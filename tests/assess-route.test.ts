import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { postAssess, postTts, type JsonResult, type ServerDeps } from "@/http/server";
import { MAX_PCM_BYTES, MAX_AUDIO_BYTES, RECORDING_SAMPLE_RATE } from "@/http/contract";
import { MAX_ASSESSABLE_SECONDS } from "@/core/audio/wav";
import type { ScoringProvider } from "@/providers/scoring/types";
import { FileAudioStore } from "@/storage/file-audio-store";
import { FakeTtsProvider } from "./helpers/fake-provider";
import {
  FakeScoringProvider,
  scores,
  noiseScores,
  err,
} from "./helpers/fake-scoring-provider";
import { dbfsToInt16 } from "@/core/audio/trim-silence";

/**
 * 输入空间分类（判据一，见 docs/decisions.md 0006）
 *
 *   A. 正常路径 —— 采样进去，分数出来，逐词明细在
 *   B. 请求体校验 —— 空、长度不是 4 的倍数、超上限
 *   C. 静音处理 —— 全静音走 no_speech，首尾静音被掐掉
 *   D. 三种走向透传 —— scored / unreliable / no_speech
 *   E. 错误映射 —— 每种分类到 HTTP 状态码
 *   F. 未配置评分 —— 503，其余功能照常
 *   G. 跨层约束 —— PCM 上限与 WAV 上限的关系（判据五）
 *
 * 为什么这些类是穷尽的：这个路由是一条直管——
 * 收字节（B）→ 转格式 → 掐静音（C）→ 编码 → 调编排层（D、E）→ 回 JSON。
 * 每一环的逻辑本身都在 core/ 里测过了，这里测的是**接缝**：
 * 字节怎么进来、结果怎么出去、错误怎么翻译。
 *
 * 判据五在这里最要紧：浏览器发的是 Float32（每采样 4 字节），
 * 服务端编出的是 Int16 WAV（每采样 2 字节）。两个上限差一倍多，
 * 靠人记得同步的话迟早出事——上次 64KB 那个 bug 就是这个形状。
 *
 * ## M2.5：驱动方式换了，断言一条没换
 *
 * 此前靠 `createApp(deps)` 起一个真端口加真实 `fetch`；现在直接
 * `await postAssess({ query, body }, deps)`。`post()` 这个助手仍然回
 * `{ status, body }`，所以**每条用例的正文一个字没改**。
 *
 * 常量的 import 也从 `@/http/server` 挪到了 `@/http/contract`——
 * server.ts 只是把它们转出来的，而 M3 之后 server.ts 不在了。
 */

const REFERENCE = "The quick brown fox jumps over the lazy dog.";

/** 造一段 Float32 语音信号（正弦波）。 */
function speech(seconds: number, amplitude = 0.25): Float32Array {
  const n = Math.round(seconds * RECORDING_SAMPLE_RATE);
  return Float32Array.from({ length: n }, (_, i) => amplitude * Math.sin(i / 4));
}

/**
 * 造一段真实基频的正弦波。
 *
 * `speech()` 用的 `sin(i / 4)` 周期约 25 个采样，换算下来是 637 Hz——
 * 超出 `extractPitch` 的 `maxHz`（500），曲线会全是 null。
 * 断言音高需要一段落在人声频段的信号，所以另起一个。
 */
function tone(hz: number, seconds: number, amplitude = 0.25): Float32Array {
  const n = Math.round(seconds * RECORDING_SAMPLE_RATE);
  return Float32Array.from(
    { length: n },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / RECORDING_SAMPLE_RATE),
  );
}

/** 静音 + 语音 + 静音。 */
function withSilence(leadSec: number, speechSec: number, tailSec: number): Float32Array {
  const out = new Float32Array(
    Math.round((leadSec + speechSec + tailSec) * RECORDING_SAMPLE_RATE),
  );
  const start = Math.round(leadSec * RECORDING_SAMPLE_RATE);
  const body = speech(speechSec);
  out.set(body, start);
  return out;
}

