import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAudioStore } from "@/storage/file-audio-store";

/**
 * 文件音频存储。
 *
 * 这一层之前只被路由测试间接带到，没有自己的用例——而它恰好藏着一个
 * 会造成**永久损坏**的缺陷：直接 writeFile 到目标路径。
 *
 * 缓存键是请求哈希不是内容哈希，加上 F4 还没有 in-flight 去重，
 * 两个并发的相同请求会同时写同一个路径；writeFile 先截断再写，
 * 交错的结果是一段拼接出来的坏音频。而 get() 只 stat 不校验内容，
 * 缓存又没有淘汰（F8）——坏文件会被当成命中，永远命中下去。
 *
 * 所以这里的重点用例是**并发写同一个键**和**写入中断**。
 */

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

let dir: string;
let store: FileAudioStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkling-store-"));
  store = new FileAudioStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const bytes = (value: number, length: number): Uint8Array =>
  new Uint8Array(length).fill(value);

const tempFiles = async (): Promise<string[]> =>
  (await readdir(dir)).filter((name) => name.endsWith(".tmp"));

describe("往返", () => {
  test("put 之后 get 命中", async () => {
    await store.put(KEY_A, bytes(1, 100), "wav");
    const hit = await store.get(KEY_A);
    expect(hit).toMatchObject({ key: KEY_A, format: "wav", bytes: 100 });
  });

  test("read 拿回一模一样的字节", async () => {
    const audio = bytes(7, 999);
    await store.put(KEY_A, audio, "wav");
    expect(await store.read(KEY_A, "wav")).toEqual(audio);
  });

  test("没存过的键返回 null", async () => {
    expect(await store.get(KEY_A)).toBeNull();
  });

  test("delete 之后不再命中，且重复 delete 不报错", async () => {
    await store.put(KEY_A, bytes(1, 10), "wav");
    await store.delete(KEY_A);
    expect(await store.get(KEY_A)).toBeNull();
    await expect(store.delete(KEY_A)).resolves.toBeUndefined();
  });
});

describe("原子写入", () => {
  test("并发写同一个键，结果是某一个写入者的完整内容——不是拼接", async () => {
    // 这是修复前会挂的那条：两段长度不同的音频同时写同一个路径，
    // writeFile 先截断再写，交错的结果既不是 A 也不是 B。
    const a = bytes(0xaa, 400_000);
    const b = bytes(0xbb, 150_000);

    await Promise.all([store.put(KEY_A, a, "wav"), store.put(KEY_A, b, "wav")]);

    const stored = await store.read(KEY_A, "wav");
    // 必须完整等于其中一个，不能是长度对不上或前后段来自不同写入者的怪物。
    const isA = stored.length === a.length && stored.every((v) => v === 0xaa);
    const isB = stored.length === b.length && stored.every((v) => v === 0xbb);
    expect(isA || isB).toBe(true);
  });

  test("十个并发写入者，读到的文件仍然是完整的单一内容", async () => {
    const sizes = [10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000, 100_000];
    await Promise.all(
      sizes.map((size, i) => store.put(KEY_A, bytes(i + 1, size), "wav")),
    );

    const stored = await store.read(KEY_A, "wav");
    const first = stored[0];
    expect(stored.every((v) => v === first)).toBe(true);
    expect(sizes).toContain(stored.length);
  });

  test("写完不留临时文件", async () => {
    await store.put(KEY_A, bytes(1, 1000), "wav");
    expect(await tempFiles()).toEqual([]);
  });

  test("并发写完也不留临时文件", async () => {
    await Promise.all([
      store.put(KEY_A, bytes(1, 1000), "wav"),
      store.put(KEY_A, bytes(2, 2000), "wav"),
      store.put(KEY_B, bytes(3, 3000), "wav"),
    ]);
    expect(await tempFiles()).toEqual([]);
  });

  test("写入失败时不留临时文件，也不留半截的目标文件", async () => {
    // 把缓存目录的位置占成一个普通文件，mkdir 会失败。
    const blocked = join(dir, "blocked");
    await writeFile(blocked, "not a directory");
    const broken = new FileAudioStore(blocked);

    await expect(broken.put(KEY_A, bytes(1, 100), "wav")).rejects.toThrow();
    expect(await tempFiles()).toEqual([]);
    expect(await store.get(KEY_A)).toBeNull();
  });

  test("临时文件不会被 get 当成缓存命中", async () => {
    // 手工造一个半路夭折的临时文件，模拟进程在 rename 之前被杀。
    await store.put(KEY_B, bytes(9, 10), "wav"); // 先建目录
    await writeFile(join(dir, `${KEY_A}.wav.abc-123.tmp`), "truncated");
    expect(await store.get(KEY_A)).toBeNull();
  });

  test("旧文件在新写入完成前一直可读——rename 没有中间态", async () => {
    await store.put(KEY_A, bytes(0x11, 5000), "wav");

    const writing = store.put(KEY_A, bytes(0x22, 800_000), "wav");
    // 新写入还在进行时读，拿到的必须是完整的旧内容。
    const during = await store.read(KEY_A, "wav");
    const wasOld = during.length === 5000 && during.every((v) => v === 0x11);
    const wasNew = during.length === 800_000 && during.every((v) => v === 0x22);
    expect(wasOld || wasNew).toBe(true);

    await writing;
    const after = await store.read(KEY_A, "wav");
    expect(after.length).toBe(800_000);
  });
});

describe("键校验", () => {
  test("路径穿越被拒", async () => {
    await expect(store.put("../../etc/passwd", bytes(1, 10), "wav")).rejects.toThrow(/非法的缓存键/);
    await expect(store.get("../../etc/passwd")).rejects.toThrow(/非法的缓存键/);
    await expect(store.delete("../../etc/passwd")).rejects.toThrow(/非法的缓存键/);
  });

  test("长度不对的键被拒", async () => {
    await expect(store.get("abc")).rejects.toThrow(/非法的缓存键/);
  });

  test("大写十六进制被拒——键必须是规范形式，否则同一内容会存两份", async () => {
    await expect(store.get("A".repeat(64))).rejects.toThrow(/非法的缓存键/);
  });

  test("不支持的格式被拒", async () => {
    await expect(store.put(KEY_A, bytes(1, 10), "ogg" as never)).rejects.toThrow(/不支持的音频格式/);
  });
});
