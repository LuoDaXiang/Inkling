# 决策记录

记录做过的选择和当时的理由。以后回头看，能知道某个设计是想清楚的还是随手写的。

---

## 0001 — 重写，不 fork Enjoy

**日期**：2026-08-22
**状态**：已采纳

Enjoy v0.7.9 是这个项目的参考实现（GPL-3.0，`ZuodaoTech/everyone-can-use-english`）。
它有 445 个 TS/TSX 文件、57,836 行代码，其中绝大部分是本项目不需要的：
YouTube/TED/Audible 内容抓取、词典系统、聊天助手、课程、社区。

剥离比重写慢，所以重写。Enjoy 只作为参考读，不复制代码。

**注意**：Enjoy 是 GPL-3.0。本项目同样采用 GPL-3.0，即便如此，仍然不复制它的代码——
参考实现的价值在于理解它的取舍，不在于省下打字的时间。

---

## 0002 — 业务逻辑不写进数据模型

**日期**：2026-08-22
**状态**：已采纳

Enjoy 把业务逻辑写成 Sequelize 模型的静态方法（`Speech.generate()`）。
这些方法直接读 electron-settings、直接调 OpenAI、直接写文件系统、直接建数据库记录。

后果是可测性归零：想测一个函数，必须启动整个 Electron 应用、登录一个用户、
连上数据库、备好真实 API key、发一次真实网络请求。

这就是为什么 Enjoy 的 57,836 行代码只有 6 个测试用例，而且全是 e2e 冒烟测试——
TTS 和评分这两个核心功能一个测试都没有。

**本项目**：模型只管存取。生成逻辑是接受 provider 作为参数的普通函数。

---

## 0003 — 账号系统不许渗进业务逻辑

**日期**：2026-08-22
**状态**：已采纳

Enjoy 的 TTS 生成逻辑里有这样一段（`enjoy/src/main/db/models/speech.ts:196`）：

```ts
if (engine === "enjoyai") {
  openaiConfig = {
    apiKey: (await UserSetting.accessToken()) as string,
    baseURL: `${settings.apiUrl()}/api/ai`,
  };
} else if (engine === "openai") { ... }
```

「谁付钱」这件事被写进了「怎么合成语音」里。结果是 Enjoy 不登录就不能用。

**本项目**：`Account` 接口只回答两个问题——我是谁（identity）、这次操作准不准且谁付钱（entitlement）。

- `LocalAccount`：我是唯一用户，用自己的 key，永远准。
- `CloudAccount`：服务端说我是谁，服务端扣额度。

Stage 0 到 Stage 3，业务代码一行不改，只换 `Account` 实现。

---

## 0004 — 音频文件按内容哈希寻址

**日期**：2026-08-22
**状态**：已采纳

这一条抄 Enjoy，它做对了：音频文件存在文件系统上，文件名是内容的哈希，
数据库只存哈希和扩展名，不存 blob。

TTS 要花钱或花算力，所以必须有缓存：先按 `hash(text + engine + model + voice)` 查，
命中就直接返回，不重复生成。

**与 Enjoy 的差别**：Enjoy 的查询键是 `(sourceId, sourceType, section, segment)`，
绑死了业务实体——同一句话出现在两个地方会生成两次。本项目用内容本身做键。

---

## 0005 — Stage 0 只写单元测试，不写 e2e

**日期**：2026-08-22
**状态**：已采纳

e2e 测试需要打包整个应用，跑一次几十分钟，且容易无故失败。
对第一个项目是负担而不是帮助。

Stage 0 用 Vitest 写单元测试，覆盖纯逻辑和 provider 接口（用假实现）。
e2e 冒烟测试推迟到 Stage 1 打包发布时再加。

---

## 0006 — 测试完整性的三条判据

**日期**：2026-08-22
**状态**：已采纳

「测试写够了没有」需要一个可检查的标准，否则永远是凭感觉。本项目用三条：

1. **输入空间被划分完** —— 每一类形态都有至少一个例子，且能说出为什么这些类是穷尽的。
   每个测试文件顶部用注释列出它的分类清单。
2. **每个分支都可达** —— 源码里每个 `if` 都有测试能走到。用覆盖率报告核对，
   不达标的地方要么补测试，要么说明为什么这条分支不该存在。
