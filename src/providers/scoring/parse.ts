import type {
  AssessmentResult,
  AssessmentScores,
  Phoneme,
  WordErrorType,
  WordScore,
} from "./types";

/**
 * 把 Azure 发音评估的原始响应解析成本项目的结构。
 *
 * 这是纯函数，不碰网络——所以它能被穷尽地测试，而这一层恰恰是最需要
 * 被穷尽测试的：响应结构比 TTS 复杂得多，而且实测下来脾气很怪。
 *
 * 三个必须记住的事实（全部实测，见 docs/decisions.md 0020）：
 *
 *   1. **HTTP 一律 200，失败信息藏在 RecognitionStatus 里。**
 *      静音、极短音频、非音频字节全都返回 200 且没有 NBest。
 *      更麻烦的是：空音频时 RecognitionStatus **字段本身都不存在**。
 *      所以判断顺序必须是先看 NBest[0] 在不在，再谈状态。
 *
 *   2. **REST 的响应比 SDK 扁一层。** 五项分数直接挂在 NBest[0] 上，
 *      不在 PronunciationAssessment 子对象里。照 SDK 的字段路径取会
 *      全部拿到 undefined，而且不报错。
 *
 *   3. **ProsodyScore 会缺席。** 音频截断、参考无效时它直接不出现。
 */

/** 服务端可能返回的识别状态。列出来是为了让「未知状态」也有归属。 */
export type RecognitionStatus =
  | "Success"
  | "NoMatch"
  | "InitialSilenceTimeout"
  | "BabbleTimeout"
  | "Error";

const ERROR_TYPES: ReadonlySet<string> = new Set<WordErrorType>([
  "None",
  "Omission",
  "Insertion",
  "Mispronunciation",
  "UnexpectedBreak",
  "MissingBreak",
  "Monotone",
]);

export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedResponseError";
  }
}

/**
 * 解析响应体。
 *
 * 返回 null 表示**没有识别到语音**——静音、噪声、空音频都归这一类。
 * 这不是错误，是一条要如实告诉用户的结果。
 *
 * 只有响应本身结构坏掉（不是合法 JSON、NBest 里缺必需字段）才抛
 * MalformedResponseError。区分这两者很重要：前者要提示用户重录，
 * 后者说明服务端变了或者我们的假设错了，得报警。
 */
export function parseAssessment(body: string): AssessmentResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    throw new MalformedResponseError(`响应不是合法 JSON：${body.slice(0, 120)}`);
  }

  // 数组也满足 typeof === "object" 且不是 null，必须单独排除。
  // 漏掉这一条的后果不是崩溃，是**把畸形响应报成「你没说话」**——
  // 用户会以为自己录音有问题，而真正的问题在服务端或我们的假设上。
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MalformedResponseError(`响应不是对象：${body.slice(0, 120)}`);
  }

  const response = raw as {
    RecognitionStatus?: unknown;
    SNR?: unknown;
    NBest?: unknown;
  };

  // 先看 NBest，再看状态——因为空音频时 RecognitionStatus 字段根本不存在。
  const nbest = response.NBest;
  if (!Array.isArray(nbest) || nbest.length === 0) {
    return null;
  }

  const best = nbest[0] as Record<string, unknown>;
  if (typeof best !== "object" || best === null) {
    throw new MalformedResponseError("NBest[0] 不是对象");
  }

  const scores = parseScores(best);
  const words = parseWords(best["Words"]);
  const recognized = typeof best["Display"] === "string" ? best["Display"] : "";

  const result: AssessmentResult = { scores, words, recognized };
  if (typeof response.SNR === "number" && Number.isFinite(response.SNR)) {
    result.snr = response.SNR;
  }
  return result;
}

