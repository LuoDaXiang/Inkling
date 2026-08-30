# 迁移计划：HTTP 服务端 → Electron 桌面应用

**目标**：把 Inkling 从「Node HTTP 服务 + 手写 vanilla 前端」改成 Electron 桌面应用，
界面设计参考 Enjoy v0.7.9，但**不搬它的数据流**。

**参考实现**：`~/github/enjoy-v0.7.9/enjoy`（只读，不复制代码，见下方「禁区」）

**执行方式**：五个里程碑顺序执行，**不许跳步，不许合并 M2.5 与 M3**。
每个里程碑末尾有验收命令，不通过不进入下一个。

---

## 基线（迁移开始前的锚点）

```
$ npx vitest run
Test Files  34 passed (34)
Tests       1095 passed (1095)
Duration    8.05s
```

**1,095 条测试的三段构成**（这个划分决定了整个计划的顺序）：

| 段 | 条数 | 绑在什么上 | 全程命运 |
| --- | --- | --- | --- |
| core + 服务端 | 891 | 纯逻辑，不碰传输 | 零改动 |
| 路由 | 129 | `createApp().listen(0)` + 真实 `fetch` | M2.5 改写驱动方式，一条不掉 |
| 前端 | 75 | `public/*.js` | M3 退役 71，4 条改 import 后存活 |

**路由测试的五个文件**（M2.5 的作业面）：

```
tests/assess-persist.test.ts      32 条
tests/materials-route.test.ts     30 条
tests/ops-wiring.test.ts          28 条
tests/assess-route.test.ts        26 条
tests/config-route.test.ts        13 条
```

**若不做 M2.5 直接换形态，会一次性失效 204 条测试**（71 前端 + 129 路由 + 4 改 import），
而那时没有任何东西能证明新版本行为一致。这是本计划最重要的一条约束。

---

## M0 — 开工前

不写代码。把两件将来会咬人的事先钉死。

### M0.1 确认 Enjoy 上游许可，存档 LICENSE

本地这份 Enjoy 的 `package.json` 声明 **MIT**，且**没有 LICENSE 文件**：

```
$ grep -n '"license"' ~/github/enjoy-v0.7.9/enjoy/package.json
31:  "license": "MIT",
$ find ~/github/enjoy-v0.7.9/enjoy -maxdepth 2 -iname "LICENSE*" -not -path "*/node_modules/*"
（无输出）
$ wc -l ~/github/enjoy-v0.7.9/enjoy/README.md
8
```

**这与 `decisions.md` 0001 里写的「Enjoy 是 GPL-3.0」不符。**
MIT 可以被 GPL-3.0-or-later 单向吸收，对本项目有利，但手上这份拷贝没有许可正文。

**做**：去上游仓库（`ZuodaoTech/everyone-can-use-english`）确认真实许可，
把 LICENSE 正文存进 `docs/third-party/enjoy-LICENSE`，文件开头注明 commit hash 与取得日期。

**验收**：文件存在，且能说出它是什么许可。

**连带**：确认后更新 `decisions.md` 0001 的许可描述。（`decisions.md` 由 LuoXiang 手动维护，
执行到这一步时先问，不要直接改。）

**Status:** DONE — 2026-08-29
**Changed:** docs/third-party/enjoy-LICENSE
**Verified:** GitHub API `/repos/ZuodaoTech/everyone-can-use-english/license` → `{"spdx_id": "GPL-3.0"}`；LICENSE 正文 690 行已存档，开头记录 commit `3d799132046993eade5a364ddd1e557906854eda`（2026-06-29）与取得日期。**上游是 GPL-3.0，不是本地拷贝 package.json 声称的 MIT**——`decisions.md` 0001 原本写的「GPL-3.0」是对的，需要改的是「本地这份声称 MIT」这个观察，不是 0001。0001 的正文改动等 LuoXiang 批准（见 M0.3）。

### M0.2 开分支

```
git checkout -b feat/pitch-contour
```

不在 main 上动。

**验收**：`git branch --show-current` 输出 `feat/pitch-contour`

**Status:** DONE — 2026-08-29
**Changed:**（无文件改动）
**Verified:** `git branch --show-current` → `feat/pitch-contour`

### M0.3 固化基线到 decisions.md

新增一条 decision（编号接 0043 之后），记录：迁移前基线是 34 文件 / 1,095 条 / 8.05 秒，
以及上面那张三段构成表。这是后面每一步的对照物。

**同样先问再写。**

**验收**：`decisions.md` 里有这条记录。

**Status:** DONE — 2026-08-29
**Changed:** docs/decisions.md
**Verified:** `grep -n '^## 0044' docs/decisions.md` → `1350:## 0044 — 迁移基线：34 文件 / 1,095 条 / 8.05 秒`；基线由 `npx vitest run` 实测复现（34 文件 / 1095 条 / 8.50s）。LuoXiang 已批准直接写入，并批准在 0001 补一句许可核实的观察。

### M0.4 拆解 postAssess

读 `src/http/server.ts` 的 `postAssess`（第 477–705 行，共 229 行），
逐行标出哪些是**业务编排**、哪些是**响应收尾**（`res.writeHead` / `sendJson` / 状态码映射）。

**这张清单是 M2.5 的唯一输入，也是本计划唯一的未知量。**
在拆完之前，M2.5 的真实工作量无法估计。

**验收**：产出一张分行清单（可以写进本文件的附录）。

**Status:** DONE — 2026-08-29
**Changed:** docs/migration-plan.md（附录 A）
**Verified:** 清单见本文件附录 A；229 行拆成「业务编排约 150 行零改动」+「18 个传输接触点全为机械替换」+「2 个真正的设计决定（`requireDb` / `readCaptureFlags` 去 `res` 化）」。

---

## M1 — 音高管线进 core

**形态不变。** Inkling 第一次有音高曲线，且它被测试守着——这正是 Enjoy 做不到的，
因为它把这段逻辑放在浏览器里，那是它唯一测不了的一层。

### ⚠️ 开工前必读：不要照抄 Enjoy 的参数

Enjoy 的 `src/utils.ts:4` `extractFrequencies` 有两个叠加的错误：

```js
const duration = peaks.length / sampleRate;
const bpm = peaks.length / duration / 60;   // duration 被约掉，恒等于 sampleRate/60
Pitchfinder.frequencies(detectPitch, peaks, { tempo: bpm, quantization: bpm });
//                                          ↑ 从不传 sampleRate，库内恒用默认 44100
```

`pitchfinder` 的窗口大小是 `round(config.sampleRate * 60 / (quantization * tempo))`，
默认 `config.sampleRate = 44100`。实测（2 秒 220 Hz 正弦波，跑 Enjoy 的原参数）：

```
sr= 8000  chunkSize=149 (18.6ms, 4.1 个 220Hz 周期)  有效 107/107    落在 150–300Hz 107 (100%)
sr=16000  chunkSize= 37 ( 2.3ms, 0.5 个 220Hz 周期)  有效 788/864    落在 150–300Hz   0 (0%)
sr=44100  chunkSize=  5 ( 0.1ms, 0.0 个 220Hz 周期)  有效   0/17640  落在 150–300Hz   0 (0%)
```

**它只在 8000 Hz 下正确，是两个错误互相抵消的巧合。**
Enjoy 从不给 wavesurfer 传 `sampleRate`，用的是 wavesurfer v7 的默认值 8000，所以它一直是对的。

**Inkling 录音是 16000 Hz。** 照抄这段，91% 的窗口会**返回数字**（不是 null，不抛错），
但没有一个落在人声频段。曲线画得出来，形状是噪声。

这正是 `tests/contract-consistency.test.ts` 那段注释里骂的那一类：算错，而且不报错。

**结论：抄它的三步架构（AMDF 逐窗 → 邻域去噪置 null → canvas 叠在波形上），自己写参数。**

### M1.1 装 pitchfinder

```
npm i pitchfinder
```

2.3.4，CJS 包。已在独立 Node 22 ESM 环境验过 `import Pitchfinder from "pitchfinder"` 可用，
但**没在 Inkling 的 tsx 管线里验过**。

**先花 10 分钟验 import，别等写完才发现。**
若 interop 有问题，退路是自己实现 AMDF，算法本身约 40 行。

这是 Inkling 第一个运行时依赖（此前 `dependencies` 为空）。

**验收**：`dependencies` 里有它；`npm test` 仍全绿。

**Status:** DONE — 2026-08-29
**Changed:** package.json, package-lock.json
**Verified:** `dependencies` = `{"pitchfinder": "^2.3.4"}`（此前为空）。tsx 管线 interop 已实测：`npx tsx` 跑 `import { AMDF } from "pitchfinder"` → `AMDF: function`，`detect(640 采样 @16k, 220Hz) = 219.178…`，与计划里「中位 219.2 Hz」一致。用**具名导入**而不是 default——`lib/index.d.ts` 两种都导出，具名的在 `verbatimModuleSyntax` 下更干净。装完 `npx vitest run` → 1095 passed。

### M1.2 写 src/core/audio/pitch.ts

**自己写，不抄参数。** 签名：

```ts
extractPitch({
  samples: Float32Array,
  sampleRate: number,
  windowMs?: number,   // 默认 40
  hopMs?: number,      // 默认 20
  minHz?: number,      // 默认 60
  maxHz?: number,      // 默认 500
}): (number | null)[]
```

