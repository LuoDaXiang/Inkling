import { mkdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import type { PitchContour } from "@/core/audio/pitch";

/**
 * 参考音高曲线的缓存。
 *
 * 键与 TTS 音频**共用同一个** `cacheKey()`——同一段文本、同一个音色、
 * 同一个语速，音频和它的曲线是同一份东西的两面。复用键而不是另造一个，
 * 理由和 0004 一样：键由内容决定，不绑业务实体。
 *
 * **为什么单独一个 store 而不是塞进 `FileAudioStore`。**
 * `AudioStore` 的 `get()` 只 stat 不读内容，`put()` 吃 `AudioFormat`——
 * 它的整个接口是围绕「大块二进制、按扩展名找、HTTP 直接流出去」长的。
 * 曲线是几百个数字的 JSON，读回来要解析，没有格式维度。硬塞进去要么
 * 污染那个接口，要么给它加一个只有一半方法能用的第二形态。
 *
 * **目录也分开**：和 `RecordingStore` 与 `FileAudioStore` 分开是同一个理由
 * （0043）——F8 将来给 TTS 缓存加淘汰时，曲线应当和它对应的音频一起淘汰，
 * 独立目录让「一起淘汰」是一个显式的决定，而不是一个巧合。
 *
 * 缺席时 TTS 照常工作，只是没有参考曲线。这条纪律和 `log` / `rates` /
 * `db` 一致：可选设施不到位，主链路不能因此走不通。
 */
export interface PitchStore {
  get(key: string): Promise<PitchContour | null>;
  put(key: string, contour: PitchContour): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * 哈希是 64 位十六进制。键直接参与拼路径，所以必须校验——
 * 少了这一行，一个带上跳段的键就能写到目录外面去。
 */
const KEY_PATTERN = /^[0-9a-f]{64}$/;

export class FilePitchStore implements PitchStore {
  private readonly dir: string;
  private ready: Promise<void> | null = null;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  async get(key: string): Promise<PitchContour | null> {
    assertKey(key);
    let raw: string;
    try {
      raw = await readFile(this.pathFor(key), "utf8");
    } catch {
      return null;
    }
    try {
      return parseContour(JSON.parse(raw) as unknown);
    } catch {
      // 文件坏了当成没有。曲线是派生数据，重算一次就有了——
      // 在这里返回一个半截的曲线才是真正的坏事。
      return null;
    }
  }

  async put(key: string, contour: PitchContour): Promise<void> {
    assertKey(key);
    await this.ensureDir();
    const bytes = new TextEncoder().encode(JSON.stringify(contour));
    await writeFileAtomic(this.pathFor(key), bytes);
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    try {
      await unlink(this.pathFor(key));
    } catch {
      // 本来就不存在，delete 应当幂等。
    }
  }

  private pathFor(key: string): string {
    return join(this.dir, `${key}.pitch.json`);
  }

  private ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }
}

/** 测试与开发用的内存实现。 */
export class MemoryPitchStore implements PitchStore {
  private readonly items = new Map<string, PitchContour>();

  /** 测试用：记录每个方法被调用的次数。命中缓存不该重算，靠 `put` 的计数来证。 */
  readonly calls = { get: 0, put: 0, delete: 0 };

  async get(key: string): Promise<PitchContour | null> {
    this.calls.get++;
    return this.items.get(key) ?? null;
  }

  async put(key: string, contour: PitchContour): Promise<void> {
    this.calls.put++;
    this.items.set(key, contour);
  }

  async delete(key: string): Promise<void> {
    this.calls.delete++;
    this.items.delete(key);
  }

  get size(): number {
    return this.items.size;
  }
}

/**
 * 读回来的 JSON 必须验形状。
 *
 * 磁盘上的东西不是我们刚写的那一份——版本换过、手动改过、写到一半断电过。
 * 不验就把一个 `{}` 当曲线发给客户端，前端画出一条空线而没有任何东西报错。
 */
function parseContour(value: unknown): PitchContour {
  if (typeof value !== "object" || value === null) throw new Error("不是对象");
  const raw = value as { hz?: unknown; hopMs?: unknown };
  if (!Array.isArray(raw.hz)) throw new Error("hz 不是数组");
  if (typeof raw.hopMs !== "number" || !Number.isFinite(raw.hopMs) || raw.hopMs <= 0) {
    throw new Error("hopMs 不是正数");
  }
  const hz = raw.hz.map((v) => {
    if (v === null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    throw new Error("hz 里有既不是数字也不是 null 的项");
  });
  return { hz, hopMs: raw.hopMs };
}

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`非法的缓存键：${key.slice(0, 32)}`);
  }
}
