import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyImport,
  titleFromPath,
  DictError,
  DictLookup,
  MAX_LINK_HOPS,
  type InstalledDict,
  type MdictReader,
} from "@/core/dict/mdict";
import { DictStore } from "@/storage/dict-store";

/**
 * mdict 词典 —— 迁移计划 M4.1。
 *
 * ## 输入空间分类
 *
 *   A. 导入的挑选 —— 一个 mdx、零个、多个、大小写
 *   B. 查词与转跳 —— `@@@LINK=`、成环、查不到
 *   C. reader 缓存 —— 同一本不重复解析  ⭐
 *   D. 安装与卸载 —— 文件真的被复制走了  ⭐
 *   E. 清单坏掉时不让应用起不来
 *   F. 真文件 —— 用一本合成词典跑通整条链  ⭐
 *
 * **C、D、F 三组分别对应参考实现的三个缺陷**，都是「不报错」的那种：
 *
 *   C ← 它的 `currentDictHash` 从来没被赋值过，每查一个词都把整本词典
 *       重新解析一遍。只是慢，不报错。
 *   D ← 它复制了文件，返回的却是源路径。用户拔了 U 盘就查不了词，
 *       而清单里那条词典看起来完全正常。
 *   F ← 前五组都能用假 reader 测完，但那样验不了「这个库真的能读文件」。
 *       所以有一本 4 个词的合成词典（`tests/fixtures/test-dict.mdx`，
 *       由 `scripts/make-test-mdx.ts` 生成，无版权内容）。
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/test-dict.mdx", import.meta.url));

const dictOf = (overrides: Partial<InstalledDict> = {}): InstalledDict => ({
  hash: "a".repeat(32),
  title: "Test",
  mdx: "/dicts/a/Test.mdx",
  mdds: [],
  installedAt: 1,
  ...overrides,
});

/** 假 reader：一张表。用来把「我们的逻辑」和「那个库」分开测。 */
function fakeReader(table: Record<string, string | null>): MdictReader {
  return {
    lookup: (word) =>
      word in table ? { keyText: word, definition: table[word] ?? null } : null,
  };
}

describe("A. 导入时挑选文件", () => {
  test("一个 mdx 加若干 mdd", () => {
    const found = classifyImport(["/x/C.mdx", "/x/C.mdd", "/x/C.1.mdd"]);
    expect(found.mdx).toBe("/x/C.mdx");
    expect(found.mdds).toEqual(["/x/C.mdd", "/x/C.1.mdd"]);
  });

  test("只有 mdd 没有 mdx → 抛，且说清楚正文在哪", () => {
    expect(() => classifyImport(["/x/C.mdd"])).toThrow(DictError);
    expect(() => classifyImport(["/x/C.mdd"])).toThrow(/正文在 \.mdx/);
  });

  test("两个 mdx → 抛。两本词典合成一条记录，用户看到的和查到的会是两本", () => {
    expect(() => classifyImport(["/x/A.mdx", "/x/B.mdx"])).toThrow(/一次只能导入一本/);
  });

  test("空列表 → 抛", () => {
    expect(() => classifyImport([])).toThrow(DictError);
  });

  test("扩展名大小写不敏感 —— Windows 上大写很常见", () => {
    const found = classifyImport(["/x/C.MDX", "/x/C.MDD"]);
    expect(found.mdx).toBe("/x/C.MDX");
    expect(found.mdds).toEqual(["/x/C.MDD"]);
  });

  test.each([
    ["/a/b/Collins.mdx", "Collins"],
    ["C:\\dicts\\Longman.MDX", "Longman"],
    ["Oxford.mdx", "Oxford"],
  ])("%s 的展示名是 %s", (path, title) => {
    expect(titleFromPath(path)).toBe(title);
  });
});

describe("B. 查词与转跳", () => {
  test("查得到就给释义", () => {
    const lookup = new DictLookup(() => fakeReader({ fast: "<div>quick</div>" }));
    expect(lookup.lookup("fast", dictOf())).toBe("<div>quick</div>");
  });

  test("查不到给 null，不给空字符串", () => {
    // 「没这个词」和「有但释义是空的」是两件事，界面上的处置也不同。
    const lookup = new DictLookup(() => fakeReader({}));
    expect(lookup.lookup("nope", dictOf())).toBeNull();
  });

  test("释义是空白也当成没有", () => {
    const lookup = new DictLookup(() => fakeReader({ x: "   " }));
    expect(lookup.lookup("x", dictOf())).toBeNull();
  });

  test("尾部的 NUL 被去掉 —— 它不显示、不报错，但会跟着复制粘贴走", () => {
    const lookup = new DictLookup(() => fakeReader({ x: "<i>y</i>\u0000" }));
    expect(lookup.lookup("x", dictOf())).toBe("<i>y</i>");
  });

  test("@@@LINK= 转跳到目标词", () => {
    const lookup = new DictLookup(() =>
      fakeReader({ quick: "@@@LINK=fast", fast: "<div>real</div>" }),
    );
    expect(lookup.lookup("quick", dictOf())).toBe("<div>real</div>");
  });

  test("转跳成环时不死循环，返回 null", () => {
    // 参考实现这里没有深度上限，两个词互相指向就把主进程转死。
    const lookup = new DictLookup(() =>
      fakeReader({ a: "@@@LINK=b", b: "@@@LINK=a" }),
    );
    expect(lookup.lookup("a", dictOf())).toBeNull();
  });

  test(`连续 ${MAX_LINK_HOPS} 跳以内还查得到`, () => {
    const table: Record<string, string> = { end: "<div>done</div>" };
    let prev = "end";
    for (let i = 0; i < MAX_LINK_HOPS; i++) {
      table[`n${i}`] = `@@@LINK=${prev}`;
      prev = `n${i}`;
    }
    const lookup = new DictLookup(() => fakeReader(table));
    expect(lookup.lookup(prev, dictOf())).toBe("<div>done</div>");
  });

  test("reader 抛错时当成查不到，不让整个查词崩掉", () => {
    const lookup = new DictLookup(() => ({
      lookup: () => {
        throw new Error("文件坏了");
      },
    }));
    expect(lookup.lookup("x", dictOf())).toBeNull();
  });
});

