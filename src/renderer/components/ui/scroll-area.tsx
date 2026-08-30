import * as React from "react";
import { cn } from "@renderer/lib/utils";

/**
 * 手写，不装 `@radix-ui/react-scroll-area`（迁移计划 M3.6）。
 *
 * 那个包换掉的是**滚动条本身的外观**——它渲染一套自绘的滚动条，
 * 好让 Windows 上的粗滚动条和 macOS 上的悬浮滚动条长得一样。
 * 这是个真实的问题，但它的代价是：滚动位置、惯性、触控板的橡皮筋
 * 全部变成 JS 在算，而这三件事原生做得比任何库都好。
 *
 * 这里选原生滚动 + `scrollbar-thin` 之类的 CSS。**如果哪天真的需要
 * 跨平台一致的滚动条外观**，那时再装那个包，并且要知道换来的是什么。
 */
export interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "vertical" | "horizontal";
}

const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, orientation = "vertical", children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "relative",
        orientation === "vertical" ? "overflow-y-auto" : "overflow-x-auto",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  ),
);
ScrollArea.displayName = "ScrollArea";

export { ScrollArea };
