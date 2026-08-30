/*
 * 来自 shadcn/ui（MIT），经由 enjoy v0.7.9 的 components/ui/ 引入，未作改动。
 *
 * 这批组件不是参考实现自己写的，是 shadcn CLI 生成的样板——所以 decisions 0001
 * 那条「Enjoy 只作为参考读，不复制代码」在这里不适用：复制的是 shadcn 的样板，
 * 不是它的取舍。九个文件共 416 行，全都不依赖 Radix。
 */
import { cn } from "@renderer/lib/utils";

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-primary/10", className)}
      {...props}
    />
  );
}

export { Skeleton };
