import { describe, test, expect } from "vitest";
import {
  CONTRACT_VERSION,
  ContractError,
  buildAssessQuery,
  canRecord,
  captureFlagsFrom,
  loadConfig,
  newClientRequestId,
} from "../../public/contract.js";

/**
 * 客户端契约层 —— 契约 §8 的七条承诺，测试清单 #30、#36–#39 的可测部分。
 *
 * ## 这一批测试为什么必须在客户端做
 *
 * §8 那七条**服务端一条都验不了**。它拿到的只是一串浮点数，无从判断
 * 采样率对不对；它拿到 `echoCancellation=false`，无从判断那是回读值
 * 还是客户端一厢情愿填的。违反的后果是时长算错、计费算错，**且不报错**。
 *
 * ## 边缘情况在这里，不在界面里
 *
 * 界面是草稿，会重画。但「版本不匹配要停」「缺席不能当成 false」
 * 「id 不能做形状假设」这些由契约决定，重画多少次都不变。
 */

/** 一份合法的 config。各用例在它上面改。 */
const validConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  contractVersion: CONTRACT_VERSION,
  recordingSampleRate: 16000,
  maxRecordingSeconds: 30,
  maxUploadBytes: 2097152,
  maxReferenceChars: 900,
  maxTitleChars: 200,
  maxSentencesPerMaterial: 500,
  scoringAvailable: true,
  ...overrides,
});

/** 假 fetch：返回给定的响应。 */
const fetchReturning = (
  body: unknown,
  init: { ok?: boolean; status?: number; malformed?: boolean } = {},
) => {
  const ok = init.ok ?? true;
  return async (): Promise<Response> =>
    ({
      ok,
      status: init.status ?? (ok ? 200 : 500),
      json: async () => {
        if (init.malformed) throw new SyntaxError("bad json");
        return body;
      },
    }) as unknown as Response;
};

describe("#30 loadConfig 与版本校验 [C3][C4]", () => {
  test("正常拿到配置", async () => {
    const config = await loadConfig({ fetch: fetchReturning(validConfig()) });
    expect(config.recordingSampleRate).toBe(16000);
    expect(config.scoringAvailable).toBe(true);
  });

  test("版本不匹配 → 抛 ContractError，且消息说得清怎么办 [C4]", async () => {
    // 「客户端与服务端同版本发布」这个假设一旦不成立，必须**明确报错并停止**，
    // 不能继续以诡异的方式工作——那正是这个字段存在的全部理由。
    const call = loadConfig({ fetch: fetchReturning(validConfig({ contractVersion: "v1" })) });
    await expect(call).rejects.toThrow(ContractError);
    await expect(call).rejects.toThrow(/契约版本不匹配/);
  });

  test("contractVersion 缺席也算不匹配", async () => {
    const broken = validConfig();
    delete broken["contractVersion"];
    await expect(loadConfig({ fetch: fetchReturning(broken) })).rejects.toThrow(ContractError);
  });

  test("对多出来的字段宽容——加字段不是破坏性变更 [§15]", async () => {
    // 严格校验会让服务端加一个字段就打死所有老客户端。
    const config = await loadConfig({
      fetch: fetchReturning(validConfig({ futureFeature: true, anotherOne: "x" })),
    });
    expect(config.recordingSampleRate).toBe(16000);
  });

  test("少一个必填数值 → 抛，且指名是哪个", async () => {
    for (const missing of [
      "recordingSampleRate",
      "maxRecordingSeconds",
      "maxUploadBytes",
      "maxReferenceChars",
      "maxTitleChars",
      "maxSentencesPerMaterial",
    ]) {
      const broken = validConfig();
      delete broken[missing];
      await expect(
        loadConfig({ fetch: fetchReturning(broken) }),
        missing,
      ).rejects.toThrow(new RegExp(missing));
    }
  });

  test("数值不是正整数 → 抛", async () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, "16000", null]) {
      await expect(
        loadConfig({ fetch: fetchReturning(validConfig({ recordingSampleRate: bad })) }),
        String(bad),
      ).rejects.toThrow(ContractError);
    }
  });

  test("scoringAvailable 不是布尔 → 抛", async () => {
    for (const bad of ["true", 1, null, undefined]) {
      await expect(
        loadConfig({ fetch: fetchReturning(validConfig({ scoringAvailable: bad })) }),
        String(bad),
      ).rejects.toThrow(ContractError);
    }
  });

  test("HTTP 不是 200 → 抛，且不是 ContractError", async () => {
    // 网络/服务端故障不是契约违反，两者的处置不同：一个是刷新重试，
    // 一个是版本对不上必须重新部署。
    const call = loadConfig({ fetch: fetchReturning(null, { ok: false, status: 503 }) });
    await expect(call).rejects.toThrow(/HTTP 503/);
    await expect(call).rejects.not.toThrow(ContractError);
  });

  test("响应不是合法 JSON → ContractError", async () => {
    await expect(
      loadConfig({ fetch: fetchReturning(null, { malformed: true }) }),
    ).rejects.toThrow(ContractError);
  });

  test("响应是数组或 null → ContractError", async () => {
    for (const bad of [null, [], "text", 42]) {
      await expect(loadConfig({ fetch: fetchReturning(bad) }), String(bad)).rejects.toThrow(
        ContractError,
      );
    }
  });

  test("fetch 本身抛（断网）→ 报网络错误，不是契约错误", async () => {
    const call = loadConfig({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(call).rejects.toThrow(/取不到服务端配置/);
    await expect(call).rejects.not.toThrow(ContractError);
  });
});

