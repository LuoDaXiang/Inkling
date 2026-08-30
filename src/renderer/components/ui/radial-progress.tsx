/*
 * 来自 shadcn/ui（MIT），经由 enjoy v0.7.9 的 components/ui/ 引入，未作改动。
 *
 * 这批组件不是参考实现自己写的，是 shadcn CLI 生成的样板——所以 decisions 0001
 * 那条「Enjoy 只作为参考读，不复制代码」在这里不适用：复制的是 shadcn 的样板，
 * 不是它的取舍。九个文件共 416 行，全都不依赖 Radix。
 */
"use client";

import * as React from "react";
import { cn } from "@renderer/lib/utils";

export const RadialProgress = ({
  progress,
  thickness = 10,
  className,
  fontSize = 12,
  ringClassName,
  circleClassName,
  label,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  progress: number;
  thickness?: number;
  ringClassName?: string;
  circleClassName?: string;
  fontSize?: number;
  label?: string;
}) => {
  const length = 2 * Math.PI * (50 - thickness / 2);
  return (
    <div className={cn("relative w-40 h-40", className)} {...props}>
      <svg className="w-full h-full" viewBox="0 0 100 100" fill="currentColor">
        <circle
          className={cn("text-gray-500 stroke-current", circleClassName)}
          strokeWidth={thickness}
          cx="50"
          cy="50"
          r={`${50 - thickness / 2}`}
          fill="transparent"
        ></circle>
        <circle
          className={cn("text-indigo-500 stroke-current", ringClassName)}
          style={{
            strokeDasharray: `${length}, ${length}`,
            transition: "stroke-dashoffset 0.35s",
            transform: "rotate(-90deg)",
            transformOrigin: "50% 50%",
          }}
          strokeWidth={thickness}
          strokeLinecap="round"
          cx="50"
          cy="50"
          r={`${50 - thickness / 2}`}
          fill="transparent"
          strokeDashoffset={`calc(${length} - (${length} * ${progress}) / 100)`}
        ></circle>

        <text
          x="50"
          y="50"
          fontFamily="Verdana"
          fontSize={fontSize}
          textAnchor="middle"
          alignmentBaseline="middle"
        >
          {label || progress}
        </text>
      </svg>
    </div>
  );
};
