import { describe, test, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WordList, describeMarks } from "@renderer/components/WordList";
import { wordMarks } from "@renderer/lib/present";

/**
 * 逐词三层标记的**组件层** —— 迁移计划 M3.10。
 *
 * ## 这一批和 `tests/client/present.test.ts` 的分工
 *
 * 那边测的是**决定**：给定一个 `WordScore`，三个通道各该是什么值。
 * 这边测的是**画**：三个通道有没有真的变成三组互不覆盖的视觉标记。
 *
 * 两边都要有，因为它们会各自坏掉，而且坏法不同：
 * 决定层坏了是「算错了」，组件层坏了是「算对了但画丢了」——
 * 后者尤其容易发生在重画界面的时候，**而且不报错**。
 * M3 的铁律「界面长得和 M2 一模一样」，靠的就是这一批。
 *
 * ## 输入空间分类
 *
 *   A. 三个维度的 8 种组合 —— 每一种都要三层齐备  ⭐
 *   B. 底色的四种取值
 *   C. 音素弹出层
 *   D. 无障碍与降级
 *
 * A 组用 `data-*` 属性断言，不断言 class 名。class 是排版细节，
 * 会随 Tailwind 的写法变；`data-base` / `data-flat` / `data-brk` 是
 * **组件对外承诺的三个通道**，它们变了才是行为变了。
 */

function word(opts: { wrong?: boolean; flat?: boolean; broke?: boolean }) {
  return {
    word: opts.wrong ? "think" : "fast",
    accuracy: opts.wrong ? 41 : 92,
    errorType: opts.wrong ? "Mispronunciation" : "None",
    phonemes: [
      { phoneme: "th", accuracy: 22 },
      { phoneme: "ih", accuracy: 88 },
    ],
    ...(opts.flat ? { monotone: 0.8 } : {}),
    ...(opts.broke ? { breakError: "unexpected" } : {}),
  };
}

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

describe("A. 三个维度的 8 种组合都画得出来", () => {
  test.each(COMBOS)("%s", (_name, opts) => {
    render(<WordList words={[word(opts)]} />);
    const el = screen.getByTestId("word");

    expect(el.dataset["base"]).toBe(opts.wrong ? "mispronounced" : "ok");
    expect(Number(el.dataset["flat"]) > 0).toBe(Boolean(opts.flat));
    expect(el.dataset["brk"]).toBe(opts.broke ? "unexpected" : "");
  });

  test("三样都占时三层同时在场 —— 查表结构画不出这一格", () => {
    render(<WordList words={[word({ wrong: true, flat: true, broke: true })]} />);
    const el = screen.getByTestId("word");

    expect(el.dataset["base"]).toBe("mispronounced");
    expect(el.dataset["flat"]).toBe("3");
    expect(el.dataset["brk"]).toBe("unexpected");
  });

  test("念错且读平时底色让给念错，**下划线照画**", () => {
    // 这一条是 0045 与查表结构的分界：优先级只管底色归谁，
    // 不是「其余的层不显示」。
    render(<WordList words={[word({ wrong: true, flat: true })]} />);
    const el = screen.getByTestId("word");

    expect(el.dataset["base"]).toBe("mispronounced");
    expect(Number(el.dataset["flat"])).toBeGreaterThan(0);
  });

  test("八个词一起渲染时各自独立，不互相串", () => {
    render(<WordList words={COMBOS.map(([, opts]) => word(opts))} />);
    const els = screen.getAllByTestId("word");

    expect(els).toHaveLength(8);
    expect(els.map((e) => e.dataset["base"])).toEqual(
      COMBOS.map(([, o]) => (o.wrong ? "mispronounced" : "ok")),
    );
    expect(els.map((e) => e.dataset["brk"] !== "")).toEqual(
      COMBOS.map(([, o]) => Boolean(o.broke)),
    );
  });

  test("空列表渲染成空容器，不抛", () => {
    render(<WordList words={[]} />);
    expect(within(screen.getByTestId("words")).queryAllByTestId("word")).toHaveLength(0);
  });
});

