import { describe, test, expect, beforeAll } from "vitest";
import { AzureTtsProvider } from "@/providers/tts/azure";
import { parseWav } from "@/core/audio/wav";

/**
 * 发音评估的第一次真实调用。M02 的探针。
 *
 *   npm run test:live
 *
 * 要回答三个问题，回答不了就不该往下走：
 *
 *   1. prosody（语调）能不能拿到？
 *      参考实现 Enjoy 拿不到——它从没调用 enableProsodyAssessment
 *      （构造函数第四个参数是 enableMiscue，不是 prosody），
 *      却照样往数据库里存 prosodyScore，那一列永远是空的。
 *      语调是本项目三个维度里最想要的一个，拿不到就得换服务商。
 *
 *   2. REST 接口的形状对不对？端点路径此前没有核实过。
 *
 *   3. 自己 TTS 出的 16kHz WAV，评分接口收不收？
 *      收，就说明 M03 录音对齐同一格式即可，不需要重采样层。
 *
 * 素材用 TTS 合成，所以不需要麦克风、不需要人来录。
 * 人声的效度对比是另一件事，见 docs/roadmap.md 的 M02。
 *
 * 注意响应结构：REST 的原始报文比 SDK 扁一层——各项分数直接挂在
 * NBest[0] 上，不在 PronunciationAssessment 子对象里。抄 SDK 的
 * 字段路径会全部取到 undefined。
 */

const KEY = process.env["AZURE_SPEECH_KEY"];
const REGION = process.env["AZURE_SPEECH_REGION"];

const ready = Boolean(KEY && REGION);
const describeIf = ready ? describe : describe.skip;

/** 13 词，约 4 秒。和 TTS live 测试用同一句，方便对照。 */
const SENTENCE = "The quick brown fox jumps over the lazy dog while the cat watches.";

interface Word {
  Word: string;
  AccuracyScore: number;
  ErrorType: string;
  Syllables?: Array<{ Syllable: string; AccuracyScore: number }>;
  Phonemes?: Array<{ Phoneme: string; AccuracyScore: number }>;
  Feedback?: {
    Prosody?: {
      Break?: { ErrorTypes: string[]; BreakLength: number };
      Intonation?: {
        ErrorTypes: string[];
        /** 单调检测：读得平的时候 Confidence 会升高。 */
        Monotone?: { Confidence: number };
      };
    };
  };
}

interface Best {
  Display: string;
  Confidence: number;
  AccuracyScore: number;
  FluencyScore: number;
  ProsodyScore?: number;
  CompletenessScore: number;
  PronScore: number;
  Words: Word[];
}

interface AssessmentResponse {
  RecognitionStatus: string;
  DisplayText?: string;
  /** 信噪比。将来可以用它提示「你的麦克风太吵」。 */
  SNR?: number;
  NBest?: Best[];
}

const ENDPOINT =
  `https://${REGION}.stt.speech.microsoft.com` +
  `/speech/recognition/conversation/cognitiveservices/v1?language=en-US`;

/**
 * 直接打 REST，不引 SDK。
 *
 * Enjoy 用官方 SDK，代价是评估逻辑绑在浏览器端，且错误被包成
 * CancellationDetails 还要再翻译一层。我们已有一套认 HTTP 状态码的
 * 错误分类器，走 REST 能直接复用。同理见 docs/decisions.md 0010。
 */
async function assess(audio: Uint8Array, reference: string, key = KEY as string) {
  const config = {
    ReferenceText: reference,
    GradingSystem: "HundredMark",
    Granularity: "Phoneme",
    Dimension: "Comprehensive",
    // 这一行就是 Enjoy 缺的那一行。
    EnableProsodyAssessment: "True",
  };

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
      "Pronunciation-Assessment": Buffer.from(JSON.stringify(config)).toString("base64"),
      Accept: "application/json",
    },
    body: Buffer.from(audio),
  });

  const text = await response.text();
  return { status: response.status, body: text };
}

async function scoresOf(audio: Uint8Array, reference: string): Promise<Best> {
  const { status, body } = await assess(audio, reference);
  if (status !== 200) throw new Error(`Azure 返回 ${status}：${body.slice(0, 300)}`);
  const parsed = JSON.parse(body) as AssessmentResponse;
  const best = parsed.NBest?.[0];
  if (!best) throw new Error(`没有 NBest：${body.slice(0, 200)}`);
  return best;
}

