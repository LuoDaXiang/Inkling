import { describe, test, expect } from "vitest";
import {
  parseAssessment,
  looksLikeSpeech,
  MalformedResponseError,
} from "@/providers/scoring/parse";

/**
 * 输入空间分类（判据一，见 docs/decisions.md 0006）
 *
 *   A. 退化输入 —— 不是 JSON、不是对象、空、null
 *   B. 无 NBest 的每一种形态 —— 这是「没识别到语音」的正常结果，不是错误
 *   C. 五项分数 —— 缺失、越界、非数字、小数、边界值
 *   D. 语调缺席 —— 唯一允许缺席的一项，必须单独成类
 *   E. 逐词明细 —— 缺失、空、字段不全、未知错误类型
 *   F. 语调反馈 —— Monotone 与 Break 的各种缺失层级
 *   G. 真实响应样本 —— 从实测报文剪下来的，防止分类想当然
 *   H. 语义组合 —— 白噪声型、截断型这些「分数正常但录音无意义」的情况
 *
 * 为什么这些类是穷尽的：响应是一棵三层树（顶层 → NBest[0] → Words[]）。
 * 每一层只有三种可能：缺失、类型不对、值有问题。A/B 覆盖顶层，
 * C/D 覆盖第二层的分数，E/F 覆盖第三层，G 用真实报文交叉验证分类没漏，
 * H 覆盖「结构都对但语义不可信」——这一类是实测才发现的，光看结构想不出来。
 */

/** 从一次真实响应剪下来的骨架，各用例在此基础上改。 */
const REAL = {
  RecognitionStatus: "Success",
  Offset: 1300000,
  Duration: 36600000,
  DisplayText: "The quick brown fox jumps over the lazy dog.",
  SNR: 38.729744,
  NBest: [
    {
      Confidence: 0.9893554,
      Display: "The quick brown fox jumps over the lazy dog.",
      AccuracyScore: 96,
      FluencyScore: 100,
      ProsodyScore: 91,
      CompletenessScore: 100,
      PronScore: 95.6,
      Words: [
        {
          Word: "The",
          AccuracyScore: 80,
          ErrorType: "None",
          Syllables: [{ Syllable: "dhax", AccuracyScore: 77 }],
          Phonemes: [
            { Phoneme: "dh", AccuracyScore: 67 },
            { Phoneme: "ax", AccuracyScore: 100 },
          ],
          Feedback: {
            Prosody: {
              Break: { ErrorTypes: ["None"], BreakLength: 0 },
              Intonation: { ErrorTypes: [], Monotone: { Confidence: 0.31 } },
            },
          },
        },
      ],
    },
  ],
};

const json = (value: unknown): string => JSON.stringify(value);

/** 深拷贝后改一处，避免用例之间互相污染。 */
function variant(mutate: (r: typeof REAL) => void): string {
  const copy = structuredClone(REAL);
  mutate(copy);
  return json(copy);
}