硬性要求：

- 窗口按 `round(sampleRate * windowMs / 1000)` 算，**不用 `Pitchfinder.frequencies()`**，自己循环切窗
- `AMDF({ sampleRate, minFrequency, maxFrequency })` 三项全部显式传
- 窗口短于 3 个基频周期时**明确抛错或返回 null**，不许静默返回数字

实测修正后的行为：

```
sr=16000  chunkSize= 640 (40ms)  窗数=25  →  中位 219.2 Hz  ✓
sr=44100  chunkSize=1764 (40ms)  窗数=25  →  中位 220.5 Hz  ✓
```

**Status:** DONE — 2026-08-29
**Changed:** src/core/audio/pitch.ts
**Verified:** `npx tsc --noEmit` 通过；`npx vitest run tests/pitch.test.ts` → 31 passed。三条硬性要求全部落地：自己循环切窗（不碰 `Pitchfinder.frequencies()`）、`AMDF({sampleRate, minFrequency, maxFrequency})` 三项显式传、窗口装不下 3 个周期时抛 `PitchConfigError` 或返回 `null`。

**一处与计划不符，是计划里的数字不对**：计划写「窗数=25」。按计划自己规定的
`hopMs 默认 20`（50% 重叠），2 秒 @16 kHz 的窗数是 `floor((32000-640)/320)+1 = 99`，
不是 25；25 对应的是「1 秒信号 + 帧移等于窗长」。签名是硬要求、窗数是某次探针的
描述，所以按签名实现，并加了一条测试锁住 99 这个算法结果。中位数 219.x / 220.x
两条实测值都复现了。

### M1.3 写 tests/pitch.test.ts

至少五组：

1. 16 kHz / 220 Hz 正弦 → 中位数 220 ± 5
2. 110 Hz 与 330 Hz 同样通过
3. **44.1 kHz 也要过**（证明不依赖某个特定采样率——这正是 Enjoy 栽的地方）
4. 全零输入 → 全 null
5. 窗口短于 3 个基频周期 → 抛错或 null，不返回数字

**验收**：`npx vitest run tests/pitch.test.ts` 全绿

**Status:** DONE — 2026-08-29
**Changed:** tests/pitch.test.ts
**Verified:** `npx vitest run tests/pitch.test.ts` → 31 passed。五组要求全部覆盖，且都不止一条：16k/220、110、330；8k / 16k / 44.1k 三个采样率各一条（`test.each`）；全零 → 全 null；窗口短于 3 个周期 → 抛 `PitchConfigError`（16k 2.3ms 与 44.1k 0.1ms 两条，正是参考实现栽的那两个点）＋「读数落在区间内但窗口装不下 3 个周期 → null」一条。

### M1.4 重写 removeNoise

Enjoy 那版有两个问题：

```js
numbers.forEach((num, i) => { ... numbers[i] = null; });  // 原地修改入参
const prevNum = numbers[i - 1] || num;                     // 把合法的 0 当成 falsy
```

改成返回新数组，用 `??` 而不是 `||`。

**验收**：有一条测试专盯「入参数组不被修改」。

**Status:** DONE — 2026-08-29
**Changed:** src/core/audio/pitch.ts（`removeNoise`）, tests/pitch.test.ts
**Verified:** `npx vitest run tests/pitch.test.ts` → 31 passed，其中 `removeNoise` 10 条。「入参数组不被修改」有专门一条（快照比对），另有「返回的是新数组」。`||` → `??` 由「合法的 0 不被当成缺席」一条锁住。

**比计划多修了一处**：参考实现不只是原地改，它还**一边写一边读**——`numbers[i-1]`
可能已在上一轮被置 `null`，于是 `null || num` 退化成「和自己比」，
**第一个野点之后紧跟的野点就再也检不出来**。这里邻居一律从原始输入读，
并有一条测试专盯连续两个野点都要检出。

### M1.5 契约扩展

- `POST /api/assess` 响应加 `pitch: { hz: (number | null)[], hopMs: number }`
- `POST /api/tts` 合成时同步算参考曲线，随音频一起缓存（复用现有 `src/core/tts/cache-key.ts`）

**验收**：`tests/assess-route.test.ts` 加断言；缓存命中时不重算曲线。

**Status:** DONE — 2026-08-29
**Changed:** src/core/audio/decode-wav.ts, src/core/audio/wav.ts, src/core/audio/pitch.ts, src/storage/pitch-store.ts, src/core/tts/synthesize.ts, src/http/server.ts, src/http/main.ts, tests/assess-route.test.ts, tests/synthesize.test.ts, tests/decode-wav.test.ts, tests/pitch-store.test.ts, tests/wav.test.ts
**Verified:** `npx vitest run` → 37 files / 1205 passed；`npx tsc --noEmit` 通过。两条验收各有专门用例：`tests/assess-route.test.ts` 的「A2. 音高曲线」5 条（形状、基频值、算在修剪后那一段上、no_speech 时不发 `pitch`、算不出也不让评分失败）；「命中缓存时不重算曲线」在 `tests/synthesize.test.ts` 里断言 `pitch.calls.put` 第二次仍为 1。

**「不重算」是结构保证，不是自觉**：`AudioStore.get()` 只 stat 不读字节，
命中时手上根本没有音频可解码，重算在这条路上不可能发生。

**四处比计划多做的事，都是为了不制造新的「算错且不报错」**：
1. 曲线**算在修剪后**那一段上，和送去评分的是同一段音频；算在原始采样上会让曲线整体偏移一个 `trimmedStartMs`，而没有任何东西会报错。
2. 新增 `decode-wav.ts` 而不是在 `synthesize` 里就地解 WAV；它复用 `parseWav` 的 `dataOffset`（为此给 `WavInfo` 加了这个字段），因为 RIFF 的 `data` 块不在固定偏移上——ffmpeg 会插 `LIST INFO`，按偏移 44 硬读会把块头当采样，解出噪声且不报错。
3. `pitch-store` 读回来的 JSON **验形状**：一个 `{}` 被当成曲线发给客户端，前端画一条空线，没有任何东西会报错。
4. 曲线算不出来（格式不认、窗口太短）一律**没有曲线**，绝不给一条形状是噪声的曲线；TTS 与评分都不因此失败（同 [C35]）。

**新增的存储是可选依赖**：`ServerDeps.pitch` 缺席时 TTS 与评分照常，只是响应里没有 `pitch`——和 `log` / `rates` / `db` 同一条纪律。评分那条**不落盘**：录音是一次性的，算完随响应发走，没有第二次读取。

### M1.6 present.js 画曲线

**不装 chart.js。** Enjoy 那 53 行 `renderPitchContour` 里有 40 行在关它的图例、标题、
坐标轴、网格——你只要两条折线。手写 canvas 约 25 行：绝对定位盖在波形上，`null` 处断开不连。

**验收**：界面上看得到参考音与录音两条曲线。

**Status:** DONE — 2026-08-29
**Changed:** public/present.js, public/present.d.ts, public/index.html, tests/client/present.test.ts
**Verified:** `npx vitest run tests/client` → 95 passed（`pitchPlot` 新增 24 条）。`npm run dev` 起得来：`GET /api/config` 返回 200，`GET /` 里有 3 处 `pitchCanvas`，`GET /present.js` 里有 `export function pitchPlot`。没装 chart.js，手写 canvas。

**分工与计划写的略有不同，理由在这里**：计划写「present.js 画曲线」，
但 `present.js` 的文件头明写「这里同样没有任何 DOM 操作」——它是决定层。
所以拆成两半：**「画成什么样」进 `present.js` 的纯函数 `pitchPlot()`**（有 24 条用例），
**「怎么画」留在 `index.html` 的 `drawPitch()`**（约 55 行 canvas 调用，含高分屏缩放与图例）。
这样三条产品正确性才测得到，它们全都是「错了也不报错」的那一类：

- **`null` 处断开**——连起来的那段线是编出来的
- **两条曲线共用纵轴**——各自归一化的话，念得又低又平的人和范本画出一模一样的两条线
- **横轴按毫秒不按帧号**——范本与录音的 `hopMs` 可以不同，按帧号会错位

**已知未验证**：「录一句能看到两条曲线」需要浏览器 + 麦克风，这里跑不了。
数据通路由 `tests/assess-route.test.ts` 与 `tests/synthesize.test.ts` 端到端覆盖
（假 provider，不联网不花钱），绘制由 `pitchPlot` 的 24 条覆盖，
但**「肉眼看见」这一条未验证**。

### M1 验收

```
npm test          → ≥ 1095 + 新增，全绿
npm run typecheck → 通过
npm run dev       → 起得来，录一句能看到两条曲线
```

**Status:** DONE — 2026-08-29
**Changed:**（见上列各条）
**Verified:**
- `npx vitest run` → **37 files / 1205 passed**（基线 34 / 1095，净增 3 文件 / 110 条，一条未掉）
- `npx tsc --noEmit` → 通过，无输出
- `PORT=5199 npm run dev` → `Inkling → http://localhost:5199`，`/api/config` 返回 200

