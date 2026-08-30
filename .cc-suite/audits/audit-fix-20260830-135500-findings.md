# Audit Findings

**Codex unavailable — manual analysis.** To restore Codex mode:
- codex-cli registration: missing（Inkling 里没有 `.mcp.json`，也没有 `.cc-suite.md`——这个仓库没接过 cc-suite）
- codex binary on PATH: yes — `/Users/luoxiang/.local/bin/codex`（codex-cli 0.146.0）
- **实际失败原因不是没装**：runner 连续两次返回
  `status: "failed"`、`error: "You've hit your usage limit. Upgrade to Plus to continue using Codex"`。
  升级是要花钱的事，不在我能自己决定的范围内，所以没有升级，改走 fallback。
- Suggested fix: 等额度恢复后重跑 `/cc-suite:audit-fix`；若要在 Inkling 里常用，先 `/cc-suite:init`
- Full diagnostic: `/cc-suite:diagnose`

**Run**: audit-fix 20260830-135500 | **Scope**: 本次迁移新增/改写的生产代码（10 个文件） | **Audit type**: mini（5 维）
**Model**: —（fallback：Claude 手动） | **Effort**: — | **Audit thread**: —（两次 failed：`audit-mtfe7rhb-kzhi11`、`audit-mtfe84hk-jpc0n4`）
**Status values**: open | fixed | not-fixed | partial | regressed | skipped

| # | File | Line | Severity | Dimension | Finding | Suggested fix | Status | Round |
|---|------|------|----------|-----------|---------|---------------|--------|-------|
| 1 | src/storage/dict-store.ts | 150 | High | 1 逻辑 | 坏清单的处理写错了两处：`rm` 和 `writeFile` **各自调一次 `Date.now()`**，是两个不同的路径名，所以那个 `rm` 什么也没删；而且**原始的坏 `index.json` 从来没被挪走**——下次 `list()` 又会检测到它，再写一个新的 `.corrupt.<ts>`。文件无上限增长。`word-store` 那边用 `rename` 是对的，两处应当一致。 | 改成一次 `rename(path, \`${path}.corrupt.${ts}\`)`，一个时间戳 | fixed | 1 |
| 2 | src/electron/main.ts | 81 | High | 1 逻辑 | 词典频道在 `realReaderFactory().then(...)` 里注册，而 `createWindow()` 在它**外面同步执行**。窗口可能先渲染并调 `dict.list()`，那时频道还没注册 → `No handler registered`。竞态，且只在冷启动偶发。 | 先 await 拿到 factory、注册完频道，再开窗口 | fixed | 1 |
| 3 | src/renderer/App.tsx | 138, 213 | Medium | 1 逻辑 | `URL.createObjectURL` 的结果从不 `revokeObjectURL`。每合成一次范本、每录一次音都漏一个 blob（音频，几百 KB 到 2 MB）。**旧的 vanilla 版本是 revoke 的**（`if (myUrl) URL.revokeObjectURL(myUrl)`），M3 搬家时丢了——这是一处回归。 | 换 url 之前 revoke 旧的；组件卸载时也 revoke | fixed | 1 |
| 4 | src/renderer/lib/ipc.ts | 63 | Medium | 3 死代码 | `bytes()` 的函数体是 `return result`——一个 `async` 空壳；`json()` 也没有任何调用方。两个都是写的时候预备着、后来没用上的。 | 删掉 | fixed | 1 |
| 5 | src/renderer/components/PitchChart.tsx | 30 | Low | 2 重复 | render 每次都重算一遍 `pitchPlot()` 只为判断「画不画」，而它要遍历两条曲线的每一帧；任何无关的 state 变化都会让它重跑。 | 判断那一次用 `useMemo` 记住 | fixed | 1 |
| 6 | src/core/dict/mdict.ts | 30 | Low | 5 快捷方式 | `InstalledDict.mdds` 存下来了，但**查词路径完全不用**——参考实现的 `getResource`（读 `.mdd` 里的图片/发音）没搬。M4.1 的验收没要求，但「存了不用的字段」要在文件头说清楚，否则下一个人会以为资源已经能读了。 | 文件头写明这一版不读资源，以及为什么 | fixed | 1 |

## 两处自我更正

### 一、第 2 条的修法一度基于一个错误的观测

修完第 2 条之后重启 Electron，我用
`osascript -e 'tell application "System Events" ... get count of windows'`
读到 0，判定「窗口不开了」，据此又改了一轮（把注册改成同步 require）。

**那个观测是错的。** 直接问 Electron 自己
（`BrowserWindow.getAllWindows().length`）拿到的是 **1** —— 窗口一直开着，
AppleScript 那条路读不到而已。

改成同步 require 这件事**本身仍然值得做**（同步注册就没有竞态；
可选功能的加载失败不该让窗口不开；CJS 包在 ESM 主进程里 `createRequire`
比 `await import()` 直接），所以保留。但代码注释里原本写着
「结果是窗口根本不开」——那是把一个测量错误写成了事实，已经改掉。

**教训**：外部工具说「没有」的时候，先确认它看得见。

### 二、第 5 条的严重程度判错了

第 5 条最初被判成 Medium，理由写的是「两次调用的宽度不同，窄窗口下可能
一个说有段、一个说没有」。**那个理由是错的**：`pitchPlot` 的段数只由数据里
有没有非 null 的读数决定，宽度只影响坐标，不影响段数。

第一版的修法（改成 effect 里量完再决定显不显示）因此是过度反应，而且顺带
改掉了行为——空的时候会渲染一个隐藏的容器，而 M2 是整块不渲染，
这违反 M3「不顺带做任何功能改动」的铁律。已改回 `useMemo`：
判断仍在 render、仍然 `return null`，只是不再每次重算。

降级为 Low，因为剩下的只是一点无谓的计算。

## 备注：本轮没有做的事

`cc-suite:audit-fix` 的 fix 循环要求由 Codex 独立复核（Step 3c verify 是一次独立的
read-only 调用）。Codex 额度用尽，所以**这一轮没有独立验证**——上面的 `fixed`
是「改了并且被用例与 typecheck 覆盖」，不是「被第二个审计者确认过」。
额度恢复后重跑 `/cc-suite:audit-fix` 可以补上那一步。
