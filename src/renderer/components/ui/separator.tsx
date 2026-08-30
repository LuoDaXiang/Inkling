import * as React from "react";
import { cn } from "@renderer/lib/utils";

/**
 * 手写，不装 `@radix-ui/react-separator`（迁移计划 M3.6）。
 *
 * 那个包做的全部事情是：一个 div 加 `role="separator"` 与 `aria-orientation`，
 * 装饰性的时候换成 `role="none"`。二十行不到，不值一个依赖。
 *
 * `decorative` 默认为真：一条纯视觉的分隔线报给读屏软件只是噪音。
 */
export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
}

const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  ({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
    <div
      ref={ref}
      {...(decorative
        ? { role: "none" }
        : { role: "separator", "aria-orientation": orientation })}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...props}
    />
  ),
);
Separator.displayName = "Separator";

export { Separator };