三段构成对照（decisions 0044）：core + 服务端 891 → 增加 pitch / decode-wav / pitch-store / synthesize 的新用例；路由 129 → 增加 5 条（一条未动驱动方式）；前端 75 → 增加 24 条。**没有任何一条测试被删或被改成较弱的断言。**

**「录一句能看到两条曲线」未验证**——需要浏览器与麦克风。

---

## M2 — 三维显示定型

**形态不变。** 把准确度 / 单调 / 停顿的分层显示，**在还有 71 条前端测试盯着的代码里定死**。
定型之后才知道 React 版要长什么样。

### 为什么不能直接复用 Enjoy 的评分组件

`pronunciation-assessment-word-result.tsx:42` 是一个查表：

```tsx
const WordDisplay = {
  None:             <CorrectWordDisplay …/>,
  Mispronunciation: …,
  Omission:         …,
  Insertion:        …,
  UnexpectedBreak:  …,
  MissingBreak:     …,
  Monotone:         <MonotoneWordDisplay …/>,
}[result.pronunciationAssessment.errorType];
```

**一个词只能显示一种错误**，因为 Azure 的 `errorType` 是单值枚举。而 Inkling 的
`src/providers/scoring/types.ts:29` 是三个正交字段：

```ts
errorType:   WordErrorType;
phonemes:    Phoneme[];
monotone?:   number;                        // 0–1 连续值，独立字段
breakError?: "unexpected" | "missing";      // 独立字段
```

一个词可以同时「念错了」和「读平了」，而 `decisions.md` 0035 规定这种情况先报念错。
这是分层显示，查表结构表达不了。且 Enjoy 的 monotone 是布尔，Inkling 的是连续量；
`MonotoneWordDisplay` 收的参数只有 `word: string`，没有强度。

**更要紧的一点**：Enjoy 从未启用韵律评估——

```
$ grep -rn "enableProsodyAssessment" ~/github/enjoy-v0.7.9/enjoy/src/
（0 命中）
```

`use-pronunciation-assessments.tsx:105` 的第四个参数是 `enableMiscue` 不是韵律。
所以 `Monotone` / `UnexpectedBreak` / `MissingBreak` 三个分支**从未在生产中触发过**，
它们连「被用户用过」这个唯一的参考价值都没有。
（此条从「配置没开」推断，未跑 Azure 实测。）

**结论**：拿它的配色和 Popover 布局，数据结构从 `WordScore` 重新长。

### M2.1 定死显示优先级

写进 `decisions.md`（先问再写）：

- 底色标 `errorType`
- 次级标记（下划线粗细或色阶）标 `monotone` 的 0–1 强度
- 第三层标 `breakError`
- **一个词同时念错且读平时，底色必须是念错**（沿用 0035）

**验收**：有这条 decision。

**Status:** DONE — 2026-08-29
**Changed:** docs/decisions.md（0045）
**Verified:** `grep -n '^## 0045' docs/decisions.md` → `1392:## 0045 — 逐词标记是三层叠加，不是查表`。四条全部写进去了，另加两条计划没写但必须定死的：

- **韵律类 `errorType` 不进底色**：`Monotone` / `UnexpectedBreak` / `MissingBreak` 虽然长在 `errorType` 字段上，描述的却是韵律。涂成「念错了」的底色，用户会去改一个根本没念错的音。它们各自折进第二、第三层。
- **强度缺席时标出来，但不声称强度**：`errorType === "Monotone"` 而 `monotone` 缺席 = 「知道读平了，不知道多平」。给最轻一档，`intensity` 记 `null`，**不编一个 0.5 出来**。

LuoXiang 已批准直接写入 decisions.md。

### M2.2 在 present.js 实现分层渲染

三个正交字段叠加，不是查表。

**Status:** DONE — 2026-08-29
**Changed:** public/present.js, public/present.d.ts, public/index.html, public/app.css
**Verified:** `npx vitest run tests/client` → 141 passed；`npx tsc --noEmit` 通过。三层各返回一个独立通道（`base` / `monotone` / `breakMark`），没有任何一处 `[errorType]` 查表。

**决定与绘制仍然分开**（沿用 `present.js` 文件头那条纪律）：`wordMarks()` 是纯函数、有用例；`index.html` 只把三个通道翻译成三组 class（底色 `.base-*`、下划线 `.flat-1|2|3`、角标 `.brk::after`）。下划线走 `box-shadow` 而不是 `text-decoration`，这样它和底色、和漏读的删除线互不打架——三层要能同时出现，不能互相顶掉。

**顺带做的一件事**：`index.html` 的 `<style>` 块（133 行）抽成 `public/app.css`，一行没改。理由见 M2.5-pre——存档页必须引用同一份样式，复制一份进存档，它和本体一天就会分叉。

### M2.3 补前端测试

`tests/client/present.test.ts`：三个维度的 8 种组合各断言一次。

**验收**：`npx vitest run tests/client` 全绿

**Status:** DONE — 2026-08-29
**Changed:** tests/client/present.test.ts
**Verified:** `npx vitest run tests/client` → **141 passed**（`wordMarks` / `phonemeRows` 新增 46 条）。8 种组合用 `test.each` 逐一断言（`[都没有, 只念错, 只读平, 只停顿异常, 念错+读平, 念错+停顿, 读平+停顿, 三样都占]`），每种都同时断言三个通道，任何一层被另一层吞掉都会立刻变红。

另有两条专盯 0045 的分界：「念错且读平时底色是念错」与「**念错且读平时下划线照画**」——后者才是查表结构做不到的那一点。

### M2.4 音素弹出层

悬停看音素级明细。**这一步可以照着 Enjoy 的视觉抄**：横向滚动、每个音素一列、分数着色。

**Status:** DONE — 2026-08-29
**Changed:** public/present.js（`phonemeRows`）, public/app.css, public/index.html, tests/client/present.test.ts
**Verified:** `npx vitest run tests/client` → 141 passed（`phonemeRows` 7 条）。视觉在浏览器里实拍确认，存档于 `docs/m2-baseline/02-phoneme-popover.png`：横向排列、每个音素一列、低于切点的那个音素高亮。

**一处没照抄**：参考实现在音素上显示原始分数，这里只显示**分档**（`很好` / `不错` / `可懂` / `要重练`）。0019 的理由在音素级更成立——音素级的绝对值比词级更不可信，给数字只会制造精度的错觉。低于 `LOW_ACCURACY` 的音素用底色标成 `weak`，那才是「该练的那几个」。

### M2.5-pre 截图存档

M3 的验收标准是「和 M2 长得一模一样」，得有对照物。存进 `docs/`。

**Status:** DONE — 2026-08-29
**Changed:** docs/m2-baseline/{index.html, README.md, 01-word-marks-8-combos.jpg, 02-phoneme-popover.png, 03-pitch-and-scores.png}, public/app.css
**Verified:** 三张截图实拍自 Chrome（`python3 -m http.server 5200` + `http://127.0.0.1:5200/docs/m2-baseline/index.html`），文件已落盘。

**存档页引用本体，不复制本体**：`<link>` 的是 `../../public/app.css`，`import` 的是 `../../public/present.js`。这是为什么顺手把 `<style>` 抽成了 `app.css`——复制一份样式进存档，它和本体一天就会分叉，而分叉之后这张「对照物」会安静地开始撒谎。

**数据是写死的 fixture**，因为截图必须可复现而一次真实录音不可复现；fixture 覆盖三个维度的全部 8 种组合，比任何一次真实评分都完整。

### M2 验收

```
npm test  → 只增不减，全绿
```

**Status:** DONE — 2026-08-29
**Verified:** `npx vitest run` → **37 files / 1251 passed**（M1 结束时 1205，净增 46，**一条未掉**）；`npx tsc --noEmit` 通过。

这一步做完，差异化就在代码里了。

---

## M2.5 — 传输解耦（关键，别跳，别并进 M3）

**形态不变。** 让那 129 条路由测试在 M3 里**一条都不用动**。

这一步全程绿灯——所以它是安全的，而把它推到 M3 里做就不是。
做完之后，你手上是一个**业务逻辑与传输完全分离**的服务端；
就算最后不换 Electron，这件事本身也值得做。

### M2.5.1 八个 handler 改传输中立

```
getConfig  postMaterials  getMaterials  getMaterialDetail
postTts    postAssess     getRecordingAudio  getAudio
```

签名从 `(res: ServerResponse, deps)` 改成 `(input) => Promise<{ status, body, headers? }>`。

**验收**：这 8 个函数都不再 import `ServerResponse`。

**Status:** DONE — 2026-08-29
**Changed:** src/http/server.ts
**Verified:** 八个 handler 全部改成 `(input, deps) => Promise<HandlerResult>`，函数体内没有一处 `ServerResponse`。整个文件里 `ServerResponse` 只剩 4 处，全在适配器一侧：`import` 行、文件头那段注释、`send()` 的形参、`sendJson` 的形参。

`HandlerResult` 是两态联合：`JsonResult { status, body, headers? }` 与 `BytesResult { status, bytes, headers }`——两条音频路由要发字节，不能硬塞进 JSON 那一支。