describe("parseAssessment", () => {
  describe("A. 退化输入", () => {
    test("不是合法 JSON", () => {
      expect(() => parseAssessment("{oops")).toThrow(MalformedResponseError);
      expect(() => parseAssessment("{oops")).toThrow(/不是合法 JSON/);
    });

    test("空字符串", () => {
      expect(() => parseAssessment("")).toThrow(MalformedResponseError);
    });

    test("JSON 是数组不是对象", () => {
      expect(() => parseAssessment("[]")).toThrow(/不是对象/);
    });

    test("JSON 是 null", () => {
      expect(() => parseAssessment("null")).toThrow(/不是对象/);
    });

    test("JSON 是数字", () => {
      expect(() => parseAssessment("42")).toThrow(/不是对象/);
    });
  });

  describe("B. 没识别到语音 —— 返回 null 而不是抛错", () => {
    // 这一整类是实测来的：静音、噪声、非音频字节全都返回 HTTP 200，
    // 只是没有 NBest。用户确实录了一段没语音的东西，这是要如实告诉他的
    // 结果，不是异常。

    test("完全没有 NBest 字段", () => {
      expect(parseAssessment(json({ RecognitionStatus: "InitialSilenceTimeout" }))).toBeNull();
    });

    test("NBest 是空数组", () => {
      expect(parseAssessment(json({ RecognitionStatus: "NoMatch", NBest: [] }))).toBeNull();
    });

    test("NBest 不是数组", () => {
      expect(parseAssessment(json({ NBest: "nope" }))).toBeNull();
    });

    test("连 RecognitionStatus 字段都没有 —— 空音频时的真实形态", () => {
      // 实测：只有 WAV 头没有采样数据时，响应里连状态字段都不存在。
      // 所以判断顺序必须是先看 NBest，不能先看状态。
      expect(parseAssessment(json({}))).toBeNull();
    });

    test("状态是 Success 但没有 NBest", () => {
      expect(parseAssessment(json({ RecognitionStatus: "Success" }))).toBeNull();
    });

    test("NBest[0] 不是对象 —— 有 NBest 但内容是垃圾", () => {
      // 和 B 组其他用例不同：这里 NBest 存在且非空，说明服务端认为识别成功了，
      // 但内容取不出来。这是响应坏掉，不是「没说话」，所以抛错而不是返回 null。
      expect(() => parseAssessment(json({ NBest: ["not an object"] }))).toThrow(
        /NBest\[0\] 不是对象/,
      );
      expect(() => parseAssessment(json({ NBest: [null] }))).toThrow(/NBest\[0\] 不是对象/);
    });
  });

  describe("C. 五项分数", () => {
    test("正常响应，五项都取到", () => {
      const r = parseAssessment(json(REAL));
      expect(r?.scores).toEqual({
        accuracy: 96,
        fluency: 100,
        completeness: 100,
        prosody: 91,
        overall: 95.6,
      });
    });

    test("分数是小数不是整数", () => {
      const r = parseAssessment(variant((x) => (x.NBest[0]!.PronScore = 78.35)));
      expect(r?.scores.overall).toBe(78.35);
    });

    test("分数为 0 是合法值，不能当成缺失", () => {
      const r = parseAssessment(
        variant((x) => {
          x.NBest[0]!.AccuracyScore = 0;
          x.NBest[0]!.FluencyScore = 0;
        }),
      );
      expect(r?.scores.accuracy).toBe(0);
      expect(r?.scores.fluency).toBe(0);
    });

    test("分数为 100 是合法值", () => {
      const r = parseAssessment(variant((x) => (x.NBest[0]!.CompletenessScore = 100)));
      expect(r?.scores.completeness).toBe(100);
    });

    test.each([
      ["AccuracyScore"],
      ["FluencyScore"],
      ["CompletenessScore"],
      ["PronScore"],
    ])("%s 缺失必须抛错 —— 它们不像语调，没有缺席的理由", (field) => {
      const body = variant((x) => {
        delete (x.NBest[0] as Record<string, unknown>)[field];
      });
      expect(() => parseAssessment(body)).toThrow(MalformedResponseError);
      expect(() => parseAssessment(body)).toThrow(new RegExp(field));
    });

    test.each([[null], ["96"], [NaN], [undefined]])(
      "分数是 %s 时抛错，不让 NaN 流进数据库",
      (bad) => {
        const body = variant((x) => {
          (x.NBest[0] as Record<string, unknown>)["AccuracyScore"] = bad;
        });
        expect(() => parseAssessment(body)).toThrow(MalformedResponseError);
      },
    );

    test("分数越界时夹到 0–100，而不是让它污染统计", () => {
      const r = parseAssessment(
        variant((x) => {
          x.NBest[0]!.AccuracyScore = 120;
          x.NBest[0]!.FluencyScore = -5;
        }),
      );
      expect(r?.scores.accuracy).toBe(100);
      expect(r?.scores.fluency).toBe(0);
    });
  });

  describe("D. 语调 —— 唯一允许缺席的一项", () => {
    test("正常返回时取到", () => {
      expect(parseAssessment(json(REAL))?.scores.prosody).toBe(91);
    });

    test("字段缺失时是 undefined，其余四项照常", () => {
      // 实测：音频被截断、参考文本无效时，ProsodyScore 直接不出现。
      const r = parseAssessment(
        variant((x) => {
          delete (x.NBest[0] as Record<string, unknown>)["ProsodyScore"];
        }),
      );
      expect(r?.scores.prosody).toBeUndefined();
      expect(r?.scores.accuracy).toBe(96);
    });

    test("语调是 null 时当作缺席，不抛错", () => {
      const r = parseAssessment(
        variant((x) => {
          (x.NBest[0] as Record<string, unknown>)["ProsodyScore"] = null;
        }),
      );
      expect(r?.scores.prosody).toBeUndefined();
    });

    test("语调为 0 是合法值，不是缺席", () => {
      const r = parseAssessment(variant((x) => (x.NBest[0]!.ProsodyScore = 0)));
      expect(r?.scores.prosody).toBe(0);
    });
  });

  describe("E. 逐词明细", () => {
    test("正常解析出词、准确度、错误类型、音素", () => {
      const w = parseAssessment(json(REAL))?.words[0];
      expect(w?.word).toBe("The");
      expect(w?.accuracy).toBe(80);
      expect(w?.errorType).toBe("None");
      expect(w?.phonemes).toEqual([
        { phoneme: "dh", accuracy: 67 },
        { phoneme: "ax", accuracy: 100 },
      ]);
    });

    test("Words 缺失时给空数组，不抛错", () => {
      const r = parseAssessment(
        variant((x) => {
          delete (x.NBest[0] as Record<string, unknown>)["Words"];
        }),
      );
      expect(r?.words).toEqual([]);
    });

    test("Words 是空数组", () => {
      const r = parseAssessment(variant((x) => (x.NBest[0]!.Words = [])));
      expect(r?.words).toEqual([]);
    });

    test("Words 里混入非对象条目时跳过", () => {
      const r = parseAssessment(
        variant((x) => {
          x.NBest[0]!.Words = [
            "garbage" as never,
            null as never,
            { Word: "ok", AccuracyScore: 90, ErrorType: "None" } as never,
          ];
        }),
      );
      expect(r?.words).toHaveLength(1);
      expect(r?.words[0]?.word).toBe("ok");
    });

    test("Phonemes 里混入非对象条目时跳过", () => {
      const r = parseAssessment(
        variant((x) => {
          x.NBest[0]!.Words[0]!.Phonemes = [
            "junk" as never,
            null as never,
            { Phoneme: "k", AccuracyScore: 88 },
          ];
        }),
      );
      expect(r?.words[0]?.phonemes).toEqual([{ phoneme: "k", accuracy: 88 }]);
    });

    test("单个词缺 Word 字段时跳过它，不影响其他词", () => {
      const r = parseAssessment(
        variant((x) => {
          x.NBest[0]!.Words = [
            { AccuracyScore: 50 } as never,
            { Word: "ok", AccuracyScore: 90, ErrorType: "None" } as never,
          ];
        }),
      );
      expect(r?.words).toHaveLength(1);
      expect(r?.words[0]?.word).toBe("ok");
    });

    test.each([
      ["Omission"],
      ["Insertion"],
      ["Mispronunciation"],
      ["UnexpectedBreak"],
      ["MissingBreak"],
      ["Monotone"],
    ])("错误类型 %s 原样保留", (kind) => {
      const r = parseAssessment(variant((x) => (x.NBest[0]!.Words[0]!.ErrorType = kind)));
      expect(r?.words[0]?.errorType).toBe(kind);
    });

    test("未知的错误类型归到 None —— 服务端加新类型不该让整次评分失败", () => {
      const r = parseAssessment(
        variant((x) => (x.NBest[0]!.Words[0]!.ErrorType = "SomeNewTypeIn2027")),
      );
      expect(r?.words[0]?.errorType).toBe("None");
    });

    test("词缺 AccuracyScore 时按 0 计，但保留这个词", () => {
      // 和分数字段不同，词级缺字段不抛错——一个词的明细取不到，
      // 不该让整次评分作废。丢掉这个词的分数，但保住其余部分。
      const r = parseAssessment(
        variant((x) => {
          delete (x.NBest[0]!.Words[0] as Record<string, unknown>)["AccuracyScore"];
        }),
      );
      expect(r?.words[0]?.word).toBe("The");
      expect(r?.words[0]?.accuracy).toBe(0);
    });

    test("音素缺 AccuracyScore 时按 0 计", () => {
      const r = parseAssessment(
        variant((x) => {
          x.NBest[0]!.Words[0]!.Phonemes = [{ Phoneme: "dh" } as never];
        }),
      );
      expect(r?.words[0]?.phonemes).toEqual([{ phoneme: "dh", accuracy: 0 }]);
    });

    test("音素缺失时给空数组", () => {
      const r = parseAssessment(
        variant((x) => {
          delete (x.NBest[0]!.Words[0] as Record<string, unknown>)["Phonemes"];
        }),
      );
      expect(r?.words[0]?.phonemes).toEqual([]);
    });

    test("音素条目缺字段时跳过该条", () => {
      const r = parseAssessment(
        variant((x) => {
          x.NBest[0]!.Words[0]!.Phonemes = [
            { AccuracyScore: 50 } as never,
            { Phoneme: "k", AccuracyScore: 88 },
          ];
        }),
      );
      expect(r?.words[0]?.phonemes).toEqual([{ phoneme: "k", accuracy: 88 }]);
    });
  });

  describe("F. 语调反馈的各级缺失", () => {
    // 这是四层嵌套：Feedback → Prosody → Intonation → Monotone → Confidence。
    // 每一层都可能不存在，逐层测过才敢在界面上直接用。

    test("正常取到单调置信度", () => {
      expect(parseAssessment(json(REAL))?.words[0]?.monotone).toBe(0.31);
    });

    test.each([
      ["Feedback", (w: Record<string, unknown>) => delete w["Feedback"]],
      [
        "Prosody",
        (w: Record<string, unknown>) => delete (w["Feedback"] as Record<string, unknown>)["Prosody"],
      ],
      [
        "Intonation",
        (w: Record<string, unknown>) =>
          delete (
            (w["Feedback"] as Record<string, unknown>)["Prosody"] as Record<string, unknown>
          )["Intonation"],
      ],
    ])("缺 %s 层时 monotone 是 undefined，不崩", (_name, remove) => {
      const r = parseAssessment(
        variant((x) => remove(x.NBest[0]!.Words[0] as unknown as Record<string, unknown>)),
      );
      expect(r?.words[0]?.monotone).toBeUndefined();
      expect(r?.words[0]?.word).toBe("The");
    });

    test("单调置信度为 0 是合法值，不是缺席", () => {
      const r = parseAssessment(
        variant(
          (x) => (x.NBest[0]!.Words[0]!.Feedback.Prosody.Intonation.Monotone.Confidence = 0),
        ),
      );
      expect(r?.words[0]?.monotone).toBe(0);
    });

    test("Break 的 ErrorTypes 含 UnexpectedBreak", () => {
      const r = parseAssessment(
        variant((x) => (x.NBest[0]!.Words[0]!.Feedback.Prosody.Break.ErrorTypes = ["UnexpectedBreak"])),
      );
      expect(r?.words[0]?.breakError).toBe("unexpected");
    });

    test("Break 的 ErrorTypes 含 MissingBreak", () => {
      const r = parseAssessment(
        variant((x) => (x.NBest[0]!.Words[0]!.Feedback.Prosody.Break.ErrorTypes = ["MissingBreak"])),
      );
      expect(r?.words[0]?.breakError).toBe("missing");
    });

    test("Break 是 None 时不设 breakError", () => {
      expect(parseAssessment(json(REAL))?.words[0]?.breakError).toBeUndefined();
    });

    test("Break 的 ErrorTypes 不是数组时不设 breakError", () => {
      const r = parseAssessment(
        variant((x) => {
          (x.NBest[0]!.Words[0]!.Feedback.Prosody.Break as Record<string, unknown>)[
            "ErrorTypes"
          ] = "None";
        }),
      );
      expect(r?.words[0]?.breakError).toBeUndefined();
    });
  });

  describe("G. 顶层字段", () => {
    test("识别文本取自 NBest[0].Display", () => {
      expect(parseAssessment(json(REAL))?.recognized).toContain("quick brown fox");
    });

    test("Display 缺失时给空串，不抛错", () => {
      const r = parseAssessment(
        variant((x) => {
          delete (x.NBest[0] as Record<string, unknown>)["Display"];
        }),
      );
      expect(r?.recognized).toBe("");
    });

    test("SNR 取到", () => {
      expect(parseAssessment(json(REAL))?.snr).toBeCloseTo(38.73, 2);
    });

    test("SNR 缺失时是 undefined", () => {
      const r = parseAssessment(
        variant((x) => {
          delete (x as Record<string, unknown>)["SNR"];
        }),
      );
      expect(r?.snr).toBeUndefined();
    });
  });
});

