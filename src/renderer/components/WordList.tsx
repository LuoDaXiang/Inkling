import * as React from "react";
import { cn } from "@renderer/lib/utils";
import { phonemeRows, wordMarks, type WordMarks } from "@renderer/lib/present";

/**
 * 逐词三层标记 —— decisions 0045。
 *
 * 三个正交字段**叠加**，不是查表：底色标 `errorType`、下划线粗细标
 * `monotone` 的 0–1 强度、角标标 `breakError`。一个词可以同时
 * 「念错了」和「读得平」——参考实现的
 * `pronunciation-assessment-word-result.tsx:42` 那张查表画不出这一格，
 * 因为 Azure 的 `errorType` 是单值枚举。
 *
 * **一个词同时念错且读平时，底色是念错**（沿用 0035），**而下划线照画**。
 * 优先级说的是「底色归谁」，不是「其余的层不显示」。
 *
 * 「标成什么」的决定全在 `wordMarks()` 里，8 种组合各有用例；
 * 这个组件只把三个通道翻译成三组 class。
 */

const BASE_CLASS: Record<WordMarks["base"], string> = {
  ok: "",
  mispronounced: "bg-[color-mix(in_srgb,var(--bad)_20%,transparent)]",
  omission: "bg-[color-mix(in_srgb,var(--bad)_12%,transparent)] line-through decoration-[var(--bad)]",
  insertion: "bg-[color-mix(in_srgb,var(--muted-ink)_18%,transparent)] italic",
};

/** 下划线走 box-shadow，这样它和底色、和漏读的删除线都不打架。 */
const FLAT_CLASS: Record<0 | 1 | 2 | 3, string> = {
  0: "",
  1: "shadow-[inset_0_-1px_0_0_var(--warn)]",
  2: "shadow-[inset_0_-2px_0_0_var(--warn)]",
  3: "shadow-[inset_0_-3px_0_0_var(--warn)]",
};

const BASE_TEXT: Record<WordMarks["base"], string | null> = {
  ok: null,
  mispronounced: "念得不准",
  omission: "漏读了",
  insertion: "多读了",
};
const FLAT_TEXT: Array<string | null> = [null, "读得略平", "读得偏平", "读得很平"];
const BRK_TEXT: Record<"unexpected" | "missing", string> = {
  unexpected: "这里不该停",
  missing: "这里该停一下",
};

/** 悬停文案。只说分档不说原始百分数（0019）。 */
export function describeMarks(m: WordMarks): string {
  const parts = [
    BASE_TEXT[m.base],
    FLAT_TEXT[m.monotone.level] ?? null,
    m.breakMark ? BRK_TEXT[m.breakMark] : null,
  ].filter(Boolean);
  return parts.length === 0 ? "念准了" : parts.join(" · ");
}

export function WordList({ words }: { words: unknown[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 leading-[2.4]" data-testid="words">
      {words.map((raw, i) => (
        <Word key={i} raw={raw} />
      ))}
    </div>
  );
}

function Word({ raw }: { raw: unknown }) {
  const m = wordMarks(raw);
  const rows = phonemeRows(raw);

  return (
    <span
      tabIndex={0}
      title={describeMarks(m)}
      data-testid="word"
      data-base={m.base}
      data-flat={m.monotone.level}
      data-brk={m.breakMark ?? ""}
      className={cn(
        "group relative rounded-[3px] px-1.5 py-0.5 text-[15px] outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        BASE_CLASS[m.base],
        FLAT_CLASS[m.monotone.level],
      )}
    >
      {m.word}
      {m.breakMark ? (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 text-[10px] leading-none text-muted-foreground"
        >
          {m.breakMark === "unexpected" ? "‖" : "·"}
        </span>
      ) : null}

      {/*
        音素弹出层（0035 第 4 条）。「第 3 个词念错了」不够，
        「第 3 个词的 /θ/ 念成了 /s/」才是能拿去改的东西。
        视觉照参考实现：横向滚动、每个音素一列、按分档着色——
        但**只显示分档不显示原始分数**，音素级的绝对值比词级更不可信。
      */}
      {rows.length > 0 ? (
        <span
          data-testid="phonemes"
          className={cn(
            "pointer-events-none absolute bottom-[calc(100%+6px)] left-0 z-10 hidden",
            "max-w-[320px] gap-0.5 overflow-x-auto rounded border border-border bg-popover p-1.5 shadow-lg",
            "group-hover:flex group-focus-within:flex",
          )}
        >
          {rows.map((row) => (
            <span
              key={row.phoneme + String(row.accuracy)}
              className={cn(
                "flex min-w-[34px] flex-col items-center gap-0.5 whitespace-nowrap rounded px-1 py-0.5 font-mono text-xs",
                row.weak ? "bg-[color-mix(in_srgb,var(--bad)_22%,transparent)]" : "",
              )}
            >
              {row.phoneme}
              <small className="text-[10px] text-muted-foreground">{row.band ?? "—"}</small>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
