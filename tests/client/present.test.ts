import { describe, test, expect } from "vitest";
import {
  AUTO_RETRY_POST,
  band,
  interpretError,
  LOW_ACCURACY,
  MONOTONE_HEAVY,
  MONOTONE_LIGHT,
  phonemeRows,
  pitchPlot,
  presentResult,
  wordMarks,
} from "@renderer/lib/present";

/**
 * 「该展示什么」的决定层 —— 测试清单 #32、#33、#35、#39，以及 §5 的封闭枚举降级。
 *
 * 这一批守的是**产品正确性**，契约特意说明它们「不能留给客户端自己发挥」：
 *
 *   [C30] `unreliable` 照 `scored` 渲染，会把噪声当成「读得还行」端给用户。
 *         纯白噪声的准确度是 71 分，而准确度是主打维度。
 *   [C44] 缺席渲染成 0 是在撒谎——「语调 0 分」和「语调没测出来」是两回事。
 *   [C32] `persisted:false` 的两种含义分不开，用户就不知道这次有没有记上。
 *
 * 界面会重画，这些判断不会变。所以它们在这里，不在界面里。
 *
 * ## M3.9：import 改指 `src/renderer/lib/present.ts`，**一条都没退役**
 *
 * 迁移计划把这个文件划进「M3 退役 71 条」那一格。那一格的前提是
 * 「这些代码随 `public/*.js` 一起消失」——**而它没有消失**：
 * 决定层原样搬进了渲染层，React 界面照着画的就是它。
 *
 * 退役一批仍然守着活代码的用例，是拿覆盖率换一个更好看的迁移故事。
 * 所以这里只改了那一行 import。文件头上面那句「界面是草稿，这个文件不是」
 * 本来就是这么说的。
 */

const scoredBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  outcome: "scored",
  scores: { accuracy: 82.1, fluency: 74, completeness: 100, prosody: 68.2, overall: 79.5 },
  words: [{ word: "think", accuracy: 41.2, errorType: "Mispronunciation", phonemes: [] }],
  recognized: "think fast",
  snr: 24.5,
  trimmedStartMs: 80,
  trimmedEndMs: 200,
  assessedMs: 4620,
  persisted: true,
  recordingId: 301,
  assessmentId: 455,
  traceId: "trace-1",
  audioUrl: "/api/recordings/301/audio",
  ...overrides,
});

describe("#32 三种走向 [C11][C30]", () => {
  test("scored → 分数和逐词都展示", () => {
    const view = presentResult(scoredBody());
    expect(view.kind).toBe("scored");
    expect(view.showScores).toBe(true);
    expect(view.showWords).toBe(true);
    expect(view.recognized).toBe("think fast");
    expect(view.notices).toEqual([]);
  });

  test("unreliable → 不展示 scores、不展示逐词，只展示 recognized 并提示重录 [C30]", () => {
    // recognized 保留是因为它在 unreliable 时**恰恰是最有用的信息**：
    // 用户看到系统听成了什么，就理解了为什么不可信。
    const view = presentResult(scoredBody({ outcome: "unreliable" }));
    expect(view.kind).toBe("unreliable");
    expect(view.showScores).toBe(false);
    expect(view.showWords).toBe(false);
    expect(view.scores).toBeNull();
    expect(view.recognized).toBe("think fast");
    expect(view.notices.join()).toMatch(/重录/);
  });

  test("unreliable 时 scores 字段确实拿不到——不是靠界面自觉不画", () => {
    // 把「不展示」做成数据上的缺席，界面就没有机会画错。
    const view = presentResult(scoredBody({ outcome: "unreliable" }));
    expect(view.scores).toBeNull();
  });

  test("no_speech → 提示重录，没有分数也没有词", () => {
    const view = presentResult({
      outcome: "no_speech",
      trimmedStartMs: 3000,
      persisted: false,
      traceId: "t",
    });
    expect(view.kind).toBe("no_speech");
    expect(view.showScores).toBe(false);
    expect(view.words).toEqual([]);
    expect(view.notices.join()).toMatch(/没有录到语音/);
  });

  test("未知 outcome → 降级，不崩溃 [§5 封闭枚举]", () => {
    // 收窄枚举是破坏性变更；反过来，服务端**加**一种走向不是。
    // 老客户端见到不认识的取值必须降级显示，而不是白屏。
    const view = presentResult(scoredBody({ outcome: "partially_scored" }));
    expect(view.kind).toBe("unknown");
    expect(view.showScores).toBe(false);
    expect(view.notices.join()).toMatch(/看不懂/);
  });

  test("outcome 缺席 → 同样降级", () => {
    const view = presentResult({ traceId: "t" });
    expect(view.kind).toBe("unknown");
    expect(view.notices.length).toBeGreaterThan(0);
  });
});