describe("C. reader 缓存 —— 同一本词典不重复解析", () => {
  test("查十次只解析一次", () => {
    // 参考实现的 currentDictHash 从来没被赋值过，所以它这里是十次。
    let opened = 0;
    const lookup = new DictLookup(() => {
      opened++;
      return fakeReader({ x: "y" });
    });

    for (let i = 0; i < 10; i++) lookup.lookup("x", dictOf());
    expect(opened).toBe(1);
  });

  test("不同词典各解析一次", () => {
    let opened = 0;
    const lookup = new DictLookup(() => {
      opened++;
      return fakeReader({ x: "y" });
    });

    lookup.lookup("x", dictOf({ hash: "a".repeat(32) }));
    lookup.lookup("x", dictOf({ hash: "b".repeat(32) }));
    expect(opened).toBe(2);
    expect(lookup.cachedCount).toBe(2);
  });

  test("超过上限时淘汰最久没用的那本 —— 词典是大文件，不能全留着", () => {
    const lookup = new DictLookup(() => fakeReader({ x: "y" }), 2);

    lookup.lookup("x", dictOf({ hash: "a".repeat(32) }));
    lookup.lookup("x", dictOf({ hash: "b".repeat(32) }));
    lookup.lookup("x", dictOf({ hash: "c".repeat(32) }));

    expect(lookup.cachedCount).toBe(2);
  });

  test("命中会刷新使用顺序，不是纯粹按插入顺序淘汰", () => {
    let opened = 0;
    const lookup = new DictLookup(() => {
      opened++;
      return fakeReader({ x: "y" });
    }, 2);

    const a = dictOf({ hash: "a".repeat(32) });
    const b = dictOf({ hash: "b".repeat(32) });
    const c = dictOf({ hash: "c".repeat(32) });

    lookup.lookup("x", a);
    lookup.lookup("x", b);
    lookup.lookup("x", a); // a 变成最近使用
    lookup.lookup("x", c); // 该淘汰的是 b
    lookup.lookup("x", a); // a 还在，不该重新解析

    expect(opened).toBe(3);
  });

  test("卸载之后把 reader 丢掉", () => {
    let opened = 0;
    const lookup = new DictLookup(() => {
      opened++;
      return fakeReader({ x: "y" });
    });

    lookup.lookup("x", dictOf());
    lookup.forget(dictOf().hash);
    lookup.lookup("x", dictOf());

    expect(opened).toBe(2);
  });
});

