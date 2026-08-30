import * as React from "react";

/**
 * 界面状态 —— **走 localStorage，不走 IPC**（迁移计划 M3.4）。
 *
 * 参考实现有一个叫 `cacheObjects` 的 namespace，是它调用最多的一个（39 次），
 * 存的是「当前在哪个 tab」——一个键值表，走了一趟跨进程 IPC 落进 sequelize，
 * **只因为渲染层没有自己的存储抽象**。
 *
 * 判据很清楚：**这条状态丢了会怎样。**
 * 丢了只是下次打开回到默认值 → localStorage。
 * 丢了是用户的数据没了 → 主进程，落库。
 *
 * 音色、语速、上次输入的文本全属于前者。IPC 通道里没有 UI 状态。
 */

const PREFIX = "inkling:";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // 读不到、解析不了、浏览器禁了存储——都当成「没存过」。
    // 界面状态没有一条值得为它中断启动。
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // 存不进去（无痕模式、配额满）就算了。下次打开回默认值，不是故障。
  }
}

/**
 * 和 `useState` 同形，多一件事：值会被记住。
 *
 * 初值用 lazy initializer 读一次，之后每次变化写回去——
 * 不在 render 里读，那会让每次重渲染都碰一次同步存储。
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState<T>(() => read(key, initial));

  React.useEffect(() => {
    write(key, value);
  }, [key, value]);

  return [value, setValue];
}
