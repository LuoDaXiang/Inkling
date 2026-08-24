import { describe, test, expect } from "vitest";
import { assess, RETRY, type AssessOutcome } from "@/core/scoring/assess";
import { ServiceError } from "@/core/errors";
import {
  FakeScoringProvider,
  scores,
  noiseScores,
  err,
} from "./helpers/fake-scoring-provider";

/**
 * 输入空间分类（判据一，见 docs/decisions.md 0006）
 *
 *   A. 三种走向 —— scored / unreliable / no_speech，调用方必须全处理
 *   B. 可信度判断 —— 边界在哪，「读得差」和「不是在读」怎么分开
 *   C. 重试 —— 可重试与不可重试的分岔、次数、退避时长、中途成功
 *   D. 透传 —— 请求原样交给 provider，不做任何加工
 *   E. 与 TTS 的差异 —— 不缓存
 *
 * 为什么这些类是穷尽的：编排层只做四件事——**调 provider**（D）、
 * **把结果分成三类**（A、B）、**决定要不要重试**（C）、**不缓存**（E）。
 * 它自己不校验输入（那是 provider 的职责，C 组有用例守住这个边界）。
 *
 * 判据三的落法：C 组按 retryable 分组，每种错误分类都断言了
 * 「重试几次」——只断言「抛错」的话，「auth 被重试到额度耗尽」测不出来。
 */

const REQUEST = { audio: new Uint8Array([1, 2, 3]), reference: "The quick brown fox." };

/** 跳过真实等待，同时记录每次退避了多久。 */
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe("A. 三种走向", () => {
  test("正常评分 → scored", async () => {
    const provider = new FakeScoringProvider({ results: [scores()] });
    const outcome = await assess(REQUEST, { provider });

    expect(outcome.kind).toBe("scored");
    if (outcome.kind !== "scored") return;
    expect(outcome.result.scores.prosody).toBe(91);
    // 逐词明细必须透传到底——它是本项目相对 Enjoy 的差异化。
    expect(outcome.result.words[0]?.monotone).toBe(0.31);
  });

  test("没识别到语音 → no_speech，不是错误", async () => {
    // 用户确实录了一段没有语音的东西，这是要如实告诉他的结果。
    // 抛错的话界面会显示「出错了」，而实际上系统工作正常。
    const provider = new FakeScoringProvider({ results: [null] });
    const outcome = await assess(REQUEST, { provider });
    expect(outcome.kind).toBe("no_speech");
  });

  test("识别到了但不可信 → unreliable，并保留结果", async () => {
    // 结果仍然带回来，因为界面可能要显示「听起来像是环境噪声」
    // 并附上信噪比。丢掉结果的话这个提示就没素材了。
    const provider = new FakeScoringProvider({ results: [noiseScores()] });
    const outcome = await assess(REQUEST, { provider });

    expect(outcome.kind).toBe("unreliable");
    if (outcome.kind !== "unreliable") return;
    expect(outcome.result.scores.accuracy).toBe(71);
    expect(outcome.result.snr).toBe(38.7);
  });

  test("三种走向覆盖了所有可能 —— 穷尽性由类型保证", () => {
    // 这条用例的价值在于：将来加第四种走向时，这里会编译失败，
    // 提醒所有调用方都要跟着改。
    const exhaustive = (outcome: AssessOutcome): string => {
      switch (outcome.kind) {
        case "scored":
          return "有分数";
        case "unreliable":
          return "不可信";
        case "no_speech":
          return "没听到";
      }
    };
    expect(exhaustive({ kind: "no_speech" })).toBe("没听到");
  });
});

