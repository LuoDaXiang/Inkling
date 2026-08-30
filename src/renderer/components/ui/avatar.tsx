import * as React from "react";
import { cn } from "@renderer/lib/utils";

/**
 * 手写，不装 `@radix-ui/react-avatar`（迁移计划 M3.6）。
 *
 * 那个包做的一件真事是：图片加载失败或还没加载完时显示占位，
 * 且**不闪**（它有一个短暂的延迟窗口，避免缓存命中时占位一闪而过）。
 * 这里用 `onError` 做同一件事——闪一下的代价，换掉一个依赖。
 */
export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  src?: string | undefined;
  alt?: string;
  /** 图片加载失败时显示的文字，通常是首字母。 */
  fallback?: React.ReactNode;
}

const Avatar = React.forwardRef<HTMLSpanElement, AvatarProps>(
  ({ className, src, alt = "", fallback, ...props }, ref) => {
    const [broken, setBroken] = React.useState(false);
    const showImage = Boolean(src) && !broken;

    return (
      <span
        ref={ref}
        className={cn(
          "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full bg-muted",
          className,
        )}
        {...props}
      >
        {showImage ? (
          <img
            src={src}
            alt={alt}
            className="aspect-square h-full w-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-sm">
            {fallback}
          </span>
        )}
      </span>
    );
  },
);
Avatar.displayName = "Avatar";

export { Avatar };
