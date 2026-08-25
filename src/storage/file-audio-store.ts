import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

/**
 * 临时文件后缀。
 *
 * 必须是 KEY_PATTERN 认不出来的形状，这样半路夭折的临时文件
 * 既不会被 get() 当成缓存命中，也不会被当成合法的键。
 */
const TEMP_SUFFIX = ".tmp";

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

  /**
   * 写入。**先写临时文件再 rename**，不能直接写目标路径。
   *
   * 直接 writeFile 有两条路会写出一个坏文件，而且是永久的坏：
   *
   *   1. 并发。缓存键是**请求哈希**不是内容哈希（见 cache-key.ts），
   *      而 F4 目前没有 in-flight 去重——两个并发的相同请求会各调一次
   *      provider，拿到两段不保证逐字节相同的音频，然后同时写同一个路径。
   *      writeFile 是先截断再写，两个交错就是一段拼接出来的坏音频。
   *   2. 中断。进程被杀或磁盘满，留下一个截断的文件。
   *
   * 两种情况下 get() 都会命中——它只 stat 不校验内容——而缓存没有淘汰
   * （F8），所以这个坏文件永远不会被替换掉。用户看到的是某一句话的音频
   * 永远是坏的，且没有任何界面能清掉它。
   *
   * 同目录内的 rename 在 POSIX 上是原子的：要么看到完整的旧文件，
   * 要么看到完整的新文件，不存在中间态。临时文件带随机后缀，
   * 所以并发的两个写者不会互相踩。
   */
  async put(key: string, audio: Uint8Array, format: AudioFormat): Promise<StoredAudio> {
    assertKey(key);
    assertFormat(format);
    await this.ensureDir();
    const path = this.pathFor(key, format);
    const temp = `${path}.${randomUUID()}${TEMP_SUFFIX}`;

    try {
      await writeFile(temp, audio);
      await rename(temp, path);
    } catch (err) {
      // 失败就把临时文件收走，别在缓存目录里堆垃圾。
      await unlink(temp).catch(() => undefined);
      throw err;
    }

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