describe("#35 缺席绝不渲染成 0 [C44]", () => {
  test("snr 缺席 → null，不是 0", () => {
    const body = scoredBody();
    delete body["snr"];
    expect(presentResult(body).meta.snr).toBeNull();
  });

  test("assessedMs 缺席 → null，不是 0", () => {
    const body = scoredBody();
    delete body["assessedMs"];
    expect(presentResult(body).meta.assessedMs).toBeNull();
  });

  test("两个 trimmed 都缺席 → null，不是 0", () => {
    // 这条最容易写错：`(a ?? 0) + (b ?? 0)` 在两个都缺席时得到 0，
    // 界面就会显示「掐掉首尾静音 0.00s」——那是一句假话。
    const body = scoredBody();
    delete body["trimmedStartMs"];
    delete body["trimmedEndMs"];
    expect(presentResult(body).meta.trimmedMs).toBeNull();
  });

  test("只有一个 trimmed 时按它算，另一个当 0 是对的", () => {
    const body = scoredBody();
    delete body["trimmedEndMs"];
    expect(presentResult(body).meta.trimmedMs).toBe(80);
  });

  test("snr 为 0 时保留 0——那是真的测出来是 0", () => {
    // 缺席和零必须分得开，两个方向都要对。
    expect(presentResult(scoredBody({ snr: 0 })).meta.snr).toBe(0);
  });

  test("snr 为负数时保留——信噪比可正可负 [C42]", () => {
    expect(presentResult(scoredBody({ snr: -3.2 })).meta.snr).toBe(-3.2);
  });

  test("非有限数一律当缺席", () => {
    for (const bad of [NaN, Infinity, -Infinity, "24.5", null]) {
      expect(presentResult(scoredBody({ snr: bad })).meta.snr, String(bad)).toBeNull();
    }
  });

  test("prosody 缺席时 scores 里就没有它，不补 0", () => {
    const body = scoredBody();
    delete (body["scores"] as Record<string, unknown>)["prosody"];
    const view = presentResult(body);
    expect(view.scores).not.toBeNull();
    expect("prosody" in (view.scores as object)).toBe(false);
  });
});

describe("#33 persisted 的三态 [C32]", () => {
  test("persisted:true → 给回放地址", () => {
    const view = presentResult(scoredBody());
    expect(view.playbackUrl).toBe("/api/recordings/301/audio");
    expect(view.notices).toEqual([]);
  });

  test("persisted:false + persistError → 提示「没记上」", () => {
    // 练习记录丢一行是用户的数据没了，而且不会重新产生。
    // 结果照给，失败照说。
    const view = presentResult(
      scoredBody({ persisted: false, persistError: "写入失败", audioUrl: undefined }),
    );
    expect(view.notices.join()).toMatch(/没保存上/);
    expect(view.playbackUrl).toBeNull();
    // 结果字段一个不少。
    expect(view.showScores).toBe(true);
    expect(view.scores).not.toBeNull();
  });

  test("persisted:false 且没有 persistError → **不**提示", () => {
    // 「本来就没要求记录」——匿名试用，或无成本的 no_speech。那不是失败。
    // 这两种 false 分不开的话，每次试用都会弹一句「没记上」，用户会以为坏了。
    const view = presentResult(scoredBody({ persisted: false, audioUrl: undefined }));
    expect(view.notices).toEqual([]);
    expect(view.playbackUrl).toBeNull();
  });

  test("persisted:true 但没给 audioUrl → 回放地址为 null，不瞎拼", () => {
    // 不要用 recordingId 自己拼 `/api/recordings/${id}/audio`：
    // 那是在对 id 和路由形状做假设（[C7] [C55]）。
    const body = scoredBody();
    delete body["audioUrl"];
    expect(presentResult(body).playbackUrl).toBeNull();
  });

  test("unreliable 也会落库，回放地址照给", () => {
    const view = presentResult(scoredBody({ outcome: "unreliable" }));
    expect(view.playbackUrl).toBe("/api/recordings/301/audio");
  });
});