describe("looksLikeSpeech —— 单个维度不能单独信", () => {
  const withScores = (
    accuracy: number,
    fluency: number,
    overall: number,
  ): ReturnType<typeof parseAssessment> =>
    parseAssessment(
      variant((x) => {
        x.NBest[0]!.AccuracyScore = accuracy;
        x.NBest[0]!.FluencyScore = fluency;
        x.NBest[0]!.PronScore = overall;
      }),
    );

  test("正常朗读判为有效", () => {
    expect(looksLikeSpeech(withScores(96, 100, 95.6)!)).toBe(true);
  });

  test("纯白噪声判为无效 —— 准确度 71 分是个陷阱", () => {
    // 这组数字是实测的：3 秒白噪声拿到准确度 71、流利度 13、总分 32.7。
    // 只看准确度会把一段噪声当成「读得还行」呈现给用户。
    expect(looksLikeSpeech(withScores(71, 13, 32.7)!)).toBe(false);
  });

  test("读得差但确实在读，判为有效", () => {
    // 效度测量里专家给 3 分的样本，Azure 总分 40.8、语调 27.1。
    // 分低不等于无效——这类用户最需要反馈，不能被当成噪声丢掉。
    expect(looksLikeSpeech(withScores(46, 32, 37.1)!)).toBe(true);
  });

  test("刚好在阈值上", () => {
    expect(looksLikeSpeech(withScores(50, 20, 20)!)).toBe(true);
    expect(looksLikeSpeech(withScores(50, 19, 20)!)).toBe(false);
  });
});
