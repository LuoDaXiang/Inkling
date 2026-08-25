import { describe, test, expect } from "vitest";
import type { AssessmentResult } from "@/providers/scoring/types";
import {
  insertAssessment,
  insertMaterial,
  insertRecording,
  insertSentence,
  phonemeHistory,
  readWords,
  withTransaction,
} from "@/storage/records";
import { memoryDb } from "./helpers/db";

/**
 * 四张业务表。
 *
 * 重点在**双写**：完整 JSON（事实来源）+ 扁平音素表（服务查询）。
 * 这是个故意的冗余，所以要有测试证明冗余的两侧都在、且一致，
 * 否则冗余会退化成「两份都不可信」。
 */

const ts = 1_700_000_000_000;

const result = (overrides: Partial<AssessmentResult> = {}): AssessmentResult => ({
  scores: { accuracy: 88, fluency: 92, completeness: 100, prosody: 75, overall: 89 },
  recognized: "think fast",
  snr: 31.5,
  words: [
    {
      word: "think",
      accuracy: 62,
      errorType: "Mispronunciation",
      phonemes: [
        { phoneme: "θ", accuracy: 40 },
        { phoneme: "ɪ", accuracy: 90 },
        { phoneme: "ŋ", accuracy: 85 },
        { phoneme: "k", accuracy: 88 },
      ],
      monotone: 0.8,
    },
    {
      word: "fast",
      accuracy: 95,
      errorType: "None",
      phonemes: [
        { phoneme: "f", accuracy: 96 },
        { phoneme: "æ", accuracy: 94 },
        { phoneme: "s", accuracy: 95 },
        { phoneme: "t", accuracy: 93 },
      ],
    },
  ],
  ...overrides,
});

function chain(db: ReturnType<typeof memoryDb>): number {
  const materialId = insertMaterial(db, { title: "第一课", source: "imported", createdAt: ts });
  const sentenceId = insertSentence(db, {
    materialId,
    ord: 0,
    text: "think fast",
    createdAt: ts,
  });
  return insertRecording(db, {
    sentenceId,
    audioKey: "a".repeat(64),
    durationMs: 2100,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    createdAt: ts,
  });
}

