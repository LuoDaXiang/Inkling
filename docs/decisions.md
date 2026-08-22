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
