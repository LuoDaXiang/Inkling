import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WordStore } from "@/storage/word-store";

/**
 * 生词本 —— 迁移计划 M4.3。
 *
 * ## 输入空间分类
 *
 *   A. 增删查 —— 基本往返
 *   B. 去重 —— 同一个词加两次是更新，不是两条  ⭐
 *   C. 笔记 —— 再次加词不该把笔记冲掉  ⭐
 *   D. 坏文件 —— 挪走，不覆盖  ⭐
 *   E. 离线 —— 整条链不碰网络
 *
 * **B、C、D 都是「不报错」的那一类**：
 *   B 错了列表越来越长，用户以为自己记了两遍；
 *   C 错了用户写的笔记悄悄没了，而且不会重新产生；
 *   D 错了几年的生词本被一个坏 JSON 静默清空。
 */

let dir: string;
let store: WordStore;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkling-words-"));
  path = join(dir, "words.json");
  store = new WordStore(path);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("A. 增删查", () => {
  test("没加过任何词时是空数组，不抛", async () => {
    expect(await store.list()).toEqual([]);
  });

  test("加了就查得到", async () => {
    await store.add("serendipity");
    expect((await store.list()).map((w) => w.word)).toEqual(["serendipity"]);
  });

  test("最近加的排前面", async () => {
    await store.add("first", 1000);
    await store.add("second", 2000);
    expect((await store.list()).map((w) => w.word)).toEqual(["second", "first"]);
  });

  test("删掉之后就没了", async () => {
    await store.add("gone");
    await store.remove("gone");
    expect(await store.list()).toEqual([]);
  });

  test("删一个不存在的词不抛 —— 幂等", async () => {
    await expect(store.remove("nope")).resolves.toBeUndefined();
    await expect(store.remove("nope")).resolves.toBeUndefined();
  });

  test("has 回答在不在", async () => {
    await store.add("here");
    expect(await store.has("here")).toBe(true);
    expect(await store.has("there")).toBe(false);
  });

  test("首尾空白被去掉", async () => {
    await store.add("  spaced  ");
    expect((await store.list())[0]?.word).toBe("spaced");
    expect(await store.has("spaced")).toBe(true);
  });

  test("空字符串不是一个词 → 抛", async () => {
    await expect(store.add("   ")).rejects.toThrow(/不是一个词/);
  });

  test("大小写不同就是两个词 —— March 和 march 不是一个词", async () => {
    await store.add("March");
    await store.add("march");
    expect(await store.list()).toHaveLength(2);
  });
});

describe("B. 去重", () => {
  test("同一个词加两次只有一条", async () => {
    // 在两篇材料里碰到同一个生词是常事，攒出两条只会让列表越来越难看。
    await store.add("again", 1000);
    await store.add("again", 2000);
    expect(await store.list()).toHaveLength(1);
  });

  test("第二次加会更新时间", async () => {
    await store.add("again", 1000);
    await store.add("again", 2000);
    expect((await store.list())[0]?.addedAt).toBe(2000);
  });
});

describe("C. 笔记", () => {
  test("写得进去也读得出来", async () => {
    await store.annotate("word", "记一下这个词的用法");
    expect((await store.list())[0]?.note).toBe("记一下这个词的用法");
  });

  test("再次加同一个词**不会**把笔记冲掉", async () => {
    // 用户写的笔记悄悄没了，而且不会重新产生——这是这个文件里最要紧的一条。
    await store.annotate("word", "我的笔记");
    await store.add("word", 3000);
    expect((await store.list())[0]?.note).toBe("我的笔记");
    expect((await store.list())[0]?.addedAt).toBe(3000);
  });

  test("显式改笔记会覆盖旧的", async () => {
    await store.annotate("word", "旧的");
    await store.annotate("word", "新的");
    expect((await store.list())[0]?.note).toBe("新的");
  });

  test("没有笔记时字段不出现，不发空串", async () => {
    await store.add("plain");
    expect("note" in ((await store.list())[0] as object)).toBe(false);
  });

  test("给一个没加过的词写笔记 = 加它并带上笔记", async () => {
    await store.annotate("fresh", "第一次见");
    expect((await store.list())[0]).toMatchObject({ word: "fresh", note: "第一次见" });
  });
});

describe("D. 坏文件", () => {
  test.each([
    ["不是 JSON", "{{{"],
    ["words 不是数组", '{"words":42}'],
    ["条目缺 word", '{"words":[{"addedAt":1}]}'],
    ["条目的 word 是空串", '{"words":[{"word":"","addedAt":1}]}'],
    ["条目缺 addedAt", '{"words":[{"word":"x"}]}'],
  ])("%s → 当成空的，应用照样能用", async (_name, text) => {
    await store.writeRaw(text);
    expect(await store.list()).toEqual([]);
  });

  test("坏文件被挪到一边，不是覆盖 —— 这是用户攒了几年的东西", async () => {
    await store.writeRaw("{{{");
    await store.list();

    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith("words.json.corrupt."))).toBe(true);
    // 原来的内容还在那份挪走的文件里。
    const corrupt = files.find((f) => f.startsWith("words.json.corrupt."));
    expect(await readFile(join(dir, corrupt as string), "utf8")).toBe("{{{");
  });

  test("挪走之后照样能继续加词", async () => {
    await store.writeRaw("{{{");
    await store.add("after");
    expect((await store.list()).map((w) => w.word)).toEqual(["after"]);
  });
});

describe("E. 离线", () => {
  test("整条链只碰文件系统 —— 落地的是一份人能读的 JSON", async () => {
    await store.annotate("offline", "不联网");
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    expect(raw["schema_version"]).toBe(1);
    expect(raw["words"]).toEqual([
      { word: "offline", addedAt: expect.any(Number), note: "不联网" },
    ]);
  });

  test("换一个 store 实例读同一个文件，内容还在", async () => {
    await store.add("persisted");
    expect(await new WordStore(path).list()).toHaveLength(1);
  });
});
