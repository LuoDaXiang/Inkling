import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write";

/**
 * 用户录音的存储。
 *
 * ## 为什么不复用 `FileAudioStore`
 *
 * 两者的**键语义正好相反**，共用一个类必然让后人搞混：
 *
 *   `FileAudioStore` 的键是**请求参数派生**的（text + engine + model + voice + speed，
 *   见 `core/tts/cache-key.ts`），语义是「同样的请求复用同一段音频」——去重是目的。
 *
 *   录音相反：**同一句话录十次是十份必须各自保留的音频**，去重就是数据丢失。
 *
 * 所以录音走独立目录 + **内容哈希**（对编码后的 WAV 取 sha256）。见契约 [C38]。
 *
 * 内容哈希意味着两段逐字节相同的音频会共用一个文件。对真实录音这实际上
 * 不会发生（麦克风底噪保证了每次都不同），而万一发生了，共用也是对的——
 * 它们本来就是同一串字节。这和「按请求去重」是两回事。
 *
 * ## 独立目录还有一个理由
 *
 * F8（缓存无上界、无淘汰）将来要给 TTS 缓存加淘汰。混在一个目录里，
 * 淘汰策略会把用户的录音一起删掉——那是用户资产，不是缓存。
 *
 * ## 存的是修剪后那一份
 *
 * [C39]：那才是真正送去评分、也是计费依据的字节。存原始的，
 * 将来复盘会和分数对不上。
 */

/** sha256 十六进制。和 `FileAudioStore` 的键格式一致，同样用来防路径穿越。 */
const KEY_PATTERN = /^[0-9a-f]{64}$/;

export interface StoredRecording {
  key: string;
  bytes: number;
  location: string;
}

export class RecordingStore {
  private readonly dir: string;
  private ready: Promise<void> | null = null;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  /** 内容哈希。导出是为了让调用方能在写盘之前先算出键（[C67] 的第 1 步）。 */
  static keyOf(wav: Uint8Array): string {
    return createHash("sha256").update(wav).digest("hex");
  }

  /**
   * 存一段录音，返回它的内容哈希。
   *
   * 不接受外部传入的键——键**必须**由内容决定，这是这个 store 的全部约定。
   */
  async put(wav: Uint8Array): Promise<StoredRecording> {
    const key = RecordingStore.keyOf(wav);
    await this.ensureDir();
    const path = this.pathFor(key);
    await writeFileAtomic(path, wav);
    return { key, bytes: wav.byteLength, location: path };
  }

  async read(key: string): Promise<Uint8Array> {
    assertKey(key);
    return new Uint8Array(await readFile(this.pathFor(key)));
  }

  async has(key: string): Promise<boolean> {
    assertKey(key);
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  private pathFor(key: string): string {
    return join(this.dir, `${key}.wav`);
  }

  private ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }
}

/** 键直接参与拼路径，所以必须校验。少了这一行，一个 "../../etc/passwd" 就能读到目录外面去。 */
function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`非法的录音键：${key.slice(0, 32)}`);
  }
}