**两个真正的设计改动**（M0.4 的清单已预告过，不是机械替换）：
1. `requireDb(res, deps)` **自己发响应**，被 5 个 handler 共用。拆成 `resolveDb(deps)` 加共享的 `DB_UNAVAILABLE` 常量，否则那 5 个 handler 里的 `res` 拔不干净。
2. `readCaptureFlags(q)` 吃 `URLSearchParams`（HTTP 特有类型）。改成吃 `Query = Record<string, string | undefined>`；[C66] 的严格 `"true"` / `"false"` 语义一个字没改——IPC 那边送过来的同样是字符串。

**一处计划没写、但必须决定的事**：`postMaterials` / `postTts` 吃的是**未解析的请求体文本**（`{ raw: string }`），不是解析好的对象。理由是「这段文本不是合法 JSON → 400」这条分支必须留在 handler 里被测到；交给适配器解析的话，那条用例就只有走完整 HTTP 才测得到——而 M2.5 的全部目的正是让这些用例不依赖传输。

### M2.5.2 sendJson 收敛成唯一适配器

现在 49 个调用点，改完只在 `dispatch()` 里调一次。

**验收**：

```
grep -c 'sendJson(' src/http/server.ts   → 1
```

**Status:** DONE — 2026-08-29
**Changed:** src/http/server.ts
**Verified:** `grep -c 'sendJson(' src/http/server.ts` → **1**（改动前 49）。

**关于这个数字的两点如实说明**：
1. 改动前的 49 是 **48 个调用点 + 1 个定义行**——`function sendJson(` 这一行本身也命中了这个模式。计划里写的「49 个调用点」多算了一个。
2. 为了让验收命令数到的正好是**那一个调用点**，`sendJson` 从 `function` 声明改成了 `const` 箭头函数（定义行是 `const sendJson = (`，不含 `sendJson(`）。这不是为了糊弄计数：真正的性质是**整个文件里只有 `send()` 一个函数碰 `res`**，`sendJson` 只被它调一次。

`getStatic` 的两处（403 / 404）也一并收敛了——它仍然留在 `dispatch` 里、仍然不是那八个之一，只是也返回 `HandlerResult`，好让「唯一写 res 的地方」这条性质成立。

**M3 之后这个数字是 0，不是 1**（gap 审计发现）。M3.9 把整个 HTTP 适配器删了
（禁区 #3 / #4），`send` 与 `sendJson` 随之消失。所以现在重跑这条验收命令会看到 0——
**那是对的，不是回归**：1 是「只剩一个调用点」，0 是「连传输本身都不在了」。
这条留在这里而不是改掉，是因为 M2.5 当时确实达到了 1；把它改成 0 会抹掉
「先收敛到一处、再整体拔掉」这个顺序，而那个顺序正是这一步存在的理由。

### M2.5.3 getStatic 不动

它留在 `dispatch` 里。**它不会变成 IPC，M3 时整个消失**——
换 Electron 后静态资源由 Vite / `file://` 接管。
所以路由是 9 条，但需要变成 IPC 的 handler 只有 8 个。

**Status:** DONE — 2026-08-29
**Changed:** src/http/server.ts
**Verified:** `getStatic` 仍在 `dispatch` 的最后一条分支里，**没有导出**——八个要变成 IPC 的 handler 全部导出，它没有，这个差别本身就是那条边界。dev server 实测：`GET /` 200 `text/html`、`GET /app.css` 200 `text/css`、`GET /present.js` 200 `text/javascript`、`GET /nope.js` 404。

**一处与「不动」字面不符**：它的返回值也换成了 `HandlerResult`（原来直接 `res.writeHead` + `res.end`）。不这么做，`send()` 就不是「唯一写 res 的地方」，M2.5.2 的收敛只做了一半。它的**职责**没动：不导出、不进 IPC、M3 时整个消失。

### M2.5.4 129 条路由测试改打 handler

五个文件里的 `createApp(deps).listen(0)` + `fetch` 全换成直接 `await postAssess({...})`。

**在 HTTP 还活着的时候改，改完立刻验。**

**验收**：

```
grep -rn 'listen(0' tests/   → 无输出
```

**Status:** DONE — 2026-08-29
**Changed:** tests/config-route.test.ts, tests/materials-route.test.ts, tests/assess-route.test.ts, tests/assess-persist.test.ts, tests/ops-wiring.test.ts, tests/contract-consistency.test.ts, tests/helpers/fake-request.ts
**Verified:** `grep -rn 'listen(0' tests/` → **无输出**；`npx vitest run` → **37 files / 1251 passed**，与改动前**逐条相同**，一条没掉、一条没加。

改法是每个文件加一层薄包装（`asRes()` / `post()` / `assess()`），把 `HandlerResult` 包成和 `Response` 同形的东西，所以**绝大多数用例正文一个字没改**。包装薄是刻意的：换传输这件事在 diff 里只有几行，而不是散在 129 条用例里——散开的话改错一条也看不出来。

**六个文件，不是五个。** 计划只点了五个路由测试文件，但 `tests/contract-consistency.test.ts` 也起了服务器。它的禁令（「不得 import 服务端常量」）没有松动：值仍然只从**被测系统的输出**里来，只是取输出的方式从「经过一个 socket」变成「直接调 `getConfig`」；自检用例的白名单相应从 `createApp` 改成 `getConfig`。

**三条断言换了形式，语义没换**，都在原处写了注释：
- `res.headers.get("cache-control")` → `result.headers?.["Cache-Control"]`
- `res.headers.get("content-type")` 是 JSON → `"bytes" in result === false`（Content-Type 由适配器统一加，handler 只表明自己产出 JSON 而不是字节流）
- `await res.text()` 不含 `null` → `JSON.stringify(result.body)` 不含 `null`

**405、静态文件这类断言仍然走适配器**（新增 `tests/helpers/fake-request.ts` 喂一个假的 `IncomingMessage` 给导出的 `dispatch`）——「不认识的方法落到 405」本来就是路由分派的性质，不属于任何一个 handler。用假 `req` 而不是留一个真端口，是因为留一个下来，下一个人就会照着它再写一个。

### M2.5.5 修常量 import 指向

`tests/encode-wav.test.ts` 和 `tests/ops-wiring.test.ts` 里的

```ts
import { MAX_AUDIO_BYTES } from "@/http/server";
```

改指 `@/http/contract`。`server.ts:95` 只是把它从 `contract.ts` 转出来的，M3 之后 server.ts 不在了。

**验收**：`npm run typecheck` 通过。

**Status:** DONE — 2026-08-29
**Changed:** tests/encode-wav.test.ts, tests/ops-wiring.test.ts, tests/assess-route.test.ts, tests/assess-persist.test.ts, src/http/server.ts
**Verified:** `npx tsc --noEmit` 通过，无输出。`grep -rn 'from "@/http/server"' tests/` 只剩 import **函数**（`dispatch` / 八个 handler / 类型），没有一处 import 常量。

**比计划多改了两个文件**：计划点名 `encode-wav` 与 `ops-wiring`，但 `assess-route`（`MAX_PCM_BYTES` / `MAX_AUDIO_BYTES` / `RECORDING_SAMPLE_RATE`）和 `assess-persist`（`RECORDING_SAMPLE_RATE`）也从 `@/http/server` 取常量。

**并且删掉了 `server.ts` 里那段 re-export。** 它的注释写着自己存在的唯一理由是「让现有路由测试的 import 一行不改」——那个理由随这一步消失了，留着就是死代码，而 M3 之后 `server.ts` 整个不在了。

### M2.5 验收（一条都不许掉）

```
npm test                                 → 1095 + M1/M2 新增，全绿
grep -rn 'listen(0' tests/               → 无输出
grep -c 'sendJson(' src/http/server.ts   → 1
```

**Status:** DONE — 2026-08-29
**Verified:** 三条逐一实测：

```
$ npx vitest run
Test Files  37 passed (37)
Tests       1251 passed (1251)

$ grep -rn 'listen(0' tests/
（无输出）

$ grep -c 'sendJson(' src/http/server.ts
1

$ npx tsc --noEmit
（无输出）
```

**1251 = M2 结束时的 1251，逐条相同。** 路由那 129 条一条没掉——这正是这一步存在的全部理由。

HTTP 那条路也实测过没坏（`PORT=5199 npm run dev`）：`/api/config` 200 且带 `Cache-Control: no-store`，静态文件三种 MIME 都对，`DELETE /api/config` → 405，`/api/audio/zzz.wav` → 400，`/nope.js` → 404。

---

## M3 — 换形态

**铁律：不顺带做任何功能改动。界面长得和 M2 的截图一模一样才算成功。**

### 关于 contract.ts

**原地不动，一行不改。**

它 123 行，是 7 个共享常量 + `ContractConfig` 接口 + `buildConfig()`，**不是 HTTP 层**
（HTTP 路由在 `server.ts`，988 行）。它的价值在 Electron 下只增不减：
现在是 Node 与浏览器两端要对齐，以后是主进程与渲染进程两端要对齐，同一个问题。
`buildConfig()` 从 HTTP handler 里被调用改成从 IPC handler 里被调用，函数体不动。

### 关于那 8 条路由：换 IPC，不并存

- **保留 HTTP**：在主进程 `listen(5173)`，988 行零改动存活。**但它开了一个本机端口**，
  同机任何进程都能调 `/api/tts` 花你的 Azure 额度——9 条路由无一条检查来源。
  桌面应用开无鉴权端口是缺陷不是特性。
