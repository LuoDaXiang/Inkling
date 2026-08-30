import * as React from "react";

/**
 * 手写，不装 `@radix-ui/react-collapsible`（迁移计划 M3.6）。
 *
 * 原生 `<details>` / `<summary>` 就是可折叠区块，键盘与读屏支持是浏览器给的。
 * Radix 那个包解决的是「要给展开收起加动画」，而这里不需要动画。
 */
export function Collapsible(props: React.DetailsHTMLAttributes<HTMLDetailsElement>) {
  return <details {...props} />;
}

export function CollapsibleTrigger(props: React.HTMLAttributes<HTMLElement>) {
  return <summary className="cursor-pointer select-none" {...props} />;
}

export function CollapsibleContent(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} />;
}
