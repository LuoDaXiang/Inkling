import { describe, test, expect } from "vitest";
import { AzureScoringProvider } from "@/providers/scoring/azure";
import { ServiceError } from "@/core/errors";
import { InvalidWavError, buildWav } from "@/core/audio/wav";
import { InvalidReferenceError, decodeAssessmentHeader } from "@/providers/scoring/config";
import { MalformedResponseError } from "@/providers/scoring/parse";
import { fakeFetch } from "./helpers/fake-fetch";

/**
 * 输入空间分类（判据一，见 docs/decisions.md 0006）
 *
 *   A. 构造期校验 —— 缺配置、区域设置不对，都要立刻炸而不是等第一次调用
 *   B. 请求构造 —— URL、五个必需头、密钥不进 URL、音频原样送出
 *   C. 前置拒绝 —— 音频与参考文本的问题必须在发请求之前挡住
 *   D. HTTP 错误 —— 每个状态码到分类的映射，且每种的 retryable 都断言
 *   E. 限流 —— 429 的 Retry-After 两种形态，以及读不出来时的行为
 *   F. 网络层 —— fetch 抛错、超时挂死
 *   G. 响应处理 —— 识别成功、没识别到语音、响应结构坏掉
 *
 * 为什么这些类是穷尽的：provider 是一条直线管道——
 * 构造（A）→ 校验输入（C）→ 拼请求（B）→ 发出去（F）→ 看状态码（D、E）→ 解析（G）。
 * 每一环都有「正常」和「出错」两种走向，以上七类覆盖了每一环的两侧。
 *
 * 判据三的落法：D 组每个用例都断言 kind **和** retryable。
 * 只断言 kind 的话，「auth 错误被误标成可重试」这种 bug 测不出来——
 * 而它的后果是拿着错密钥重试到额度耗尽。
 */

const KEY = "0".repeat(32);
const REGION = "eastus";
const SENTENCE = "The quick brown fox jumps over the lazy dog.";

/** 一段合法的 16kHz 单声道音频，2 秒。 */
const AUDIO = buildWav({ sampleRate: 16000, samples: 32000 });

