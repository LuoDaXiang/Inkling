# Inkling

一个给英语学习者用的跟读练习工具。

> 状态：v0.0.0 —— TTS 引擎可用，界面刚刚开始。

## 这是什么

我每天朗读英语。现有的工具要么太复杂，要么把我不需要的功能塞满界面。
Inkling 只做一条链路，把它做好：

```
拿到文本  →  合成语音  →  跟读录音  →  发音评分
```

文本可以自己导入，也可以让 AI 生成地道的美式英语。
评分给三个维度：发音准确度、流利度、语调节奏。

## 这不是什么

- 不是词典、不是背单词软件、不是聊天机器人。
- 不做视频/影视剧字幕跟读。
- 不做多语言。只做美式英语。

## 跑起来

需要 Node 22 以上。

```bash
npm install
npm test              # 321 个离线用例，一秒跑完，不联网

cp .env.example .env.local   # 填 AZURE_SPEECH_KEY 和 AZURE_SPEECH_REGION
npm run test:live     # 真实调用 Azure，会消耗免费额度
npm run dev           # 打开 http://localhost:5173
```

没配 `.env.local` 时 `npm run test:live` 整组跳过而不是失败，
`npm run dev` 会在启动时明确告诉你缺什么。

## 设计原则

**1. 核心逻辑不知道自己跑在哪。**
分句、缓存、调度、评分归一化这些逻辑写成纯函数，不 import Electron、不碰网络、不碰文件系统。
所以它们能被测试，也能在以后原样搬到服务器上跑。

**2. 外部依赖都藏在接口后面。**

| 接口 | 职责 | 状态 |
| --- | --- | --- |
| `TtsProvider` | 文字转语音 | ✅ Azure |
| `AudioStore` | 音频存哪里 | ✅ 内存 / 文件系统 |
| `ScoringProvider` | 发音评分 | 未开始 |
| `LlmProvider` | 生成练习文本 | 未开始 |
| `Account` | 我是谁，这次操作谁付钱 | 未开始（Stage 2） |

换掉任何一家服务商，改动只发生在一个目录里。

**3. 每个花钱或耗时的操作都留一条记录。**
什么时候、输入是什么、用了哪个 provider、成功还是失败。
这张表以后会变成学习报告、失败重试、成本统计。不留就补不回来。

**4. 不做插件系统。**
扩展性来自干净的模块边界和想清楚的数据模型，不来自提前设计的扩展点。

## 不可逾越的边界

这一节写的是**改代码时不许越过的线**。它们不是风格偏好，
每一条都对应参考实现 Enjoy 上真实发生过的问题。

**`src/core/` 不许 import `src/providers/`。**
依赖方向只能是 providers → core，反过来一次都不行。
core 里出现任何一个具体服务商的名字，这一层就不再可测了。

**身份和额度检查只能待在 `src/http/`，永远不进 `core/`。**
Enjoy 的 TTS 生成逻辑里写着 `if (engine === "enjoyai") { apiKey: await UserSetting.accessToken() }`——
「谁付钱」被写进了「怎么合成语音」，结果是不登录就不能用，TTS 也没法单独测试。
Stage 2 加账号时，`synthesize()` 必须一行不改。

**决定写进仓库，不留在对话里。**
每个想清楚的选择记进 `docs/decisions.md`，包括当时的理由和被淘汰的方案。
对话会滚走、会被压缩、会在不同窗口里分岔；文件不会。
本项目已经发生过一次：两个会话对同一件事得出了不同结论，谁都没错，只是没人写下来。

## 目录

```
src/
  core/           纯逻辑，不碰 IO
    text/         规范化、分句
    tts/          缓存键、错误分类、编排
    audio/        WAV 结构校验与构造
  providers/      外部服务的具体实现
    tts/          Azure（REST，零依赖）
  storage/        音频存储：内存实现 + 文件实现
  http/           本地服务：路由、静态文件
public/           前端页面
tests/            321 个离线用例 + 9 个 live 用例
docs/
  roadmap.md      路线图与已知缺口
  decisions.md    决策记录
```

## 路线图

四个阶段，每个阶段结束时都是一个能用的完整软件。详见 [docs/roadmap.md](./docs/roadmap.md)。

- [ ] **Stage 0 — 单人可用**
      不需要账号，填自己的 API key，数据全在本地。
      TTS 出声 → 能录音 → 能对比听 → 接入评分。
- [ ] **Stage 1 — 能装到别人电脑上**
      macOS 和 Windows 安装包、自动更新、崩溃上报。这一步加入本地 TTS 引擎，
      让别人不申请 Azure key 也能用。
- [ ] **Stage 2 — 可选账号**
      服务端出现，用于多设备同步。不登录仍然全功能可用。
- [ ] **Stage 3 — 充值**
      兑换码形式，不集成在线支付。

## 技术选型

TypeScript / SQLite / Vitest，运行时零依赖。

**界面形态**：Stage 0 是本地 Web 应用——浏览器做前端，一个 `node:http` 服务跑在本机。
Stage 1 用 Electron 把它包成桌面应用。Electron 的 renderer 本来就是浏览器，
所以这一步不需要重写界面，也不需要改 core。

**为什么运行时零依赖**：Azure 走 REST 而不是官方 SDK（`fetch` 可以注入，
整个 provider 不联网就能测）；HTTP 服务用 `node:http` 而不是框架（两个路由不值得引一个框架）。
理由写在 `docs/decisions.md` 的 0010 和 0013。

## 开源协议

[GPL-3.0-or-later](./LICENSE)