3. **每种失败都有归属** —— 不是「失败了」，而是「哪一种失败」，每种都有测试，
   且每种的 `retryable` 都被断言过。

三条里最难的是第一条，因为它要求先想清楚问题域。第二条是机械的，
覆盖率工具会告诉你。第三条最容易被跳过，也最容易在线上出事。

**取舍**：不追求 100% 覆盖率。`types.ts` 这类纯类型声明排除在外；
剩下的未覆盖分支必须是有意留下的，不能是忘了写。

---

## 0007 — 音频只验证结构，不比对内容

**日期**：2026-08-22
**状态**：已采纳

TTS 的输出没有「正确答案」：同一段文字合成两次，字节可能不一样，
换个模型版本音色就变了。所以 `expect(audio).toEqual(expected)` 这种断言写不出来。

做法学微软 Speech SDK（`tests/SpeechSynthesisTests.ts` 的 `CheckRiffPcmComplete`）：
手工解析 WAV 头，逐字段验证 RIFF / WAVE / fmt / PCM 格式码 / data 块，
并检查「头部声明的长度」与「实际字节数」是否一致。

最后那一条是重点，它抓的是**音频被截断**——文件能播放、不报错、只是短了一截。
在跟读场景里表现为评分莫名其妙地低，极难定位。

对于时长这类会波动的数值，断言「相差不超过 10%」而不是相等。

实现见 `src/core/audio/wav.ts`。

---

## 0008 — 超长文本必须拒绝，不能静默截断

**日期**：2026-08-22
**状态**：已采纳

Kokoro 的分词器上限是 509 token，超出后的处理是 `truncation: true`。
作者自己在源码里留了 TODO（`kokoro.js/src/kokoro.js:143`）：

```js
// TODO: There may be some cases where - even with splitting - the text is too long.
// For now, we just truncate these exceptionally long chunks
```

后果是音频短一截且不报错。而 Kokoro 的分句测试里最长输入只有 157 字符，
中位数 34 字符——**这套测试从来没接近过那个边界**。

本项目的做法：`TtsProvider` 接口带 `maxChars` 字段，`synthesize()` 在调用
provider 之前就检查长度，超出直接抛 `too_long`。宁可报错，不要静默产出坏数据。

---

## 0009 — 测试分两层，日常那层不联网

**日期**：2026-08-22
**状态**：已采纳

`npm test` —— 纯逻辑，不联网、不写磁盘、不装模型，一秒内跑完，任何人克隆下来就能跑。
`npm run test:live` —— 真实调用，要密钥，慢，可能失败，手动触发。

配置来自 `.env.local`（不入库，见 `.env.example`）。未配置时 live 测试
**自动跳过而不是失败**——否则新克隆仓库的人第一次跑测试就是红的。

这个分层学自 OpenAI 的 node SDK（`scripts/test` 起本地 mock server）
和微软 Speech SDK（`run-connection-tests.sh` 与 `run-non-connection-tests.sh` 分开）。

---

## 0010 — Azure TTS 走 REST，不用官方 SDK

**日期**：2026-08-22
**状态**：已采纳

Azure 有官方 SDK（`microsoft-cognitiveservices-speech-sdk`），Enjoy 用的就是它。
本项目改用 REST 接口，理由：

1. **零依赖**。Node 自带 fetch，不引入一个几 MB 的包。
2. **错误直接对上已有的分类器**。REST 返回标准 HTTP 状态码，
   `classify()` 已经认得；SDK 会把错误包成 `CancellationDetails`，还要再翻译一层。
3. **fetch 可以注入**。整个 provider 不联网就能测——37 个用例覆盖了
   401/403/415/429/502/503、网络异常、空响应体，这些用真 SDK 根本制造不出来。

**代价**：REST 拿不到词/句边界的时间戳事件，那需要 SDK 的 WebSocket 通道。
我们按句合成、按句缓存，暂时不需要句边界。将来做逐词高亮时再评估是否引入 SDK，
届时只需新增一个实现 `TtsProvider` 的文件，不影响任何已有代码。

接口文档：https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech

---

## 0011 — SSML 转义由我们自己负责

**日期**：2026-08-22
**状态**：已采纳