describe("B. 可信度判断 —— 单个维度不能单独信", () => {
  test("纯白噪声判为不可信，尽管准确度有 71 分", async () => {
    // 实测数据：3 秒白噪声 → 准确度 71、流利度 13、总分 32.7。
    // 只看准确度会把一段噪声当成「读得还行」呈现给用户。
    const provider = new FakeScoringProvider({ results: [noiseScores()] });
    expect((await assess(REQUEST, { provider })).kind).toBe("unreliable");
  });

  test("读得差但确实在读 → scored，不能被当成噪声丢掉", async () => {
    // 效度测量里专家给 3 分的样本：Azure 总分 40.8、语调 27.1。
    // 这类用户最需要反馈，判成 unreliable 等于把最该帮的人拒之门外。
    const provider = new FakeScoringProvider({
      results: [scores({ accuracy: 46, fluency: 32, prosody: 27.1, overall: 40.8 })],
    });
    expect((await assess(REQUEST, { provider })).kind).toBe("scored");
  });

  test.each([
    ["流利度刚好在线上", { fluency: 20, overall: 20 }, "scored"],
    ["流利度差一点", { fluency: 19, overall: 20 }, "unreliable"],
    ["总分差一点", { fluency: 20, overall: 19 }, "unreliable"],
    ["两项都是 0", { fluency: 0, overall: 0 }, "unreliable"],
  ])("%s → %s", async (_name, overrides, expected) => {
    const provider = new FakeScoringProvider({ results: [scores(overrides)] });
    expect((await assess(REQUEST, { provider })).kind).toBe(expected);
  });
});