/**
 * 起两个服务器，各起一次。
 *
 * 第一版是每个用例重启服务器来换 provider，结果用例之间互相干扰——
 * server.close() 要等 keep-alive 连接释放，单独跑通过、连起来跑就挂。
 * 改成一次性起好、用一个可替换的代理换实现，干扰就消失了。
 */
let deps: ServerDeps;
/** 没配置评分的那一套，用来测 503 与「其余功能照常」。 */
let bareDeps: ServerDeps;

/** 当前生效的假 provider。换实现只改这个引用，不动服务器。 */
let current: FakeScoringProvider;

/** 代理：把调用转给 current，所以换实现不需要重启。 */
const proxy: ScoringProvider = {
  engine: "fake",
  maxSeconds: 30,
  maxReferenceChars: 900,
  assess: (request) => current.assess(request),
};

/** 换一个假实现。不重启服务器，所以用例之间不会互相干扰。 */
function use(options: ConstructorParameters<typeof FakeScoringProvider>[0]): FakeScoringProvider {
  current = new FakeScoringProvider(options);
  return current;
}

async function post(
  pcm: Float32Array | Uint8Array,
  reference = REFERENCE,
  at?: ServerDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bytes = pcm instanceof Float32Array ? Buffer.from(pcm.buffer) : Buffer.from(pcm);
  const result = (await postAssess(
    { query: { reference }, body: bytes },
    at ?? deps,
  )) as JsonResult;
  return { status: result.status, body: result.body as Record<string, unknown> };
}

