import { rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/**
 * 原子写文件：先写临时文件，再 rename。
 *
 * 抽出来是因为有两个 store 需要它（TTS 缓存与录音），而**重抄一遍正是
 * F15 那个坑的形状**——那次的教训不是「某个文件写错了」，是「直接写目标
 * 路径」这个做法本身会产生永久损坏，所以它不该有第二份实现。
 *
 * 直接 `writeFile(目标路径, 字节)` 有两条路会留下一个坏文件：
 *
 *   1. **并发**。两个写者同时写同一路径，`writeFile` 先截断再写，
 *      交错的结果既不是 A 也不是 B。
 *   2. **中断**。进程被杀或磁盘满，留下一个截断的文件。
 *
 * 同目录内的 rename 在 POSIX 上是原子的：要么看到完整的旧文件，
 * 要么看到完整的新文件，不存在中间态。临时文件带随机后缀，
 * 所以并发的两个写者不会互相踩；失败时把它收走，别在目录里堆垃圾。
 */

/** 临时文件后缀。必须是各 store 的键格式认不出来的形状，免得半路夭折的文件被当成命中。 */
export const TEMP_SUFFIX = ".tmp";

export async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}${TEMP_SUFFIX}`;
  try {
    await writeFile(temp, bytes);
    await rename(temp, path);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
}
