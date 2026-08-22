/**
 * TTS provider 接口。
 *
 * 这个文件是整个 TTS 功能可测性的来源：业务逻辑只依赖这个接口，
 * 不依赖任何具体的服务商。测试时塞一个假实现进去，就能在不联网、
 * 不花钱、不装模型的前提下，把「查缓存 / 生成 / 错误处理」全部测到。
 */

export type AudioFormat = "wav" | "mp3";

export interface TtsRequest {
  text: string;
  voice: string;
  /** 语速倍率，1 为原速。 */
  speed?: number;
}

export interface TtsResult {
  audio: Uint8Array;
  format: AudioFormat;
  sampleRate: number;
}

export interface TtsProvider {
  /** 引擎标识，进缓存键，换引擎必须重新生成。 */
  readonly engine: string;
  /** 模型标识，同上。 */
  readonly model: string;
  /**
   * 单次请求能处理的最大字符数。
   *
   * 这个字段存在的原因：Kokoro 的分词器上限是 509 token，超出会被
   * 静默截断——音频短一截，不报错。上游必须能问到这个上限并在
   * 送进来之前就拒绝，而不是等模型悄悄砍掉。
   */
  readonly maxChars: number;

  synthesize(request: TtsRequest): Promise<TtsResult>;
}
