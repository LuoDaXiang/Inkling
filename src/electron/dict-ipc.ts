import type { IpcMain } from "electron";
import { createRequire } from "node:module";
import { DictLookup, type MdictReader, type InstalledDict } from "@/core/dict/mdict";
import type { DictStore } from "@/storage/dict-store";
import type { WordStore } from "@/storage/word-store";

/**
 * 词典与生词本的 IPC —— 迁移计划 M4。
 *
 * ## 为什么另起一个文件而不是加进 `ipc.ts`
 *
 * `ipc.ts` 那八个频道是**契约的一部分**：它们一一对应 M2.5 那八个
 * 传输中立的 handler，`contract.ts` 下发的常量约束的也是它们。
 * 词典是一个可选功能——没装词典的用户整条主链路照常工作——
 * 把它混进那八个里，会让「八个频道」这条一眼可查的性质变成
 * 「八个再加几个说不清的」。参考实现的 preload 长到 186 个频道，
 * 就是从「再加一个」开始的。
 *
 * 仍然是**同一个 namespace**（`window.inkling`），只是频道名另起一组前缀。
 *
 * ## 打开文件对话框在主进程
 *
 * 渲染层拿不到文件系统，也不该拿到。导入词典是**用户主动发起**的操作：
 * 用户点「导入」→ 主进程开系统对话框 → 用户自己选文件 → 复制进词典目录。
 * 渲染层从头到尾没有碰过路径。
 */

export const DICT_CHANNELS = {
  list: "inkling:dict:list",
  import: "inkling:dict:import",
  remove: "inkling:dict:remove",
  lookup: "inkling:dict:lookup",
  wordList: "inkling:word:list",
  wordAdd: "inkling:word:add",
  wordAnnotate: "inkling:word:annotate",
  wordRemove: "inkling:word:remove",
} as const;

/** 一次导入的结果。取消对话框不是失败，所以它有自己的取值。 */
export type ImportOutcome =
  | { ok: true; dict: InstalledDict }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string };

export interface DictDeps {
  dicts: DictStore;
  words: WordStore;
  lookup: DictLookup;
  /**
   * 开文件对话框，返回用户选中的路径。取消时返回空数组。
   *
   * 是参数不是 import：这样这一整套频道能在测试里跑完，
   * 不需要一个真的 Electron 进程。
   */
  pickFiles: () => Promise<string[]>;
}

/**
 * 用真的 `@divisey/js-mdict` 造 reader。只有这一处碰那个库。
 *
 * ## 为什么是 `createRequire` 而不是 `await import()`
 *
 * 三件事凑在一起：那个包是 CJS；主进程打包成 ESM（`package.json` 有
 * `"type": "module"`，见 vite.main.config.ts）；而 `ReaderFactory` 是**同步**的。
 *
 * 最初写成 `async function` + `await import()`。那样一来频道注册也是异步的，
 * 于是要么留一个竞态（窗口先开、频道后注册），要么把 `createWindow()` 挂进
 * 那个 promise 的 `.then` 里——而后者意味着**一个可选功能的加载失败会让
 * 整个窗口不开**，并且 `void promise` 会把 rejection 吞掉，屏幕和日志里
 * 都什么都没有。两个选项都不好。
 *
 * 同步 require 把三件事一起解决：注册是同步的（没有竞态），加载失败在这里
 * 当场抛（调用方一个 try 就接住，有堆栈），而窗口的生死和词典无关。
 * 这个包也因此在 `vite.main.config.ts` 里被列为 external——
 * 和 `node:sqlite` 同样的理由：运行时从 node_modules 读，不进 bundle。
 */
export function realReaderFactory(): (mdxPath: string) => MdictReader {
  const require = createRequire(import.meta.url);
  const mod = require("@divisey/js-mdict") as {
    Mdict: new (path: string, options?: { resort?: boolean }) => MdictReader;
  };
  // `resort: true` 是那个库 5.0 之后的硬性要求，不传会抛。
  return (mdxPath: string) => new mod.Mdict(mdxPath, { resort: true });
}

export function registerDict(ipcMain: IpcMain, deps: DictDeps): void {
  ipcMain.handle(DICT_CHANNELS.list, async () => deps.dicts.list());

  ipcMain.handle(DICT_CHANNELS.import, async (): Promise<ImportOutcome> => {
    const paths = await deps.pickFiles();
    // 用户点了取消。这不是错误，界面不该弹红字。
    if (paths.length === 0) return { ok: false, cancelled: true };

    try {
      return { ok: true, dict: await deps.dicts.install(paths) };
    } catch (err) {
      return {
        ok: false,
        cancelled: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(DICT_CHANNELS.remove, async (_event, hash: string) => {
    await deps.dicts.remove(hash);
    // reader 缓存里那一份也要丢掉，否则删完还能查出词来。
    deps.lookup.forget(hash);
  });

  ipcMain.handle(
    DICT_CHANNELS.lookup,
    async (_event, word: string, hash: string): Promise<string | null> => {
      const dict = (await deps.dicts.list()).find((d) => d.hash === hash);
      if (!dict) return null;
      return deps.lookup.lookup(word, dict);
    },
  );

  ipcMain.handle(DICT_CHANNELS.wordList, async () => deps.words.list());

  ipcMain.handle(DICT_CHANNELS.wordAdd, async (_event, word: string) => deps.words.add(word));

  ipcMain.handle(DICT_CHANNELS.wordAnnotate, async (_event, word: string, note: string) =>
    deps.words.annotate(word, note),
  );

  ipcMain.handle(DICT_CHANNELS.wordRemove, async (_event, word: string) =>
    deps.words.remove(word),
  );
}