function parseScores(best: Record<string, unknown>): AssessmentScores {
  const scores: AssessmentScores = {
    accuracy: requireScore(best["AccuracyScore"], "AccuracyScore"),
    fluency: requireScore(best["FluencyScore"], "FluencyScore"),
    completeness: requireScore(best["CompletenessScore"], "CompletenessScore"),
    overall: requireScore(best["PronScore"], "PronScore"),
  };

  // 语调是唯一允许缺席的一项，所以单独处理，不能走 requireScore。
  const prosody = best["ProsodyScore"];
  if (typeof prosody === "number" && Number.isFinite(prosody)) {
    scores.prosody = clamp(prosody);
  }
  return scores;
}

/**
 * 分数必须是有限数字。
 *
 * 服务端目前不会返回 null 或字符串，但解析层是我们和外部世界的边界——
 * 边界上不做假设。真出现了要当场炸，而不是让 NaN 一路流进数据库，
 * 三个月后在趋势图上表现为一段莫名其妙的空白。
 */
function requireScore(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MalformedResponseError(`${field} 不是有限数字：${JSON.stringify(value)}`);
  }
  return clamp(value);
}

/** 服务端理论上只给 0–100，越界就说明它变了，夹住比让它污染统计好。 */
function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function parseWords(raw: unknown): WordScore[] {
  if (!Array.isArray(raw)) return [];

  const words: WordScore[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const w = item as Record<string, unknown>;

    const word = typeof w["Word"] === "string" ? w["Word"] : "";
    if (!word) continue;

    const score: WordScore = {
      word,
      accuracy:
        typeof w["AccuracyScore"] === "number" && Number.isFinite(w["AccuracyScore"])
          ? clamp(w["AccuracyScore"])
          : 0,
      errorType: parseErrorType(w["ErrorType"]),
      phonemes: parsePhonemes(w["Phonemes"]),
    };

    const feedback = asObject(w["Feedback"]);
    const prosody = asObject(feedback?.["Prosody"]);

    const monotone = asObject(asObject(prosody?.["Intonation"])?.["Monotone"])?.["Confidence"];
    if (typeof monotone === "number" && Number.isFinite(monotone)) {
      score.monotone = monotone;
    }

    const breakError = parseBreak(asObject(prosody?.["Break"]));
    if (breakError) score.breakError = breakError;

    words.push(score);
  }
  return words;
}

/** 未知的错误类型归到 None，而不是抛错——服务端加一个新类型不该让整次评分失败。 */
function parseErrorType(raw: unknown): WordErrorType {
  return typeof raw === "string" && ERROR_TYPES.has(raw) ? (raw as WordErrorType) : "None";
}

function parsePhonemes(raw: unknown): Phoneme[] {
  if (!Array.isArray(raw)) return [];
  const out: Phoneme[] = [];
  for (const item of raw) {
    const p = asObject(item);
    if (!p) continue;
    const phoneme = p["Phoneme"];
    if (typeof phoneme !== "string" || !phoneme) continue;
    out.push({
      phoneme,
      accuracy:
        typeof p["AccuracyScore"] === "number" && Number.isFinite(p["AccuracyScore"])
          ? clamp(p["AccuracyScore"])
          : 0,
    });
  }
  return out;
}

function parseBreak(raw: Record<string, unknown> | null): "unexpected" | "missing" | undefined {
  if (!raw) return undefined;
  const types = raw["ErrorTypes"];
  if (!Array.isArray(types)) return undefined;
  if (types.includes("UnexpectedBreak")) return "unexpected";
  if (types.includes("MissingBreak")) return "missing";
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 这段录音有没有意义。
 *
 * 单个维度不能单独信——实测纯白噪声的**准确度是 71 分**，比及格线还高，
 * 但流利度只有 13、语调 5.2、总分 32.7。只看准确度会把一段噪声当成
 * 「读得还行」呈现给用户。
 *
 * 所以要看组合。这个判断放在解析层而不是界面层，因为它是关于
 * 「数据可不可信」的事实判断，不是关于「怎么展示」的呈现选择。
 */
export function looksLikeSpeech(result: AssessmentResult): boolean {
  const { fluency, overall } = result.scores;
  return fluency >= 20 && overall >= 20;
}
