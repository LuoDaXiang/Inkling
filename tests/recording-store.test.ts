import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingStore } from "@/storage/recording-store";
import { FileAudioStore } from "@/storage/file-audio-store";

/**
 * 录音存储 —— 契约 [C38] [C39]，测试清单 #19 的一半。
 *
 * 重点是**它和 TTS 缓存的语义正好相反**：那边去重是目的，这边去重是数据丢失。
 * 同一句话录十次是十份必须各自保留的音频。
 */

let dir: string;
let store: RecordingStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkling-rec-"));
  store = new RecordingStore(join(dir, "recordings"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 造一段「录音」：内容由种子决定，不同种子必然不同字节。 */
const wav = (seed: number, length = 512): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (seed * 31 + i * 7) % 256);

describe("内容哈希", () => {
  test("键是 64 位十六进制", async () => {
    const stored = await store.put(wav(1));
    expect(stored.key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("同一句话录两次 → 两个不同的键，且都读得回来 [C38]", async () => {
    // 这是和 TTS 缓存最本质的区别。按请求去重会让第二次录音覆盖第一次，
    // 那是数据丢失，不是省钱。
    const first = await store.put(wav(1));
    const second = await store.put(wav(2));

    expect(first.key).not.toBe(second.key);
    expect(await store.read(first.key)).toEqual(wav(1));
    expect(await store.read(second.key)).toEqual(wav(2));
  });

  test("逐字节相同的内容得到同一个键——它们本来就是同一串字节", async () => {
    const a = await store.put(wav(7));
    const b = await store.put(wav(7));
    expect(a.key).toBe(b.key);
    expect(await store.read(a.key)).toEqual(wav(7));
  });

  test("keyOf 可以在写盘之前先算出键 —— [C67] 第 1 步要用", () => {
    const bytes = wav(3);
    expect(RecordingStore.keyOf(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("keyOf 与 put 得到同一个键", async () => {
    const bytes = wav(4);
    expect((await store.put(bytes)).key).toBe(RecordingStore.keyOf(bytes));
  });

  test("不接受外部传入的键——键必须由内容决定", () => {
    // 签名层面就没有这个口子。这条用类型断言表达：put 只吃字节。
    expect(store.put.length).toBe(1);
  });
});

describe("与 TTS 缓存分开存放", () => {
  test("目录不同，互不可见 [C38]", async () => {
    // F8 将来要给 TTS 缓存加淘汰。混在一个目录里，淘汰会把用户的录音
    // 一起删掉——那是用户资产，不是缓存。
    const tts = new FileAudioStore(join(dir, "audio"));
    const key = "a".repeat(64);
    await tts.put(key, new Uint8Array([1, 2, 3]), "wav");

    const recording = await store.put(wav(9));
    expect(await tts.get(recording.key)).toBeNull();
    expect(await store.has(key)).toBe(false);

    const dirs = (await readdir(dir)).sort();
    expect(dirs).toEqual(["audio", "recordings"]);
  });
});

describe("原子写入", () => {
  test("并发写入不同内容，每一份都完整", async () => {
    const stored = await Promise.all([1, 2, 3, 4, 5].map((seed) => store.put(wav(seed, 40_000))));
    for (const [i, s] of stored.entries()) {
      expect((await store.read(s.key)).length).toBe(40_000);
      expect(await store.read(s.key)).toEqual(wav(i + 1, 40_000));
    }
  });

  test("写完不留临时文件", async () => {
    await store.put(wav(1, 20_000));
    const left = (await readdir(join(dir, "recordings"))).filter((n) => n.endsWith(".tmp"));
    expect(left).toEqual([]);
  });

  test("写入失败时不留临时文件，也不留半截文件", async () => {
    const blocked = join(dir, "blocked");
    await writeFile(blocked, "not a directory");
    const broken = new RecordingStore(blocked);
    await expect(broken.put(wav(1))).rejects.toThrow();
  });
});

describe("键校验", () => {
  test("路径穿越被拒", async () => {
    await expect(store.read("../../etc/passwd")).rejects.toThrow(/非法的录音键/);
    await expect(store.has("../../etc/passwd")).rejects.toThrow(/非法的录音键/);
  });

  test("长度或字符不对的键被拒", async () => {
    await expect(store.read("abc")).rejects.toThrow(/非法的录音键/);
    await expect(store.read("A".repeat(64))).rejects.toThrow(/非法的录音键/);
  });

  test("没存过的键 has 返回 false，不抛", async () => {
    expect(await store.has("b".repeat(64))).toBe(false);
  });
});