Azure 的 TTS 收的是 SSML（一种 XML），而我们的文本来自用户粘贴或 AI 生成，
两条路径都不可信。文本里的 `<` `>` `&` 轻则让请求变成非法 XML 被 400 拒掉，
重则被当成标记执行：

```
text = '</voice><voice name="zh-CN-XiaoxiaoNeural">被劫持的内容'
```

微软自己的 SDK 测试里，搜 `&amp;` / `escape` / `injection` 全部零命中——
它的 SSML 用例用的是写死的合法 XML。这一层没有现成保障，必须自己守。

`src/providers/tts/ssml.ts` 是纯函数：转义五个 XML 特殊字符、移除 XML 1.0
不允许的控制字符、把音色名解析成语言标记。48 个测试用例，含注入攻击场景。

**顺带**：`maxChars` 默认 3000 是我们自己设的闸门，不是 Azure 的文档限制。
官方只写了「音频超过 10 分钟会被截断」，没给字符数上限。

---

## 0012 — Stage 0 做本地 Web 应用，Stage 1 才上 Electron

**日期**：2026-08-23
**状态**：已采纳

需求是「macOS 和 Windows 都能用」，最终形态是 Electron 桌面应用。
但 Stage 0 不直接上 Electron，先做本地 Web 应用：浏览器做前端，一个 `node:http` 服务跑在本机。

理由：

1. **Electron 的 renderer 本来就是浏览器。** 界面用标准 Web API 写，
   Stage 1 包进 Electron 时不需要重写，也不需要改 core。
2. **少一整层 IPC。** Electron 的 main/renderer 之间要手写 IPC 通道、preload 桥接、
   再手写一遍类型声明——同一个字段改三处。Enjoy 的 `preload.ts` 有 808 行，
   全是这种胶水。Stage 0 不需要为它付代价。
3. **client/server 边界更真实。** HTTP 是个真边界，逼着我们把「哪些逻辑在服务端」
   想清楚。Stage 2 那台服务器要跑的就是同一份代码。

**关于麦克风权限**：`getUserMedia` 要求安全上下文，而 `http://localhost`
被浏览器算作安全上下文，不需要 HTTPS。

**代价**：Stage 0 期间要手动打开浏览器，没有应用图标，关不掉后台进程时要自己 kill。
这些都是 Stage 1 顺手解决的问题，不值得提前处理。

---

## 0013 — HTTP 层用 node:http，不引框架

**日期**：2026-08-23
**状态**：已采纳

Stage 0 的服务端只有三个路由：合成、取音频、静态文件。为它引入 Fastify 或 Express
会打破本项目的运行时零依赖（`dependencies: {}`）。

沿用 0010 的同一套理由：Node 自带的东西够用时就不引包。三个路由用 `node:http`
大约 100 行，而且这些代码本身有教学价值——请求解析、状态码、流式响应、
Content-Type，这些是框架替你做掉、但迟早要懂的东西。

**什么时候该改**：路由数量超过六个，或者开始需要中间件、参数校验、
路由参数解析这些东西的时候。那时引框架是划算的，现在不是。

**已经付出的代价**：手写路由没有参数校验，请求体大小限制要自己设，
错误处理要自己兜。这三件事在 `src/http/server.ts` 里都显式做了，没有假装不存在。

---

## 0014 — live 测试的密钥由 vitest 配置显式注入

**日期**：2026-08-23
**状态**：已采纳

`.env.example` 让人把密钥填进 `.env.local`，live 测试读 `process.env.AZURE_SPEECH_KEY`——
但中间**没有任何东西负责把文件加载进环境变量**。结果是：填好密钥、跑 `npm run test:live`、
仍然是 9 skipped，而且不报错，因为「没配置就跳过」的逻辑无法区分
「用户没配」和「配了但没加载」。

这是一类很坏的 bug：它伪装成正常行为。

**做法**：`vitest.live.config.ts` 自己读 `.env.local` 并通过 `test.env` 显式注入。
零依赖（不用 dotenv），且加载动作发生在配置里，看得见。

**顺带**：live 测试现在会在整组跳过时打印一行原因，而不是静默跳过。
「跳过」和「没配置所以跳过」是两个不同的信息。

---

## 0015 — 发音评估走 REST，并开启 prosody