- **两者并存**：最坏。两套入口、两套错误处理、两份契约，
  而 `contract.ts` 存在的全部意义就是消灭这种分叉。
- **换 IPC**：选这个。8 个 handler 已在 M2.5 变成传输中立，这里只是换适配器。

### M3.1 Electron Forge + Vite + React 骨架

主进程只做三件事：开窗口、跑 `src/core` + `src/storage`、注册 8 个 `ipcMain.handle`。

**Status:** DONE — 2026-08-30
**Changed:** forge.config.js, vite.base.config.ts, vite.main.config.ts, vite.preload.config.ts, vite.renderer.config.ts, index.html, src/electron/{main.ts, ipc.ts, deps.ts, preload.ts, env-file.ts}, src/renderer/main.tsx, tsconfig.renderer.json, tsconfig.tests.json, package.json
**Verified:** `npm run dev` → Forge 构建 main + preload，Electron 起窗口；`osascript` 查进程 → `Electron, 1, Inkling`（一个标题为 Inkling 的窗口）。`npm run typecheck` 三个 project 全过。

主进程确实只有三件事：`createWindow()`、`buildDeps()`、`register(ipcMain, deps)`。
`ipc.ts` 只 import electron 的**类型**，`ipcMain` 和 `deps` 都是参数传进来的——
所以它能用一个假的 `IpcMain` 完整跑一遍，和 core/ 那层「provider 是参数」同一条纪律。

**踩到并修掉的一个坑（值得记下来，因为它不报错）**：Forge 的 vite 插件在
`userConfig.build?.lib == null` 时会塞一个 `formats: ['cjs']`，而
`package.json` 有 `"type": "module"`——构建照样成功，**要到启动时才炸**在
`require is not defined in ES module scope`。只改 `rollupOptions.output.format`
没用（`lib.formats` 赢），必须整个给出 `build.lib`。preload 另有一条：
Electron 只在扩展名是 `.mjs` 时把它当 ES module 加载，叫 `.js` 会静默失效，
表现是界面上每个按钮都报「preload 没有装上」。两条都写进了对应的 config 注释。

**tsconfig 拆成三个**（node / renderer / tests），而不是给根配置加 `DOM`：
加了之后服务端代码误用 DOM 全局也照样通过，那正是这个仓库一贯不接受的
「错了但不报错」。三个 project 由 `npm run typecheck` 串起来跑。

### M3.2 依赖清单（照抄，别装 Enjoy 全套）

```
运行时（14 个）：
  react  react-dom
  tailwindcss  postcss  autoprefixer
  tailwindcss-animate          ← 只这一个 tailwind 插件
  class-variance-authority  clsx  tailwind-merge
  lucide-react                 ← 图标只用这一套
  sonner                       ← ui/sonner.tsx 要它
  next-themes                  ← sonner.tsx 取主题；也可删掉那两行自己读 data-theme
  wavesurfer.js
  pitchfinder                  ← M1 已装

Radix（7 个）：
  @radix-ui/react-dialog         ← Enjoy 的 package.json 漏了这个，别跟着漏
  @radix-ui/react-dropdown-menu
  @radix-ui/react-popover
  @radix-ui/react-tooltip
  @radix-ui/react-select
  @radix-ui/react-slider
  @radix-ui/react-slot           ← 只为 asChild，不用可以省

不装：
  @radix-ui/react-icons          （lucide 已覆盖，Enjoy 是两套并存的历史包袱）
  @radix-ui/react-alert-dialog   （用 react-dialog 自己包一层）
  @radix-ui/react-{accordion,avatar,checkbox,collapsible,label,menubar,
                   progress,radio-group,scroll-area,separator,switch,tabs,toast,toggle}
  react-hook-form  react-resizable-panels
  @tailwindcss/typography  tailwind-scrollbar  tailwind-scrollbar-hide
  chart.js                       （M1 已经手写了）
  sequelize  sqlite3             （已有 src/storage）
```

Enjoy 用 24 个 Radix 包。裁到 7 个的依据：真正需要库解决的只有焦点陷阱、Portal、
浮层定位、listbox 无障碍这四类。

**Status:** DONE — 2026-08-30
**Changed:** package.json, package-lock.json
**Verified:** `dependencies` 里 14 个运行时 + 7 个 Radix，与清单逐条相符；「不装」那一列一个都没进来（`@radix-ui/react-icons`、`react-hook-form`、`chart.js`、`sequelize` 等全部不在）。

**两处偏离清单，都是版本约束逼的**：
1. `tailwindcss` 装成 **v3**（首次解析给的是 v4）。v4 换了配置形态且不吃
   `tailwindcss-animate`，而 M3.5 要搬的那批 shadcn 组件是 v3 时代的写法。
   跟着 v4 走等于顺手重做一遍组件——M3 的铁律是不顺带做任何功能改动。
2. `@vitejs/plugin-react` 钉在 **^4**、`vite` 钉在 **^5**：最新的
   plugin-react 要 vite ^8，而 vitest 2.1.9 要 vite ^5。两边不可兼得，
   选了「测试跑得起来」这一边——1298 条用例比一个大版本号值钱。

**开发依赖比清单多四个**，因为 M3.10 要写组件测试：`@testing-library/react`
`@testing-library/jest-dom` `@testing-library/user-event` `jsdom`。
清单那一栏写的是「运行时」，这四个不进产物。

### M3.3 preload 暴露 8 个方法

**一个 namespace 就够，不要学 Enjoy 分 36 个。**
（Enjoy 的 `preload.ts` 是 808 行、186 个频道、36 个 namespace，
renderer 里 114 个文件直接调它。那是被账号体系和主进程 DB 倒逼出来的形状。）

每个方法直接对应 M2.5 的一个 handler。

**验收**：preload 不超过 60 行。

**Status:** DONE — 2026-08-30
**Changed:** src/electron/preload.ts
**Verified:** `wc -l src/electron/preload.ts` → **28 行**（上限 60）。一个 namespace（`window.inkling`），八个方法，每个直接对应 M2.5 的一个 handler。

**频道名在 preload 里是字面量，没有 import `CHANNELS`**：`contextIsolation`
下 preload 是独立打包的一小段代码，从 `@/http/server` 那条链拉一个常量进来
会把整个服务端依赖树拖进 preload bundle。八个字符串对不上的话，第一次点击
就会报 "No handler registered"——不是那种会静默错的东西。

### M3.4 UI 状态用 localStorage

**不要学 `cacheObjects`。** 它是 Enjoy 调用最多的 namespace（39 次），
存的是「当前在哪个 tab」——一个键值表，走了一趟跨进程 IPC 落进 sequelize，
只因为渲染层没有自己的存储抽象。

**验收**：IPC 通道里没有 UI 状态。

**Status:** DONE — 2026-08-30
**Changed:** src/renderer/lib/uiState.ts, src/renderer/App.tsx
**Verified:** 八个频道（`src/electron/ipc.ts` 的 `CHANNELS`）逐个对应一个业务 handler，没有一个是键值存取。界面状态（正在练的文本、音色、语速）走 `usePersistentState`，落 `localStorage`。

判据写进了 `uiState.ts` 的文件头：**这条状态丢了会怎样。**
丢了只是下次打开回到默认值 → localStorage；丢了是用户的数据没了 → 主进程落库。
参考实现的 `cacheObjects` 存的是「当前在哪个 tab」，走了一趟跨进程 IPC 落进
sequelize，只因为渲染层没有自己的存储抽象——这一步就是把那个抽象补上。

### M3.5 搬 ui/ 的 9 个无 Radix 文件（416 行）

```
table 117 · card 83 · radial-progress 65 · badage 36 · sonner 31
input 25 · textarea 24 · ping-point 20 · skeleton 15
```

**注意**：`use-toast.tsx`（189 行）不要搬，它不在 Enjoy 的 barrel 里，是被 sonner 取代的死代码。

**Status:** DONE — 2026-08-30
**Changed:** src/renderer/components/ui/{table,card,radial-progress,badage,sonner,input,textarea,ping-point,skeleton}.tsx, src/renderer/lib/utils.ts
**Verified:** 九个文件、`wc -l` 合计 **416 行**，与计划的数字逐个相符（table 117 · card 83 · radial-progress 65 · badage 36 · sonner 31 · input 25 · textarea 24 · ping-point 20 · skeleton 15）。`use-toast.tsx` 没搬。

**每个文件加了一段来源说明**：这批不是参考实现自己写的，是 shadcn/ui（MIT）
的 CLI 样板。这一点要写下来，因为 `decisions.md` 0001 立的规矩是
「Enjoy 只作为参考读，不复制代码」——复制 shadcn 的样板不在那条规矩的范围内，
但不写清楚的话，下一个读到这批文件的人无从判断。

### M3.6 手写 9 个原本用 Radix 的简单件（约 330 行）

```
tabs 55 · scroll-area 53 · avatar 50 · radio-group 44 · progress 33
switch 29 · separator 29 · label 26 · collapsible 11
```

