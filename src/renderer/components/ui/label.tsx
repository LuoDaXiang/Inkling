import * as React from "react";
import { cn } from "@renderer/lib/utils";

/**
 * 手写，不装 `@radix-ui/react-label`（迁移计划 M3.6）。
 *
 * Radix 的 Label 只多做一件事：点击 label 时把焦点交给关联控件。
 * 原生 `<label htmlFor>` 本来就做这件事——那个包解决的是「label 包着的
 * 是自定义组件而不是原生 input」的场景，而这里全都是原生 input。
 */
const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    />
  ),
);
Label.displayName = "Label";

export { Label };