describe("四张表", () => {
  test("整条链插得进去", () => {
    const db = memoryDb();
    const recordingId = chain(db);
    const assessmentId = insertAssessment(db, {
      recordingId,
      engine: "azure",
      result: result(),
      createdAt: ts,
    });
    expect(assessmentId).toBeGreaterThan(0);
    db.close();
  });

  test("音频采集参数是三态：开 / 关 / 不知道", () => {
    // 浏览器可以无视 constraint，读不到就是 null。
    // 默认成 false 会让「没关掉 AGC」和「不知道有没有关」混成一谈。
    const db = memoryDb();
    const materialId = insertMaterial(db, { title: "t", source: "imported", createdAt: ts });
    const sentenceId = insertSentence(db, { materialId, ord: 0, text: "x", createdAt: ts });

    const known = insertRecording(db, {
      sentenceId,
      audioKey: "b".repeat(64),
      durationMs: 1000,
      echoCancellation: true,
      noiseSuppression: false,
      createdAt: ts,
    });
    const unknown = insertRecording(db, {
      sentenceId,
      audioKey: "c".repeat(64),
      durationMs: 1000,
      createdAt: ts,
    });

    const read = (id: number): Record<string, unknown> =>
      db
        .prepare(
          "SELECT echo_cancellation, noise_suppression, auto_gain_control FROM recording WHERE id = ?",
        )
        .get(id) as Record<string, unknown>;

    expect(read(known)["echo_cancellation"]).toBe(1);
    expect(read(known)["noise_suppression"]).toBe(0);
    expect(read(known)["auto_gain_control"]).toBeNull();
    expect(read(unknown)["echo_cancellation"]).toBeNull();
    db.close();
  });

  test("prosody 缺席时存 null，不是 0", () => {
    // 音频被截断、参考文本无效时 Azure 直接不返回 prosody。
    // 存成 0 会让趋势曲线上多出一个不存在的低谷。
    const db = memoryDb();
    const recordingId = chain(db);
    const r = result();
    delete r.scores.prosody;
    delete r.snr;
    const id = insertAssessment(db, { recordingId, engine: "azure", result: r, createdAt: ts });

    const row = db
      .prepare("SELECT prosody, snr FROM assessment WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row["prosody"]).toBeNull();
    expect(row["snr"]).toBeNull();
    db.close();
  });
});

describe("双写", () => {
  test("扁平表把每个音素都摊开了", () => {
    const db = memoryDb();
    const recordingId = chain(db);
    const id = insertAssessment(db, {
      recordingId,
      engine: "azure",
      result: result(),
      createdAt: ts,
    });

    const row = db
      .prepare("SELECT COUNT(*) c FROM phoneme_score WHERE assessment_id = ?")
      .get(id) as Record<string, unknown>;
    expect(Number(row["c"])).toBe(8); // 2 个词 × 4 个音素
    db.close();
  });

  test("JSON 那份保留了扁平表丢掉的字段", () => {
    const db = memoryDb();
    const recordingId = chain(db);
    const id = insertAssessment(db, {
      recordingId,
      engine: "azure",
      result: result(),
      createdAt: ts,
    });

    const words = readWords(db, id);
    expect(words[0]?.errorType).toBe("Mispronunciation");
    expect(words[0]?.monotone).toBe(0.8);
    // 扁平表里没有这两个字段——这正是要留完整 JSON 的理由。
    const columns = db
      .prepare("SELECT * FROM phoneme_score LIMIT 1")
      .columns()
      .map((c) => c.name);
    expect(columns).not.toContain("error_type");
    expect(columns).not.toContain("monotone");
    db.close();
  });

  test("两份数据一致：JSON 里的音素数等于扁平表行数", () => {
    const db = memoryDb();
    const recordingId = chain(db);
    const id = insertAssessment(db, {
      recordingId,
      engine: "azure",
      result: result(),
      createdAt: ts,
    });

    const words = readWords(db, id);
    const fromJson = words.reduce((n, w) => n + w.phonemes.length, 0);
    const row = db
      .prepare("SELECT COUNT(*) c FROM phoneme_score WHERE assessment_id = ?")
      .get(id) as Record<string, unknown>;
    expect(Number(row["c"])).toBe(fromJson);
    db.close();
  });

  test("双写是原子的：明细写失败，总分也不会留下", () => {
    const db = memoryDb();
    const recordingId = chain(db);
    const broken = result();
    // NaN 存进 REAL NOT NULL 列会变成 NULL，触发约束失败。
    broken.words[1]!.phonemes[2]!.accuracy = NaN;

    expect(() =>
      insertAssessment(db, { recordingId, engine: "azure", result: broken, createdAt: ts }),
    ).toThrow();

    // 关键断言：不能留下一条「有总分没明细」的半截记录。
    const a = db.prepare("SELECT COUNT(*) c FROM assessment").get() as Record<string, unknown>;
    const p = db.prepare("SELECT COUNT(*) c FROM phoneme_score").get() as Record<string, unknown>;
    expect(Number(a["c"])).toBe(0);
    expect(Number(p["c"])).toBe(0);
    db.close();
  });

  test("没有词的评分结果不写任何明细行，也不报错", () => {
    const db = memoryDb();
    const recordingId = chain(db);
    const id = insertAssessment(db, {
      recordingId,
      engine: "azure",
      result: result({ words: [] }),
      createdAt: ts,
    });
    const row = db
      .prepare("SELECT COUNT(*) c FROM phoneme_score WHERE assessment_id = ?")
      .get(id) as Record<string, unknown>;
    expect(Number(row["c"])).toBe(0);
    db.close();
  });
});

describe("音素历史——双写存在的理由", () => {
  test("查得出「这个音素历史上念得怎么样」", () => {
    const db = memoryDb();
    const recordingId = chain(db);

    // 三次练习，/θ/ 从 40 分涨到 78 分
    for (const [i, accuracy] of [40, 61, 78].entries()) {
      const r = result();
      r.words[0]!.phonemes[0]!.accuracy = accuracy;
      insertAssessment(db, {
        recordingId,
        engine: "azure",
        result: r,
        createdAt: ts + i * 86_400_000,
      });
    }

    const history = phonemeHistory(db, "θ");
    expect(history.map((h) => h.accuracy)).toEqual([40, 61, 78]);
    expect(history[0]?.word).toBe("think");
    expect(history[0]?.wordIndex).toBe(0);
    db.close();
  });

  test("按时间排序，不是按插入顺序", () => {
    const db = memoryDb();
    const recordingId = chain(db);

    // 故意乱序插入
    for (const [createdAt, accuracy] of [
      [ts + 2000, 78],
      [ts, 40],
      [ts + 1000, 61],
    ] as const) {
      const r = result();
      r.words[0]!.phonemes[0]!.accuracy = accuracy;
      insertAssessment(db, { recordingId, engine: "azure", result: r, createdAt });
    }

    expect(phonemeHistory(db, "θ").map((h) => h.accuracy)).toEqual([40, 61, 78]);
    db.close();
  });

  test("查一个没出现过的音素返回空数组", () => {
    const db = memoryDb();
    const recordingId = chain(db);
    insertAssessment(db, { recordingId, engine: "azure", result: result(), createdAt: ts });
    expect(phonemeHistory(db, "ʒ")).toEqual([]);
    db.close();
  });

  test("同一个音素在一次评分里出现多次也全都算上", () => {
    const db = memoryDb();
    const recordingId = chain(db);
    const r = result();
    r.words[1]!.phonemes[0]!.phoneme = "θ"; // fast 的第一个音素也改成 θ
    insertAssessment(db, { recordingId, engine: "azure", result: r, createdAt: ts });

    const history = phonemeHistory(db, "θ");
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.word)).toEqual(["think", "fast"]);
    db.close();
  });
});

describe("readWords", () => {
  test("读不存在的评分抛错，而不是返回空数组", () => {
    const db = memoryDb();
    expect(() => readWords(db, 999)).toThrow(/不存在/);
    db.close();
  });

  test("JSON 往返之后结构完全一致", () => {
    const db = memoryDb();
    const recordingId = chain(db);
    const original = result();
    const id = insertAssessment(db, {
      recordingId,
      engine: "azure",
      result: original,
      createdAt: ts,
    });
    expect(readWords(db, id)).toEqual(original.words);
    db.close();
  });
});

describe("withTransaction", () => {
  test("抛错时回滚", () => {
    const db = memoryDb();
    expect(() =>
      withTransaction(db, () => {
        insertMaterial(db, { title: "a", source: "imported", createdAt: ts });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    const row = db.prepare("SELECT COUNT(*) c FROM material").get() as Record<string, unknown>;
    expect(Number(row["c"])).toBe(0);
    db.close();
  });

  test("正常返回时提交", () => {
    const db = memoryDb();
    const id = withTransaction(db, () =>
      insertMaterial(db, { title: "a", source: "imported", createdAt: ts }),
    );
    const row = db.prepare("SELECT COUNT(*) c FROM material").get() as Record<string, unknown>;
    expect(Number(row["c"])).toBe(1);
    expect(id).toBeGreaterThan(0);
    db.close();
  });

  test("原样把返回值传出来", () => {
    const db = memoryDb();
    expect(withTransaction(db, () => "hello")).toBe("hello");
    db.close();
  });
});
