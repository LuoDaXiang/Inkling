import * as React from "react";
import { toast } from "sonner";
import type { DictBridge, InstalledDict } from "@renderer/lib/ipc";

/**
 * 词典设置 —— 迁移计划 M4.2。
 *
 * 列出已装的词典、导入、卸载。**自己写，没搬参考实现那 576 行**
 * （`context/dict-provider.tsx` 222 + `preferences/dict-settings/` 354）：
 * 那批代码的形状是被它自己的 provider 体系和 8 本预置词典的下载/校验流程
 * 撑起来的——预置词典这一层我们不碰（版权），provider 体系我们没有。
 * 剩下的就是一张表加两个按钮。
 *
 * ## 三件事写在这里，因为它们会被重画掉
 *
 * 1. **「取消导入」不是失败。** 用户点开对话框又关掉是最常见的操作；
 *    为它弹一个红字，用户会以为自己弄坏了什么。
 * 2. **没装词典时说清楚下一步。** 空列表配一句「点导入」是废话；
 *    要说的是「Inkling 不附带词典」——这是一个产品事实，不是一个空状态。
 * 3. **卸载要确认。** 词典是用户自己找来的几百兆文件，误删的代价是重新找一遍。
 */
export interface DictSettingsProps {
  bridge: DictBridge;
}

export function DictSettings({ bridge }: DictSettingsProps) {
  const [dicts, setDicts] = React.useState<InstalledDict[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    bridge
      .list()
      .then(setDicts)
      .catch(() => setDicts([]));
  }, [bridge]);

  React.useEffect(refresh, [refresh]);

  async function doImport(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await bridge.import();
      if (outcome.ok) {
        toast.success(`装好了《${outcome.dict.title}》`);
        refresh();
        return;
      }
      // 取消不是失败。见文件头第 1 条。
      if (outcome.cancelled) return;
      toast.error(outcome.message);
    } catch (err) {
      toast.error(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function doRemove(hash: string): Promise<void> {
    setConfirming(null);
    try {
      await bridge.remove(hash);
      refresh();
    } catch (err) {
      toast.error(`卸载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <section
      data-testid="dict-settings"
      className="flex flex-col gap-3.5 rounded border border-border bg-card p-5"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">词典</h2>
        <button
          type="button"
          onClick={() => void doImport()}
          disabled={busy}
          data-testid="dict-import"
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--ground)] disabled:opacity-45"
        >
          {busy ? "导入中…" : "导入词典"}
        </button>
      </div>

      {dicts === null ? (
        <p className="text-sm text-muted-foreground" data-testid="dict-loading">
          读取中…
        </p>
      ) : dicts.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="dict-empty">
          {/* 空状态说的是产品事实，不是一句「点上面那个按钮」。 */}
          Inkling 不附带词典。导入你合法获得的 <code>.mdx</code>
          （连同它的 <code>.mdd</code>，如果有的话）就能查词。
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="dict-list">
          {dicts.map((dict) => (
            <li
              key={dict.hash}
              data-testid="dict-item"
              className="flex items-center justify-between gap-3 rounded border border-border px-3 py-2"
            >
              <span className="flex flex-col">
                <span className="text-sm">{dict.title}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {dict.mdds.length > 0 ? `含 ${dict.mdds.length} 个资源文件 · ` : ""}
                  {dict.hash.slice(0, 8)}
                </span>
              </span>

              {confirming === dict.hash ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">删掉这本词典？</span>
                  <button
                    type="button"
                    onClick={() => void doRemove(dict.hash)}
                    data-testid="dict-remove-confirm"
                    className="rounded bg-[var(--bad)] px-3 py-1 text-xs font-semibold text-white"
                  >
                    删掉
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded bg-secondary px-3 py-1 text-xs"
                  >
                    算了
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(dict.hash)}
                  data-testid="dict-remove"
                  className="rounded bg-secondary px-3 py-1 text-xs"
                >
                  卸载
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
