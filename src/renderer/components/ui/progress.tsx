import * as React from "react";
import { cn } from "@renderer/lib/utils";

/**
 * 手写，不装 `@radix-ui/react-progress`（迁移计划 M3.6）。
 *
 * 一条进度条要的是 `role="progressbar"` 加三个 aria 值。Radix 那个包
 * 多给的是「indeterminate」状态机，而这里的进度永远是已知的：录了几秒。
 *
 * **`value` 为 `null` 表示不知道进度**，不是 0——0 是「确定还没开始」。
 * 两者在界面上是不同的东西：前者不该画任何填充，后者该画一条空槽。
 */
export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 0–100。`null` = 不知道。 */
  value?: number | null;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = null, ...props }, ref) => {
    const known = typeof value === "number" && Number.isFinite(value);
    const pct = known ? Math.min(100, Math.max(0, value)) : 0;

    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(known ? { "aria-valuenow": pct } : {})}
        className={cn("relative h-2 w-full overflow-hidden rounded-full bg-secondary", className)}
        {...props}
      >
        {known ? (
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
            data-testid="progress-fill"
          />
        ) : null}
      </div>
    );
  },
);
Progress.displayName = "Progress";

export { Progress };
