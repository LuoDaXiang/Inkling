import { describe, test, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DictSettings } from "@renderer/components/DictSettings";
import { WordBook } from "@renderer/components/WordBook";
import type {
  DictBridge,
  ImportOutcome,
  InstalledDict,
  SavedWord,
  WordsBridge,
} from "@renderer/lib/ipc";

/**
 * 词典设置与生词本的组件层 —— 迁移计划 M4.2 / M4.3。
 *
 * ## 输入空间分类
 *
 *   A. 词典列表 —— 空、有、卸载要确认
 *   B. 导入 —— 成功、**取消不是失败**、真失败要说话  ⭐
 *   C. 生词本 —— 增删、空状态
 *   D. 查词 —— 查得到、查不到、没装词典  ⭐
 *   E. 释义是外来 HTML，必须隔离  ⭐
 *
 * **B 是最容易做错的一条**：用户点开文件对话框又关掉是最常见的操作，
 * 为它弹一个红字，用户会以为自己弄坏了什么。
 *
 * **E 是安全性**：释义是词典作者写的 HTML，不是我们的内容。塞进主文档
 * 就等于把渲染层（连同挂在上面的 preload）交给一本来路不明的词典。
 */

const dict = (overrides: Partial<InstalledDict> = {}): InstalledDict => ({
  hash: "abcdef0123456789abcdef0123456789",
  title: "Collins",
  mdx: "/dicts/x/Collins.mdx",
  mdds: [],
  installedAt: 1,
  ...overrides,
});

function dictBridge(overrides: Partial<DictBridge> = {}): DictBridge {
  return {
    list: async () => [],
    import: async (): Promise<ImportOutcome> => ({ ok: false, cancelled: true }),
    remove: async () => undefined,
    lookup: async () => null,
    ...overrides,
  };
}

function wordsBridge(overrides: Partial<WordsBridge> = {}): WordsBridge {
  return {
    list: async () => [],
    add: async (word): Promise<SavedWord> => ({ word, addedAt: 1 }),
    annotate: async (word, note): Promise<SavedWord> => ({ word, addedAt: 1, note }),
    remove: async () => undefined,
    ...overrides,
  };
}

describe("A. 词典列表", () => {
  test("没装词典时说的是产品事实，不是「点上面那个按钮」", async () => {
    render(<DictSettings bridge={dictBridge()} />);
    await waitFor(() => expect(screen.getByTestId("dict-empty")).toBeInTheDocument());
    expect(screen.getByTestId("dict-empty")).toHaveTextContent("Inkling 不附带词典");
  });

  test("装了就列出来", async () => {
    render(<DictSettings bridge={dictBridge({ list: async () => [dict()] })} />);
    await waitFor(() => expect(screen.getAllByTestId("dict-item")).toHaveLength(1));
    expect(screen.getByTestId("dict-list")).toHaveTextContent("Collins");
  });

  test("有资源文件时说清楚有几个", async () => {
    render(
      <DictSettings bridge={dictBridge({ list: async () => [dict({ mdds: ["/a.mdd"] })] })} />,
    );
    await waitFor(() => expect(screen.getByTestId("dict-list")).toHaveTextContent("1 个资源文件"));
  });

  test("卸载要先确认 —— 误删的代价是重新找一遍几百兆的文件", async () => {
    const remove = vi.fn(async () => undefined);
    render(<DictSettings bridge={dictBridge({ list: async () => [dict()], remove })} />);

    await waitFor(() => expect(screen.getByTestId("dict-remove")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("dict-remove"));

    expect(remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("dict-remove-confirm"));
    expect(remove).toHaveBeenCalledWith(dict().hash);
  });

  test("列表读不出来时当成空的，不白屏", async () => {
    render(
      <DictSettings
        bridge={dictBridge({
          list: async () => {
            throw new Error("坏了");
          },
        })}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("dict-empty")).toBeInTheDocument());
  });
});

describe("B. 导入", () => {
  test("成功之后刷新列表", async () => {
    let installed = false;
    render(
      <DictSettings
        bridge={dictBridge({
          list: async () => (installed ? [dict()] : []),
          import: async () => {
            installed = true;
            return { ok: true, dict: dict() };
          },
        })}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("dict-empty")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("dict-import"));
    await waitFor(() => expect(screen.getAllByTestId("dict-item")).toHaveLength(1));
  });

  test("取消不弹错 —— 点开对话框又关掉是最常见的操作", async () => {
    render(
      <DictSettings
        bridge={dictBridge({ import: async () => ({ ok: false, cancelled: true }) })}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("dict-import")).toBeEnabled());
    await userEvent.click(screen.getByTestId("dict-import"));

    // 界面上不该出现任何错误文字，列表仍然是空状态。
    await waitFor(() => expect(screen.getByTestId("dict-empty")).toBeInTheDocument());
    expect(screen.queryByText(/失败/)).toBeNull();
  });

  test("真失败时按钮恢复可点，不卡在「导入中」", async () => {
    render(
      <DictSettings
        bridge={dictBridge({
          import: async () => ({ ok: false, cancelled: false, message: "没有 .mdx" }),
        })}
      />,
    );

    await userEvent.click(screen.getByTestId("dict-import"));
    await waitFor(() => expect(screen.getByTestId("dict-import")).toBeEnabled());
  });
});

