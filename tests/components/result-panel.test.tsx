import { describe, test, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResultPanel } from "@renderer/components/ResultPanel";
import type { PitchContour } from "@renderer/lib/present";

/**
 * 结果区的**组件层** —— 迁移计划 M3.10。
 *
 * 守的是三条产品正确性在重画之后**没有画丢**。它们全都是
 * 「错了也不报错」的那一类，所以必须有组件层的断言：
 *
 *   [C30] `unreliable` 要降级呈现 —— 照 `scored` 渲染会把噪声当成
 *         「读得还行」端给用户。纯白噪声的准确度是 71 分，而准确度是主打维度。
 *   [C44] 缺席不能渲染成 0 —— 「语调 0 分」和「语调没测出来」是两回事。
 *   [C32] `persisted:false` 的两种含义必须分得开，否则用户不知道
 *         这次到底有没有记上。
 *
 * 另外守 0035 的两条界面规矩：准确度排第一并高亮；文案先说准确度再说语调。
 */

/**
 * jsdom 没有 canvas 的 2D 上下文。
 *
 * **只桩掉画笔，不桩掉曲线的决定逻辑**——`pitchPlot()` 照常跑，
 * 所以「有没有该画的东西」仍然是真的判断，桩掉的只是「怎么落笔」。
 * 桩在这个文件里而不是全局 setup 里，是为了让读到这条用例的人知道它被桩了。
 */
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

const scored = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  outcome: "scored",
  scores: { accuracy: 82.1, fluency: 74, completeness: 100, prosody: 68.2, overall: 79.5 },
  words: [{ word: "think", accuracy: 41, errorType: "Mispronunciation", phonemes: [] }],
  recognized: "think fast",
  snr: 24.5,
  trimmedStartMs: 80,
  trimmedEndMs: 200,
  assessedMs: 4620,
  persisted: false,
  traceId: "t-1",
  ...overrides,
});

const contour = (baseHz: number): PitchContour => ({
  hz: Array.from({ length: 12 }, (_, i) => (i === 5 ? null : baseHz + i)),
  hopMs: 20,
});

describe("A. 三种走向各自的呈现", () => {
  test("scored：分数、逐词、元信息都在", () => {
    render(<ResultPanel data={scored()} referencePitch={null} />);

    expect(screen.getByTestId("result-title")).toHaveTextContent("评分");
    expect(screen.getByTestId("scores")).toBeInTheDocument();
    expect(screen.getByTestId("words")).toBeInTheDocument();
    expect(screen.getByTestId("result-meta")).toHaveTextContent("think fast");
  });

  test("unreliable：不展示分数、不展示逐词标红 [C30]", () => {
    // 照 scored 渲染会把噪声当成「读得还行」端给用户。
    render(<ResultPanel data={scored({ outcome: "unreliable" })} referencePitch={null} />);

    expect(screen.getByTestId("result-title")).toHaveTextContent("结果可能不可信");
    expect(screen.queryByTestId("scores")).toBeNull();
    expect(screen.queryByTestId("words")).toBeNull();
  });

  test("unreliable：仍然告诉用户系统听到了什么", () => {
    // recognized 在 unreliable 时恰恰是最有用的信息——
    // 用户看到系统听成了什么，就理解了为什么不可信。
    render(<ResultPanel data={scored({ outcome: "unreliable" })} referencePitch={null} />);
    expect(screen.getByTestId("result-meta")).toHaveTextContent("think fast");
  });

  test("no_speech：只说重录，不画分数", () => {
    render(
      <ResultPanel
        data={{ outcome: "no_speech", trimmedStartMs: 40, persisted: false, traceId: "t" }}
        referencePitch={null}
      />,
    );

    expect(screen.getByTestId("result-title")).toHaveTextContent("没有听到声音");
    expect(screen.queryByTestId("scores")).toBeNull();
    // 文案和 M2 逐字一致（docs/m2-baseline/）——M3 不顺带改文案。
    expect(screen.getByTestId("result-note")).toHaveTextContent(
      "录音里没有可识别的语音。检查一下麦克风，或者换个安静点的地方。",
    );
  });

  test("认不出的 outcome 降级显示，不白屏", () => {
    // §5：封闭枚举收窄是破坏性变更，而客户端遇到未知取值必须降级。
    render(<ResultPanel data={{ outcome: "brand_new" }} referencePitch={null} />);
    expect(screen.getByTestId("result-title")).toHaveTextContent("看不懂");
  });

  test("没有结果时整块不渲染", () => {
    render(<ResultPanel data={null} referencePitch={null} />);
    expect(screen.queryByTestId("result")).toBeNull();
  });
});

