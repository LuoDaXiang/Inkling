/**
 * 发音评分 provider 接口。
 *
 * 和 TtsProvider 同构：业务逻辑只依赖这个接口，不依赖任何具体服务商。
 * 测试时塞假实现进去，不联网、不花钱就能把编排逻辑全部测到。
 *
 * 与 TTS 的两处刻意不同：
 *
 *   1. **不缓存**。TTS 的前提是「同样的文本必然产出同样的音频」，所以缓存省钱。
 *      评分的输入是每次都不同的录音，缓存永远不会命中，加了只会白占磁盘。
 *      同一个仓库里两个模块用相反的缓存策略是对的，不要为了一致性统一掉。
 *
 *   2. **有时长上限**。评估服务会静默截断超长音频——73 秒的音频完整度只给 49
 *      （约等于 35/73），HTTP 200、状态 Success、没有任何警告。
 *      所以接口带 maxSeconds，上游必须在送出前拦。见 docs/decisions.md 0022。
 */

/** 逐词的错误类型。取值来自 Azure，其他服务商要映射到这套。 */
export type WordErrorType =
  | "None"
  | "Omission"
  | "Insertion"
  | "Mispronunciation"
  | "UnexpectedBreak"
  | "MissingBreak"
  | "Monotone";

export interface Phoneme {
  phoneme: string;
  accuracy: number;
}

export interface WordScore {
  word: string;
  accuracy: number;
  errorType: WordErrorType;
  phonemes: Phoneme[];
  /**
   * 单调程度，0–1。
   *
   * 这是逐词语调反馈里最有用的一项：一个总分只能告诉用户「语调不太好」，
   * 这个能指出**哪几个词读平了**。跟读训练要的是后者。
   * 见 docs/decisions.md 0016。
   */
  monotone?: number;
  /** 停顿异常。 */
  breakError?: "unexpected" | "missing";
}

export interface AssessmentScores {
  accuracy: number;
  fluency: number;
  completeness: number;
  /**
   * 语调。**可能缺席**——音频被截断、参考文本无效时它直接不出现，
   * 且仅 en-US 支持。所以类型是可选的，不能当成必然有值。
   */
  prosody?: number;
  /** 加权总分。 */
  overall: number;
}

export interface AssessmentResult {
  scores: AssessmentScores;
  words: WordScore[];
  /** 服务端识别出来的文本，用来和参考文本对照。 */
  recognized: string;
  /** 信噪比。将来可以据此提示「你的麦克风太吵」。 */
  snr?: number;
}

export interface AssessmentRequest {
  /** 必须是合法 WAV，且时长不超过 provider.maxSeconds。 */
  audio: Uint8Array;
  /** 参考文本。**不能为空**——空参考会触发无参考评估并返回一个看起来正常的高分。 */
  reference: string;
}

export interface ScoringProvider {
  /** 引擎标识，进操作流水，换引擎要能看出来。 */
  readonly engine: string;
  /** 音频时长上限（秒）。超过会被服务端静默截断。 */
  readonly maxSeconds: number;
  /** 参考文本字符上限。超长会让请求挂死而不是报错。 */
  readonly maxReferenceChars: number;

  /**
   * 返回 null 表示**没有识别到语音**（静音、噪声、空音频）。
   *
   * 这不是错误——用户确实录了一段没有语音的东西，这是一条要如实告诉他的
   * 结果，不该抛异常。真正的错误（密钥错、网络断、额度尽）才抛。
   */
  assess(request: AssessmentRequest): Promise<AssessmentResult | null>;
}