describe("C. 生词本", () => {
  test("没有生词时给一句能行动的话", async () => {
    render(<WordBook words={wordsBridge()} dict={dictBridge()} dicts={[]} />);
    await waitFor(() => expect(screen.getByTestId("word-empty")).toBeInTheDocument());
  });

  test("加一个词", async () => {
    const add = vi.fn(async (word: string) => ({ word, addedAt: 1 }));
    render(<WordBook words={wordsBridge({ add })} dict={dictBridge()} dicts={[]} />);

    await userEvent.type(screen.getByTestId("word-input"), "serendipity");
    await userEvent.click(screen.getByTestId("word-add"));

    expect(add).toHaveBeenCalledWith("serendipity");
  });

  test("回车也能加", async () => {
    const add = vi.fn(async (word: string) => ({ word, addedAt: 1 }));
    render(<WordBook words={wordsBridge({ add })} dict={dictBridge()} dicts={[]} />);

    await userEvent.type(screen.getByTestId("word-input"), "quick{Enter}");
    expect(add).toHaveBeenCalledWith("quick");
  });

  test("空输入时按钮是禁用的", async () => {
    render(<WordBook words={wordsBridge()} dict={dictBridge()} dicts={[]} />);
    expect(screen.getByTestId("word-add")).toBeDisabled();
  });

  test("列出已有的词，笔记跟着显示", async () => {
    render(
      <WordBook
        words={wordsBridge({
          list: async () => [{ word: "fast", addedAt: 2, note: "我的笔记" }],
        })}
        dict={dictBridge()}
        dicts={[]}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("word-list")).toHaveTextContent("fast"));
    expect(screen.getByTestId("word-list")).toHaveTextContent("我的笔记");
  });

  test("删掉一个词", async () => {
    const remove = vi.fn(async () => undefined);
    render(
      <WordBook
        words={wordsBridge({ list: async () => [{ word: "gone", addedAt: 1 }], remove })}
        dict={dictBridge()}
        dicts={[]}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("word-remove")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("word-remove"));
    expect(remove).toHaveBeenCalledWith("gone");
  });
});

describe("D. 查词", () => {
  const withOneWord = (dictOverrides: Partial<DictBridge> = {}, dicts = [dict()]) =>
    render(
      <WordBook
        words={wordsBridge({ list: async () => [{ word: "fast", addedAt: 1 }] })}
        dict={dictBridge(dictOverrides)}
        dicts={dicts}
      />,
    );

  test("点开就查，查得到就显示", async () => {
    withOneWord({ lookup: async () => "<b>quick</b>" });

    await waitFor(() => expect(screen.getByTestId("word-open")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("word-open"));

    await waitFor(() => expect(screen.getByTestId("definition-frame")).toBeInTheDocument());
  });

  test("查不到时说清楚是「这本词典里没有」", async () => {
    withOneWord({ lookup: async () => null });

    await userEvent.click(await screen.findByTestId("word-open"));
    await waitFor(() =>
      expect(screen.getByTestId("word-definition")).toHaveTextContent("查不到"),
    );
  });

  test("没装词典时说的是「去导入一本」，不是「查不到」", async () => {
    // 两种说法对用户的意义完全不同：一个是「去做件事」，
    // 一个是「这个词不在词典里」。
    withOneWord({}, []);

    await userEvent.click(await screen.findByTestId("word-open"));
    expect(screen.getByTestId("word-definition")).toHaveTextContent("还没装词典");
  });

  test("再点一次收起来", async () => {
    withOneWord({ lookup: async () => "<b>quick</b>" });

    const open = await screen.findByTestId("word-open");
    await userEvent.click(open);
    await waitFor(() => expect(screen.getByTestId("word-definition")).toBeInTheDocument());

    await userEvent.click(open);
    expect(screen.queryByTestId("word-definition")).toBeNull();
  });

  test("查词抛错时不崩，当成查不到", async () => {
    withOneWord({
      lookup: async () => {
        throw new Error("词典坏了");
      },
    });

    await userEvent.click(await screen.findByTestId("word-open"));
    await waitFor(() =>
      expect(screen.getByTestId("word-definition")).toHaveTextContent("查不到"),
    );
  });
});

describe("E. 释义是外来 HTML，必须隔离", () => {
  test("释义走 sandbox 的 iframe，不塞进主文档", async () => {
    // 直接 innerHTML 的话，一本被做过手脚的词典就能读到整个渲染层——
    // 而 preload 就挂在那上面。
    render(
      <WordBook
        words={wordsBridge({ list: async () => [{ word: "fast", addedAt: 1 }] })}
        dict={dictBridge({ lookup: async () => "<img src=x onerror='alert(1)'>" })}
        dicts={[dict()]}
      />,
    );

    await userEvent.click(await screen.findByTestId("word-open"));
    const frame = await screen.findByTestId("definition-frame");

    expect(frame.tagName).toBe("IFRAME");
    // 空的 sandbox = 什么都不给：不给脚本、不给同源、不给表单提交。
    expect(frame.getAttribute("sandbox")).toBe("");
  });

  test("释义没有出现在主文档的 DOM 里", async () => {
    render(
      <WordBook
        words={wordsBridge({ list: async () => [{ word: "fast", addedAt: 1 }] })}
        dict={dictBridge({ lookup: async () => "<b>SENTINEL</b>" })}
        dicts={[dict()]}
      />,
    );

    await userEvent.click(await screen.findByTestId("word-open"));
    await screen.findByTestId("definition-frame");

    // srcDoc 是属性，不是子节点——主文档里没有那个 <b>。
    expect(screen.queryByText("SENTINEL")).toBeNull();
  });
});