describe("不承诺什么 [C68][C70]", () => {
  test("words 原样透传，不按下标和参考文本对齐 [C68]", () => {
    // Omission 和 Insertion 会让 words 的长度不等于参考文本的词数，
    // 按下标对齐必然错位。
    const words = [{ word: "a" }, { word: "b" }, { word: "c" }];
    expect(presentResult(scoredBody({ words })).words).toEqual(words);
  });

  test("words 不是数组 → 空数组，不崩", () => {
    for (const bad of [null, undefined, "x", 42, {}]) {
      expect(presentResult(scoredBody({ words: bad })).words, String(bad)).toEqual([]);
    }
  });

  test("不重算 overall，也不反推权重 [C70]", () => {
    // overall 不是其他四项的任何固定加权，也不承诺加权方式稳定。
    const view = presentResult(scoredBody());
    expect(view.scores).toEqual(scoredBody()["scores"]);
  });

  test("未知的 errorType 原样保留，由界面降级 [C12]", () => {
    const words = [{ word: "x", errorType: "SomethingNew" }];
    expect(presentResult(scoredBody({ words })).words).toEqual(words);
  });
});

describe("畸形输入不崩", () => {
  test("null / undefined / 数组 / 标量都能吃下去", () => {
    for (const bad of [null, undefined, [], "text", 42, true]) {
      const view = presentResult(bad);
      expect(view.kind, String(bad)).toBe("unknown");
      expect(view.words).toEqual([]);
      expect(view.meta.snr).toBeNull();
    }
  });

  test("traceId 缺席或非字符串 → null", () => {
    for (const bad of [undefined, null, 42, {}]) {
      expect(presentResult(scoredBody({ traceId: bad })).traceId, String(bad)).toBeNull();
    }
  });

  test("recognized 非字符串 → null，不是 undefined 也不是 ''", () => {
    expect(presentResult(scoredBody({ recognized: 42 })).recognized).toBeNull();
  });
});

describe("band 分档 [decisions 0019 / 0035]", () => {
  test("四档的切点", () => {
    expect(band(85)).toBe("很好");
    expect(band(84.9)).toBe("不错");
    expect(band(70)).toBe("不错");
    expect(band(69.9)).toBe("可懂");
    expect(band(50)).toBe("可懂");
    expect(band(49.9)).toBe("要重练");
    expect(band(0)).toBe("要重练");
  });

  test("非数值 → null，界面据此不显示那一行", () => {
    // 不展示原始百分数是硬规矩：准确度绝对值虚高约 20 分，
    // 主打维度报一个虚高的数字，整个产品的可信度就没了。
    for (const bad of [undefined, null, NaN, Infinity, "85"]) {
      expect(band(bad), String(bad)).toBeNull();
    }
  });

  test("越界的分数也给得出档位，不抛", () => {
    expect(band(120)).toBe("很好");
    expect(band(-5)).toBe("要重练");
  });
});