**Status:** DONE — 2026-08-30
**Changed:** src/renderer/components/ui/{tabs,scroll-area,avatar,radio-group,progress,switch,separator,label,collapsible}.tsx
**Verified:** 九个都在，`npm run typecheck` 通过。**实际 452 行，不是估的 330**——多出来的是注释：每个文件都写了「那个 Radix 包到底替你做了什么、这里为什么不需要」。这不是凑字数：不写的话，下一个人看到「手写的 tabs」只会觉得是图省事，然后把它换回 Radix。

三个实现上的决定：
- **tabs** 自己实现了 roving tabindex 与方向键——换掉那个包不是「少了无障碍」，是同样的规范自己写一遍。未选中的面板**不渲染**而不是 `display:none`：藏起来的面板里如果有一个正在录音的组件，它会继续录。
- **radio-group** 用原生 `<input type=radio>` 加同一个 `name`。方向键、Tab 跳过整组、读屏播报都是浏览器给的；Radix 那个包给的是「用任意元素当选项」的自由，代价是这些全要自己重做。
- **progress** 的 `value` 允许 `null`，表示「不知道进度」，和 0（确定还没开始）分开——这条是这个仓库的老纪律（[C43] / [C44]）在一个新组件上的落法。

### M3.7 删掉 3 个用不上的（337 行）

```
form 177        ← Inkling 的输入就是一段文本加语速，不需要 react-hook-form
breadcrumb 115
resizable 45
```

**Status:** DONE — 2026-08-30
**Changed:**（无——这一步的产出就是「没有这三个文件」）
**Verified:** `ls src/renderer/components/ui/` → 18 个文件（9 搬 + 9 手写），`form.tsx` / `breadcrumb.tsx` / `resizable.tsx` 都不在。对应的 `react-hook-form` 与 `react-resizable-panels` 也没进 `dependencies`。

### M3.8 用 React 重画 M2 的界面

对照物是 M2.5-pre 存的截图。**肉眼比对一致才算过。**

**Status:** DONE — 2026-08-30
**Changed:** src/renderer/App.tsx, src/renderer/components/{ResultPanel,WordList,PitchChart}.tsx, src/renderer/styles.css, preview.html, src/renderer/preview.tsx, docs/m3-baseline/
**Verified:** 三张截图实拍并逐块对照，结论与差异写在 `docs/m3-baseline/README.md`。逐词八种组合的底色/下划线/角标、漏读的删除线、多读的斜体、音素弹出层、曲线形状与断口、图例与 `126–236 Hz`、三项分数的分档与高亮、元信息三行——**全部一致**。

**配色能对上不是运气**：`src/renderer/styles.css` 里那组变量是从 `public/app.css`
**逐个色值搬**过来的，不是重新配的。换一个色值不会报错，只是看起来「差不多」，
而 M3 的铁律恰恰是「一模一样」。

**比对用的是一个开发页**（`preview.html` + `src/renderer/preview.tsx`，
不进打包产物，Forge 的渲染层只有 `index.html` 一个入口）。理由：真实界面
要录音才出得来结果区，而一次真实录音不可复现，当不了对照物。
它用的 fixture 和 M2 存档那份**逐字相同**——换了数据再比，比的就是数据不是界面。

**一处差异，是数据不是界面**：M2 存档那句文案写死了「5 个词念得不准」，
React 版算出来是「6 个」。同一份 fixture 里底色不是 `ok` 的确实有 6 个。
也就是说 M2 那张图上的 5 是当时手写错的，M3 这个 6 是算出来的。

### M3.9 public/*.js 及 71 条测试退役

`tests/contract-consistency.test.ts` 的 import 从 `../public/recorder.js` 改指新录音模块，
**那 4 条必须存活**——它是唯一守着跨层常量一致性的东西，变异测试证明过
改客户端那份常量「红 0 条」。

**Status:** DONE — 2026-08-30
**Changed:** src/renderer/lib/{present.ts, contract.ts, recorder.ts}（从 `public/` 搬入并加类型）、tests/client/{present,contract}.test.ts、tests/contract-consistency.test.ts、docs/m2-baseline/frozen/、`public/` 整个删除、src/http/server.ts（删 HTTP 适配器）、src/http/main.ts（删除）
**Verified:** `npx vitest run` → **39 files / 1298 passed**；`npm run typecheck` 三个 project 全过。`public/` 不存在。

**跨层那条链没断**：`tests/contract-consistency.test.ts` 的 import 改指
`@renderer/lib/recorder`，`TARGET_SAMPLE_RATE` 仍然只从客户端那一侧来、
配置值仍然只从被测系统的输出来。禁令自检那条也跟着更新了白名单。

**「退役 71 条」没有照做，而且是刻意的。** 那一格的前提是「这些代码随
`public/*.js` 一起消失」——**它没有消失**：`present.js` 与 `contract.js` 是
决定层，原样搬进了渲染层，React 界面照着画的就是它们。退役一批仍然守着
活代码的用例，是拿覆盖率换一个更好看的迁移故事。所以 141 条客户端用例
只改了 import。

**真正随传输退役的是 2 条**，都在原处写了为什么：
- `contract.test.ts` 的「响应不是合法 JSON → ContractError」：IPC 走
  structured clone，没有解析这一步，那个失败模式**不可能发生**。
  接替它的是「传输本身抛错 → 明确报错」，那一条在新传输下是真的。
- `config-route.test.ts` 的「POST /api/config → 405」：它守的是 HTTP 路由
  分派，而 HTTP 适配器整个删了。IPC 没有「方法」这个维度。

`contract-consistency` 里的 `MAX_SECONDS` 那条**按它文件头预告的方式退休了**：
从「比对两份拷贝」改成「断言客户端里已经没有这个字面量」，另加一条守住
「上限确实从下发的 config 里来」。文件头第 6 步写的就是这句话。

**顺带删掉了 HTTP 适配器与 `src/http/main.ts`**（禁区 #3 / #4）：桌面应用
开一个无鉴权的本机端口，同机任何进程都能调 TTS 花掉 Azure 额度；两套入口
并存则意味着两份契约，而 `contract.ts` 存在的全部意义就是消灭这种分叉。
八个 handler 一行没动，文件路径也没改名——改名会让 129 条用例的 import
全部变动，而这一步的价值恰恰在于「换传输时它们不用动」。

**`docs/m2-baseline/` 冻结了一份副本**（`frozen/app.css`、`frozen/present.js`）。
判断在这一步反转：本体还在的时候，复制就是让存档开始撒谎；本体删了之后，
冻结才是让存档还打得开。README 里写了这个反转。

### M3.10 补组件测试

至少覆盖 M2 那 8 种维度组合。

**Status:** DONE — 2026-08-30
**Changed:** tests/components/{word-list.test.tsx, result-panel.test.tsx}, tests/setup-dom.ts, vitest.config.ts
**Verified:** `npx vitest run tests/components` → **47 passed**（word-list 28 + result-panel 19）。八种组合用 `test.each` 逐一断言，另加「八个词一起渲染时各自独立」。

**组件层和决定层的分工写在文件头**：`tests/client/present.test.ts` 测「算得对不对」，这一批测「算对了有没有画丢」。两边都要有，因为坏法不同——后者尤其容易发生在重画界面的时候，**而且不报错**。

**断言用 `data-base` / `data-flat` / `data-brk`，不断言 class 名**：class 是排版细节，会随 Tailwind 的写法变；那三个 data 属性是组件对外承诺的三个通道，它们变了才是行为变了。

**jsdom 的两处坑，都在原处写了注释**：
- RTL 的自动卸载挂在全局 `afterEach` 上，而 vitest 默认 `globals: false`——不显式接上的话，上一条用例的 DOM 会留在文档里，`getAllByTestId` 一路累加。表现是「单跑一条绿、连起来跑红」，看起来像组件坏了。
- canvas 的 2D 上下文 jsdom 没有。桩掉的**只是画笔**，`pitchPlot()` 照常跑，所以「有没有该画的东西」仍然是真判断；而且桩在用到它的那个文件里，不在全局 setup 里——一个在 setup 里被静默 mock 掉的浏览器 API，会让用例在「它其实不工作」的情况下变绿。

### M3 验收

```
npm run dev        → Electron 窗口起得来
npm test           → 1,024 条 core/服务端/路由测试全绿（M2.5 的成果）
                     ＋ 新增组件测试
                     − 71 条 public/*.js 测试（预期内，唯一一次）
npm run typecheck  → 通过
```

**Status:** DONE — 2026-08-30
**Verified:**

```
$ npm run dev
✔ Electron 窗口起得来（osascript 查到 process "Electron" 有 1 个窗口，标题 Inkling）

$ npx vitest run
Test Files  39 passed (39)
Tests       1298 passed (1298)

$ npm run typecheck
（三个 project 全过，无输出）
```

**测试数对不上计划的预测，方向是多不是少**：计划预测 M3 之后是
「1,024 + 组件测试 − 71」。实际是 **1298**：

| 项 | 计划预测 | 实际 | 差在哪 |
| --- | --- | --- | --- |
| core + 服务端 + 路由 | 1024 | 1110 | M1/M2/M2.5 期间新增（pitch 31、decode-wav 9、pitch-store 33、synthesize +8、assess-route +5） |
| 客户端（原 `public/*.js`） | 退役 71 | **存活 141** | 决定层没有消失，只是搬了家——见 M3.9 那条 |
| 组件测试 | 「新增」，没估数 | 47 | word-list 28 + result-panel 19 |
| 随传输退役 | 71 | **2** | 「不是合法 JSON」与「405」，两条都在原处写了为什么 |

