import type { IpcMain } from "electron";
import {
  getAudio,
  getConfig,
  getMaterialDetail,
  getMaterials,
  getRecordingAudio,
  postAssess,
  postMaterials,
  postTts,
  type HandlerResult,
  type Query,
  type ServerDeps,
} from "@/http/server";

/**
 * IPC 适配器。
 *
 * 这个文件是 M2.5 那一步的收款：八个 handler 早就不认识 `ServerResponse` 了，
 * 所以换传输**只是换适配器**——handler 一行没动，那 129 条路由用例一条没改。
 * HTTP 那边的 `dispatch()` 与这里的 `register()` 是同一件事的两种写法。
 *
 * ## 为什么是换，不是并存（迁移计划 M3「关于那 8 条路由」）
 *
 * **保留 HTTP** 意味着桌面应用开一个无鉴权的本机端口：同机任何进程都能调
 * `/api/tts` 花掉你的 Azure 额度，而那 9 条路由无一条检查来源。
 * **两者并存**更糟：两套入口、两套错误处理、两份契约——而 `contract.ts`
 * 存在的全部意义就是消灭这种分叉。
 *
 * ## 一个 namespace，八个方法
 *
 * 参考实现的 `preload.ts` 是 808 行、186 个频道、36 个 namespace，
 * renderer 里 114 个文件直接调它。那是被账号体系和主进程数据库倒逼出来的形状，
 * 不是设计出来的。这里每个频道**直接对应一个 handler**，没有第二种形状。
 */

/** 频道名。前缀是唯一的 namespace——不分 36 个。 */
export const CHANNELS = {
  getConfig: "inkling:getConfig",
  postMaterials: "inkling:postMaterials",
  getMaterials: "inkling:getMaterials",
  getMaterialDetail: "inkling:getMaterialDetail",
  postTts: "inkling:postTts",
  postAssess: "inkling:postAssess",
  getRecordingAudio: "inkling:getRecordingAudio",
  getAudio: "inkling:getAudio",
} as const;

/**
 * 跨进程传回渲染层的结果。
 *
 * 和 `HandlerResult` 几乎同形，只有一处不同：二进制那一支的 `bytes` 换成
 * `ArrayBuffer`。`Uint8Array` 走 structured clone 是可以的，但它会连着
 * 底层 buffer 的 `byteOffset` 一起过去，而 `subarray` 出来的视图偏移不为零——
 * 渲染层拿到一段看起来对、实际错位的音频，**而且不报错**。
 * 在边界上转成一段独立的 `ArrayBuffer`，这个坑就不存在。
 */
export type IpcResult =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | { status: number; bytes: ArrayBuffer; headers: Record<string, string> };

export function toIpcResult(result: HandlerResult): IpcResult {
  if (!("bytes" in result)) return result;
  const { bytes, ...rest } = result;
  // slice() 而不是 .buffer：见上面那段关于 byteOffset 的注释。
  return { ...rest, bytes: bytes.slice().buffer as ArrayBuffer };
}

/**
 * 注册八个频道。
 *
 * `ipcMain` 与 `deps` 都是参数传进来的，所以这个函数**不 import electron 的
 * 运行时**（只 import 它的类型），也就能在测试里用一个假的 `IpcMain` 完整跑一遍。
 * 这和 core/ 那一层「provider 是参数」是同一条纪律。
 */
export function register(ipcMain: IpcMain, deps: ServerDeps): void {
  ipcMain.handle(CHANNELS.getConfig, async () => toIpcResult(await getConfig(deps)));

  ipcMain.handle(CHANNELS.postMaterials, async (_event, raw: string) =>
    toIpcResult(await postMaterials({ raw }, deps)),
  );

  ipcMain.handle(CHANNELS.getMaterials, async (_event, limit: string | null) =>
    toIpcResult(await getMaterials({ limit }, deps)),
  );

  ipcMain.handle(CHANNELS.getMaterialDetail, async (_event, id: string) =>
    toIpcResult(await getMaterialDetail({ id }, deps)),
  );

  ipcMain.handle(CHANNELS.postTts, async (_event, raw: string) =>
    toIpcResult(await postTts({ raw }, deps)),
  );

  ipcMain.handle(
    CHANNELS.postAssess,
    async (_event, query: Query, body: ArrayBuffer) =>
      toIpcResult(await postAssess({ query, body: new Uint8Array(body) }, deps)),
  );

  ipcMain.handle(CHANNELS.getRecordingAudio, async (_event, id: string) =>
    toIpcResult(await getRecordingAudio({ id }, deps)),
  );

  ipcMain.handle(CHANNELS.getAudio, async (_event, name: string) =>
    toIpcResult(await getAudio({ name }, deps)),
  );
}
