import type { AudioFormat } from "@/providers/tts/types";

/**
 * 音频存储。
 *
 * 音频文件走文件系统，数据库只存键——不要把 blob 塞进 SQLite。
 * 这里只定义接口，测试用内存实现，生产用文件系统实现，
 * 以后要换成 S3 也只改这一个目录。
 */

export interface StoredAudio {
  key: string;
  format: AudioFormat;
  bytes: number;
  /** 播放用的定位串。内存实现返回伪路径，文件实现返回绝对路径。 */
  location: string;
}

export interface AudioStore {
  get(key: string): Promise<StoredAudio | null>;
  put(key: string, audio: Uint8Array, format: AudioFormat): Promise<StoredAudio>;
  delete(key: string): Promise<void>;
}

/** 测试与开发用的内存实现。 */
export class MemoryAudioStore implements AudioStore {
  private readonly items = new Map<string, { audio: Uint8Array; format: AudioFormat }>();

  /** 测试用：记录每个方法被调用的次数。 */
  readonly calls = { get: 0, put: 0, delete: 0 };

  async get(key: string): Promise<StoredAudio | null> {
    this.calls.get++;
    const item = this.items.get(key);
    if (!item) return null;
    return this.describe(key, item.audio, item.format);
  }

  async put(key: string, audio: Uint8Array, format: AudioFormat): Promise<StoredAudio> {
    this.calls.put++;
    this.items.set(key, { audio, format });
    return this.describe(key, audio, format);
  }

  async delete(key: string): Promise<void> {
    this.calls.delete++;
    this.items.delete(key);
  }

  /** 测试用：直接取回字节，验证存进去的确实是 provider 返回的东西。 */
  raw(key: string): Uint8Array | undefined {
    return this.items.get(key)?.audio;
  }

  get size(): number {
    return this.items.size;
  }

  private describe(key: string, audio: Uint8Array, format: AudioFormat): StoredAudio {
    return { key, format, bytes: audio.byteLength, location: `memory://${key}.${format}` };
  }
}
