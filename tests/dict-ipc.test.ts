import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcMain } from "electron";
import { DICT_CHANNELS, registerDict, type ImportOutcome } from "@/electron/dict-ipc";
import { DictLookup, type MdictReader } from "@/core/dict/mdict";
import { DictStore } from "@/storage/dict-store";
import { WordStore } from "@/storage/word-store";
import type { InstalledDict } from "@/core/dict/mdict";
import type { SavedWord } from "@/storage/word-store";

/**
 * 词典与生词本的 IPC 接线 —— 迁移计划 M4.2 / M4.3。
 *
 * 测的是**接缝**：频道注册全没全、参数怎么进来的、取消怎么表达、
 * 卸载有没有把 reader 缓存一起清掉。业务逻辑本身在
 * `tests/mdict.test.ts` 与 `tests/word-store.test.ts` 里测过了。
 *
 * `ipcMain` 和 `pickFiles` 都是参数传进来的，所以这一整套能在测试里
 * 跑完，**不需要一个真的 Electron 进程**——和 core/ 那层「provider 是参数」
 * 同一条纪律。
 */

/**
 * 一个够用的假 `IpcMain`：把 handler 收起来，让测试直接调。
 *
 * 这就是 `registerDict(ipcMain, deps)` 把 `ipcMain` 做成参数换来的东西——
 * 整套频道能在 node 环境里跑完，不需要起一个 Electron 进程。
 */
interface IpcHarness {
  ipcMain: IpcMain;
  call: (channel: string, ...args: unknown[]) => Promise<unknown>;
  channelList: () => string[];
}

function fakeIpc(): IpcHarness {
  type Handler = (event: unknown, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();

  const ipcMain = {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  } as unknown as IpcMain;

  return {
    ipcMain,
    call: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`没有注册频道 ${channel}`);
      return handler(null, ...args);
    },
    channelList: () => [...handlers.keys()],
  };
}

const FIXTURE = fileURLToPath(new URL("./fixtures/test-dict.mdx", import.meta.url));

let dir: string;
let dicts: DictStore;
let words: WordStore;
let opened: string[];
let picked: string[];
let harness: IpcHarness;