describe("B. 底色的四种取值", () => {
  test.each([
    ["Mispronunciation", "mispronounced"],
    ["Omission", "omission"],
    ["Insertion", "insertion"],
    ["None", "ok"],
  ])("errorType %s → data-base=%s", (errorType, base) => {
    render(<WordList words={[{ word: "x", accuracy: 92, errorType, phonemes: [] }]} />);
    expect(screen.getByTestId("word").dataset["base"]).toBe(base);
  });

  test.each(["Monotone", "UnexpectedBreak", "MissingBreak"])(
    "韵律类的 %s 不进底色",
    (errorType) => {
      // 涂成念错的话，用户会去改一个根本没念错的音。
      render(<WordList words={[{ word: "x", accuracy: 92, errorType, phonemes: [] }]} />);
      expect(screen.getByTestId("word").dataset["base"]).toBe("ok");
    },
  );

  test("monotone 的三档各画各的粗细", () => {
    render(
      <WordList
        words={[0.2, 0.5, 0.9].map((m) => ({
          word: "x",
          accuracy: 92,
          errorType: "None",
          phonemes: [],
          monotone: m,
        }))}
      />,
    );
    expect(screen.getAllByTestId("word").map((e) => e.dataset["flat"])).toEqual(["1", "2", "3"]);
  });
});

describe("C. 音素弹出层", () => {
  test("有音素就渲染出来，每个一格", () => {
    render(<WordList words={[word({ wrong: true })]} />);
    const box = screen.getByTestId("phonemes");

    expect(box).toHaveTextContent("th");
    expect(box).toHaveTextContent("ih");
  });

  test("只显示分档，不显示原始百分数（0019）", () => {
    // 音素级的绝对值比词级更不可信，给数字只会制造精度的错觉。
    const box = (render(<WordList words={[word({ wrong: true })]} />),
      screen.getByTestId("phonemes"));

    expect(box).toHaveTextContent("要重练");
    expect(box).toHaveTextContent("很好");
    expect(box.textContent).not.toContain("22");
    expect(box.textContent).not.toContain("88");
  });

  test("没有音素就不渲染这个层 —— 不留一个空弹层", () => {
    render(<WordList words={[{ word: "x", accuracy: 92, errorType: "None", phonemes: [] }]} />);
    expect(screen.queryByTestId("phonemes")).toBeNull();
  });

  test("键盘也能唤出来：词是可聚焦的", async () => {
    // 只在 hover 时显示的话，键盘用户永远看不到音素明细。
    render(<WordList words={[word({ wrong: true })]} />);
    await userEvent.tab();
    expect(screen.getByTestId("word")).toHaveFocus();
  });
});

describe("D. 无障碍与降级", () => {
  test("悬停文案把三层都说出来", () => {
    render(<WordList words={[word({ wrong: true, flat: true, broke: true })]} />);
    expect(screen.getByTestId("word").title).toBe("念得不准 · 读得很平 · 这里不该停");
  });

  test("什么都没有时说「念准了」，不是空字符串", () => {
    render(<WordList words={[word({})]} />);
    expect(screen.getByTestId("word").title).toBe("念准了");
  });

  test("describeMarks 与 wordMarks 对得上", () => {
    // 组件用的是同一对函数，这条守的是它们没有各写一份判断。
    expect(describeMarks(wordMarks(word({ flat: true })))).toBe("读得很平");
  });

  test("形状不对的词降级成一个空词，不让整段炸掉", () => {
    // 一个坏词不该把整句的标记全带走。
    render(<WordList words={[null, word({ wrong: true })]} />);
    const els = screen.getAllByTestId("word");

    expect(els).toHaveLength(2);
    expect(els[0]?.dataset["base"]).toBe("ok");
    expect(els[1]?.dataset["base"]).toBe("mispronounced");
  });
});
