import * as React from "react";
import { band, presentResult, wordMarks, type PitchContour } from "@renderer/lib/present";
import { PitchChart } from "./PitchChart";
import { WordList } from "./WordList";

/**
 * 一次评分的结果区。
 *
 * 这是 M3 要和 M2 截图逐像素对上的那一块（`docs/m2-baseline/`）。
 * **不顺带做任何功能改动**——摆放、文案、优先级全部照 M2。
 *
 * 「该展示什么」仍然由 `presentResult()` 决定（[C30] [C43] [C32] 三条
 * 产品正确性都在那里，有用例守着）；这个组件只负责画。
 */
export interface ResultPanelProps {
  data: Record<string, unknown> | null;
  referencePitch: PitchContour | null;
}

export function ResultPanel({ data, referencePitch }: ResultPanelProps) {
  if (!data) return null;

  const view = presentResult(data);
  const recordingPitch = (data["pitch"] as PitchContour | undefined) ?? null;

  return (
    <section
      data-testid="result"
      className="flex flex-col gap-3.5 rounded border border-border bg-card p-5"
    >
      <h2 className="text-base font-semibold" data-testid="result-title">
        {view.kind === "no_speech"
          ? "没有听到声音"
          : view.kind === "unreliable"
            ? "结果可能不可信"
            : view.kind === "unknown"
              ? "这次的结果看不懂"
              : "评分"}
      </h2>

      {/*
        曲线在 no_speech 时也画：音频送出去了，用户能看到自己确实发了声，
        只是没被认出来。所以它排在下面那个 early return 之前。
      */}
      <PitchChart reference={referencePitch} recording={recordingPitch} />

      {view.showScores && view.scores ? <Scores scores={view.scores} /> : null}
      {view.showWords ? <WordList words={view.words} /> : null}

      <Note view={view} />
      <Meta view={view} />
    </section>
  );
}

/**
 * 三项分数。
 *
 * 准确度排第一并高亮——说话首先要说准，流利和语调是在「说准了」之上的加分（0035）。
 * 完整度不展示：朗读场景下专家全给满分，没有区分度，而服务端平均只给 86.7，
 * 展示它只会制造无意义的焦虑（0019）。
 *
 * **只展示分档，不展示原始百分数**：准确度绝对值虚高约 20 分，
 * 主打维度报一个虚高的数字，整个产品的可信度就没了。
 */
function Scores({ scores }: { scores: Record<string, unknown> }) {
  const dims: Array<[string, unknown, boolean]> = [
    ["准确度", scores["accuracy"], true],
    ["流利度", scores["fluency"], false],
    ["语调", scores["prosody"], false],
  ];

  return (
    <div
      className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(120px,1fr))]"
      data-testid="scores"
    >
      {dims.map(([label, value, hero]) => (
        <div key={label} className="flex flex-col gap-0.5" data-testid={`score-${label}`}>
          {/* [C44] 缺席不能渲染成 0 —— 「语调 0 分」和「语调没测出来」是两回事。 */}
          <b
            className={
              "font-mono text-2xl font-semibold leading-none tabular-nums" +
              (hero ? " text-[var(--accent)]" : "")
            }
          >
            {band(value) ?? "—"}
          </b>
          <small className="text-xs text-muted-foreground">{label}</small>
        </div>
      ))}
    </div>
  );
}

/**
 * 文案。**先说准确度的问题，再说语调**——顺序反过来会让用户去调语调，
 * 而真正该改的是那几个念错的音（0035 第 3 条）。
 */
function Note({ view }: { view: ReturnType<typeof presentResult> }) {
  if (view.kind === "no_speech") {
    return (
      <p className="text-sm text-muted-foreground" data-testid="result-note">
        录音里没有可识别的语音。检查一下麦克风，或者换个安静点的地方。
      </p>
    );
  }
  if (view.kind === "unreliable") {
    return (
      <p className="text-sm text-muted-foreground" data-testid="result-note">
        各项指标显示这更像是环境噪声而不是朗读。换个安静的地方再试一次。
      </p>
    );
  }
  if (view.kind === "unknown") {
    return (
      <p className="text-sm text-muted-foreground" data-testid="result-note">
        {view.notices.join(" ")}
      </p>
    );
  }

  const marks = view.words.map(wordMarks);
  const wrong = marks.filter((m) => m.base !== "ok").length;
  const flat = marks.filter((m) => m.base === "ok" && m.monotone.level > 0).length;

  const text =
    wrong > 0
      ? `${wrong} 个词念得不准，标红的就是——鼠标悬停能看到具体是哪个音素。` +
        (flat > 0 ? `另有 ${flat} 个词读得偏平。` : "")
      : flat > 0
        ? `发音都念准了。有 ${flat} 个词读得偏平，标黄的就是。`
        : "念准了，语调也自然。";

  return (
    <p className="text-sm text-muted-foreground" data-testid="result-note">
      {text}
      {/* [C32] 「要求记录但写失败了」必须说出来——练习记录丢一行是用户的数据没了。 */}
      {view.notices.map((n) => (
        <span key={n}> {n}</span>
      ))}
    </p>
  );
}

/**
 * 元信息。契约 [C28]：单位进字段名，`assessedMs` / `trimmedStartMs` 已经是毫秒，
 * 换算不在这里做。
 */
function Meta({ view }: { view: ReturnType<typeof presentResult> }) {
  const lines = [
    `识别到  ${view.recognized ?? "—"}`,
    `时长    ${view.meta.assessedMs != null ? (view.meta.assessedMs / 1000).toFixed(2) : "—"}s` +
      (view.meta.trimmedMs && view.meta.trimmedMs > 0
        ? `（掐掉首尾静音 ${(view.meta.trimmedMs / 1000).toFixed(2)}s）`
        : ""),
    ...(view.meta.snr != null ? [`信噪比  ${view.meta.snr.toFixed(1)} dB`] : []),
  ];

  return (
    <p
      className="whitespace-pre-wrap font-mono text-xs leading-[1.7] text-muted-foreground"
      data-testid="result-meta"
    >
      {lines.join("\n")}
    </p>
  );
}
