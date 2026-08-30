import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ResultPanel } from "./components/ResultPanel";
import { WordList } from "./components/WordList";
import type { PitchContour } from "./lib/present";
import "./styles.css";

/**
 * M3 结果区预览 —— **开发用，不进打包产物**（入口只有 `index.html`）。
 *
 * 用的 fixture 和 `docs/m2-baseline/index.html` 里那份**逐字相同**：
 * 三个维度的 8 种组合、同一组音素分数、同一条曲线、同一组分数与文案。
 * 只有这样，两张截图才是可比的——换了数据再比，比的就是数据不是界面。
 */

const PHONEMES = {
  think: [
    { phoneme: "th", accuracy: 22 },
    { phoneme: "ih", accuracy: 88 },
    { phoneme: "ng", accuracy: 95 },
    { phoneme: "k", accuracy: 71 },
  ],
  fast: [
    { phoneme: "f", accuracy: 96 },
    { phoneme: "ae", accuracy: 74 },
    { phoneme: "s", accuracy: 91 },
    { phoneme: "t", accuracy: 58 },
  ],
};

const COMBOS: Array<[string, { wrong?: boolean; flat?: boolean; broke?: boolean }]> = [
  ["都没有", {}],
  ["只念错", { wrong: true }],
  ["只读平", { flat: true }],
  ["只停顿异常", { broke: true }],
  ["念错 + 读平", { wrong: true, flat: true }],
  ["念错 + 停顿", { wrong: true, broke: true }],
  ["读平 + 停顿", { flat: true, broke: true }],
  ["三样都占", { wrong: true, flat: true, broke: true }],
];

function fixtureWord(opts: { wrong?: boolean; flat?: boolean; broke?: boolean }) {
  return {
    word: opts.wrong ? "think" : "fast",
    accuracy: opts.wrong ? 41 : 92,
    errorType: opts.wrong ? "Mispronunciation" : "None",
    phonemes: opts.wrong ? PHONEMES.think : PHONEMES.fast,
    ...(opts.flat ? { monotone: 0.8 } : {}),
    ...(opts.broke ? { breakError: "unexpected" } : {}),
  };
}

const EXTRA: Array<[string, Record<string, unknown>]> = [
  ["漏读（Omission）", { word: "the", accuracy: 0, errorType: "Omission", phonemes: [] }],
  ["多读（Insertion）", { word: "uh", accuracy: 0, errorType: "Insertion", phonemes: [] }],
  [
    "只给单值枚举的 provider：Monotone 折进第二层，不进底色",
    { word: "over", accuracy: 91, errorType: "Monotone", phonemes: [] },
  ],
];

function contour(baseHz: number, n: number, hopMs: number, gaps: number[]): PitchContour {
  return {
    hz: Array.from({ length: n }, (_, i) =>
      gaps.includes(i) ? null : baseHz + 24 * Math.sin(i / 5) + (i % 3),
    ),
    hopMs,
  };
}

const RESULT: Record<string, unknown> = {
  outcome: "scored",
  scores: { accuracy: 82.1, fluency: 74, completeness: 100, prosody: 68.2, overall: 79.5 },
  words: [
    ...COMBOS.map(([, opts]) => fixtureWord(opts)),
    ...EXTRA.map(([, w]) => w),
  ],
  recognized: "think fast over the lazy dog",
  snr: 24.5,
  trimmedStartMs: 80,
  trimmedEndMs: 200,
  assessedMs: 4620,
  persisted: false,
  pitch: contour(150, 58, 20, [7, 30, 31]),
};

function Preview() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-8">
      <h1 className="text-xl font-semibold">M3 结果区预览</h1>
      <p className="text-sm text-muted-foreground">
        和 <code>docs/m2-baseline/</code> 同一份 fixture。逐块对照那三张截图。
      </p>

      <section className="flex flex-col gap-3.5 rounded border border-border bg-card p-5">
        <h2 className="text-base font-semibold">逐词三层标记 —— 8 种组合</h2>
        {COMBOS.map(([label, opts]) => (
          <div key={label}>
            <p className="mb-0.5 font-mono text-xs text-muted-foreground">{label}</p>
            <WordList words={[fixtureWord(opts)]} />
          </div>
        ))}
        {EXTRA.map(([label, w]) => (
          <div key={label}>
            <p className="mb-0.5 font-mono text-xs text-muted-foreground">{label}</p>
            <WordList words={[w]} />
          </div>
        ))}
      </section>

      <ResultPanel data={RESULT} referencePitch={contour(210, 60, 20, [18, 19, 20, 41])} />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("preview.html 里没有 #root");
createRoot(root).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