describe("POST /api/assess", () => {
  beforeAll(async () => {
    use({ results: [scores()] });
    const shared: ServerDeps = {
      provider: new FakeTtsProvider({ maxChars: 1000 }),
      store: new FileAudioStore("/tmp/inkling-test-audio"),
      defaultVoice: "en-US-AvaNeural",
    };
    deps = Object.assign({}, shared, { scoring: proxy });
    bareDeps = shared;
  });

  afterAll(async () => {
    // 没有服务器要关了 —— M2.5 之后这些用例不占端口。
  });

  beforeEach(() => {
    use({ results: [scores()] });
  });

  describe("A. 正常路径", () => {
    test("采样进去，三项分数出来", async () => {
      const { status, body } = await post(speech(2));
      expect(status).toBe(200);
      expect(body["outcome"]).toBe("scored");
      expect(body["scores"]).toMatchObject({ prosody: 91, accuracy: 96, fluency: 100 });
    });

    test("逐词明细透传到底 —— 这是相对参考实现的差异化", async () => {
      const { body } = await post(speech(2));
      const words = body["words"] as Array<Record<string, unknown>>;
      expect(words[0]?.["monotone"]).toBe(0.31);
      expect(words[0]?.["phonemes"]).toBeInstanceOf(Array);
    });

    test("回报修剪后的时长与信噪比", async () => {
      // 单位进字段名（契约 [C28] [C41]）：assessedMs 取代了原来的 seconds。
      // 原来一个响应里并存三种时间单位而文档只规定了其中一种，是歧义的温床。
      const { body } = await post(speech(2));
      expect(body["assessedMs"] as number).toBeCloseTo(2000, -2);
      expect(body["snr"]).toBe(38.7);
    });

    test("参考文本原样交给评分层", async () => {
      const provider = use({ results: [scores()] });
      await post(speech(1), "Custom reference here.");
      expect(provider.calls[0]?.reference).toBe("Custom reference here.");
    });
  });

  /* ---- A2. 音高曲线（M1.5 契约扩展）---- */

  describe("A2. 音高曲线", () => {
    test("响应带 pitch，形状是 { hz, hopMs }", async () => {
      const { body } = await post(tone(220, 2));
      const pitch = body["pitch"] as { hz: unknown; hopMs: unknown };
      expect(pitch).toBeDefined();
      expect(Array.isArray(pitch.hz)).toBe(true);
      expect(pitch.hopMs).toBe(20);
    });

    test("曲线的值就是那段音的基频", async () => {
      const { body } = await post(tone(220, 2));
      const hz = (body["pitch"] as { hz: (number | null)[] }).hz;
      const nums = hz.filter((v): v is number => v !== null).sort((a, b) => a - b);
      expect(nums.length).toBeGreaterThan(0);
      expect(nums[Math.floor(nums.length / 2)] as number).toBeGreaterThan(215);
      expect(nums[Math.floor(nums.length / 2)] as number).toBeLessThan(225);
    });

    test("曲线算在修剪后的那一段上，不是原始采样", async () => {
      // 前面 1 秒静音会被掐掉。曲线若算在原始采样上，开头会多出
      // 约 50 帧 null，和波形图差一整秒——而没有任何东西会报错。
      const withLead = new Float32Array(3 * RECORDING_SAMPLE_RATE);
      withLead.set(tone(220, 2), RECORDING_SAMPLE_RATE);
      const { body } = await post(withLead);
      const hz = (body["pitch"] as { hz: (number | null)[] }).hz;
      const assessedMs = body["assessedMs"] as number;
      // 帧数应当对得上 assessedMs，而不是对上原始的 3000ms。
      expect(hz.length).toBeCloseTo(assessedMs / 20, -1);
      expect(hz.length).toBeLessThan(3000 / 20);
    });

    test("全静音走 no_speech 时没有 pitch 字段——不发 null（[C43]）", async () => {
      const { body } = await post(new Float32Array(2 * RECORDING_SAMPLE_RATE));
      expect(body["outcome"]).toBe("no_speech");
      expect("pitch" in body).toBe(false);
    });

    test("算不出曲线也不能让评分失败", async () => {
      // 短到只剩几个采样的一段声音：修剪后不足一个 40ms 窗口，
      // 曲线是空数组，但分数照给。
      const { status, body } = await post(tone(220, 0.12));
      expect(status).toBe(200);
      expect(body["outcome"]).toBe("scored");
    });
  });

  describe("B. 请求体校验", () => {
    test("空请求体被拒", async () => {
      const { status, body } = await post(new Uint8Array(0));
      expect(status).toBe(400);
      expect(body["error"]).toBe("rejected");
    });

    test.each([[1], [2], [3], [5], [7]])(
      "长度 %i 字节不是 4 的倍数 → 拒绝（上传被截断了）",
      async (n) => {
        // 按 4 取整会让最后一个采样是垃圾数据，而且不报错。
        const { status, body } = await post(new Uint8Array(n));
        expect(status).toBe(400);
        expect(String(body["message"])).toMatch(/4 的倍数/);
      },
    );

    test("超过上传上限 → 413", async () => {
      const tooBig = new Uint8Array(MAX_PCM_BYTES + 4);
      const { status, body } = await post(tooBig);
      expect(status).toBe(413);
      expect(body["error"]).toBe("too_long");
    });
  });

  describe("C. 静音处理", () => {
    test("全是静音 → no_speech，且不调用评分服务", async () => {
      const provider = use({ results: [scores()] });

      const { status, body } = await post(new Float32Array(RECORDING_SAMPLE_RATE));
      expect(status).toBe(200);
      expect(body["outcome"]).toBe("no_speech");
      // 一段静音没必要花钱去评。
      expect(provider.calls).toHaveLength(0);
    });

    test("首尾静音被掐掉，时长明显缩短", async () => {
      // 用户点「录音」到开口总有一两秒空白，这段静音会拉低流利度分数，
      // 而它和发音水平毫无关系。
      const { body } = await post(withSilence(1.5, 1, 1.5));
      expect(body["assessedMs"] as number).toBeLessThan(1500);

      // trimmedStartMs / trimmedEndMs 取代了原来按采样数计的 trimmed.start/end。
      expect(body["trimmedStartMs"] as number).toBeGreaterThan(0);
      expect(body["trimmedEndMs"] as number).toBeGreaterThan(0);
    });

    test("低于阈值的底噪也算静音", async () => {
      const quiet = dbfsToInt16(-70) / 32768;
      const pcm = withSilence(1, 1, 0);
      for (let i = 0; i < RECORDING_SAMPLE_RATE; i++) pcm[i] = quiet * Math.sin(i / 4);

      const { body } = await post(pcm);
      expect(body["trimmedStartMs"] as number).toBeGreaterThan(0);
    });
  });

  describe("D. 三种走向透传", () => {
    test("unreliable 也回 200，并带上结果", async () => {
      // 结果仍然带回来，界面要显示「听起来像环境噪声」并附上信噪比。
      const provider = use({ results: [noiseScores()] });

      const { status, body } = await post(speech(2));
      expect(status).toBe(200);
      expect(body["outcome"]).toBe("unreliable");
      expect(body["scores"]).toBeTruthy();
    });

    test("评分层说没识别到语音 → no_speech", async () => {
      const provider = use({ results: [null] });

      const { status, body } = await post(speech(2));
      expect(status).toBe(200);
      expect(body["outcome"]).toBe("no_speech");
    });
  });

  describe("E. 错误映射", () => {
    test.each([
      ["auth", 500],
      ["quota", 503],
      ["rejected", 400],
      ["too_long", 413],
    ] as const)("%s → HTTP %i", async (kind, status) => {
      const provider = use({ results: [err(kind)] });

      const result = await post(speech(1));
      expect(result.status).toBe(status);
      expect(result.body["error"]).toBe(kind);
    });
  });

  describe("F. 未配置评分", () => {
    // 用的是另一套 deps，没有 scoring provider。

    test("没有评分 provider → 503，且说清楚该去配什么", async () => {
      const { status, body } = await post(speech(1), "hi", bareDeps);

      expect(status).toBe(503);
      expect(String(body["message"])).toMatch(/\.env\.local/);
    });

    test("评分没配时 TTS 路由照常可用 —— 一个功能缺失不该拖垮别的", async () => {
      const result = await postTts(
        { raw: JSON.stringify({ text: "Hello.", voice: "en-US-AvaNeural" }) },
        bareDeps,
      );
      expect(result.status).toBe(200);
    });
  });
});

