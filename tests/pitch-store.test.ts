import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePitchStore, MemoryPitchStore } from "@/storage/pitch-store";
import type { PitchContour } from "@/core/audio/pitch";

/**
 * 输入空间分类
 *
 *   A. 往返 —— 存进去的曲线原样读回来
 *   B. 缺席 —— 没存过读回 null，delete 幂等
 *   C. 坏文件 —— 读回来的东西必须验形状  ⭐
 *   D. 键校验 —— 键直接拼路径，非法键当场抛
 *   E. 两个实现同构 —— 内存实现和文件实现在同一组断言下行为一致
 *
 * **C 组是这里最要紧的一组。** 磁盘上的东西不是我们刚写的那一份：
 * 版本换过、手动改过、写到一半断电过。不验形状就把一个 `{}` 当曲线
 * 发给客户端，前端画出一条空线，**没有任何东西会报错**。
 *
 * 「坏文件当成没有」是刻意的：曲线是派生数据，重算一次就有了。
 * 这和 `boards.db` 那类用户数据相反——那种东西坏了必须报，不能悄悄当空的。
 */

const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);

const contour: PitchContour = { hz: [220, null, 221.5, 219], hopMs: 20 };

describe("FilePitchStore", () => {
  let dir: string;
  let store: FilePitchStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "inkling-pitch-"));
    store = new FilePitchStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("A. 往返", () => {
    test("存进去的曲线原样读回来，null 也保住", async () => {
      await store.put(KEY, contour);
      expect(await store.get(KEY)).toEqual(contour);
    });

    test("不同键互不干扰", async () => {
      await store.put(KEY, contour);
      await store.put(OTHER, { hz: [110], hopMs: 40 });

      expect(await store.get(KEY)).toEqual(contour);
      expect(await store.get(OTHER)).toEqual({ hz: [110], hopMs: 40 });
    });

    test("同一个键再写一次是覆盖", async () => {
      await store.put(KEY, contour);
      await store.put(KEY, { hz: [330], hopMs: 10 });

      expect(await store.get(KEY)).toEqual({ hz: [330], hopMs: 10 });
    });

    test("空曲线也是合法的曲线，不能当成缺席", async () => {
      // 一段短到不足一个窗口的音频，曲线就是空数组。
      // 把它当成「没存过」的话，每次都会重算一次注定为空的结果。
      await store.put(KEY, { hz: [], hopMs: 20 });
      expect(await store.get(KEY)).toEqual({ hz: [], hopMs: 20 });
    });
  });

  describe("B. 缺席", () => {
    test("没存过 → null", async () => {
      expect(await store.get(KEY)).toBeNull();
    });

    test("delete 之后读回 null", async () => {
      await store.put(KEY, contour);
      await store.delete(KEY);
      expect(await store.get(KEY)).toBeNull();
    });

    test("delete 一个不存在的键不抛 —— 幂等", async () => {
      await expect(store.delete(KEY)).resolves.toBeUndefined();
      await expect(store.delete(KEY)).resolves.toBeUndefined();
    });
  });

  describe("C. 坏文件当成没有，不当成空曲线", () => {
    const bad: Array<[string, string]> = [
      ["不是 JSON", "{{{"],
      ["是数组不是对象", "[1,2,3]"],
      ["是 null", "null"],
      ["缺 hz", '{"hopMs":20}'],
      ["hz 不是数组", '{"hz":"220","hopMs":20}'],
      ["缺 hopMs", '{"hz":[220]}'],
      ["hopMs 是字符串", '{"hz":[220],"hopMs":"20"}'],
      ["hopMs 是 0", '{"hz":[220],"hopMs":0}'],
      ["hz 里混了字符串", '{"hz":[220,"x"],"hopMs":20}'],
      ["hz 里混了 NaN（JSON 里是 null 以外的非法值）", '{"hz":[220,true],"hopMs":20}'],
    ];

    test.each(bad)("%s → null", async (_name, text) => {
      await store.put(KEY, contour);
      const files = await readdir(dir);
      await writeFile(join(dir, files[0] as string), text, "utf8");

      expect(await store.get(KEY)).toBeNull();
    });
  });

  describe("D. 键校验", () => {
    const illegal = ["", "short", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65)];

    test.each(illegal)("非法键 %s 在 get 时抛", async (key) => {
      await expect(store.get(key)).rejects.toThrow(/非法的缓存键/);
    });

    test.each(illegal)("非法键 %s 在 put 时抛", async (key) => {
      await expect(store.put(key, contour)).rejects.toThrow(/非法的缓存键/);
    });

    test("带路径分隔符的键抛，不会写到目录外面去", async () => {
      const escaping = `${"a".repeat(30)}/${"b".repeat(33)}`;
      await expect(store.put(escaping, contour)).rejects.toThrow(/非法的缓存键/);
    });
  });
});

describe("MemoryPitchStore", () => {
  let store: MemoryPitchStore;

  beforeEach(() => {
    store = new MemoryPitchStore();
  });

  test("和文件实现在同一组断言下行为一致", async () => {
    expect(await store.get(KEY)).toBeNull();
    await store.put(KEY, contour);
    expect(await store.get(KEY)).toEqual(contour);
    await store.delete(KEY);
    expect(await store.get(KEY)).toBeNull();
  });

  test("calls 计数是「命中缓存没重算」那条断言的依据", async () => {
    await store.put(KEY, contour);
    await store.get(KEY);
    await store.get(OTHER);

    expect(store.calls).toEqual({ get: 2, put: 1, delete: 0 });
  });

  test("size 反映条目数", async () => {
    expect(store.size).toBe(0);
    await store.put(KEY, contour);
    await store.put(OTHER, contour);
    expect(store.size).toBe(2);
  });
});
