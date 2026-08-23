import { normalize } from "@/core/text/normalize";
import { MAX_ASSESSABLE_SECONDS } from "@/core/audio/wav";

/**
 * 构造发音评估的 `Pronunciation-Assessment` 请求头。
 *
 * 这个头收的是一段 JSON 的 base64。和 SSML 那一层的位置相同——
 * 都是「把用户文本塞进一个有结构的载体」，所以同样是这一层负责挡脏东西。
 *
 * 但威胁模型不同，值得说清楚：
 *
 *   SSML  是 XML，用户文本里的 `<` `&` 会被当成标记执行，
 *         所以 ssml.ts 要转义五个字符、防 `</voice>` 劫持。
 *   这里  是 JSON + base64，`JSON.stringify` 已经处理了引号和反斜杠，
 *         base64 保证结果是纯 ASCII。**注入不是这一层的风险。**
 *
 * 这一层真正要挡的是两件实测出来的事，两件都不报错、都很难查：
 *
 *   1. **空参考文本会触发无参考评估**，返回准确度 90 / 流利度 100 /
 *      总分 92.2 的高分。用户看到一个完全正常的分数，而它毫无意义。
 *   2. **超长参考文本会让请求挂死**，服务端不返回响应头，
 *      客户端一直等到超时。不是 4xx，是没有响应。
 *
 * 见 docs/decisions.md 0020。
 */

export class InvalidReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReferenceError";
  }
}

/** 英语朗读的字符速度，约 2.5 词/秒、每词 6 字符。 */
export const CHARS_PER_SECOND = 15;

/** 留给标点、专有名词、语速偏慢的人的余量。 */
const HEADROOM = 2;

/**
 * 参考文本的字符上限，**从音频时长上限推出来**，不是拍一个数。
 *
 * 这样写是因为这两个数字必须联动：音频上限哪天改了，这里跟着变，
 * 不依赖谁记得两处要同步。跨层约束写进代码比写进注释可靠。
 *
 * 两条理由都指向同一个量级：
 *
 *   **一、和音频时长对得上。** 30 秒 × 15 字符/秒 = 450 字符是能念完的极限，
 *   两倍余量到 900。比这更长的参考不可能在 30 秒内念完，送上去只会让
 *   完整度莫名其妙地低——服务端还会静默截断音频，两头都不对。
 *
 *   **二、请求头有大小限制。** 参考文本会被 base64 编码放进请求头，
 *   体积涨 1/3。实测约 13000 字符导致请求挂死——编码后约 17KB，
 *   超过常见的 8KB 请求头上限，服务端直接不响应，不是返回 4xx。
 *   900 字符编码后约 1.3KB，离上限很远。
 */
export const MAX_REFERENCE_CHARS = MAX_ASSESSABLE_SECONDS * CHARS_PER_SECOND * HEADROOM;

export type Granularity = "Phoneme" | "Word" | "FullText";

export interface AssessmentConfigOptions {
  reference: string;
  /** 默认 Phoneme —— 音素级明细是做发音纠错的素材，不要退到 Word。 */
  granularity?: Granularity;
  /**
   * 默认开。这是参考实现 Enjoy 缺的那一项：它的
   * PronunciationAssessmentConfig 第四个参数是 enableMiscue 不是 prosody，
   * 所以它的 prosodyScore 那一列永远是空的。见 docs/decisions.md 0015。
   */
  prosody?: boolean;
}

/**
 * 校验并归一化参考文本。
 *
 * 单独导出，因为编排层要在**调 provider 之前**就拒绝——
 * 和 `synthesize()` 在调 TTS 之前拒绝空文本同理。等到构造请求头时才发现，
 * 说明已经走过了一段不该走的路。
 */
export function prepareReference(raw: string): string {
  // 复用 TTS 那套规范化：CRLF、零宽字符、全角标点，来源都一样（复制粘贴）。
  const text = normalize(raw).trim();

  if (!text) {
    throw new InvalidReferenceError(
      "参考文本为空。空参考会触发无参考评估并返回一个看起来正常的高分，必须拒绝。",
    );
  }

  if (text.length > MAX_REFERENCE_CHARS) {
    throw new InvalidReferenceError(
      `参考文本 ${text.length} 字符，超过 ${MAX_REFERENCE_CHARS} 上限。` +
        `超长参考会让请求挂死而不是报错。`,
    );
  }

  return text;
}

/** 构造请求头的值：一段 JSON 的 base64。 */
export function buildAssessmentHeader(options: AssessmentConfigOptions): string {
  const config = {
    ReferenceText: prepareReference(options.reference),
    GradingSystem: "HundredMark",
    Granularity: options.granularity ?? "Phoneme",
    Dimension: "Comprehensive",
    // 服务端要的是字符串 "True" 而不是布尔 true。
    EnableProsodyAssessment: (options.prosody ?? true) ? "True" : "False",
  };

  return Buffer.from(JSON.stringify(config), "utf8").toString("base64");
}

/** 测试与排障用：把头的值解回来看看到底发了什么。 */
export function decodeAssessmentHeader(header: string): Record<string, string> {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, string>;
}
