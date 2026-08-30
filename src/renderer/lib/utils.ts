import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 class 名，后写的赢。
 *
 * `clsx` 负责条件拼接，`tailwind-merge` 负责让 `px-2 px-4` 只剩 `px-4`——
 * 少了后者，组件的默认 class 和调用方传进来的 class 会同时生效，
 * 谁赢取决于 CSS 里谁在后面，**而那是不确定的**。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
