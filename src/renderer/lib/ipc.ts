/**
 * 渲染层这一侧的 IPC 门面。
 *
 * `window.inkling` 是 preload 暴露的那**一个** namespace，八个方法各对应
 * M2.5 的一个 handler。这个文件只做两件事：给它一个类型，以及把
 * 「结果是 JSON 还是字节」这个判断收在一处。
 *
 * **渲染层不 import `src/core` 或 `src/storage`。** 那些东西只在主进程跑，
 * 而 vite 的 renderer 配置里刻意没有 `@/` alias——这条纪律是机械保证的，
 * 不靠自觉。
 */

/** 和主进程 `ipc.ts` 里的 `IpcResult` 同形。 */
export type IpcJson = { status: number; body: unknown; headers?: Record<string, string> };
export type IpcBytes = { status: number; bytes: ArrayBuffer; headers: Record<string, string> };
export type IpcResult = IpcJson | IpcBytes;

export function isBytes(result: IpcResult): result is IpcBytes {
  return "bytes" in result;
}

/** 一本已安装的词典。和 `@/core/dict/mdict` 的 `InstalledDict` 同形。 */
export interface InstalledDict {
  hash: string;
  title: string;
  mdx: string;
  mdds: string[];
  installedAt: number;
}

export interface SavedWord {
  word: string;
  addedAt: number;
  note?: string;
}

/** 导入的结果。**取消不是失败**，所以它有自己的取值——界面不该为取消弹红字。 */
export type ImportOutcome =
  | { ok: true; dict: InstalledDict }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; message: string };

/**
 * 词典与生词本。**可选功能**——没装词典时列表是空的，主链路照常。
 *
 * 单列一组而不是拍平进上面那八个：那八个是契约的一部分，
 * 这一组不是。见 `src/electron/dict-ipc.ts` 的文件头。
 */
export interface DictBridge {
  list(): Promise<InstalledDict[]>;
  import(): Promise<ImportOutcome>;
  remove(hash: string): Promise<void>;
  lookup(word: string, hash: string): Promise<string | null>;
}

export interface WordsBridge {
  list(): Promise<SavedWord[]>;
  add(word: string): Promise<SavedWord>;
  annotate(word: string, note: string): Promise<SavedWord>;
  remove(word: string): Promise<void>;
}

export interface InklingBridge {
  getConfig(): Promise<IpcResult>;
  postMaterials(raw: string): Promise<IpcResult>;
  getMaterials(limit: string | null): Promise<IpcResult>;
  getMaterialDetail(id: string): Promise<IpcResult>;
  postTts(raw: string): Promise<IpcResult>;
  postAssess(
    query: Record<string, string | undefined>,
    body: ArrayBuffer,
  ): Promise<IpcResult>;
  getRecordingAudio(id: string): Promise<IpcResult>;
  getAudio(name: string): Promise<IpcResult>;
  dict: DictBridge;
  words: WordsBridge;
}

declare global {
  interface Window {
    inkling?: InklingBridge;
  }
}

/**
 * 取桥。缺席时**当场抛**，不返回 null。
 *
 * 桥不在只有一个原因：preload 没跑起来。那种情况下界面上每一个按钮都不工作，
 * 逐个位置去做 null 检查只会把同一个故障摊成十几种奇怪的表现。
 */
export function bridge(): InklingBridge {
  const found = globalThis.window?.inkling;
  if (!found) {
    throw new Error("preload 没有装上（window.inkling 不存在）——主进程可能起失败了。");
  }
  return found;
}