**日期**：2026-08-23
**状态**：已采纳（已用真实调用验证）

延续 0010 对 TTS 的同一判断：REST，不引 SDK。运行时依赖保持为空。

**端点与请求形状**（已核实，第一次真实调用即通过）：

```
POST https://{region}.stt.speech.microsoft.com
     /speech/recognition/conversation/cognitiveservices/v1?language=en-US

Ocp-Apim-Subscription-Key: {key}
Content-Type: audio/wav; codecs=audio/pcm; samplerate=16000
Pronunciation-Assessment: {下面这段 JSON 的 base64}
Accept: application/json

{ "ReferenceText": "...", "GradingSystem": "HundredMark",
  "Granularity": "Phoneme", "Dimension": "Comprehensive",
  "EnableProsodyAssessment": "True" }
```

**响应结构与 SDK 不同，这一点会坑人**：REST 原始报文比 SDK 扁一层——
五项分数直接挂在 `NBest[0]` 上（`AccuracyScore` / `FluencyScore` /
`ProsodyScore` / `CompletenessScore` / `PronScore`），**不在
`PronunciationAssessment` 子对象里**。照着 SDK 的字段路径取会全部拿到
`undefined`，而且不报错。第一版测试就是这么写错的。

逐词同理：`Words[i].AccuracyScore` 和 `Words[i].ErrorType` 直接挂在词上。

**实测数据**（TTS 合成的 en-US-AvaNeural，13 词）：

| 场景 | 准确度 | 流利度 | 完整度 | 语调 | 总分 |
| --- | --- | --- | --- | --- | --- |
| 参考文本对上 | 96 | 100 | 100 | 91 | 95.6 |
| 参考文本对不上 | 13 | 0 | 0 | 59.6 | 14.5 |

区分度足够。另外机器给自己合成的语音打 95.6 而不是 100，语调只给 91——
说明它没有盲目偏爱合成语音，这对「用它给人打分」是个好信号。

---

## 0016 — 逐词语调反馈比总分更有价值

**日期**：2026-08-23
**状态**：已采纳

开启 prosody 之后，响应里每个词还带一个 `Feedback.Prosody`：

```json
{ "Break": { "ErrorTypes": ["None"], "BreakLength": 0,
             "UnexpectedBreak": { "Confidence": ... },
             "MissingBreak": { "Confidence": ... } },
  "Intonation": { "ErrorTypes": [],
                  "Monotone": { "Confidence": 0,
                                "WordPitchSlopeConfidence": 0,
                                "SyllablePitchDeltaConfidence": 0.54 } } }
```

`Monotone` 是单调检测。一个 ProsodyScore 只能告诉用户「语调不太好」，
而 `Monotone.Confidence` 能逐词指出**哪几个词读平了**，`Break` 能指出
**哪里该停没停、哪里不该停却停了**。

跟读训练需要的是后者：知道错在哪，而不是知道自己得了几分。

**因此**：`ScoringProvider` 的返回类型必须保留逐词明细，不能只回五个数字。
M04 建这一层时，数据模型要为 `Words[]` 留位置。

**顺带**：响应还有一个顶层 `SNR`（信噪比，实测 38.7）。将来可以用它
提示「你的麦克风太吵，先换个环境再练」——这是个不用额外成本就能给的提示。

---

## 0017 — 不抄 Enjoy 的超长音频合并算法

**日期**：2026-08-23
**状态**：已采纳

Enjoy 在 `use-pronunciation-assessments.tsx` 里以 30 秒为界：短音频用
`recognizeOnceAsync`，长音频用连续识别切段后合并。这证实了 30 秒是硬上限。

但它的合并是**等权平均**：1 秒的片段和 20 秒的片段权重相同。
`CompletenessScore` 取平均更是没有意义——完整度衡量的是「参考文本被念了多少」，
把两段的完整度相加除以二不对应任何东西。

**本项目的做法**：不在评分层合并。在**分句阶段**就保证每一句都是可评分单元
（见 roadmap 的 F3），一句一评、一句一分。跟读训练本来就是按句练的，
没有理由把一段三十秒以上的音频当成一个整体去评。

这样既避开了合并的数学问题，也让反馈粒度和练习粒度对齐。