describe("#39 错误只按 error 分支，不解析 message [C46][C53]", () => {
  test("每个已知取值都有处置", () => {
    const codes = [
      "rejected",
      "not_found",
      "forbidden",
      "method_not_allowed",
      "too_long",
      "network",
      "empty",
      "unknown",
      "auth",
      "quota",
      "unavailable",
      "internal",
    ];
    for (const code of codes) {
      const view = interpretError({ error: code, message: "随便什么话" });
      expect(view.known, code).toBe(true);
      expect(view.code, code).toBe(code);
      expect(typeof view.action, code).toBe("string");
    }
  });

  test("auth / quota 不向用户追责 [C45]", () => {
    // 密钥是本机配的，浏览器端的用户没做错任何事。
    for (const code of ["auth", "quota"]) {
      expect(interpretError({ error: code }).blameUser, code).toBe(false);
    }
  });

  test("rejected / too_long 才是用户能改的", () => {
    for (const code of ["rejected", "too_long"]) {
      expect(interpretError({ error: code }).blameUser, code).toBe(true);
      expect(interpretError({ error: code }).action, code).toBe("fix_input");
    }
  });

  test("message 完全不影响分支 [C53]", () => {
    // message 的措辞随时可能改，而且改它不算破坏性变更。
    const a = interpretError({ error: "network", message: "超时了" });
    const b = interpretError({ error: "network", message: "完全不同的一句话" });
    expect(a.action).toBe(b.action);
    expect(a.canRetry).toBe(b.canRetry);
    expect(a.blameUser).toBe(b.blameUser);
  });

  test("message 原样带出来供显示", () => {
    expect(interpretError({ error: "auth", message: "密钥不对" }).message).toBe("密钥不对");
    expect(interpretError({ error: "auth" }).message).toBe("");
  });

  test("未知 error 取值 → 降级成报 bug，不崩 [§5]", () => {
    const view = interpretError({ error: "teapot", message: "?" });
    expect(view.known).toBe(false);
    expect(view.action).toBe("report_bug");
  });

  test("响应体畸形 → 也能给出一个处置", () => {
    for (const bad of [null, undefined, [], "x", 42, {}]) {
      const view = interpretError(bad);
      expect(view.known, String(bad)).toBe(false);
      expect(view.action, String(bad)).toBe("report_bug");
    }
  });
});

describe("#34 不自动重试 [C36][C47][C52]", () => {
  test("这条禁令在代码里有位置，不只写在文档里", () => {
    // 每次 POST /api/assess 都真实付费，而且超时之后请求可能已经在
    // 服务端执行并计费了。一条只写在文档里的禁令，迟早有人不知道。
    expect(AUTO_RETRY_POST).toBe(false);
  });

  test("可重试的错误说的是「提示用户手动重试」，不是自动重试", () => {
    const view = interpretError({ error: "network" });
    expect(view.canRetry).toBe(true);
    expect(view.action).toBe("retry_manually");
  });
});

/* ================================================================== *
 * 音高曲线（M1.6）
 * ================================================================== */

/**
 * 输入空间分类
 *
 *   A. 断开 —— null 处必须切段，不能连成直线  ⭐
 *   B. 共用纵轴 —— 两条曲线一起定范围，不各自归一化  ⭐
 *   C. 时间对齐 —— 横轴按毫秒，不按帧号  ⭐
 *   D. 退化 —— 全 null、空、只有一条、形状不对
 *
 * A、B、C 三条都是**产品正确性**，而且三条都是「错了也不报错」的那一类：
 *
 *   A 错 → 一段根本没测出音高的地方画出一条平滑曲线。那条线是编的。
 *   B 错 → 一个念得又低又平的人和范本画出一模一样的两条线，
 *          跟读练习的全部意义就没了。
 *   C 错 → 两条 hopMs 不同的曲线错位，用户以为自己的语调整体提前了。
 */

const REF = "reference";
const MINE = "recording";