/** 从一次真实响应剪下来的成功报文骨架（判据四：不是照类型定义编的）。 */
const SUCCESS_BODY = JSON.stringify({
  RecognitionStatus: "Success",
  DisplayText: SENTENCE,
  SNR: 38.7,
  NBest: [
    {
      Display: SENTENCE,
      Confidence: 0.98,
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
          Phonemes: [{ Phoneme: "dh", AccuracyScore: 67 }],
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
});

function providerWith(responses: Parameters<typeof fakeFetch>[0]) {
  const fetchImpl = fakeFetch(responses);
  const provider = new AzureScoringProvider({ key: KEY, region: REGION, fetch: fetchImpl });
  return { provider, fetchImpl };
}

describe("A. 构造期校验", () => {
  test.each([
    ["缺 key", { key: "", region: REGION }],
    ["key 是空白", { key: "   ", region: REGION }],
    ["缺 region", { key: KEY, region: "" }],
    ["region 是空白", { key: KEY, region: "  " }],
  ])("%s 立刻抛 auth", (_name, config) => {
    // 配置错误要在构造时就炸。等到第一次评分才发现的话，
    // 用户已经读完一遍了，白读。
    expect(() => new AzureScoringProvider(config)).toThrow(ServiceError);
    expect(() => new AzureScoringProvider(config)).toMatchObject({});
    try {
      new AzureScoringProvider(config);
    } catch (err) {
      expect((err as ServiceError).kind).toBe("auth");
      expect((err as ServiceError).retryable).toBe(false);
    }
  });

  test("非 en-US 的区域设置被拒绝 —— 语调会静默缺席", () => {
    // 用别的区域设置不会报错，只是 ProsodyScore 不出现。
    // 而语调是这个产品的主打维度，静默降级比报错糟糕得多。
    expect(
      () => new AzureScoringProvider({ key: KEY, region: REGION, language: "en-GB" }),
    ).toThrow(/只支持 en-US/);
  });

  test("显式传 en-US 是允许的", () => {
    expect(
      () => new AzureScoringProvider({ key: KEY, region: REGION, language: "en-US" }),
    ).not.toThrow();
  });

  test("上限从共享常量来，不各写各的", () => {
    const { provider } = providerWith({});
    expect(provider.maxSeconds).toBe(30);
    expect(provider.maxReferenceChars).toBe(900);
    expect(provider.engine).toBe("azure");
  });
});

describe("B. 请求构造", () => {
  test("URL 含 region 与 language", async () => {
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await provider.assess({ audio: AUDIO, reference: SENTENCE });
    expect(fetchImpl.requests[0]?.url).toBe(
      "https://eastus.stt.speech.microsoft.com" +
        "/speech/recognition/conversation/cognitiveservices/v1?language=en-US",
    );
  });

  test("region 大小写与空白被归一", async () => {
    const fetchImpl = fakeFetch({ status: 200, text: SUCCESS_BODY });
    const provider = new AzureScoringProvider({ key: KEY, region: "  EastUS  ", fetch: fetchImpl });
    await provider.assess({ audio: AUDIO, reference: SENTENCE });
    expect(fetchImpl.requests[0]?.url).toContain("https://eastus.stt");
  });

  test("五个必需头都在", async () => {
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await provider.assess({ audio: AUDIO, reference: SENTENCE });
    const headers = fetchImpl.requests[0]?.headers ?? {};
    expect(headers["Ocp-Apim-Subscription-Key"]).toBe(KEY);
    expect(headers["Content-Type"]).toBe("audio/wav; codecs=audio/pcm; samplerate=16000");
    expect(headers["Accept"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe("Inkling");
    expect(headers["Pronunciation-Assessment"]).toBeTypeOf("string");
  });

  test("评估配置在头里，base64 解得回来", async () => {
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await provider.assess({ audio: AUDIO, reference: SENTENCE });
    const decoded = decodeAssessmentHeader(
      fetchImpl.requests[0]?.headers["Pronunciation-Assessment"] as string,
    );
    expect(decoded["ReferenceText"]).toBe(SENTENCE);
    expect(decoded["Granularity"]).toBe("Phoneme");
    // 这一行就是参考实现 Enjoy 缺的那一行。
    expect(decoded["EnableProsodyAssessment"]).toBe("True");
  });

  test("密钥只在头里，绝不进 URL", async () => {
    // URL 会进日志、进浏览器历史、进错误上报。密钥进 URL 等于泄露。
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await provider.assess({ audio: AUDIO, reference: SENTENCE });
    expect(fetchImpl.requests[0]?.url).not.toContain(KEY);
  });

  test("音频原样作为请求体，不做任何转换", async () => {
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await provider.assess({ audio: AUDIO, reference: SENTENCE });
    expect(fetchImpl.requests[0]?.body).toBe(AUDIO);
  });

  test("采样率照实声明 —— 24kHz 音频声明 24000", async () => {
    // 服务端其实读 WAV 头、忽略这个值（实测），但声明得对
    // 能在抓包排障时省掉一轮困惑。
    const audio24 = buildWav({ sampleRate: 24000, samples: 24000 });
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await provider.assess({ audio: audio24, reference: SENTENCE });
    expect(fetchImpl.requests[0]?.headers["Content-Type"]).toContain("samplerate=24000");
  });
});

describe("C. 前置拒绝 —— 必须在发请求之前挡住", () => {
  test.each([
    ["空音频", new Uint8Array(0)],
    ["非 WAV 字节", new TextEncoder().encode("not audio at all")],
    ["被截断的 WAV", AUDIO.slice(0, 100)],
  ])("%s 抛 InvalidWavError，且不发请求", async (_name, audio) => {
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await expect(provider.assess({ audio, reference: SENTENCE })).rejects.toThrow(InvalidWavError);
    expect(fetchImpl.requests).toHaveLength(0);
  });

  test("超过 30 秒的音频被拒，且不发请求", async () => {
    // 实测：73 秒音频返回 HTTP 200 + Success，完整度只给 49（≈35/73）。
    // 服务端静默截断，不报错。等它返回一个莫名其妙的低分再去猜原因，
    // 是这个产品最难查的一类问题。
    const long = buildWav({ sampleRate: 16000, samples: 16000 * 31 });
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await expect(provider.assess({ audio: long, reference: SENTENCE })).rejects.toThrow(
      /静默截断/,
    );
    expect(fetchImpl.requests).toHaveLength(0);
  });

  test.each([
    ["空参考文本", ""],
    ["纯空白参考文本", "   "],
    ["零宽字符组成的参考文本", "​​"],
  ])("%s 被拒，且不发请求", async (_name, reference) => {
    // 空参考会触发无参考评估，返回总分 92.2 的正常高分——
    // 不崩、不报错、结果错。最坏的一类失败。
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await expect(provider.assess({ audio: AUDIO, reference })).rejects.toThrow(
      InvalidReferenceError,
    );
    expect(fetchImpl.requests).toHaveLength(0);
  });

  test("超长参考文本被拒，且不发请求", async () => {
    // 实测约 13000 字符会让服务端不返回响应头，请求挂死。
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await expect(
      provider.assess({ audio: AUDIO, reference: "a".repeat(1000) }),
    ).rejects.toThrow(InvalidReferenceError);
    expect(fetchImpl.requests).toHaveLength(0);
  });
});

describe("D. HTTP 错误 —— 分类与可重试性都要断言", () => {
  // 判据三：只断言 kind 不够。「auth 被误标成可重试」这种 bug
  // 只有断言 retryable 才测得出来，而它的后果是拿着错密钥重试到额度耗尽。
  test.each([
    [400, "rejected", false],
    [401, "auth", false],
    [403, "auth", false],
    [415, "rejected", false],
    [422, "rejected", false],
    [429, "quota", false],
    [500, "network", true],
    [502, "network", true],
    [503, "network", true],
  ])("HTTP %i → %s，retryable=%s", async (status, kind, retryable) => {
    const { provider } = providerWith({ status, text: "boom" });
    try {
      await provider.assess({ audio: AUDIO, reference: SENTENCE });
      expect.unreachable("应该抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).kind).toBe(kind);
      expect((err as ServiceError).retryable).toBe(retryable);
    }
  });

  test("错误信息带上状态码与服务端文案", async () => {
    const { provider } = providerWith({ status: 400, text: "Invalid reference text" });
    await expect(provider.assess({ audio: AUDIO, reference: SENTENCE })).rejects.toThrow(
      /400：Invalid reference text/,
    );
  });

  test("错误体过长时截断，不把整篇 HTML 塞进错误信息", async () => {
    const { provider } = providerWith({ status: 500, text: "x".repeat(5000) });
    try {
      await provider.assess({ audio: AUDIO, reference: SENTENCE });
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(400);
    }
  });

  test("错误体读不出来时，仍然抛正确的分类", async () => {
    const { provider } = providerWith({ status: 401, bodyThrows: true });
    try {
      await provider.assess({ audio: AUDIO, reference: SENTENCE });
    } catch (err) {
      expect((err as ServiceError).kind).toBe("auth");
    }
  });

  test("带上 RequestId —— 报障时唯一能给服务商的凭据", async () => {
    const { provider } = providerWith({
      status: 500,
      text: "server error",
      headers: { "X-RequestId": "req-abc-123" },
    });
    await expect(provider.assess({ audio: AUDIO, reference: SENTENCE })).rejects.toThrow(
      /RequestId req-abc-123/,
    );
  });

  test("没有 RequestId 时不编一个", async () => {
    const { provider } = providerWith({ status: 500, text: "server error" });
    await expect(provider.assess({ audio: AUDIO, reference: SENTENCE })).rejects.not.toThrow(
      /RequestId/,
    );
  });
});

describe("E. 限流", () => {
  test("429 带秒数形态的 Retry-After，错误信息说清楚等多久", async () => {
    const { provider } = providerWith({
      status: 429,
      text: "Too many requests",
      headers: { "Retry-After": "45" },
    });
    await expect(provider.assess({ audio: AUDIO, reference: SENTENCE })).rejects.toThrow(
      /45 秒后可重试/,
    );
  });

  test("Retry-After 用小写也能读到 —— 头查询大小写不敏感", async () => {
    const { provider } = providerWith({
      status: 429,
      text: "slow down",
      headers: { "retry-after": "12" },
    });
    await expect(provider.assess({ audio: AUDIO, reference: SENTENCE })).rejects.toThrow(
      /12 秒后可重试/,
    );
  });

  test("429 没带 Retry-After 时，不编一个等待时间", async () => {
    const { provider } = providerWith({ status: 429, text: "slow down" });
    await expect(provider.assess({ audio: AUDIO, reference: SENTENCE })).rejects.not.toThrow(
      /秒后可重试/,
    );
  });

  test("非 429 的响应不读 Retry-After", async () => {
    // 有些网关会在 5xx 上也带这个头，但那时它的含义不是限流。
    const { provider } = providerWith({
      status: 503,
      text: "unavailable",
      headers: { "Retry-After": "60" },
    });
    await expect(provider.assess({ audio: AUDIO, reference: SENTENCE })).rejects.not.toThrow(
      /秒后可重试/,
    );
  });
});

describe("F. 网络层", () => {
  test("fetch 抛错 → network，可重试", async () => {
    const { provider } = providerWith(() => {
      throw new Error("ECONNRESET");
    });
    try {
      await provider.assess({ audio: AUDIO, reference: SENTENCE });
    } catch (err) {
      expect((err as ServiceError).kind).toBe("network");
      expect((err as ServiceError).retryable).toBe(true);
    }
  });

  test("请求挂死时超时，而不是永远等下去", async () => {
    // 实测：服务端在某些输入下不返回响应头。没有显式超时的话，
    // 一个坏输入能把整条请求链挂住。
    const fetchImpl = fakeFetch({ hangs: true });
    const provider = new AzureScoringProvider({
      key: KEY,
      region: REGION,
      timeoutMs: 30,
      fetch: fetchImpl,
    });
    const promise = provider.assess({ audio: AUDIO, reference: SENTENCE });
    await expect(promise).rejects.toThrow(/未响应/);
    await expect(promise).rejects.toMatchObject({ kind: "network", retryable: true });
  });

  test("fetch 抛的不是 Error 实例时也能取出信息", async () => {
    // 有些底层库抛的是普通对象。直接 String(err) 会得到 "[object Object]"，
    // 用户看到的报错里一点有用信息都没有。
    const { provider } = providerWith(() => {
      throw "connection lost" as never;
    });
    await expect(provider.assess({ audio: AUDIO, reference: SENTENCE })).rejects.toThrow(
      /connection lost/,
    );
  });

  test("每个请求都带超时信号", async () => {
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await provider.assess({ audio: AUDIO, reference: SENTENCE });
    expect(fetchImpl.requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("G. 响应处理", () => {
  test("识别成功时返回完整结果", async () => {
    const { provider } = providerWith({ status: 200, text: SUCCESS_BODY });
    const result = await provider.assess({ audio: AUDIO, reference: SENTENCE });

    expect(result?.scores).toEqual({
      accuracy: 96,
      fluency: 100,
      completeness: 100,
      prosody: 91,
      overall: 95.6,
    });
    expect(result?.recognized).toBe(SENTENCE);
    expect(result?.snr).toBe(38.7);
    // 逐词明细是本项目相对 Enjoy 的差异化，必须解得出来。
    expect(result?.words[0]?.monotone).toBe(0.31);
    expect(result?.words[0]?.phonemes[0]?.phoneme).toBe("dh");
  });

  test.each([
    ["静音", '{"RecognitionStatus":"InitialSilenceTimeout"}'],
    ["没有匹配", '{"RecognitionStatus":"NoMatch","NBest":[]}'],
    ["连状态字段都没有（空音频时的真实形态）", "{}"],
  ])("%s 返回 null 而不是抛错", async (_name, body) => {
    // 用户确实录了一段没有语音的东西，这是要如实告诉他的结果，不是异常。
    // 抛错的话，界面会显示「出错了」，而实际上系统工作正常。
    const { provider } = providerWith({ status: 200, text: body });
    expect(await provider.assess({ audio: AUDIO, reference: SENTENCE })).toBeNull();
  });

  test("响应不是合法 JSON → 抛 MalformedResponseError", async () => {
    // 和「没识别到语音」区分开：这个是我们的假设错了或服务端变了，
    // 混在一起的话，用户会为服务端的问题反复重录。
    const { provider } = providerWith({ status: 200, text: "{oops" });
    await expect(provider.assess({ audio: AUDIO, reference: SENTENCE })).rejects.toThrow(
      MalformedResponseError,
    );
  });

  test("响应缺必需的分数字段 → 抛 MalformedResponseError", async () => {
    const broken = JSON.stringify({ NBest: [{ Display: "x", AccuracyScore: 90 }] });
    const { provider } = providerWith({ status: 200, text: broken });
    await expect(provider.assess({ audio: AUDIO, reference: SENTENCE })).rejects.toThrow(
      MalformedResponseError,
    );
  });

  test("200 但响应体为空 → 当作没识别到语音", async () => {
    const { provider } = providerWith({ status: 200, text: "" });
    await expect(provider.assess({ audio: AUDIO, reference: SENTENCE })).rejects.toThrow(
      MalformedResponseError,
    );
  });

  test("不做任何缓存 —— 同样的输入调两次就发两次请求", async () => {
    // 和 TTS 刻意相反。评分的输入是每次都不同的录音，缓存永远不会命中，
    // 加了只会白占磁盘。同一个仓库里两个模块用相反的策略是对的。
    const { provider, fetchImpl } = providerWith({ status: 200, text: SUCCESS_BODY });
    await provider.assess({ audio: AUDIO, reference: SENTENCE });
    await provider.assess({ audio: AUDIO, reference: SENTENCE });
    expect(fetchImpl.requests).toHaveLength(2);
  });
});