describe("B. 分数（0019 / 0035）", () => {
  test("只展示分档，不展示原始百分数", () => {
    // 准确度绝对值虚高约 20 分；主打维度报一个虚高的数字，
    // 整个产品的可信度就没了。
    render(<ResultPanel data={scored()} referencePitch={null} />);
    const scores = screen.getByTestId("scores");

    expect(scores).toHaveTextContent("不错");
    expect(scores.textContent).not.toContain("82.1");
    expect(scores.textContent).not.toContain("82");
  });

  test("准确度排第一", () => {
    render(<ResultPanel data={scored()} referencePitch={null} />);
    const labels = Array.from(
      screen.getByTestId("scores").querySelectorAll("small"),
      (el) => el.textContent,
    );
    expect(labels).toEqual(["准确度", "流利度", "语调"]);
  });

  test("完整度不展示 —— 朗读场景下它没有区分度（0019）", () => {
    render(<ResultPanel data={scored()} referencePitch={null} />);
    expect(screen.getByTestId("scores").textContent).not.toContain("完整度");
  });

  test("语调缺席时显示破折号，不显示 0 分 [C44]", () => {
    // 「语调 0 分」和「语调没测出来」是两回事，把后者画成前者是在撒谎。
    const noProsody = scored({
      scores: { accuracy: 82.1, fluency: 74, completeness: 100, overall: 79.5 },
    });
    render(<ResultPanel data={noProsody} referencePitch={null} />);

    expect(screen.getByTestId("score-语调")).toHaveTextContent("—");
    expect(screen.getByTestId("score-语调").textContent).not.toContain("0");
  });
});

describe("C. 文案顺序（0035 第 3 条）", () => {
  test("先说准确度的问题，再说语调", () => {
    // 顺序反过来会让用户去调语调，而真正该改的是那几个念错的音。
    const data = scored({
      words: [
        { word: "think", accuracy: 41, errorType: "Mispronunciation", phonemes: [] },
        { word: "fast", accuracy: 92, errorType: "None", phonemes: [], monotone: 0.8 },
      ],
    });
    render(<ResultPanel data={data} referencePitch={null} />);
    const note = screen.getByTestId("result-note").textContent ?? "";

    expect(note.indexOf("念得不准")).toBeGreaterThanOrEqual(0);
    expect(note.indexOf("念得不准")).toBeLessThan(note.indexOf("偏平"));
  });

  test("只有读平的词时说读平", () => {
    const data = scored({
      words: [{ word: "fast", accuracy: 92, errorType: "None", phonemes: [], monotone: 0.8 }],
    });
    render(<ResultPanel data={data} referencePitch={null} />);
    expect(screen.getByTestId("result-note")).toHaveTextContent("偏平");
  });

  test("都念准了就直说", () => {
    const data = scored({
      words: [{ word: "fast", accuracy: 92, errorType: "None", phonemes: [] }],
    });
    render(<ResultPanel data={data} referencePitch={null} />);
    expect(screen.getByTestId("result-note")).toHaveTextContent("念准了");
  });

  test("落库失败要说出来 [C32]", () => {
    // 练习记录丢一行是用户的数据没了，而且不会重新产生。结果照给，失败照说。
    render(
      <ResultPanel
        data={scored({ persisted: false, persistError: "磁盘满了" })}
        referencePitch={null}
      />,
    );
    expect(screen.getByTestId("result-note")).toHaveTextContent("没保存");
  });

  test("匿名试用不提示「没保存」—— 那不是失败 [C32]", () => {
    render(<ResultPanel data={scored({ persisted: false })} referencePitch={null} />);
    expect(screen.getByTestId("result-note").textContent).not.toContain("没保存");
  });
});

describe("D. 音高曲线在结果区里的位置", () => {
  test("两条都有就画", () => {
    render(
      <ResultPanel data={scored({ pitch: contour(150) })} referencePitch={contour(210)} />,
    );
    expect(screen.getByTestId("pitch-panel")).toBeInTheDocument();
  });

  test("只有录音那条也画", () => {
    render(<ResultPanel data={scored({ pitch: contour(150) })} referencePitch={null} />);
    expect(screen.getByTestId("pitch-panel")).toBeInTheDocument();
  });

  test("两条都没有就整块不画 —— 空框会让人以为「测出来是平的」", () => {
    render(<ResultPanel data={scored()} referencePitch={null} />);
    expect(screen.queryByTestId("pitch-panel")).toBeNull();
  });

  test("no_speech 时也画 —— 音频确实送出去了", () => {
    render(
      <ResultPanel
        data={{ outcome: "no_speech", trimmedStartMs: 0, persisted: false, pitch: contour(150) }}
        referencePitch={null}
      />,
    );
    expect(screen.getByTestId("pitch-panel")).toBeInTheDocument();
  });
});