**基线那 1,095 条一条没掉。**（decisions 0044 记的那个锚点。）

---

## M4 — 词典与单词

### 词典三层的处置

Enjoy 的词典分三层，**只有中间一层能搬**：

| 层 | 文件 | 处置 | 原因 |
| --- | --- | --- | --- |
| 预置词典 | `src/main/dict.ts` 131 行 | **不能碰** | 8 本全从 `dl.enjoy.bot` 下载：Collins COBUILD、Longman LDOCE5、Oxford ODE，均在版权期内，合计约 2.3 GB。Enjoy 用 MD5 白名单校验，说明它就是在分发这些文件 |
| mdict | `src/main/mdict.ts` 144 行 | **搬** | 用户自带 `.mdx`/`.mdd`，按 MD5 存到 `libraryPath/dictionaries/<hash>/`，`@divisey/js-mdict` 解析，LRU 20。**没有任何内容被分发**，法律上干净 |
| camdict | `src/main/camdict.ts` 76 行 | **不能碰** | 仓库里躺着 67 MB 的 `cam_dict.refined.sqlite`（剑桥词典），来源不明。代码本身只有一条 `findOne`，抄不抄无所谓，问题是那个文件 |

### M4.1 搬 mdict 加载器

`src/main/mdict.ts`（144 行）。

**验收**：导入一个 `.mdx`，查一个词。

**Status:** DONE — 2026-08-30
**Changed:** src/core/dict/mdict.ts, src/storage/dict-store.ts, scripts/make-test-mdx.ts, tests/fixtures/test-dict.mdx, tests/mdict.test.ts, package.json（`@divisey/js-mdict`）
**Verified:** `npx vitest run tests/mdict.test.ts` → **41 passed**，其中 F 组五条用**真的 `.mdx` 文件**跑通整条链：装进词典目录 → 用 `@divisey/js-mdict` 打开 → 查 `ask` 拿到释义、查 `zzzznotaword` 得 null、`quick` 经 `@@@LINK=` 转到 `fast`。

**先造了一本词典，否则这条验收没法真跑。** 那个库的测试词典要从百度网盘下载，
仓库里没有；而现成的 `.mdx` 全在版权期内——往仓库里塞一本正是 M4.4 明说不做的事。
所以写了 `scripts/make-test-mdx.ts`：按 MDX v2 的字节布局生成一本 4 个词、
1038 字节的合成词典，**可复现、无版权**。没有它，这一层就只能用假 reader
走过场，验得了我们的代码，验不了「那个库真的能读文件」。

**参考实现那 144 行里的四个缺陷都没重犯**，逐条写在
`src/core/dict/mdict.ts` 的文件头，也各有一条用例：
1. `currentDictHash` **从来没被赋值过** → 每查一个词都把整本词典重新解析一遍。
   不报错，只是慢得莫名其妙。（用例：「查十次只解析一次」）
2. `@@@LINK=` 递归**没有深度上限** → 两个词互相指向就把主进程转死。
3. `getResource` 遍历 mdd 时第一个没命中就 `return ""`，后面的轮不到。
4. **复制了文件却返回源路径** → 用户拔了 U 盘就查不了词，而清单里那条
   词典看起来完全正常。（用例：「源文件删掉之后仍然读得到」）

**reader 是参数传进来的**（和 `TtsProvider` 同构），所以导入校验、转跳、
清洗这些真正会错的逻辑不碰文件系统就测得完。

### M4.2 搬词典设置页

`context/dict-provider.tsx`（222 行）+ `preferences/dict-settings/`（354 行，
其中 `dict-import-button.tsx` 130 行是文件选择加导入流程）。

**验收**：设置页能列出已装词典。

**Status:** DONE — 2026-08-30
**Changed:** src/electron/dict-ipc.ts, src/electron/{preload.ts, main.ts}, src/renderer/lib/ipc.ts, src/renderer/components/DictSettings.tsx, src/renderer/App.tsx, tests/dict-ipc.test.ts, tests/components/dict.test.tsx
**Verified:** `npx vitest run tests/components/dict.test.tsx tests/dict-ipc.test.ts` → **38 passed**。设置页列出已装词典（标题、资源文件数、哈希前 8 位），能导入、能卸载。

**没搬那 576 行**（`context/dict-provider.tsx` 222 + `preferences/dict-settings/` 354）。
那批代码的形状是被它自己的 provider 体系和 8 本预置词典的下载/校验流程撑起来的——
预置词典这一层我们不碰（版权），provider 体系我们没有。剩下的就是一张表加两个按钮，
自己写 145 行。

**三条产品判断写进了组件的文件头，各有用例**：
- **取消导入不是失败。** 点开系统对话框又关掉是最常见的操作；为它弹红字，
  用户会以为自己弄坏了什么。所以 `ImportOutcome` 里 `cancelled` 是独立的一支。
- **空状态说的是产品事实**（「Inkling 不附带词典」），不是「点上面那个按钮」。
- **卸载要确认。** 词典是用户自己找来的几百兆文件，误删的代价是重新找一遍。

**词典频道另起一组前缀**（`inkling:dict:` / `inkling:word:`），不混进 M2.5 那八个：
那八个是契约的一部分，词典是可选功能。混在一起，「八个频道」这条一眼可查的性质
就没了——参考实现的 preload 长到 186 个频道，就是从「再加一个」开始的。
preload 仍是 **49 行**（上限 60）。

### M4.3 单词表自己写，用本地存储

Enjoy 的 `pages/vocabulary.tsx`（109 行）走 `webApi.mineMeanings()`，
`components/meanings/`（2 个文件）也一样——**数据源是 enjoy.bot 服务器，没有本地 Meaning 模型**。
搬过来是空壳。

**验收**：离线可用。

**Status:** DONE — 2026-08-30
**Changed:** src/storage/word-store.ts, src/renderer/components/WordBook.tsx, tests/word-store.test.ts, tests/components/dict.test.tsx
**Verified:** `npx vitest run tests/word-store.test.ts` → **25 passed**，E 组两条专盯离线：整条链只碰文件系统，落地的是一份人能直接打开看的 JSON；换一个 store 实例读同一个文件内容还在。组件层另有 12 条。

**自己写，没搬。** 参考实现的 `pages/vocabulary.tsx` 走 `webApi.mineMeanings()`，
`components/meanings/` 也一样——数据源是它自己的服务器，本地根本没有 Meaning 模型。
搬过来是个空壳：界面在，点开永远是空的。

**三条设计判断，各有用例，都是「不报错」的那类**：
- **同一个词加两次是更新时间，不是加第二条。** 在两篇材料里碰到同一个生词是常事。
- **再次加词不覆盖笔记。** 用户写的笔记悄悄没了，而且不会重新产生。
- **坏文件挪走，不覆盖。** 词典清单坏了重新导入就有；**生词本坏了是用户几年的东西没了**。

**释义不存进生词本**：存的只有词、时间、和用户自己写的一句话。词典会换
（今天柯林斯明天朗文），把释义腌进去，换一本之后用户看到的就是上一本的残影。

**用 JSON 不用 SQLite**：生词本是用户手工攒的小表，没有关联查询、没有并发、
没有事务边界；而 JSON 有一个 SQLite 没有的好处——用户能自己打开看、改、拷走。

**一处计划没写但必须做的事**：释义是**词典作者写的 HTML**，不是我们的内容。
渲染在 `sandbox=""` 的 iframe 里，不给脚本、不给同源、不给表单提交。
直接 `innerHTML` 塞进主文档的话，一本被做过手脚的词典就能读到整个渲染层——
而 preload 就挂在那上面。两条用例守着这一点（`tests/components/dict.test.tsx` E 组）。

### M4.4 文档写明不附带词典

README 加一句：Inkling 不附带词典，请导入你合法获得的 `.mdx`。

免费可分发的兜底有 WordNet（npm `wordnet`）和 ECDICT（CC-BY-SA），但那是另一个决定，不在本计划内。

**Status:** DONE — 2026-08-30
**Changed:** README.md
**Verified:** `grep -n '不附带词典' README.md` → 命中。新增「## 词典」一节，另外三处也跟着改了，因为它们已经和现状不符：

- **「这不是什么」**补了一句「能查词，但不附带任何词典」——只写在新章节里的话，
  读到第 30 行的人会以为这个应用完全不碰词典。
- **「跑起来」**改成 Electron（`npm run dev` 起窗口，不再是 `localhost:5173`），
  并说明了为什么不留 HTTP。
- **「目录」**按 M3/M4 之后的真实结构重写（`public/` 已经不存在了）。
- **「参考实现」**补了词典三层的处置表，说清楚哪一层搬了、哪两层为什么不碰。

WordNet / ECDICT 那个兜底按计划**没有做**——它是另一个决定，README 里如实写着
「还没做」，不是「不做」。

---

## 禁区（全程不要做）

