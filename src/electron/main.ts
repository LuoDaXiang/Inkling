import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDeps } from "./deps";
import { loadEnvFile } from "./env-file";
import { register } from "./ipc";
import { registerDict, realReaderFactory } from "./dict-ipc";
import { DictLookup } from "@/core/dict/mdict";
import { DictStore } from "@/storage/dict-store";
import { WordStore } from "@/storage/word-store";
import type { DatabaseSync } from "node:sqlite";

/**
 * Electron 主进程。**只做三件事**：开窗口、跑 `src/core` + `src/storage`、
 * 注册八个 `ipcMain.handle`。
 *
 * 「只做三件事」不是一句口号，是这个文件长度的上限。参考实现的主进程
 * 长成 177 个频道，是因为渲染层没有自己的存储抽象、账号状态又必须在主进程——
 * 每加一个界面状态就得加一个频道。这里 UI 状态一律走 localStorage（M3.4），
 * IPC 通道里只有那八件真正需要主进程的事。
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Forge 的 Vite 插件注入的常量。dev 时是 devServer 的 URL，打包后是 undefined。 */
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string | undefined;

let db: DatabaseSync | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: "Inkling",
    webPreferences: {
      // `.mjs` 不是笔误：Electron 只在这个扩展名下把 preload 当 ES module
      // 加载，见 vite.preload.config.ts。
      preload: join(here, "preload.mjs"),
      // 三个都不能松。渲染层跑的是我们自己的代码，但 `contextIsolation`
      // 关掉就等于把整个 Node API 暴露给任何一个第三方依赖。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string") {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(join(here, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

app.whenReady().then(() => {
  // 开发时才读 .env.local —— 见 env-file.ts 里那段关于为什么不在打包版本
  // 里这么干的注释。
  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string") {
    loadEnvFile(join(app.getAppPath(), ".env.local"));
  }

  const built = buildDeps({
    // 用户数据落在系统的 userData 目录，不落在应用包里——
    // 打包后的 .app 是只读的，而且升级会整个换掉。
    dataDir: join(app.getPath("userData"), "data"),
  });

  if (!built.ok) {
    dialog.showErrorBox("Inkling 起不来", built.problems.join("\n\n"));
    app.quit();
    return;
  }

  db = built.db;
  register(ipcMain, built.deps);

  /*
   * 词典与生词本。**可选功能**，所以这一段有两条纪律：
   *
   * 1. **同步注册，在开窗口之前。** 异步注册会留一个竞态：窗口先渲染、
   *    调 `dict.list()`，那时频道还没注册，渲染层拿到 "No handler registered"。
   *    冷启动偶发，看起来像「词典功能时好时坏」。
   * 2. **它挂了不能拖垮窗口。** 一度把 `createWindow()` 塞进
   *    `void realReaderFactory().then(...)` 里——那样一来，词典模块只要加载
   *    失败，窗口就根本不开，而 `void` 会把 rejection 吞掉：屏幕和日志里
   *    都什么都没有。可选功能失败必须只让它自己失效，所以它在 try 里，
   *    `createWindow()` 在外面。
   */
  const dataDir = join(app.getPath("userData"), "data");
  try {
    registerDict(ipcMain, {
      dicts: new DictStore(join(dataDir, "dictionaries")),
      words: new WordStore(join(dataDir, "words.json")),
      lookup: new DictLookup(realReaderFactory()),
      pickFiles: async () => {
        const picked = await dialog.showOpenDialog({
          title: "选择词典文件",
          // 一次可以多选：一本词典常常是 .mdx 加若干 .mdd。
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "mdict 词典", extensions: ["mdx", "mdd"] }],
        });
        return picked.canceled ? [] : picked.filePaths;
      },
    });
  } catch (err) {
    // 词典没了，练习照常。**但要说出来**——静默降级会让人以为
    // 「这个应用就是查不了词」，而不是「这台机器上它坏了」。
    console.error("[dict] 词典功能没能装上，其余功能不受影响：", err);
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * 关库必须做。
 *
 * 开了 WAL 之后，最近的事务在 `.db-wal` 里；正常关闭会做一次 checkpoint
 * 把它们合回主文件。进程被硬杀不会丢数据（下次打开会自动恢复），
 * 但留着一个没合并的 `-wal` 文件，会让「只拷 .db 当备份」的人丢数据。
 */
app.on("will-quit", () => {
  try {
    db?.close();
  } catch {
    // 已经关了
  }
});