describe("C. 重试", () => {
  describe("可重试的失败", () => {
    test("network 失败会重试，默认最多三次请求", async () => {
      // 评分失败意味着那一遍朗读白读了，用户得重新录。
      // 所以这里值得自动重试，而 synthesize() 不需要——
      // TTS 失败用户再点一次按钮就行，代价只是等待。
      const provider = new FakeScoringProvider({ results: [err("network")] });
      const { sleep, waits } = fakeSleep();

      await expect(assess(REQUEST, { provider, sleep })).rejects.toThrow(ServiceError);
      expect(provider.calls).toHaveLength(3);
      expect(waits).toEqual([500, 1000]);
    });

    test("中途成功就不再重试", async () => {
      const provider = new FakeScoringProvider({
        results: [err("network"), scores()],
      });
      const { sleep, waits } = fakeSleep();

      const outcome = await assess(REQUEST, { provider, sleep });
      expect(outcome.kind).toBe("scored");
      expect(provider.calls).toHaveLength(2);
      expect(waits).toEqual([500]);
    });

    test("退避是指数增长的", async () => {
      const provider = new FakeScoringProvider({ results: [err("network")] });
      const { sleep, waits } = fakeSleep();

      await expect(assess(REQUEST, { provider, sleep, maxRetries: 4 })).rejects.toThrow();
      expect(waits).toEqual([500, 1000, 2000, 4000]);
    });

    test("最后一次失败后不再等待，直接抛出", async () => {
      // 等完再抛是纯浪费——用户已经在等了，而我们已经决定放弃。
      const provider = new FakeScoringProvider({ results: [err("network")] });
      const { sleep, waits } = fakeSleep();

      await expect(assess(REQUEST, { provider, sleep, maxRetries: 1 })).rejects.toThrow();
      expect(provider.calls).toHaveLength(2);
      expect(waits).toHaveLength(1);
    });

    test("maxRetries 为 0 时只请求一次", async () => {
      const provider = new FakeScoringProvider({ results: [err("network")] });
      const { sleep, waits } = fakeSleep();

      await expect(assess(REQUEST, { provider, sleep, maxRetries: 0 })).rejects.toThrow();
      expect(provider.calls).toHaveLength(1);
      expect(waits).toHaveLength(0);
    });
  });

  describe("不可重试的失败 —— 只请求一次", () => {
    // 判据三：只断言「抛错」不够，必须断言「请求了几次」。
    // 前者测不出「auth 被重试到额度耗尽」这种 bug。
    test.each([["auth"], ["quota"], ["rejected"], ["too_long"], ["empty"], ["unknown"]] as const)(
      "%s 立刻抛出，不重试",
      async (kind) => {
        const provider = new FakeScoringProvider({ results: [err(kind)] });
        const { sleep, waits } = fakeSleep();

        await expect(assess(REQUEST, { provider, sleep })).rejects.toMatchObject({ kind });
        expect(provider.calls).toHaveLength(1);
        expect(waits).toHaveLength(0);
      },
    );

    test("provider 的输入校验错误不重试 —— 输入不会因为再试就变合格", async () => {
      // 编排层不自己校验输入，那是 provider 的职责。这条守住的是边界：
      // 校验失败原样抛出，不会被重试逻辑吞掉或放大。
      const boom = new ServiceError("rejected", "参考文本为空");
      const provider = new FakeScoringProvider({ results: [boom] });
      const { sleep } = fakeSleep();

      await expect(assess(REQUEST, { provider, sleep })).rejects.toThrow(/参考文本为空/);
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe("非 ServiceError 的异常", () => {
    test("带 code 的 Node 错误被归类后处理", async () => {
      // 真实的 Node 网络错误把 errno 放在 code 属性里，不在 message 里。
      // 第一版这里写的是 new Error("ECONNRESET")，测试挂了——
      // classify 认的是 code 字段，不是文案。测试样本自己造错了，
      // 实现是对的。这正是判据四说的：样本要照着真实形态造。
      const boom = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      const provider = new FakeScoringProvider({ results: [boom] });
      const { sleep } = fakeSleep();

      await expect(assess(REQUEST, { provider, sleep })).rejects.toMatchObject({
        kind: "network",
      });
      expect(provider.calls).toHaveLength(3);
    });

    test("文案里含网络关键词的错误也能被认出来", async () => {
      // 三线索的第三条：有些 SDK 只给一句话，没有 code 也没有 status。
      const provider = new FakeScoringProvider({ results: [new Error("fetch failed")] });
      const { sleep } = fakeSleep();

      await expect(assess(REQUEST, { provider, sleep })).rejects.toMatchObject({
        kind: "network",
      });
      expect(provider.calls).toHaveLength(3);
    });

    test("认不出来的错误归入 unknown，不重试", async () => {
      // unknown 不重试，因为不知道重试是否安全。
      const provider = new FakeScoringProvider({ results: [new Error("???")] });
      const { sleep } = fakeSleep();

      await expect(assess(REQUEST, { provider, sleep })).rejects.toMatchObject({
        kind: "unknown",
      });
      expect(provider.calls).toHaveLength(1);
    });

    test("错误信息带上 engine，方便定位是哪个服务失败的", async () => {
      const provider = new FakeScoringProvider({ results: [new Error("???")] });
      const { sleep } = fakeSleep();
      await expect(assess(REQUEST, { provider, sleep })).rejects.toThrow(/fake 评分失败/);
    });
  });

  test("不注入 sleep 时用真实等待 —— 覆盖默认实现", async () => {
    // 平时测试都注入假 sleep 跳过等待，这条专门走默认那条路，
    // 用最小的重试次数和一次退避，实际只等 500ms。
    const provider = new FakeScoringProvider({ results: [err("network"), scores()] });
    const started = Date.now();

    const outcome = await assess(REQUEST, { provider, maxRetries: 1 });

    expect(outcome.kind).toBe("scored");
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  test("重试参数是共享常量，测试与实现不各写各的", () => {
    expect(RETRY).toEqual({ baseMs: 500, defaultMaxRetries: 2 });
  });
});

describe("D. 透传", () => {
  test("请求原样交给 provider，编排层不加工", async () => {
    const provider = new FakeScoringProvider({ results: [scores()] });
    await assess(REQUEST, { provider });

    expect(provider.calls[0]?.audio).toBe(REQUEST.audio);
    expect(provider.calls[0]?.reference).toBe(REQUEST.reference);
  });

  test("重试时送的是同一份输入，不会被改动", async () => {
    const provider = new FakeScoringProvider({ results: [err("network"), scores()] });
    const { sleep } = fakeSleep();
    await assess(REQUEST, { provider, sleep });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]).toEqual(provider.calls[1]);
  });
});

describe("E. 与 TTS 的差异：不缓存", () => {
  test("同样的输入调两次，provider 被调两次", async () => {
    // TTS 的前提是「同样的文本必然产出同样的音频」，所以缓存省钱；
    // 评分的输入是每次都不同的录音，缓存永远不会命中。
    // 同一个仓库里两个模块用相反的策略是对的，这条用例守住它。
    const provider = new FakeScoringProvider({ results: [scores()] });

    await assess(REQUEST, { provider });
    await assess(REQUEST, { provider });

    expect(provider.calls).toHaveLength(2);
  });
});