describe("D. 安装与卸载", () => {
  let dir: string;
  let source: string;
  let store: DictStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "inkling-dict-"));
    source = join(dir, "source");
    await import("node:fs/promises").then((fs) => fs.mkdir(source, { recursive: true }));
    store = new DictStore(join(dir, "dictionaries"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function fakeDict(name: string, body = "mdx-bytes"): Promise<string> {
    const path = join(source, `${name}.mdx`);
    await writeFile(path, body, "utf8");
    return path;
  }

  test("装完之后清单里有它", async () => {
    const dict = await store.install([await fakeDict("Collins")]);
    expect(dict.title).toBe("Collins");
    expect((await store.list()).map((d) => d.hash)).toEqual([dict.hash]);
  });

  test("文件真的被复制到词典目录里了", async () => {
    // 参考实现复制了文件却返回源路径。用户拔了 U 盘就查不了词，
    // 而清单里那条词典看起来完全正常。
    const dict = await store.install([await fakeDict("Collins")]);

    expect(dict.mdx).toContain(dict.hash);
    expect(dict.mdx).not.toContain("source");
    expect(await readFile(dict.mdx, "utf8")).toBe("mdx-bytes");
  });

  test("源文件删掉之后仍然读得到", async () => {
    const path = await fakeDict("Collins");
    const dict = await store.install([path]);
    await rm(path);

    expect(await readFile(dict.mdx, "utf8")).toBe("mdx-bytes");
  });

  test("mdd 也一起复制", async () => {
    const mdx = await fakeDict("Collins");
    const mdd = join(source, "Collins.mdd");
    await writeFile(mdd, "mdd-bytes", "utf8");

    const dict = await store.install([mdx, mdd]);
    expect(dict.mdds).toHaveLength(1);
    expect(await readFile(dict.mdds[0] as string, "utf8")).toBe("mdd-bytes");
  });

  test("按内容哈希分目录 —— 同一本装两次是覆盖，不是两条", async () => {
    const path = await fakeDict("Collins");
    await store.install([path]);
    await store.install([path]);

    expect(await store.list()).toHaveLength(1);
    expect(await store.directories()).toHaveLength(1);
  });

  test("内容不同就是两本，哪怕文件名一样", async () => {
    await store.install([await fakeDict("Collins", "one")]);
    await store.install([await fakeDict("Collins", "two")]);

    expect(await store.list()).toHaveLength(2);
  });

  test("卸载把清单和文件一起删掉", async () => {
    const dict = await store.install([await fakeDict("Collins")]);
    await store.remove(dict.hash);

    expect(await store.list()).toEqual([]);
    expect(await store.directories()).toEqual([]);
  });

  test("卸载一本不存在的不抛 —— 幂等", async () => {
    await expect(store.remove("z".repeat(32))).resolves.toBeUndefined();
  });

  test("列表按安装时间倒序，刚装的排前面", async () => {
    // 内容必须不同，否则按内容哈希是同一本（上一条用例断言的正是这个）。
    const a = await store.install([await fakeDict("A", "first")], 1000);
    const b = await store.install([await fakeDict("B", "second")], 2000);

    expect((await store.list()).map((d) => d.hash)).toEqual([b.hash, a.hash]);
  });

  test("没装过任何词典时返回空数组，不抛", async () => {
    expect(await store.list()).toEqual([]);
  });
});

describe("E. 清单坏掉时", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "inkling-dict-bad-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test.each([
    ["不是 JSON", "{{{"],
    ["dicts 不是数组", '{"dicts":42}'],
    ["词典条目缺 hash", '{"dicts":[{"title":"x","mdx":"y","mdds":[],"installedAt":1}]}'],
    ["词典条目缺 mdx", '{"dicts":[{"hash":"h","title":"x","mdds":[],"installedAt":1}]}'],
  ])("%s → 当成空清单，应用照样起得来", async (_name, text) => {
    const store = new DictStore(dir);
    await store.install([]).catch(() => {}); // 只为把目录建出来
    await writeFile(join(dir, "index.json"), text, "utf8");

    expect(await store.list()).toEqual([]);
  });

  test("坏掉的清单被挪到一边，不是覆盖 —— 里面记着用户装过什么", async () => {
    const store = new DictStore(dir);
    await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
    await writeFile(join(dir, "index.json"), "{{{", "utf8");

    await store.list();
    const files = await readdir(dir);
    expect(files.some((f) => f.includes("corrupt"))).toBe(true);
  });
});

describe("F. 真文件 —— 一本合成词典跑通整条链", () => {
  let dir: string;
  let store: DictStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "inkling-dict-real-"));
    store = new DictStore(join(dir, "dictionaries"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** 真的 `@divisey/js-mdict`。前面五组都用假 reader，只有这一组用它。 */
  async function realFactory() {
    const mod = (await import("@divisey/js-mdict")) as unknown as {
      Mdict: new (path: string, options?: { resort?: boolean }) => MdictReader;
    };
    return (mdxPath: string): MdictReader => new mod.Mdict(mdxPath, { resort: true });
  }

  test("导入一个 .mdx，查一个词 —— M4.1 的验收", async () => {
    const dict = await store.install([FIXTURE]);
    const lookup = new DictLookup(await realFactory());

    expect(lookup.lookup("ask", dict)).toMatch(/to say something/);
  });

  test("查一个不存在的词 → null", async () => {
    const dict = await store.install([FIXTURE]);
    const lookup = new DictLookup(await realFactory());

    expect(lookup.lookup("zzzznotaword", dict)).toBeNull();
  });

  test("真词典里的 @@@LINK= 也转跳", async () => {
    // 夹具里 quick → fast，专门为这条放的。
    const dict = await store.install([FIXTURE]);
    const lookup = new DictLookup(await realFactory());

    expect(lookup.lookup("quick", dict)).toMatch(/moving or able to move quickly/);
  });

  test("释义里没有尾部的 NUL", async () => {
    const dict = await store.install([FIXTURE]);
    const lookup = new DictLookup(await realFactory());

    expect(lookup.lookup("think", dict)).not.toContain("\u0000");
  });

  test("查的是复制进词典目录的那一份，不是源文件", async () => {
    const dict = await store.install([FIXTURE]);
    expect(dict.mdx).toContain(dict.hash);

    const lookup = new DictLookup(await realFactory());
    expect(lookup.lookup("fast", dict)).not.toBeNull();
  });
});