describe("pitchPlot —— A. null 处断开", () => {
  test("中间一个 null 把曲线切成两段", () => {
    const plot = pitchPlot({ recording: { hz: [200, 210, null, 220, 230], hopMs: 20 } });
    expect(plot.segments.map((s) => s.points.length)).toEqual([2, 2]);
    expect(plot.segments.every((s) => s.series === MINE)).toBe(true);
  });

  test("连续多个 null 只切一次，不产生空段", () => {
    const plot = pitchPlot({ recording: { hz: [200, null, null, null, 220], hopMs: 20 } });
    expect(plot.segments.map((s) => s.points.length)).toEqual([1, 1]);
  });

  test("开头和结尾的 null 不产生空段", () => {
    const plot = pitchPlot({ recording: { hz: [null, 200, 210, null], hopMs: 20 } });
    expect(plot.segments.length).toBe(1);
    expect(plot.segments[0]?.points.length).toBe(2);
  });

  test("孤立的单点留着，不被丢掉", () => {
    // 丢掉的话「这里测出了一个音高」这个事实就没了。
    const plot = pitchPlot({ recording: { hz: [null, 220, null], hopMs: 20 } });
    expect(plot.segments.length).toBe(1);
    expect(plot.segments[0]?.points.length).toBe(1);
  });

  test("没有 null 就是一整段", () => {
    const plot = pitchPlot({ recording: { hz: [200, 210, 220], hopMs: 20 } });
    expect(plot.segments.length).toBe(1);
    expect(plot.segments[0]?.points.length).toBe(3);
  });
});

