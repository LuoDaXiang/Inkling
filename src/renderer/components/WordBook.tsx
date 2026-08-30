import * as React from "react";
import { toast } from "sonner";
import type { InstalledDict, SavedWord, WordsBridge, DictBridge } from "@renderer/lib/ipc";

/**
 * 生词本 —— 迁移计划 M4.3。
 *
 * **自己写，用本地存储。** 参考实现的 `pages/vocabulary.tsx` 走
 * `webApi.mineMeanings()`，`components/meanings/` 也一样——数据源是它自己的
 * 服务器，本地根本没有 Meaning 模型。搬过来是个空壳：界面在，点开永远是空的。
 *
 * 验收是「离线可用」，所以这一层**不发任何网络请求**：词从
 * `<data>/words.json` 来，释义从用户自己导入的 `.mdx` 来。
 *
 * ## 释义不存进生词本
 *
 * 存的只有词、时间、和用户自己写的一句话。释义每次现查——
 * 词典会换（今天用柯林斯，明天导入朗文），而**笔记不该跟着词典一起变**。
 * 把释义腌进生词本，换一本词典之后用户看到的就是上一本的残影。
 */
export interface WordBookProps {
  words: WordsBridge;
  dict: DictBridge;
  /** 当前用哪本词典查。空表示还没装任何词典。 */
  dicts: InstalledDict[];
}

export function WordBook({ words, dict, dicts }: WordBookProps) {
  const [saved, setSaved] = React.useState<SavedWord[] | null>(null);
  const [draft, setDraft] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const [definition, setDefinition] = React.useState<string | null>(null);
  const [looking, setLooking] = React.useState(false);

  const refresh = React.useCallback(() => {
    words
      .list()
      .then(setSaved)
      .catch(() => setSaved([]));
  }, [words]);

  React.useEffect(refresh, [refresh]);

  async function add(): Promise<void> {
    const word = draft.trim();
    if (word === "") return;
    try {
      await words.add(word);
      setDraft("");
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function show(word: string): Promise<void> {
    if (open === word) {
      setOpen(null);
      setDefinition(null);
      return;
    }
    setOpen(word);
    setDefinition(null);

    const first = dicts[0];
    if (!first) return; // 没装词典。空状态由下面的文案负责，不弹错。

    setLooking(true);
    try {
      setDefinition(await dict.lookup(word, first.hash));
    } catch {
      setDefinition(null);
    } finally {
      setLooking(false);
    }
  }

  return (
    <section
      data-testid="word-book"
      className="flex flex-col gap-3.5 rounded border border-border bg-card p-5"
    >
      <h2 className="text-base font-semibold">生词本</h2>

      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="加一个词"
          aria-label="加一个词"
          data-testid="word-input"
          className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={draft.trim() === ""}
          data-testid="word-add"
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--ground)] disabled:opacity-45"
        >
          加进来
        </button>
      </div>

      {saved === null ? (
        <p className="text-sm text-muted-foreground">读取中…</p>
      ) : saved.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="word-empty">
          还没有生词。练习时碰到不认识的词，加进来。
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="word-list">
          {saved.map((entry) => (
            <li key={entry.word} data-testid="word-item" className="rounded border border-border">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <button
                  type="button"
                  onClick={() => void show(entry.word)}
                  data-testid="word-open"
                  className="flex-1 text-left text-sm"
                  aria-expanded={open === entry.word}
                >
                  {entry.word}
                  {entry.note ? (
                    <span className="ml-2 text-xs text-muted-foreground">{entry.note}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => void words.remove(entry.word).then(refresh)}
                  data-testid="word-remove"
                  className="rounded bg-secondary px-2 py-1 text-xs"
                  aria-label={`删掉 ${entry.word}`}
                >
                  删掉
                </button>
              </div>

              {open === entry.word ? (
                <div className="border-t border-border px-3 py-2" data-testid="word-definition">
                  {dicts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      还没装词典。到「词典」里导入一个 <code>.mdx</code> 就能查了。
                    </p>
                  ) : looking ? (
                    <p className="text-xs text-muted-foreground">查询中…</p>
                  ) : definition === null ? (
                    <p className="text-xs text-muted-foreground">
                      这本词典里查不到「{entry.word}」。
                    </p>
                  ) : (
                    /*
                     * 释义是词典作者写的 HTML，**不是我们的内容**。
                     * 用 iframe + sandbox 隔离：不给脚本、不给同源、不给
                     * 表单提交。直接 innerHTML 塞进主文档的话，一本被做过手脚的
                     * 词典就能读到整个渲染层——而 preload 就挂在那上面。
                     *
                     * 代价是样式进不去（词典自带的 CSS 在 .mdd 里），
                     * 这一版先接受：**能看懂的朴素释义，好过一个能被利用的漂亮释义。**
                     */
                    <iframe
                      title={`${entry.word} 的释义`}
                      data-testid="definition-frame"
                      sandbox=""
                      srcDoc={definition}
                      className="h-40 w-full border-0"
                    />
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
