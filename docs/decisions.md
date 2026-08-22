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
