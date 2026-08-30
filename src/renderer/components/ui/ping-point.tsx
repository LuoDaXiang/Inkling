/*
 * 来自 shadcn/ui（MIT），经由 enjoy v0.7.9 的 components/ui/ 引入，未作改动。
 *
 * 这批组件不是参考实现自己写的，是 shadcn CLI 生成的样板——所以 decisions 0001
 * 那条「Enjoy 只作为参考读，不复制代码」在这里不适用：复制的是 shadcn 的样板，
 * 不是它的取舍。九个文件共 416 行，全都不依赖 Radix。
 */
import { cn } from "@renderer/lib/utils";

export const PingPoint = (props: {
  colorClassName?: string;
  size?: number;
  className?: string;
}) => {
  const { colorClassName = "bg-sky-500", size = 2, className } = props;

  return (
    <span className={cn(`relative flex h-${size} w-${size}`, className)}>
      <span
        className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${colorClassName}`}
      ></span>
      <span
        className={`relative inline-flex rounded-full h-${size} w-${size} ${colorClassName}`}
      ></span>
    </span>
  );
};
