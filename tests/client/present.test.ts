import { describe, test, expect } from "vitest";
import { AUTO_RETRY_POST, band, interpretError, presentResult } from "../../public/present.js";

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
