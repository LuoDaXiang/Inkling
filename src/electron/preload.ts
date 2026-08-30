import { contextBridge, ipcRenderer } from "electron";

/**
 * preload —— **一个 namespace**。八个契约方法，每个直接对应 M2.5 的一个
 * handler；外加词典与生词本两组可选方法（M4）。
 *
 * 参考实现的 preload 是 808 行、186 个频道、36 个 namespace，renderer 里
 * 114 个文件直接调它。那形状是被账号体系和主进程数据库倒逼出来的，不是设计。
 * 这里的上限写在迁移计划里：**不超过 60 行**。
 *
 * 频道名在这里再写一遍字面量，没有 import `CHANNELS`——preload 在
 * `contextIsolation` 下是独立打包的一小段代码，从 `@/http/server` 那条链
 * 拉一个常量进来会把整个服务端依赖树拖进 preload bundle。字符串对不上的话
 * 第一次点击就会报 "No handler registered"，不是那种会静默错的东西。
 *
 * **词典那一组另起前缀**（`inkling:dict:` / `inkling:word:`），
 * 不混进上面那八个。那八个是契约的一部分，一一对应 M2.5 的八个 handler；
 * 词典是可选功能，没装词典的用户整条主链路照常工作。混在一起，
 * 「八个频道」这条一眼可查的性质就没了——参考实现的 preload 长到
 * 186 个频道，就是从「再加一个」开始的。
 */
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("inkling", {
  getConfig: () => invoke("inkling:getConfig"),
  postMaterials: (raw: string) => invoke("inkling:postMaterials", raw),
  getMaterials: (limit: string | null) => invoke("inkling:getMaterials", limit),
  getMaterialDetail: (id: string) => invoke("inkling:getMaterialDetail", id),
  postTts: (raw: string) => invoke("inkling:postTts", raw),
  postAssess: (query: Record<string, string | undefined>, body: ArrayBuffer) =>
    invoke("inkling:postAssess", query, body),
  getRecordingAudio: (id: string) => invoke("inkling:getRecordingAudio", id),
  getAudio: (name: string) => invoke("inkling:getAudio", name),

  // ---- 词典与生词本（M4，可选功能）----
  dict: {
    list: () => invoke("inkling:dict:list"),
    import: () => invoke("inkling:dict:import"),
    remove: (hash: string) => invoke("inkling:dict:remove", hash),
    lookup: (word: string, hash: string) => invoke("inkling:dict:lookup", word, hash),
  },
  words: {
    list: () => invoke("inkling:word:list"),
    add: (word: string) => invoke("inkling:word:add", word),
    annotate: (word: string, note: string) => invoke("inkling:word:annotate", word, note),
    remove: (word: string) => invoke("inkling:word:remove", word),
  },
});
