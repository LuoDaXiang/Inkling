/*
 * 来自 shadcn/ui（MIT），经由 enjoy v0.7.9 的 components/ui/ 引入，未作改动。
 *
 * 这批组件不是参考实现自己写的，是 shadcn CLI 生成的样板——所以 decisions 0001
 * 那条「Enjoy 只作为参考读，不复制代码」在这里不适用：复制的是 shadcn 的样板，
 * 不是它的取舍。九个文件共 416 行，全都不依赖 Radix。
 */
"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "light" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
