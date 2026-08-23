import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AudioFormat } from "@/providers/tts/types";
import type { AudioStore, StoredAudio } from "./audio-store";

/**
 * 文件系统实现。
 *
 * 音频按内容哈希命名，落在一个目录里，数据库（以后有的话）只存键。
 * 见 docs/decisions.md 0004。
 *
 * 缓存目前没有上界，只增不减。这是已知缺口（roadmap 的 F8），
 * 等有了淘汰策略再补——现在写死一个上限反而会在还没想清楚时定错。
 */

/** 哈希是 64 位十六进制，这里做一次校验，防止路径穿越。 */
const KEY_PATTERN = /^[0-9a-f]{64}$/;

const FORMATS: ReadonlySet<string> = new Set<AudioFormat>(["wav", "mp3"]);

export class FileAudioStore implements AudioStore {
  private readonly dir: string;
  private ready: Promise<void> | null = null;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  async get(key: string): Promise<StoredAudio | null> {
    assertKey(key);
    // 不知道扩展名，两种都试。目前只有 wav 在用，mp3 是为将来的 provider 留的。
    for (const format of ["wav", "mp3"] as const) {
      const path = this.pathFor(key, format);
      try {
        const info = await stat(path);
        return { key, format, bytes: info.size, location: path };
      } catch {
        // 不存在，试下一个扩展名
      }
    }
    return null;
  }

  async put(key: string, audio: Uint8Array, format: AudioFormat): Promise<StoredAudio> {
    assertKey(key);
    assertFormat(format);
    await this.ensureDir();
    const path = this.pathFor(key, format);
    await writeFile(path, audio);
    return { key, format, bytes: audio.byteLength, location: path };
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    for (const format of ["wav", "mp3"] as const) {
      try {
        await unlink(this.pathFor(key, format));
      } catch {
        // 本来就不存在，delete 应当是幂等的
      }
    }
  }

  /** 读回字节，供 HTTP 层流式返回。 */
  async read(key: string, format: AudioFormat): Promise<Uint8Array> {
    assertKey(key);
    assertFormat(format);
    return new Uint8Array(await readFile(this.pathFor(key, format)));
  }

  private pathFor(key: string, format: AudioFormat): string {
    return join(this.dir, `${key}.${format}`);
  }

  /** 建目录只做一次，并发调用共用同一个 Promise。 */
  private ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }
}

/**
 * 键直接参与拼路径，所以必须校验。
 * 少了这一行，一个 "../../etc/passwd" 就能写到目录外面去。
 */
function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`非法的缓存键：${key.slice(0, 32)}`);
  }
}

function assertFormat(format: string): void {
  if (!FORMATS.has(format)) {
    throw new Error(`不支持的音频格式：${format}`);
  }
}
