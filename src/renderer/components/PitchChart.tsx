import * as React from "react";
import { pitchPlot, type PitchContour } from "@renderer/lib/present";

/**
 * 两条音高曲线。
 *
 * **不装 chart.js。** 参考实现那 53 行 `renderPitchContour` 里有 40 行在关
 * 它的图例、标题、坐标轴、网格——这里只要两条折线。
 *
 * 「画成什么样」的决定全在 `pitchPlot()` 里，有 24 条用例守着；
 * 这个组件只剩把点连起来。三条产品正确性因此测得到，而它们全都是
 * 「错了也不报错」的那一类：`null` 处必须断开、两条曲线必须共用纵轴、
 * 横轴按毫秒不按帧号。
 */
export interface PitchChartProps {
  reference: PitchContour | null;
  recording: PitchContour | null;
  height?: number;
}

export function PitchChart({ reference, recording, height = 120 }: PitchChartProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [range, setRange] = React.useState<string>("");

  /**
   * 有没有东西可画。
   *
   * 记住结果，不要每次 render 重算——`pitchPlot` 要遍历两条曲线的每一帧，
   * 而 render 会因为任何无关的 state 变化重跑。
   *
   * **宽度在这里无所谓**：`pitchPlot` 的段数只由数据里有没有非 null 的读数
   * 决定，宽度只影响坐标。所以这一次用什么宽度都不改变「画不画」这个判断，
   * 真正要按画布宽度算的那一次在下面的 effect 里。
   */
  const hasAny = React.useMemo(
    () => pitchPlot({ reference, recording, height }).segments.length > 0,
    [reference, recording, height],
  );

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // 高分屏上按 CSS 像素画会糊。按设备像素建缓冲区，再把坐标系缩回去。
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 600;
    const cssHeight = canvas.clientHeight || height;

    const plot = pitchPlot({ reference, recording, width: cssWidth, height: cssHeight });
    if (plot.segments.length === 0) {
      setRange("");
      return;
    }

    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const style = getComputedStyle(document.documentElement);
    const colors: Record<"reference" | "recording", string> = {
      reference: style.getPropertyValue("--pitch-reference").trim() || "#7d7d7d",
      recording: style.getPropertyValue("--pitch-recording").trim() || "#0f7b76",
    };

    for (const segment of plot.segments) {
      ctx.strokeStyle = colors[segment.series];
      ctx.fillStyle = colors[segment.series];
      ctx.lineWidth = segment.series === "reference" ? 1.5 : 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      if (segment.points.length === 1) {
        // 孤立的一个点连不成线。画个圆点——丢掉的话「这里测出了音高」
        // 这个事实就没了。
        const p = segment.points[0]!;
        ctx.beginPath();
        ctx.arc(p.x, p.y, ctx.lineWidth, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      ctx.beginPath();
      segment.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }

    setRange(`${Math.round(plot.minHz ?? 0)}–${Math.round(plot.maxHz ?? 0)} Hz`);
  }, [reference, recording, height]);

  // 一条都画不出来就整块不渲染。画一个空框比不画更糟——
  // 用户会以为「测出来是平的」。和 M2 的行为一致（M3 不改行为）。
  if (!hasAny) return null;

  return (
    <div data-testid="pitch-panel">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-0.5 w-3.5 bg-[var(--pitch-reference)]" /> 范本
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-0.5 w-3.5 bg-[var(--pitch-recording)]" /> 你的录音
        </span>
        <span data-testid="pitch-range">{range}</span>
      </div>
      <div className="relative w-full" style={{ height }}>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      </div>
    </div>
  );
}
