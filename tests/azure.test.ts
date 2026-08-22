import { describe, test, expect } from "vitest";
import { AzureTtsProvider, AZURE_WAV_FORMATS } from "@/providers/tts/azure";
import type { AzureWavFormat } from "@/providers/tts/azure";
import { TtsError } from "@/core/tts/errors";
import { buildWav } from "@/core/audio/wav";
import { synthesize } from "@/core/tts/synthesize";
import { MemoryAudioStore } from "@/storage/audio-store";
import { fakeFetch } from "./helpers/fake-fetch";

/**
 * 整份测试不发一个真实网络请求，却覆盖了 Azure provider 的全部路径。
 * 靠的是把 fetch 作为构造参数注入——这是「接口是为了可测」最直接的一次兑现。
 *
 * 分类：
 *   A. 构造期校验（配置错要立刻炸）
 *   B. 请求构造（URL / 头 / body 必须符合文档）
 *   C. 成功响应
 *   D. HTTP 错误 → 错误分类（文档列出的每个状态码）
 *   E. 网络层异常
 *   F. 响应体异常
 *   G. 与 synthesize() 编排层的集成
 */

const config = { key: "test-key", region: "eastus" };
const make = (fetch: ReturnType<typeof fakeFetch>, extra = {}) =>
  new AzureTtsProvider({ ...config, ...extra, fetch });

const req = { text: "Hello world.", voice: "en-US-AvaNeural" };

