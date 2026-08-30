import * as React from "react";
import { cn } from "@renderer/lib/utils";

/**
 * 手写，不装 `@radix-ui/react-radio-group`（迁移计划 M3.6）。
 *
 * 原生 `<input type="radio">` 加同一个 `name` 就是一组单选：方向键在组内
 * 移动、Tab 跳过整组、读屏正确播报——这些是浏览器实现的，不是库实现的。
 * Radix 那个包给的是「用任意元素当选项」的自由，代价是要自己重做上面每一件事。
 *
 * 值通过 context 传给子项，而不是让调用方给每个 `<RadioGroupItem>` 重复
 * `name` 和 `checked`——重复的地方就是会写错的地方。
 */
interface RadioGroupContextValue {
  name: string;
  value: string;
  onValueChange?: (value: string) => void;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  name: string;
  value: string;
  onValueChange?: (value: string) => void;
}

export function RadioGroup({
  className,
  name,
  value,
  onValueChange,
  children,
  ...props
}: RadioGroupProps) {
  const ctx = React.useMemo(
    () => ({ name, value, ...(onValueChange ? { onValueChange } : {}) }),
    [name, value, onValueChange],
  );
  return (
    <RadioGroupContext.Provider value={ctx}>
      <div role="radiogroup" className={cn("grid gap-2", className)} {...props}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

export interface RadioGroupItemProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "name" | "checked"> {
  value: string;
}

export function RadioGroupItem({ className, value, ...props }: RadioGroupItemProps) {
  const ctx = React.useContext(RadioGroupContext);
  if (!ctx) throw new Error("RadioGroupItem 必须放在 RadioGroup 里面");

  return (
    <input
      type="radio"
      name={ctx.name}
      value={value}
      checked={ctx.value === value}
      onChange={() => ctx.onValueChange?.(value)}
      className={cn("h-4 w-4 accent-primary", className)}
      {...props}
    />
  );
}
