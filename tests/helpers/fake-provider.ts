import type {
  AudioFormat,
  TtsProvider,
  TtsRequest,
  TtsResult,
} from "@/providers/tts/types";

/**
 * 测试用的假 TTS。
 *
 * 它做三件真 provider 做不到的事：
 *   1. 瞬间返回，不联网不花钱
 *   2. 记录每一次调用，让测试能断言「没被调用过」
 *   3. 按指令抛出任意错误，让每一条失败路径都能被走到
 */
export class FakeTtsProvider implements TtsProvider {
  readonly engine: string;
  readonly model: string;
  readonly maxChars: number;

  /** 收到过的每一次请求，按顺序。 */
  readonly calls: TtsRequest[] = [];

  /** 设置后，下一次 synthesize 抛出它，然后清空。 */
  nextError: unknown = null;
  /** 设置后，所有 synthesize 都抛出它。 */
  alwaysError: unknown = null;
  /** 设置后，返回这段字节而不是默认的假音频。 */
  nextAudio: Uint8Array | null = null;

  constructor(options: {
    engine?: string;
    model?: string;
    maxChars?: number;
    format?: AudioFormat;
    sampleRate?: number;
  } = {}) {
    this.engine = options.engine ?? "fake";
    this.model = options.model ?? "fake-1";
    this.maxChars = options.maxChars ?? 500;
    this.format = options.format ?? "wav";
    this.sampleRate = options.sampleRate ?? 24000;
  }

  private readonly format: AudioFormat;
  private readonly sampleRate: number;

  get callCount(): number {
    return this.calls.length;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    this.calls.push({ ...request });

    if (this.alwaysError) throw this.alwaysError;
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }

    const audio = this.nextAudio ?? fakeAudio(request.text);
    this.nextAudio = null;
    return { audio, format: this.format, sampleRate: this.sampleRate };
  }
}

/** 长度随文本变化的假音频，便于断言「不同文本存下了不同内容」。 */
function fakeAudio(text: string): Uint8Array {
  return new Uint8Array(Math.max(1, text.length * 4)).fill(7);
}