describe("#31 canRecord [C5]", () => {
  test("scoringAvailable 决定能不能录", () => {
    // 评分没配的时候要在界面上直接禁用录音入口，
    // 而不是让用户录完 30 秒再吃一个 503。
    expect(canRecord(validConfig({ scoringAvailable: true }))).toBe(true);
    expect(canRecord(validConfig({ scoringAvailable: false }))).toBe(false);
  });

  test("配置缺席或畸形时保守地不给录", () => {
    for (const bad of [undefined, null, {}, { scoringAvailable: "true" }, { scoringAvailable: 1 }]) {
      expect(canRecord(bad), String(bad)).toBe(false);
    }
  });
});

describe("buildAssessQuery [C24][C27][C55]", () => {
  test("给 sentenceId", () => {
    expect(buildAssessQuery({ sentenceId: 88 }).get("sentenceId")).toBe("88");
  });

  test("给 reference", () => {
    expect(buildAssessQuery({ reference: "hello world" }).get("reference")).toBe("hello world");
  });

  test("两个都给 → 抛 [C24]", () => {
    // 服务端也会拒，但客户端不该发出去——那是一个本可以在本地发现的错误。
    expect(() => buildAssessQuery({ sentenceId: 1, reference: "x" })).toThrow(ContractError);
  });

  test("两个都不给 → 抛", () => {
    expect(() => buildAssessQuery({})).toThrow(ContractError);
    expect(() => buildAssessQuery(undefined as never)).toThrow(ContractError);
  });

  test("id 原样透传，不做形状校验 [C7][C55]", () => {
    // id 是**不透明标识符**。当前实现是自增整数，但形状将来可能变。
    // 在客户端写一个 /^\d+$/ 就是把「现在是整数」变成了一条约束，
    // 服务端换成 ULID 的那天，所有请求会被自己的客户端挡下来。
    expect(buildAssessQuery({ sentenceId: "01HQ3M2Y" }).get("sentenceId")).toBe("01HQ3M2Y");
    expect(buildAssessQuery({ sentenceId: 0 }).get("sentenceId")).toBe("0");
  });

  test("capture 缺席就不传，绝不传 false [C27]", () => {
    // NULL（不知道）和 false（确定没开）在库里是两个不同的事实。
    // 把「读不到」写成「没开」是在记录一个假的事实。
    const q = buildAssessQuery({ sentenceId: 1, capture: { echoCancellation: false } });
    expect(q.get("echoCancellation")).toBe("false");
    expect(q.has("noiseSuppression")).toBe(false);
    expect(q.has("autoGainControl")).toBe(false);
  });

  test("capture 全给", () => {
    const q = buildAssessQuery({
      sentenceId: 1,
      capture: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
    });
    expect(q.get("echoCancellation")).toBe("true");
    expect(q.get("noiseSuppression")).toBe("false");
    expect(q.get("autoGainControl")).toBe("true");
  });

  test("capture 里的非布尔值一律不传，不做强转", () => {
    const q = buildAssessQuery({
      sentenceId: 1,
      capture: { echoCancellation: 1, noiseSuppression: "true" } as never,
    });
    expect(q.has("echoCancellation")).toBe(false);
    expect(q.has("noiseSuppression")).toBe(false);
  });

  test("clientRequestId 给了就带，没给就不带", () => {
    const uuid = "0d5f8f5e-6c1e-4a5b-9a4e-2f7c1b3d4e5f";
    expect(buildAssessQuery({ sentenceId: 1, clientRequestId: uuid }).get("clientRequestId")).toBe(
      uuid,
    );
    expect(buildAssessQuery({ sentenceId: 1 }).has("clientRequestId")).toBe(false);
  });

  test("参考文本里的特殊字符被正确编码", () => {
    const tricky = "a&b=c?d #e";
    const q = buildAssessQuery({ reference: tricky });
    expect(q.get("reference")).toBe(tricky);
    expect(q.toString()).not.toContain(" ");
  });

  test("整串长度远在请求头上限之内 [C23]", () => {
    // reference 最长 900 字符（MAX_REFERENCE_CHARS 的设计依据本来就是
    // 8 KB 请求头上限）。这条把那个论证钉成可检查的。
    const q = buildAssessQuery({
      reference: "x".repeat(900),
      clientRequestId: "0d5f8f5e-6c1e-4a5b-9a4e-2f7c1b3d4e5f",
      capture: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    expect(q.toString().length).toBeLessThan(1536);
  });
});

describe("newClientRequestId [C48]", () => {
  test("是 UUID v4，服务端那条正则会认", () => {
    // 服务端严格校验格式（[C64]），不静默丢弃——一个残缺的 id 进流水
    // 比没有更糟。所以这两边必须对得上。
    const uuid = newClientRequestId();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("每次都不同", () => {
    const seen = new Set(Array.from({ length: 50 }, () => newClientRequestId()));
    expect(seen.size).toBe(50);
  });
});

describe("#37 captureFlagsFrom —— 必须是回读值 [C27][C51]", () => {
  const trackWith = (settings: unknown): unknown => ({ getSettings: () => settings });

  test("读到什么就是什么", () => {
    const flags = captureFlagsFrom(
      trackWith({ echoCancellation: false, noiseSuppression: true, autoGainControl: false }),
    );
    expect(flags).toEqual({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
    });
  });

  test("浏览器没给的键不出现——不知道不是 false", () => {
    // 这是整组里最要紧的一条。浏览器**可以无视** constraint，
    // 所以「我请求了关闭」和「它确实关了」是两回事。
    const flags = captureFlagsFrom(trackWith({ echoCancellation: true }));
    expect(flags).toEqual({ echoCancellation: true });
    expect("noiseSuppression" in flags).toBe(false);
  });

  test("非布尔值一律当成没读到，不强转", () => {
    const flags = captureFlagsFrom(
      trackWith({ echoCancellation: 1, noiseSuppression: "true", autoGainControl: null }),
    );
    // 强转会把一个猜测记录成事实，而这个事实将来要拿来解释分数差异。
    expect(flags).toEqual({});
  });

  test("getSettings 抛异常（轨道已结束）→ 返回空，不崩", () => {
    const flags = captureFlagsFrom({
      getSettings: () => {
        throw new Error("track ended");
      },
    });
    expect(flags).toEqual({});
  });

  test("轨道缺席或没有 getSettings → 返回空，不崩", () => {
    for (const bad of [undefined, null, {}, { getSettings: "nope" }, 42]) {
      expect(captureFlagsFrom(bad), String(bad)).toEqual({});
    }
  });

  test("getSettings 返回非对象 → 返回空", () => {
    for (const bad of [null, undefined, "x", 42]) {
      expect(captureFlagsFrom(trackWith(bad)), String(bad)).toEqual({});
    }
  });

  test("回读结果能直接喂给 buildAssessQuery", () => {
    // 这两个函数是一条链，接口对不上就白做了。
    const flags = captureFlagsFrom(trackWith({ echoCancellation: false }));
    const q = buildAssessQuery({ sentenceId: 1, capture: flags });
    expect(q.get("echoCancellation")).toBe("false");
    expect(q.has("autoGainControl")).toBe(false);
  });
});
