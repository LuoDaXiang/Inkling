import * as React from "react";
import { cn } from "@renderer/lib/utils";

/**
 * 手写，不装 `@radix-ui/react-tabs`（迁移计划 M3.6）。
 *
 * 标签页要守的无障碍规范就三条：`role` 三件套（tablist / tab / tabpanel）、
 * 左右方向键在标签之间移动、以及**只有当前标签可 Tab 到**（roving tabindex）。
 * 下面这些都实现了，所以换掉那个包不是「少了无障碍」，是同样的规范自己写一遍。
 *
 * 未选中的面板**不渲染**，而不是 `display:none`。藏起来的面板里如果有
 * 一个正在录音的组件，它会继续录——这类「看不见但还活着」的东西是
 * 最难查的一类缺陷。
 */
interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
  id: string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs(who: string): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error(`${who} 必须放在 Tabs 里面`);
  return ctx;
}

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
}

export function Tabs({ className, value, onValueChange, children, ...props }: TabsProps) {
  const id = React.useId();
  const ctx = React.useMemo(
    () => ({ value, setValue: onValueChange, id }),
    [value, onValueChange, id],
  );
  return (
    <TabsContext.Provider value={ctx}>
      <div className={className} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const ref = React.useRef<HTMLDivElement>(null);

  /** 方向键在标签之间移动，并把焦点带过去——键盘用户靠这个而不是 Tab。 */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const tabs = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const current = tabs.findIndex((t) => t === document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    tabs[(current + step + tabs.length) % tabs.length]?.focus();
  };

  return (
    <div
      ref={ref}
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn("inline-flex items-center gap-1 rounded-md bg-muted p-1", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabsTrigger({ className, value, ...props }: TabsTriggerProps) {
  const ctx = useTabs("TabsTrigger");
  const selected = ctx.value === value;

  return (
    <button
      type="button"
      role="tab"
      id={`${ctx.id}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${ctx.id}-panel-${value}`}
      // roving tabindex：只有当前标签在 Tab 序列里，方向键负责组内移动。
      tabIndex={selected ? 0 : -1}
      onClick={() => ctx.setValue(value)}
      onFocus={() => ctx.setValue(value)}
      className={cn(
        "rounded px-3 py-1.5 text-sm font-medium transition-colors",
        selected ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({ className, value, children, ...props }: TabsContentProps) {
  const ctx = useTabs("TabsContent");
  // 不渲染，而不是藏起来。见文件头那段。
  if (ctx.value !== value) return null;

  return (
    <div
      role="tabpanel"
      id={`${ctx.id}-panel-${value}`}
      aria-labelledby={`${ctx.id}-tab-${value}`}
      tabIndex={0}
      className={cn("mt-2", className)}
      {...props}
    >
      {children}
    </div>
  );
}