describeIf("Azure 发音评估 live", () => {
  let audio: Uint8Array;
  /** 同一段素材复用，避免每个用例都重新合成、重复花钱。 */
  let matched: Best;

  beforeAll(async () => {
    const tts = new AzureTtsProvider({
      key: KEY as string,
      region: REGION as string,
      outputFormat: "riff-16khz-16bit-mono-pcm",
    });
    audio = (await tts.synthesize({ text: SENTENCE, voice: "en-US-AvaNeural" })).audio;

    // 先确认素材本身合格，否则后面所有结论都不可信。
    const info = parseWav(audio);
    expect(info.sampleRate).toBe(16000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);

    matched = await scoresOf(audio, SENTENCE);
  });

  test("REST 端点可用，识别成功", () => {
    expect(matched.Display).toContain("quick brown fox");
  });

  test("五项分数都在 0–100 内", () => {
    const all = {
      accuracy: matched.AccuracyScore,
      fluency: matched.FluencyScore,
      completeness: matched.CompletenessScore,
      prosody: matched.ProsodyScore,
      pron: matched.PronScore,
    };
    console.log(
      `\n  准确度 ${all.accuracy}  流利度 ${all.fluency}  完整度 ${all.completeness}  ` +
        `语调 ${all.prosody}  总分 ${all.pron}\n`,
    );
    for (const [name, value] of Object.entries(all)) {
      expect(value, name).toBeTypeOf("number");
      expect(value as number, name).toBeGreaterThanOrEqual(0);
      expect(value as number, name).toBeLessThanOrEqual(100);
    }
  });

  test("ProsodyScore 真的返回了 —— Enjoy 缺的就是这一项", () => {
    // 这条断言是整个 M02 的核心。它失败就意味着要换服务商。
    expect(matched.ProsodyScore).toBeTypeOf("number");
    expect(matched.ProsodyScore as number).toBeGreaterThan(0);
  });

  test("逐词带音素、音节与错误类型", () => {
    expect(matched.Words.length).toBeGreaterThan(5);
    const first = matched.Words[0] as Word;
    expect(first.ErrorType).toBeTypeOf("string");
    // Granularity 设的是 Phoneme，音素明细必须有，否则将来做发音纠错没有素材。
    expect(first.Phonemes?.length).toBeGreaterThan(0);
    expect(first.Syllables?.length).toBeGreaterThan(0);
  });

  test("逐词带语调反馈，含单调检测", () => {
    // 这是比总分更有用的东西：它能指出「第几个词读平了」。
    // 一个 ProsodyScore 只告诉你「不太好」，Monotone 告诉你「哪里不好」。
    const withFeedback = matched.Words.filter((w) => w.Feedback?.Prosody);
    expect(withFeedback.length).toBeGreaterThan(0);

    const intonation = withFeedback[0]?.Feedback?.Prosody?.Intonation;
    expect(intonation?.Monotone?.Confidence).toBeTypeOf("number");
    expect(withFeedback[0]?.Feedback?.Prosody?.Break?.BreakLength).toBeTypeOf("number");
  });

  test("参考文本对不上时，分数应当断崖式下降", async () => {
    const mismatched = await scoresOf(
      audio,
      "Completely different sentence about something else entirely.",
    );
    console.log(
      `\n  对上 → 对不上：准确度 ${matched.AccuracyScore}→${mismatched.AccuracyScore}  ` +
        `流利度 ${matched.FluencyScore}→${mismatched.FluencyScore}  ` +
        `完整度 ${matched.CompletenessScore}→${mismatched.CompletenessScore}\n`,
    );
    // 分数得能区分开，否则它不是在评估，只是在返回一个好看的数字。
    expect(mismatched.CompletenessScore).toBeLessThan(matched.CompletenessScore);
    expect(mismatched.AccuracyScore).toBeLessThan(matched.AccuracyScore);
    expect(mismatched.PronScore).toBeLessThan(matched.PronScore);
  });

  test("密钥错误返回 401，能对上已有的错误分类", async () => {
    const { status } = await assess(audio, SENTENCE, "0".repeat(32));
    expect(status).toBe(401);
  });
});

describe("Azure 发音评估 live", () => {
  test.skip("未配置 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION，跳过", () => {});
});