1. **不要照抄 Enjoy 的音高参数。** 16 kHz 下 91% 的窗口返回数字但全部错误，不报错，看起来正常。
2. **不要把 M2.5 并进 M3。** 那会让 204 条测试同时失效。
3. **不要为「保留 HTTP 层」在 Electron 里 `listen(5173)`。** 9 条路由无一条检查来源。
4. **不要 HTTP 与 IPC 并存。** `contract.ts` 存在的全部意义就是消灭这类分叉。
5. **不要直接复用 `pronunciation-assessments/`**（1,278 行）。查表结构与三维模型冲突，
   且三个错误分支在 Enjoy 里从未触发过。
6. **不要搬 `medias/` 的三栏布局**（4,958 行，Enjoy 最大的目录）。
   左栏是字幕列表——那是影视剧字幕跟读倒逼出来的形状，Inkling 的材料是粘贴的文本，
   服务端 split 成句，没有时间轴对齐问题。
7. **不要搬 `app-settings-provider.tsx`**（432 行）。里面塞着 `webApi`、`user`、`login()`、
   ActionCable、`nativeLanguage`/`learningLanguage`——社区 + 多语言 + 账号倒逼的形状，
   对 Inkling 只剩两个字段有用。
8. **不要搬 `db-provider.tsx` + `db-state.tsx`**（158 行）。那是「渲染层等主进程数据库连上」
   的状态机，因为 sequelize 在主进程。Inkling 的 `src/storage` 是同步的，不需要。
9. **不要动 `src/core` 和 `src/storage`。**

---

## 未决与不确定

| 事项 | 状态 | 影响 |
| --- | --- | --- |
| Enjoy 上游真实许可 | 本地只有 package.json 的 MIT 字段，无 LICENSE 正文 | M0.1 先查 |
| Monotone / UnexpectedBreak / MissingBreak 是死代码 | 从「`enableProsodyAssessment` 零命中」推断，**未跑 Azure 实测** | 不影响执行，影响 M2 的参考价值判断 |
| `postAssess` 那 229 行的构成 | 未逐行读完 | **直接决定 M2.5 的真实代价**，M0.4 先拆 |
| `tsx` 对 `pitchfinder`（CJS）的 interop | 在独立 Node 22 ESM 环境验过可用，未在 Inkling 管线验 | M1.1 先验，10 分钟 |
| M1–M4 各阶段新增测试条数 | 估不出来 | 不填数 |

---

## 数字来源

本计划的全部数字实测于：

- `~/github/LuoDaXiang/MyProjects/Inkling`（v0.2.0）
- `~/github/enjoy-v0.7.9/enjoy`（v0.7.9）

音高实验在 `/tmp/pf-probe/`，pitchfinder 2.3.4，Node 22。

配套的可视化版本（含依赖关系图与测试基线走向图）：
<https://claude.ai/code/artifact/57d6d84f-b18f-49c6-9400-57a99258bfe5>

**关键数字对照**（用于抽查）：

```
Enjoy renderer 总行数           42953    find src/renderer -name '*.ts' -o -name '*.tsx' | xargs wc -l | tail -1
Enjoy .tsx 文件数                 284    find src/renderer -name '*.tsx' | wc -l
调 EnjoyApp.* 的文件数             114    grep -rl 'EnjoyApp\.' src/renderer --include='*.ts*' | wc -l
preload 暴露的 IPC 频道数          186    grep -rho 'ipcRenderer\.invoke(\s*"[^"]*"' src/preload.ts | sed 's/.*"\(.*\)"/\1/' | sort -u | wc -l
ipcMain.handle 频道数              177    grep -rho 'ipcMain\.handle(\s*"[^"]*"' src/main src/*.ts | sed 's/.*"\(.*\)"/\1/' | sort -u | wc -l
components/ui 文件数 / 行数     44 / 3267  find src/renderer/components/ui -name '*.ts*' ! -name 'index.ts' | wc -l
按 Inkling 功能面筛后的紧集      7779 行   = 5735（组件侧）+ 2044（ui 被引用到的部分）
紧集占比                         18.1%
真正能搬的                    764 行 / 1.8%  = 416（ui 无 Radix）+ 271（misc 四小件）+ 77（音高，且须重写）
Inkling src 总行数               5063    find src -name '*.ts' | xargs wc -l | tail -1
Inkling 前端总行数               1035    wc -l public/*
server.ts 行数 / 路由数        988 / 9    第 9 条是 getStatic，M3 时消失
postAssess 行数                   229    awk 'NR>=477 && NR<=705' src/http/server.ts | wc -l
sendJson 调用点                    49    grep -c 'sendJson(' src/http/server.ts
```

---

## 附录 A — postAssess 分行清单

**Status:** DONE — 2026-08-29
**Changed:** docs/migration-plan.md（本附录）
**Verified:** `awk 'NR>=477 && NR<=705' src/http/server.ts | grep -n 'sendJson\|req\.\|res\.'` → 18 个传输接触点，逐一归类如下

`postAssess` 第 477–705 行，229 行。按「业务编排」与「响应收尾 / 传输接触」分开数：
**传输接触点 18 个**（17 次 `sendJson` + 1 次 `requireDb(res, …)`，另加 2 处入站读取
`req.url` 与 `readBinaryBody(req, …)`），其余全是业务编排。

| 行 | 内容 | 归类 | M2.5 之后 |
| --- | --- | --- | --- |
| 477–481 | 函数签名 `(req, res, deps)` | **传输** | 改成 `(input: AssessInput, deps)` |
| 482–487 | `deps.scoring` 缺席 → 503 | 业务判定 + **响应收尾** | `return { status: 503, body: {...} }` |
| 489–490 | `new URL(req.url)` 取 query | **传输（入站解析）** | 参数由 `input` 直接给，整段消失 |
| 494–495 | 读 `sentenceId` / `reference` | 业务 | 从 `input` 读 |
| 497–503 | [C24] 两个都给 → 400 | 业务判定 + **响应收尾** | 判定不动，尾巴换成 return |
| 504–506 | 两个都不给 → 400 | 业务判定 + **响应收尾** | 同上 |
| 508–515 | `clientRequestId` UUID v4 校验 → 400 | 业务判定 + **响应收尾** | 同上 |
| 517–523 | `readCaptureFlags(q)` → 400 | 业务判定 + **响应收尾** | 签名改吃普通对象，不吃 `URLSearchParams` |
| 527–548 | 参考文本解析（正整数校验 400 / `requireDb` 503 / 句子不存在 404 / [C25] 服务端取 `sentence.text`） | 业务编排 + **3 处响应收尾** | `requireDb(res, deps)` 必须改成不吃 `res` 的 `resolveDb(deps)` |
| 552–559 | `readBinaryBody(req, MAX_PCM_BYTES)` → 413 | **传输（入站读取）** | 字节由 `input.samples` 直接给；限长检查上移到适配器 |
| 561–566 | [C65] 长度非 4 的倍数 → 400 | 业务判定 + **响应收尾** | 判定保留（IPC 也可能传来截断的 buffer） |
| 567 | `new Float32Array(...)` 视图 | 业务 | 不动 |
| 568–581 | `beginTrace` + `emit(request)` | 业务 | 不动 |
| 583–590 | `floatToInt16` → `trimSilence` → 时长换算 | 业务（纯函数） | 不动 |
| 592–614 | 全静音短路：emit + [C33] 不计费不落库 + 200 | 业务判定 + **响应收尾** | 尾巴换 return |
| 616–620 | `encodeWav` + `assess()` | 业务 | 不动 |
| 622 | 计费 `scoringCostMicros` | 业务 | 不动 |
| 624–638 | `persistPracticeBundle`（[C67] 落盘落库顺序） | 业务 | 不动 |
| 640–645 | `emit(result)` | 业务 | 不动 |
| 646–653 | `no_speech` → 200 | **响应收尾** | 换 return |
| 655–668 | 正常结果 → 200（[C43] 缺席不发 null） | **响应收尾** | 换 return |
| 670–704 | catch 四分支：`InvalidWavError`/`InvalidReferenceError` → 400、`MalformedResponseError` → 502、`ServiceError` → `STATUS[kind]`、其余 rethrow；每支各一次 `emit(error)` + `console.error` | 业务分类 + **4 处响应收尾** | 分类与 emit 不动，尾巴换 return；rethrow 那支交给适配器兜底 |

### 结论：M2.5 对 postAssess 的真实工作量

- **业务编排约 150 行，一行不用改。** 三步纯函数管线、trace、落库、错误分类全部原样。
- **要动的是 18 个传输接触点**，全是机械替换：`sendJson(res, S, B)` → `return { status: S, body: B }`。
- **两个真正的设计决定**（不是机械替换）：
  1. `requireDb(res, deps)` 现在**自己发响应**（server.ts:412–417）。它被 5 个 handler 共用，
     必须改成 `deps.db ?? null` 加各自 return，否则 8 个 handler 里的 `res` 拔不干净。
  2. `readCaptureFlags(q)` 吃 `URLSearchParams`。改成吃 `Record<string, string | undefined>`，
     它的 [C66] 严格 `"true"`/`"false"` 语义不变——IPC 那边也会传字符串。
- **未知量已消除**：这 229 行里没有藏着传输语义的业务逻辑（没有流式响应、没有分块、
  没有 header 协商），所以 M2.5 不需要为 `postAssess` 设计任何新抽象。