describe("AzureTtsProvider", () => {
  describe("A. 构造期校验", () => {
    test("缺 key 抛 auth", () => {
      expect(() => new AzureTtsProvider({ key: "", region: "eastus" })).toThrow(TtsError);
      expect(() => new AzureTtsProvider({ key: "", region: "eastus" })).toThrow(/key/);
    });

    test("key 只有空白也算缺", () => {
      expect(() => new AzureTtsProvider({ key: "   ", region: "eastus" })).toThrow(/key/);
    });

    test("缺 region 抛 auth", () => {
      expect(() => new AzureTtsProvider({ key: "k", region: "" })).toThrow(/region/);
    });

    test("不支持的输出格式抛 rejected", () => {
      expect(
        () =>
          new AzureTtsProvider({
            ...config,
            outputFormat: "audio-24khz-48kbitrate-mono-mp3" as AzureWavFormat,
          }),
      ).toThrow(/输出格式/);
    });

    test("配置错误在构造时暴露，不是等到第一次合成", () => {
      // 否则用户填错 key 后要等到点了播放才知道
      let thrown: unknown = null;
      try {
        new AzureTtsProvider({ key: "", region: "eastus" });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as TtsError).kind).toBe("auth");
    });

    test("engine 固定为 azure", () => {
      expect(make(fakeFetch({})).engine).toBe("azure");
    });

    test("model 反映输出格式（换格式音频不同，必须换缓存键）", () => {
      const a = make(fakeFetch({}), { outputFormat: "riff-24khz-16bit-mono-pcm" });
      const b = make(fakeFetch({}), { outputFormat: "riff-48khz-16bit-mono-pcm" });

      expect(a.model).not.toBe(b.model);
    });
  });

  describe("B. 请求构造", () => {
    test("URL 按 region 拼接", async () => {
      const fetch = fakeFetch({});
      await make(fetch, { region: "westus2" }).synthesize(req);

      expect(fetch.requests[0]?.url).toBe(
        "https://westus2.tts.speech.microsoft.com/cognitiveservices/v1",
      );
    });

    test("region 大小写与空白被归一化", async () => {
      const fetch = fakeFetch({});
      await make(fetch, { region: "  EastUS  " }).synthesize(req);

      expect(fetch.requests[0]?.url).toContain("https://eastus.tts");
    });

    test("四个必需请求头都在（文档要求）", async () => {
      const fetch = fakeFetch({});
      await make(fetch).synthesize(req);

      const headers = fetch.requests[0]!.headers;
      expect(headers["Ocp-Apim-Subscription-Key"]).toBe("test-key");
      expect(headers["Content-Type"]).toBe("application/ssml+xml");
      expect(headers["X-Microsoft-OutputFormat"]).toBe("riff-24khz-16bit-mono-pcm");
      expect(headers["User-Agent"]).toBeTruthy();
    });

    test("方法是 POST", async () => {
      const fetch = fakeFetch({});
      await make(fetch).synthesize(req);

      expect(fetch.requests[0]?.method).toBe("POST");
    });

    test("body 是 SSML 且带上音色", async () => {
      const fetch = fakeFetch({});
      await make(fetch).synthesize(req);

      const body = fetch.requests[0]!.body;
      expect(body).toContain("<speak");
      expect(body).toContain('name="en-US-AvaNeural"');
      expect(body).toContain("Hello world.");
    });

    test("语速进入 SSML", async () => {
      const fetch = fakeFetch({});
      await make(fetch).synthesize({ ...req, speed: 0.8 });

      expect(fetch.requests[0]?.body).toContain('rate="0.8"');
    });

    test("文本中的特殊字符被转义后送出", async () => {
      const fetch = fakeFetch({});
      await make(fetch).synthesize({ ...req, text: 'Tom & Jerry\'s "<show>"' });

      const body = fetch.requests[0]!.body;
      expect(body).toContain("&amp;");
      expect(body).not.toContain("<show>");
    });

    test("key 只出现在请求头里，不进 URL", async () => {
      const fetch = fakeFetch({});
      await make(fetch).synthesize(req);

      // key 进 URL 会被日志和代理记录下来
      expect(fetch.requests[0]?.url).not.toContain("test-key");
    });
  });

  describe("C. 成功响应", () => {
    test("返回音频字节与格式", async () => {
      const wav = buildWav({ samples: 100 });
      const result = await make(fakeFetch({ audio: wav })).synthesize(req);

      expect(result.format).toBe("wav");
      expect(result.audio.byteLength).toBe(wav.byteLength);
      expect(Array.from(result.audio.slice(0, 4))).toEqual(Array.from(wav.slice(0, 4)));
    });

    test("采样率与输出格式一致", async () => {
      for (const [format, rate] of Object.entries(AZURE_WAV_FORMATS)) {
        const result = await make(fakeFetch({}), {
          outputFormat: format as AzureWavFormat,
        }).synthesize(req);

        expect(result.sampleRate).toBe(rate);
      }
    });

    test("2xx 全部视为成功", async () => {
      const result = await make(fakeFetch({ status: 202 })).synthesize(req);

      expect(result.audio.byteLength).toBeGreaterThan(0);
    });
  });

  describe("D. HTTP 错误 → 分类", () => {
    // 文档《Text to speech API reference (REST)》列出的全部状态码
    const CASES: Array<[status: number, kind: string, retryable: boolean]> = [
      [400, "rejected", false],
      [401, "auth", false],
      [403, "auth", false],
      [415, "rejected", false],
      [429, "quota", false],
      [502, "network", true],
      [503, "network", true],
    ];

    for (const [status, kind, retryable] of CASES) {
      test(`${status} → ${kind}（${retryable ? "可重试" : "不可重试"}）`, async () => {
        const provider = make(fakeFetch({ status, text: "server said no" }));

        await expect(provider.synthesize(req)).rejects.toMatchObject({ kind, retryable });
      });
    }

    test("错误信息里带上状态码和服务端文案", async () => {
      const provider = make(fakeFetch({ status: 401, text: "Access denied due to invalid key" }));

      await expect(provider.synthesize(req)).rejects.toThrow(/401/);
      await expect(provider.synthesize(req)).rejects.toThrow(/invalid key/);
    });

    test("超长错误体被截断，不污染日志", async () => {
      const provider = make(fakeFetch({ status: 400, text: "x".repeat(5000) }));

      await provider.synthesize(req).catch((err: TtsError) => {
        expect(err.message.length).toBeLessThan(500);
      });
      expect.assertions(1);
    });
  });

  describe("E. 网络层异常", () => {
    test("fetch 抛错归为 network 且可重试", async () => {
      const provider = make(
        fakeFetch(() => {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        }),
      );

      await expect(provider.synthesize(req)).rejects.toMatchObject({
        kind: "network",
        retryable: true,
      });
    });

    test("网络错误信息里保留原因", async () => {
      const provider = make(
        fakeFetch(() => {
          throw new Error("fetch failed");
        }),
      );

      await expect(provider.synthesize(req)).rejects.toThrow(/fetch failed/);
    });
  });

  describe("F. 响应体异常", () => {
    test("200 但响应体为空 → empty", async () => {
      const provider = make(fakeFetch({ audio: new Uint8Array(0) }));

      await expect(provider.synthesize(req)).rejects.toMatchObject({ kind: "empty" });
    });

    test("empty 不可重试（重试大概率还是空）", async () => {
      const provider = make(fakeFetch({ audio: new Uint8Array(0) }));

      await provider.synthesize(req).catch((err: TtsError) => {
        expect(err.retryable).toBe(false);
      });
      expect.assertions(1);
    });

    test("错误体读取失败不影响错误分类", async () => {
      const provider = make(fakeFetch({ status: 429, bodyThrows: true }));

      await expect(provider.synthesize(req)).rejects.toMatchObject({ kind: "quota" });
    });
  });

  describe("G. 与编排层集成", () => {
    const deps = (fetch: ReturnType<typeof fakeFetch>) => ({
      provider: make(fetch),
      store: new MemoryAudioStore(),
    });

    test("走完整链路：合成并落盘", async () => {
      const fetch = fakeFetch({ audio: buildWav({ samples: 100 }) });
      const d = deps(fetch);

      const result = await synthesize(req, d);

      expect(result.cached).toBe(false);
      expect(result.bytes).toBeGreaterThan(0);
      expect(fetch.requests).toHaveLength(1);
    });

    test("第二次命中缓存，不再请求 Azure", async () => {
      const fetch = fakeFetch({ audio: buildWav({ samples: 100 }) });
      const d = deps(fetch);

      await synthesize(req, d);
      const second = await synthesize(req, d);

      expect(second.cached).toBe(true);
      // 这条断言守住的是真金白银
      expect(fetch.requests).toHaveLength(1);
    });

    test("超长文本在本地就被拦下，一个请求都不发", async () => {
      const fetch = fakeFetch({});
      const d = { provider: make(fetch, { maxChars: 50 }), store: new MemoryAudioStore() };

      await expect(
        synthesize({ ...req, text: "a".repeat(51) }, d),
      ).rejects.toMatchObject({ kind: "too_long" });
      expect(fetch.requests).toHaveLength(0);
    });

    test("空文本在本地就被拦下", async () => {
      const fetch = fakeFetch({});
      const d = deps(fetch);

      await expect(synthesize({ ...req, text: "   " }, d)).rejects.toMatchObject({
        kind: "rejected",
      });
      expect(fetch.requests).toHaveLength(0);
    });

    test("Azure 报错时不写入存储", async () => {
      const fetch = fakeFetch({ status: 401, text: "denied" });
      const store = new MemoryAudioStore();

      await expect(synthesize(req, { provider: make(fetch), store })).rejects.toThrow();
      expect(store.size).toBe(0);
    });
  });
});