// 判据五（decisions 0026）：跨层约束要有整条链的断言，让数字自己对账。
// 上一次失守的形态是 MAX_BODY_BYTES = 64KB 而 30 秒音频是 960KB。
describe("G. 跨层约束对账", () => {
  test("30 秒 Float32 采样能过上传上限", () => {
    // 浏览器发的是 Float32，每采样 4 字节。
    const bytes = MAX_ASSESSABLE_SECONDS * RECORDING_SAMPLE_RATE * 4;
    expect(bytes).toBeLessThan(MAX_PCM_BYTES);
  });

  test("上传上限至少是 WAV 上限的两倍 —— Float32 比 Int16 大一倍", () => {
    expect(MAX_PCM_BYTES).toBeGreaterThanOrEqual(MAX_AUDIO_BYTES * 2);
  });

  test("上传上限内的采样，编成 WAV 后一定过得了 WAV 上限", () => {
    // Float32 → Int16 体积减半，所以这条恒成立。写出来是为了让
    // 有人哪天改动其中一个数字时，这里会告诉他后果。
    expect(MAX_PCM_BYTES / 2).toBeLessThanOrEqual(MAX_AUDIO_BYTES + 44);
  });

  test("录音采样率就是评分接口要的采样率", () => {
    // 这里的 16000 **不是**服务端常量的副本，它代表的是 Azure 发音评估
    // 唯一接受的采样率——一个我们改不了的外部约束。所以这条断言是
    // 「我们的值 == 外部要求」，不是「自己等于自己」，不要当成冗余删掉。
    //
    // 它守的方向是服务端。客户端那一侧由 tests/contract-consistency.test.ts
    // 守着，两条互不替代。
    expect(RECORDING_SAMPLE_RATE).toBe(16000);
  });
});