describe("pitchPlot —— B. 两条曲线共用纵轴", () => {
  test("范围由两条一起决定", () => {
    const plot = pitchPlot({
      reference: { hz: [300, 320], hopMs: 20 },
      recording: { hz: [100, 110], hopMs: 20 },
    });
    expect(plot.minHz).toBe(100);
    expect(plot.maxHz).toBe(320);
  });

  test("念得低的那条画在下面 —— 不是各自归一化", () => {
    const plot = pitchPlot({
      reference: { hz: [300, 300], hopMs: 20 },
      recording: { hz: [100, 100], hopMs: 20 },
      height: 100,
    });
    const ref = plot.segments.find((s) => s.series === REF);
    const mine = plot.segments.find((s) => s.series === MINE);
    // canvas 的 y 向下增长，所以「低」= y 更大。
    expect((mine?.points[0]?.y as number)).toBeGreaterThan(ref?.points[0]?.y as number);
  });

  test("两条完全一样时画在同一高度", () => {
    const plot = pitchPlot({
      reference: { hz: [220, 230], hopMs: 20 },
      recording: { hz: [220, 230], hopMs: 20 },
    });
    const ref = plot.segments.find((s) => s.series === REF);
    const mine = plot.segments.find((s) => s.series === MINE);
    expect(mine?.points[0]?.y).toBeCloseTo(ref?.points[0]?.y as number, 9);
  });

  test("范围退化成一个值时不除以 0", () => {
    const plot = pitchPlot({ recording: { hz: [220, 220, 220], hopMs: 20 } });
    for (const p of plot.segments[0]?.points ?? []) {
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe("pitchPlot —— C. 横轴按时间", () => {
  test("hopMs 不同的两条曲线按毫秒对齐，不按帧号", () => {
    // 范本 40ms 一帧 3 帧 = 120ms；录音 20ms 一帧 6 帧 = 120ms。
    // 按帧号对齐的话，范本会挤在左边三分之一。
    const plot = pitchPlot({
      reference: { hz: [200, 210, 220], hopMs: 40 },
      recording: { hz: [200, 205, 210, 215, 220, 225], hopMs: 20 },
      width: 100,
      padding: 0,
    });
    const ref = plot.segments.find((s) => s.series === REF);
    const mine = plot.segments.find((s) => s.series === MINE);
    // 范本第 2 帧（80ms）应当和录音第 4 帧（80ms）落在同一个 x 上。
    expect(ref?.points[2]?.x).toBeCloseTo(mine?.points[4]?.x as number, 9);
  });

  test("durationMs 取两条里长的那条", () => {
    const plot = pitchPlot({
      reference: { hz: [200, 210], hopMs: 40 },
      recording: { hz: [200, 210, 220], hopMs: 20 },
    });
    expect(plot.durationMs).toBe(80);
  });

  test("第一个点落在左边距上，最后一个点不超出画布", () => {
    const plot = pitchPlot({
      recording: { hz: [200, 210, 220], hopMs: 20 },
      width: 200,
      padding: 5,
    });
    const points = plot.segments[0]?.points ?? [];
    expect(points[0]?.x).toBe(5);
    expect(points[points.length - 1]?.x as number).toBeLessThanOrEqual(200);
  });
});

describe("pitchPlot —— D. 退化输入", () => {
  test("全 null → 没有段，也没有范围", () => {
    const plot = pitchPlot({ recording: { hz: [null, null], hopMs: 20 } });
    expect(plot.segments).toEqual([]);
    expect(plot.minHz).toBeNull();
  });

  test("空数组 → 没有段", () => {
    expect(pitchPlot({ recording: { hz: [], hopMs: 20 } }).segments).toEqual([]);
  });

  test("两条都没有 → 没有段", () => {
    expect(pitchPlot({}).segments).toEqual([]);
  });

  test("只有录音那条也照画", () => {
    const plot = pitchPlot({ recording: { hz: [200, 210], hopMs: 20 } });
    expect(plot.segments.length).toBe(1);
    expect(plot.segments[0]?.series).toBe(MINE);
  });

  test("只有范本那条也照画", () => {
    const plot = pitchPlot({ reference: { hz: [200, 210], hopMs: 20 } });
    expect(plot.segments[0]?.series).toBe(REF);
  });

  test.each([
    ["不是对象", 42],
    ["是 null", null],
    ["缺 hopMs", { hz: [200] }],
    ["hopMs 是 0", { hz: [200], hopMs: 0 }],
    ["hopMs 是字符串", { hz: [200], hopMs: "20" }],
    ["hz 不是数组", { hz: 200, hopMs: 20 }],
  ])("形状不对（%s）当成没有这条曲线", (_name, bad) => {
    expect(pitchPlot({ recording: bad }).segments).toEqual([]);
  });

  test("hz 里混进非数字的项当成 null，不当成 0", () => {
    // 当成 0 的话纵轴范围会被拉到 0，两条曲线一起被压扁到顶上。
    const plot = pitchPlot({ recording: { hz: [200, "x", 210], hopMs: 20 } });
    expect(plot.minHz).toBe(200);
    expect(plot.segments.map((s) => s.points.length)).toEqual([1, 1]);
  });
});

/* ================================================================== *
 * 逐词三层标记（M2.2 / decisions 0045）
 * ================================================================== */

/**
 * 输入空间分类
 *
 *   A. 三个维度的 8 种组合 —— 每一种各断言一次  ⭐
 *   B. 底色 —— errorType 与低分各自能触发
 *   C. 韵律类 errorType 不进底色  ⭐
 *   D. monotone 分档 —— 连续量映射成三档，切点两侧
 *   E. 缺席 —— 不编数值
 *   F. phonemeRows —— 弹出层的数据
 *
 * **A 组是这个文件里最重要的一组。** 参考实现的
 * `pronunciation-assessment-word-result.tsx:42` 是一张查表，一个词只能
 * 显示一种错误——因为 Azure 的 `errorType` 是单值枚举。Inkling 的
 * `WordScore` 是三个正交字段，一个词可以同时「念错了」和「读得平」。
 * 8 种组合逐一断言，是为了让「查表化」这种回退在测试里立刻变红。
 *
 * **C 组是最容易写错的一条。** `Monotone` / `UnexpectedBreak` /
 * `MissingBreak` 长在 `errorType` 这个字段上，顺手涂成「念错了」的底色
 * 是最自然的写法——然后用户会去改一个根本没念错的音。
 */

/** 三个维度：念错了 / 读得平 / 停顿异常。 */
function word(opts: {
  wrong?: boolean;
  flat?: boolean;
  broke?: boolean;
}): Record<string, unknown> {
  return {
    word: "think",
    accuracy: opts.wrong ? 41 : 92,
    errorType: opts.wrong ? "Mispronunciation" : "None",
    phonemes: [],
    ...(opts.flat ? { monotone: 0.8 } : {}),
    ...(opts.broke ? { breakError: "unexpected" } : {}),
  };
}

describe("wordMarks —— A. 三个维度的 8 种组合", () => {
  const combos: Array<[string, { wrong?: boolean; flat?: boolean; broke?: boolean }]> = [
    ["都没有", {}],
    ["只念错", { wrong: true }],
    ["只读平", { flat: true }],
    ["只停顿异常", { broke: true }],
    ["念错 + 读平", { wrong: true, flat: true }],
    ["念错 + 停顿", { wrong: true, broke: true }],
    ["读平 + 停顿", { flat: true, broke: true }],
    ["三样都占", { wrong: true, flat: true, broke: true }],
  ];

  test.each(combos)("%s", (_name, opts) => {
    const marks = wordMarks(word(opts));

    // 每一层各自反映它自己那个字段，互不吞并。
    expect(marks.base).toBe(opts.wrong ? "mispronounced" : "ok");
    expect(marks.monotone.level > 0).toBe(Boolean(opts.flat));
    expect(marks.breakMark).toBe(opts.broke ? "unexpected" : null);
  });

  test("三样都占时，三层同时有值 —— 查表结构表达不了这个", () => {
    const marks = wordMarks(word({ wrong: true, flat: true, broke: true }));
    expect(marks.base).toBe("mispronounced");
    expect(marks.monotone.level).toBe(3);
    expect(marks.breakMark).toBe("unexpected");
  });

  test("念错且读平时底色是念错（沿用 0035）", () => {
    expect(wordMarks(word({ wrong: true, flat: true })).base).toBe("mispronounced");
  });

  test("念错且读平时下划线照画 —— 优先级只管底色归谁", () => {
    // 这一条是 0045 与查表结构的分界。底色让给念错，
    // 但「读得平」这个事实不能因此消失。
    expect(wordMarks(word({ wrong: true, flat: true })).monotone.level).toBeGreaterThan(0);
  });
});

describe("wordMarks —— B. 底色", () => {
  test.each([
    ["Mispronunciation", "mispronounced"],
    ["Omission", "omission"],
    ["Insertion", "insertion"],
    ["None", "ok"],
  ])("errorType %s → 底色 %s", (errorType, base) => {
    expect(wordMarks({ word: "x", accuracy: 92, errorType }).base).toBe(base);
  });

  test(`准确度低于 ${LOW_ACCURACY} 时按念错标，哪怕 errorType 是 None`, () => {
    expect(wordMarks({ word: "x", accuracy: LOW_ACCURACY - 1, errorType: "None" }).base).toBe(
      "mispronounced",
    );
  });

  test("恰好等于切点算正常（边界）", () => {
    expect(wordMarks({ word: "x", accuracy: LOW_ACCURACY, errorType: "None" }).base).toBe("ok");
  });

  test("没有 accuracy 时不按念错标 —— 不知道不等于错了", () => {
    expect(wordMarks({ word: "x", errorType: "None" }).base).toBe("ok");
    expect(wordMarks({ word: "x", errorType: "None" }).accuracy).toBeNull();
  });
});

describe("wordMarks —— C. 韵律类 errorType 不进底色", () => {
  test.each(["Monotone", "UnexpectedBreak", "MissingBreak"])(
    "%s 的底色是 ok，不是念错",
    (errorType) => {
      // 涂成念错的话，用户会去改一个根本没念错的音。
      expect(wordMarks({ word: "x", accuracy: 92, errorType }).base).toBe("ok");
    },
  );

  test("Monotone 折进第二层", () => {
    expect(wordMarks({ word: "x", accuracy: 92, errorType: "Monotone" }).monotone.level)
      .toBeGreaterThan(0);
  });

  test.each([
    ["UnexpectedBreak", "unexpected"],
    ["MissingBreak", "missing"],
  ])("%s 折进第三层", (errorType, mark) => {
    expect(wordMarks({ word: "x", accuracy: 92, errorType }).breakMark).toBe(mark);
  });

  test("独立的 breakError 字段优先于 errorType", () => {
    const marks = wordMarks({
      word: "x",
      accuracy: 92,
      errorType: "MissingBreak",
      breakError: "unexpected",
    });
    expect(marks.breakMark).toBe("unexpected");
  });
});

describe("wordMarks —— D. monotone 分档", () => {
  test.each([
    [0, 0],
    [0.01, 1],
    [MONOTONE_LIGHT, 1],
    [MONOTONE_LIGHT + 0.01, 2],
    [MONOTONE_HEAVY, 2],
    [MONOTONE_HEAVY + 0.01, 3],
    [1, 3],
  ])("强度 %f → 第 %i 档", (intensity, level) => {
    const marks = wordMarks({ word: "x", accuracy: 92, errorType: "None", monotone: intensity });
    expect(marks.monotone.level).toBe(level);
    expect(marks.monotone.intensity).toBe(intensity);
  });

  test("原始强度原样带出来，供将来做趋势用", () => {
    expect(
      wordMarks({ word: "x", accuracy: 92, errorType: "None", monotone: 0.42 }).monotone.intensity,
    ).toBe(0.42);
  });
});

describe("wordMarks —— E. 缺席不编数值", () => {
  test("errorType 是 Monotone 但没有强度 → 最轻一档，intensity 为 null", () => {
    // 编一个 0.5 出来，用户看到的是我们没测过的信息。
    const marks = wordMarks({ word: "x", accuracy: 92, errorType: "Monotone" });
    expect(marks.monotone).toEqual({ level: 1, intensity: null });
  });

  test("既没有强度也不是 Monotone → 不标", () => {
    expect(wordMarks({ word: "x", accuracy: 92, errorType: "None" }).monotone).toEqual({
      level: 0,
      intensity: null,
    });
  });

  test.each([
    ["不是对象", 42],
    ["是 null", null],
    ["是数组", []],
  ])("入参 %s 时降级，不抛", (_name, bad) => {
    const marks = wordMarks(bad);
    expect(marks.base).toBe("ok");
    expect(marks.monotone.level).toBe(0);
    expect(marks.breakMark).toBeNull();
  });

  test("monotone 是字符串时当成缺席，不当成 0", () => {
    expect(
      wordMarks({ word: "x", accuracy: 92, errorType: "None", monotone: "0.8" }).monotone.intensity,
    ).toBeNull();
  });
});

describe("phonemeRows —— F. 弹出层的数据", () => {
  const w = {
    word: "think",
    accuracy: 41,
    errorType: "Mispronunciation",
    phonemes: [
      { phoneme: "th", accuracy: 22 },
      { phoneme: "ih", accuracy: 88 },
      { phoneme: "ng", accuracy: 95 },
      { phoneme: "k", accuracy: 71 },
    ],
  };

  test("每个音素一行，顺序不变", () => {
    expect(phonemeRows(w).map((r) => r.phoneme)).toEqual(["th", "ih", "ng", "k"]);
  });

  test("只给分档，不给原始百分数（0019）", () => {
    const rows = phonemeRows(w);
    expect(rows[0]?.band).toBe("要重练");
    expect(rows[1]?.band).toBe("很好");
  });

  test("低于切点的音素被标成 weak —— 那是该练的那几个", () => {
    expect(phonemeRows(w).map((r) => r.weak)).toEqual([true, false, false, false]);
  });

  test("原始分数仍然带出来，供调试与将来的趋势用", () => {
    expect(phonemeRows(w)[0]?.accuracy).toBe(22);
  });

  test("没有 phonemes → 空数组，不抛", () => {
    expect(phonemeRows({ word: "x" })).toEqual([]);
    expect(phonemeRows(null)).toEqual([]);
  });

  test("形状不对的项被跳过，不产生一行空的", () => {
    const rows = phonemeRows({ phonemes: [{ phoneme: "th", accuracy: 22 }, null, { accuracy: 9 }] });
    expect(rows.length).toBe(1);
  });

  test("分数缺席时 band 为 null，不当成 0", () => {
    const rows = phonemeRows({ phonemes: [{ phoneme: "th" }] });
    expect(rows[0]?.accuracy).toBeNull();
    expect(rows[0]?.band).toBeNull();
    expect(rows[0]?.weak).toBe(false);
  });
});