/** 假 reader 工厂：记录被打开过几次，用来验「卸载清掉缓存」。 */
function factory(mdxPath: string): MdictReader {
  opened.push(mdxPath);
  return { lookup: (word) => (word === "fast" ? { definition: "<b>quick</b>" } : null) };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkling-dictipc-"));
  dicts = new DictStore(join(dir, "dictionaries"));
  words = new WordStore(join(dir, "words.json"));
  opened = [];
  picked = [];
  harness = fakeIpc();

  registerDict(harness.ipcMain, {
    dicts,
    words,
    lookup: new DictLookup(factory),
    pickFiles: async () => picked,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("频道注册", () => {
  test("八个频道一个不少", () => {
    expect(harness.channelList().sort()).toEqual([...Object.values(DICT_CHANNELS)].sort());
  });

  test("频道名都在 inkling: 这个 namespace 下", () => {
    for (const channel of Object.values(DICT_CHANNELS)) {
      expect(channel.startsWith("inkling:")).toBe(true);
    }
  });

  test("和那八个契约频道不重名 —— 词典是可选功能，不混进契约", () => {
    for (const channel of Object.values(DICT_CHANNELS)) {
      expect(channel).toMatch(/^inkling:(dict|word):/);
    }
  });
});

describe("导入", () => {
  test("用户选了文件 → 装上并回传词典", async () => {
    picked = [FIXTURE];
    const outcome = (await harness.call(DICT_CHANNELS.import)) as ImportOutcome;

    expect(outcome.ok).toBe(true);
    expect((outcome as { dict: InstalledDict }).dict.title).toBe("test-dict");
    expect(await dicts.list()).toHaveLength(1);
  });

  test("用户取消 → cancelled，**不是错误**", async () => {
    // 点开对话框又关掉是最常见的操作。把它报成失败，
    // 用户会以为自己弄坏了什么。
    picked = [];
    const outcome = (await harness.call(DICT_CHANNELS.import)) as ImportOutcome;

    expect(outcome).toEqual({ ok: false, cancelled: true });
  });

  test("选了一堆没有 mdx 的文件 → 失败并说清楚原因", async () => {
    const mdd = join(dir, "x.mdd");
    await writeFile(mdd, "not a dict", "utf8");
    picked = [mdd];

    const outcome = (await harness.call(DICT_CHANNELS.import)) as ImportOutcome;
    expect(outcome.ok).toBe(false);
    expect((outcome as { cancelled: boolean }).cancelled).toBe(false);
    expect((outcome as { message: string }).message).toMatch(/\.mdx/);
  });

  test("失败不抛到渲染层 —— 一个 IPC 异常在那边只剩一句 Error invoking remote method", async () => {
    picked = ["/nonexistent/nope.mdx"];
    const outcome = (await harness.call(DICT_CHANNELS.import)) as ImportOutcome;
    expect(outcome.ok).toBe(false);
  });
});

describe("列表与卸载", () => {
  test("列表给出已装的词典", async () => {
    picked = [FIXTURE];
    await harness.call(DICT_CHANNELS.import);

    const listed = (await harness.call(DICT_CHANNELS.list)) as InstalledDict[];
    expect(listed).toHaveLength(1);
  });

  test("卸载之后列表空了", async () => {
    picked = [FIXTURE];
    const outcome = (await harness.call(DICT_CHANNELS.import)) as { dict: InstalledDict };
    await harness.call(DICT_CHANNELS.remove, outcome.dict.hash);

    expect(await harness.call(DICT_CHANNELS.list)).toEqual([]);
  });

  test("卸载会把缓存的 reader 一起丢掉 —— 否则删完还查得出词", async () => {
    picked = [FIXTURE];
    const outcome = (await harness.call(DICT_CHANNELS.import)) as { dict: InstalledDict };

    await harness.call(DICT_CHANNELS.lookup, "fast", outcome.dict.hash);
    expect(opened).toHaveLength(1);

    await harness.call(DICT_CHANNELS.remove, outcome.dict.hash);
    // 删掉之后再查：词典已经不在清单里，所以是 null，
    // 而且**不该**再拿缓存里那个 reader 去读一个已经删掉的文件。
    expect(await harness.call(DICT_CHANNELS.lookup, "fast", outcome.dict.hash)).toBeNull();
    expect(opened).toHaveLength(1);
  });
});

describe("查词", () => {
  test("查得到", async () => {
    picked = [FIXTURE];
    const outcome = (await harness.call(DICT_CHANNELS.import)) as { dict: InstalledDict };

    expect(await harness.call(DICT_CHANNELS.lookup, "fast", outcome.dict.hash)).toBe(
      "<b>quick</b>",
    );
  });

  test("词典 hash 对不上 → null，不抛", async () => {
    expect(await harness.call(DICT_CHANNELS.lookup, "fast", "z".repeat(32))).toBeNull();
  });

  test("同一本词典查两次只打开一次文件", async () => {
    picked = [FIXTURE];
    const outcome = (await harness.call(DICT_CHANNELS.import)) as { dict: InstalledDict };

    await harness.call(DICT_CHANNELS.lookup, "fast", outcome.dict.hash);
    await harness.call(DICT_CHANNELS.lookup, "fast", outcome.dict.hash);

    expect(opened).toHaveLength(1);
  });
});

describe("生词本", () => {
  test("加了就列得出来", async () => {
    await harness.call(DICT_CHANNELS.wordAdd, "serendipity");
    const listed = (await harness.call(DICT_CHANNELS.wordList)) as SavedWord[];

    expect(listed.map((w) => w.word)).toEqual(["serendipity"]);
  });

  test("写笔记", async () => {
    await harness.call(DICT_CHANNELS.wordAnnotate, "word", "我的笔记");
    const listed = (await harness.call(DICT_CHANNELS.wordList)) as SavedWord[];

    expect(listed[0]?.note).toBe("我的笔记");
  });

  test("删掉", async () => {
    await harness.call(DICT_CHANNELS.wordAdd, "gone");
    await harness.call(DICT_CHANNELS.wordRemove, "gone");

    expect(await harness.call(DICT_CHANNELS.wordList)).toEqual([]);
  });

  test("生词本落在文件里，和词典目录分开", async () => {
    await harness.call(DICT_CHANNELS.wordAdd, "kept");
    await mkdir(join(dir, "dictionaries"), { recursive: true });

    // 换一个 store 实例读同一个文件——离线、可复原。
    expect(await new WordStore(join(dir, "words.json")).list()).toHaveLength(1);
  });
});
