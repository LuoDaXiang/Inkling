# 客户端契约 v0

**双方**：`public/` 里的浏览器客户端 ↔ `src/http/server.ts`。

---

## 0. 这份文件

**地位**：契约的唯一来源。代码与它不一致时，先判断哪边错，然后改一边——
不允许「代码是这样、文档是那样」并存。

**适用条件**：客户端与服务端同仓库、同版本发布，全系统只有一个客户端。
**这个假设一旦不成立**（有了移动端、或者别人写的客户端），
必须先引入版本机制，再改动任何已有字段。在那之前不加 `/v1` 前缀，不做版本协商。
**[C1]** `GET /api/config` 返回的 `contractVersion` 让这个假设可被检测——
客户端启动时发现不匹配，必须明确报错并停止，而不是继续以诡异的方式工作。
声明一个假设而不给检测手段，等于没有假设。

**条款编号**：形如 **[Cn]** 的标记表示一条**可测试的规定**。
编号只增不改，删除的条款保留编号并标注「已废止」——沿用 `decisions.md` 的规矩。
§14 的测试清单逐条引用编号，**这也是本契约完整性的判据：
每一条编号条款至少被一个测试引用，没有例外。**

**怎么改这份文件**：顺序写死，不许颠倒。

1. 先改文档，加或改编号条款
2. 再加/改测试，引用新编号
3. 最后改代码

契约文档最常见的死法不是写得不好，是写完之后代码往前跑、文档留在原地。
反过来做（先改代码再补文档）必然导致这个结果。

---

## 1. 速查表

| 路由 | 幂等 | 花钱 | 写业务表 | 一句话 |
| --- | --- | --- | --- | --- |
| `GET /api/config` | 是 | 否 | 否 | 下发共享常量与契约版本 |
| `POST /api/materials` | **否** | 否 | material / sentence | 建材料并分句，分配 `sentenceId` |
| `GET /api/materials` | 是 | 否 | 否 | 材料列表 |
| `GET /api/materials/{id}` | 是 | 否 | 否 | 一份材料的全部句子 |
| `POST /api/tts` | 是* | 未命中缓存时 | 否 | 合成范本音频 |
| `POST /api/assess` | **否** | **是** | recording / assessment / phoneme_score | 跟读评分，落库 |
| `GET /api/recordings/{id}/audio` | 是 | 否 | 否 | 回放自己的录音 |
| `GET /api/audio/{key}.{ext}` | 是 | 否 | 否 | 取范本音频 |

\* TTS 的幂等来自内容寻址缓存，不是服务端保证。缓存未命中时会真实调用外部服务。

---

## 2. 一次完整练习的时序

```
客户端启动
  │
  ├─① GET /api/config ──────────────→ 校验 contractVersion，取常量，
  │                                    scoringAvailable=false 则禁用录音入口
  │
  ├─② GET /api/materials ───────────→ 列表；没有就走 ③
  │
  ├─③ POST /api/materials ──────────→ { materialId, sentences:[{ id, ord, text, assessable }] }
  │      粘一段文本                     写 material + sentence（一个事务）
  │
  ├─④ GET /api/materials/{id} ──────→ 取某份材料的全部句子
  │
  ├─⑤ POST /api/tts ────────────────→ { url }；GET 那个 url 播放范本
  │      发句子的 text，不发 id         内容寻址，可无限期缓存
  │
  ├─⑥ 本地录音（16kHz Float32）
  │
  ├─⑦ POST /api/assess?sentenceId=… → 三种 outcome 之一
  │      body 是裸采样                  scored/unreliable 且花了钱 → 写三张表 + 落盘音频
  │                                     → { persisted, recordingId, assessmentId, audioUrl }
  │
  └─⑧ GET /api/recordings/{id}/audio → 回放自己这一次

v0 的用户故事到 ⑧ 为止。
「明天打开，看到上周练了多少」是**第二个故事**，需要聚合读路径，
不在 v0 契约里——理由和归属见 §16。
```

---

## 3. 契约的边界

判断任何一件事在不在契约里，只问一句：**改了它，另一边要不要跟着改？**

| 在契约里 | 不在契约里 |
| --- | --- |
| 路由、字段、类型、必填性 | 分句算法的内部规则 |
| 字段的**语义与单位** | 修剪静音的 50ms 回退、窗口统计量 |
| 缺席/零的区分 | 缓存策略、是否命中、有没有淘汰 |
| id 由谁分配、能不能被解读 | provider 是 azure 还是别家 |
| 错误取值，以及客户端该怎么反应 | 重试次数与退避基数 |
| 上限、超时、采样率等**共享常量** | 表结构的具体列名 |
| 幂等性与可重试性 | `core/` 里的任何东西 |

**契约越小越好。** 每多承诺一条，就多一道以后要两边同时改才能解开的锁。
所以下面凡是「维持现状不改」的地方，都写明了为什么不改——不改也是决定。

### 一条已经泄漏的承诺

`POST /api/tts` 的响应里有 `cached: true | false`。这是实现细节漏进了契约：
将来给缓存加淘汰、或者去掉缓存，这个字段就只能撒谎或者破坏客户端。
**[C2]** v0 保留它（现在删掉是破坏性变更，收益不值），但标记为 **deprecated**：
客户端不得依赖它做任何逻辑分支，只允许拿来显示。
真正该承诺的是花费，不是缓存命中。

---

## 4. 共享常量 —— `GET /api/config`

这是 v0 最重要的一条，因为它是现在唯一**正在流血**的地方。

| 常量 | 值 | 服务端 | 客户端 | 不一致的后果 |
| --- | --- | --- | --- | --- |
| 录音采样率 | 16000 | `src/http/server.ts` `RECORDING_SAMPLE_RATE` | `public/recorder.js:18` `TARGET_SAMPLE_RATE` | 时长算错 → 修剪切错 → 计费算错 |
| 最长录音秒数 | 30 | `src/core/audio/wav.ts:141` `MAX_ASSESSABLE_SECONDS` | `public/index.html:144` `MAX_SECONDS` | 录完 40 秒才被打回 |
| 上传上限 | 2 MiB | `src/http/server.ts` `MAX_PCM_BYTES` | 无 | 只能等 413 |
| 参考文本上限 | 900 | `src/providers/scoring/config.ts` `MAX_REFERENCE_CHARS` | 无 | 请求挂死而不是报错 |

前两条是**两边各硬编码一份，而且没有一条测试看过客户端那一份**。

服务端那一侧其实被多条既有测试用字面量钉着。变异测试实测（`GET /api/config` 落地之前）：

| 把哪个值改掉 | 变红的既有测试 |
| --- | --- |
| 服务端 `RECORDING_SAMPLE_RATE` 16000 → 8000 | 1 条 |
| 服务端 `MAX_ASSESSABLE_SECONDS` 30 → 40 | 7 条，散在 5 个文件 |
| **客户端 `TARGET_SAMPLE_RATE` 16000 → 8000** | **0 条** |
| **客户端 `MAX_SECONDS` 30 → 40** | **0 条** |

**真正没人守的是客户端那一侧**——而那恰恰是更容易发生的方向：
改前端的人不会去跑服务端测试。

这正撞在 README 判据五「跨层约束要有整条链的断言」上：既有断言全都是
「服务端常量 == 字面量」或者服务端两个常量互相对账，**链条只有半条**。

**解法不是加一条断言，是消灭这一整类问题**：服务端成为唯一来源，客户端启动时取。

```
GET /api/config
```

**200**
```json
{
  "contractVersion": "v0",
  "recordingSampleRate": 16000,
  "maxRecordingSeconds": 30,
  "maxUploadBytes": 2097152,
  "maxReferenceChars": 900,
  "maxTitleChars": 200,
  "maxSentencesPerMaterial": 500,
  "scoringAvailable": true
}
```

- **[C3]** 客户端必须在启动时调用一次，并用返回值替换掉上表里的两处本地硬编码。
- **[C4]** `contractVersion` 与客户端内置的版本不一致时，客户端必须明确报错并停止，
  不得继续工作。
- **[C5]** `scoringAvailable` 为 `false` 时（`deps.scoring` 未配置），
  客户端必须**在界面上直接禁用录音入口**，而不是让用户录完 30 秒再吃一个 503。
  这是目前另一个契约缺口：服务端知道评分没配，但没有任何办法告诉客户端。
- **[C6]** 响应头必须是 `Cache-Control: no-store`。这份 config 的全部目的是消灭
  「两边不一致」，让它自己被缓存住是自相矛盾。
- 无错误分支。无副作用。不花钱。幂等。

### 这些值从哪里来

「服务端成为唯一来源」只有落到具体文件上才成立。`src/http/contract.ts` 是这个
唯一来源，**它必须 import 既有常量求值，不得重新写一遍字面量**——
否则这条路由不是在消灭分叉，是在制造第三份拷贝。

| config 字段 | 来源 |
| --- | --- |
| `recordingSampleRate` | `contract.ts` 自己持有（原在 `server.ts`，移过来后由 `server.ts` 再导出） |
| `maxUploadBytes` | 同上（原 `MAX_PCM_BYTES`） |
| `maxRecordingSeconds` | import `core/audio/wav.ts` 的 `MAX_ASSESSABLE_SECONDS` |
| `maxReferenceChars` | import `providers/scoring/config.ts` 的 `MAX_REFERENCE_CHARS` |
| `maxTitleChars` `maxSentencesPerMaterial` | `contract.ts` 新建，§9 的 [C58] [C60] 校验直接用它 |

**`maxReferenceChars` 特别注意**：它是派生量
（`MAX_ASSESSABLE_SECONDS × CHARS_PER_SECOND × HEADROOM`，当前求值 900），
不是自由常量。写死 `900` 会在有人调整 30 秒上限时**静默错位**。

这不是一条编号条款——常量放在哪个文件对客户端不可观测，不属于客户端契约。
它是实现约束，归属见 §12。

---

## 5. 身份、数据模型与枚举

```
material ──< sentence ──< recording ──< assessment ──< phoneme_score
```

`insertRecording()` 要 `sentenceId`，`insertAssessment()` 要 `recordingId`
（`src/storage/records.ts`）。**F12 断的就是这一节**：`POST /api/assess` 现在只拿到一段
字面文本，而文本反查不出 id——`sentence` 表没有 text 上的唯一约束，
同一句话出现在两个材料里是合法状态。

**谁分配 id**：服务端，在 `POST /api/materials` 时。
客户端不生成任何业务 id（`clientRequestId` 除外，见 §7.5）。

**[C7]** id 是**不透明标识符**（opaque id）。客户端不得对它做算术、排序、
猜测下一个、或假设它连续。当前实现是自增整数，形状将来可能变。

**[C8]** 排序永远用 id，不用时间戳。`Date.now()` 不单调，
`operations` 已经踩过这条（`src/storage/operations.ts`），业务表沿用同一规矩。

### 封闭枚举

**收窄任何一个都是破坏性变更。** 客户端遇到未知取值时必须降级显示，不得崩溃。

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `material.source` | `"paste"` \| `"ai"` | **[C9]** v0 只接受 `"paste"`，`"ai"` 由 M06 打开 |
| `sentence.ord` | 从 **0** 开始的连续整数 | **[C10]** 与 `UNIQUE(material_id, ord)` 对应 |
| `outcome` | `"scored"` \| `"unreliable"` \| `"no_speech"` | **[C11]** 客户端必须处理全部三种 |
| `words[].errorType` | `"None"` \| `"Omission"` \| `"Insertion"` \| `"Mispronunciation"` \| `"UnexpectedBreak"` \| `"MissingBreak"` \| `"Monotone"` | **[C12]** **主打维度标红的唯一依据**。取值来自 Azure，换 provider 必须映射到这套 |
| `words[].breakError` | `"unexpected"` \| `"missing"` | **[C13]** 可缺席 |
| `error` | 见 §7.4 | **[C14]** |

---

## 6. 路由

### 6.1 `GET /api/config` — 新增

见 §4。

### 6.2 `POST /api/materials` — 新增

```json
{ "title": "…", "source": "paste", "text": "原文全文" }
```

**201**
```json
{
  "materialId": 12,
  "sentences": [
    { "id": 88, "ord": 0, "text": "…", "assessable": true },
    { "id": 89, "ord": 1, "text": "…", "assessable": false }
  ]
}
```

- **[C15]** 服务端用 `core/text/split.ts` 的 `split()` 分句，结果与直接调用它一致。
- **[C16]** `assessable` 表示这一句能不能送去评分，判据是
  `text.length <= maxReferenceChars`。**这是保守代理，不是真实时长**——
  真实时长要合成完才知道，而 F3（分句不知道 30 秒约束）还没解决。
  字符长度会误伤极慢语速的短句，但方向是安全的：宁可标成不可评分，
  也不要让用户录完才吃 400。
- **[C17]** `assessable` 的**值**可能随版本变化（F3 修好后换成真实判据）。
  **客户端不得缓存它**，每次从服务端取。语义不变但值会变——
  这是「承诺语义、不承诺取值」的代价，必须说明。
- **[C18]** `assessable: false` 的句子仍然入库、仍然出现在列表里，
  客户端应禁用它的录音按钮，但不禁用合成按钮。
  **待确认**：TTS 对超长单句的行为未经测试（SSML 构造、provider 长度限制），
  在实测之前不承诺 `assessable: false` 的句子一定能合成成功。

**错误**：`400 rejected`、`413 too_long`。校验细则见 §9。

**[C19] 幂等：否。** 同一段文本 POST 两次会产生两个 material——**这是刻意的**，
同一篇文章练两遍是合法需求。客户端不得自动重试这个请求。

**副作用**：在**同一个事务**里写 `material` + `sentence`。不花钱。

### 6.3 `GET /api/materials?limit=` — 新增

**200**
```json
{ "materials": [ { "id": 12, "title": "…", "source": "paste",
                   "createdAtMs": 1730000000000, "sentenceCount": 14 } ] }
```

- **[C20]** 按 `id` 降序。`limit` 默认 50，上限 200。
- 不做游标分页：v0 单用户，承诺游标语义是自缚。

### 6.4 `GET /api/materials/{id}` — 新增

**200**：`{ id, title, source, createdAtMs, sentences: [ …同 6.2… ] }`
**错误**：`404 not_found`、`400 rejected`（`{id}` 不是整数）。

### 6.5 `POST /api/tts` — **不变**

请求 `{ text, voice?, speed? }`，响应 `{ key, format, bytes, cached, url }`。

**[C21] 为什么不加 `sentenceId`**：TTS 的缓存键是内容派生的
（`core/tts/cache-key.ts`：text + engine + model + voice + speed），
**刻意不绑任何业务实体**——同一句话出现在两篇文章里应该共用同一段音频。
这是 decisions 0004 的核心决定，加 `sentenceId` 会诱导后人把它做进键里，
重蹈参考实现的覆辙。客户端从 `GET /api/materials/{id}` 拿到文本，直接发文本。

**[C22]** `url` 是**内容寻址且永久不变**的，配 `Cache-Control: immutable`，
客户端可以无限期缓存。（这条一直在做，只是从没写下来。）

### 6.6 `POST /api/assess` — 改造

```
POST /api/assess?sentenceId=88&clientRequestId=<uuid>
                &echoCancellation=true&noiseSuppression=true&autoGainControl=false
Content-Type: application/octet-stream
Body: 裸 Float32 小端采样
```

**[C23] 为什么参数全在 query string**：body 必须保持裸二进制——base64 会让体积
再涨三分之一，而 30 秒采样已经接近 2 MiB。query 全部参数不超过 1.5 KB，
`reference` 最长 900 字符（`MAX_REFERENCE_CHARS` 的设计依据本来就是 8 KB 请求头上限），
安全。不引入 multipart：为几个标量字段引入一套新编码不划算。

**已知代价**（记录在案，v0 接受）：`reference` 走 query 意味着**用户的练习文本会进 URL**，
反向代理的 access log 和浏览器历史都会留下。Stage 0 本机单用户可接受，
一旦部署到公网必须改成 header 或 body 内嵌。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `sentenceId` | 否 | 给了就落库。**不给 = 匿名试用**，正常返回分数但不记录 |
| `reference` | 否 | **仅当 `sentenceId` 缺席时使用** |
| `clientRequestId` | 否 | 客户端生成的 UUID v4。v0 服务端只记进流水，不做去重 |
| `echoCancellation` `noiseSuppression` `autoGainControl` | 否 | `"true"` / `"false"` |

- **[C24]** `sentenceId` 与 `reference` **同时给 → `400 rejected`**。
  不是「以某个为准」：同一个事实存两份且可能不一致，是契约必须在边界上杀死的东西。
  规定优先级只是把歧义推迟到实现里，将来一定有人搞反。
- **[C25]** `sentenceId` 给定时，参考文本由服务端从 `sentence.text` 读，
  客户端不传。客户端传的话，用户在界面上改了文本而 id 没变，
  评分就会挂到错误的句子上。
- **[C26]** `sentenceId` 可选而非必填，是为了保留「粘一句，试一下」的通路——
  这是当前唯一能用的流程，也是新用户第一次打开时唯一合理的入口。
  **写下这一条是为了防止将来有人把它当残留代码删掉。**
- **[C27]** 三个 capture 参数**必须是 `MediaStreamTrack.getSettings()` 的回读值**，
  不是客户端请求的值——`records.ts:34` 说得很清楚，浏览器可以无视你的 constraint。
  缺席则落库为 `NULL`（不知道），不是 `false`（确定没开）。

#### 响应

**200 `scored`**
```json
{
  "outcome": "scored",
  "scores": { "accuracy": 82.1, "fluency": 74.0, "completeness": 100, "prosody": 68.2, "overall": 79.5 },
  "words": [ { "word": "think", "accuracy": 41.2, "errorType": "Mispronunciation",
               "phonemes": [ { "phoneme": "th", "accuracy": 22.0 } ], "monotone": 0.8 } ],
  "recognized": "…",
  "snr": 24.5,
  "trimmedStartMs": 80,
  "trimmedEndMs": 200,
  "assessedMs": 4620,
  "persisted": true,
  "recordingId": 301,
  "assessmentId": 455,
  "traceId": "…",
  "audioUrl": "/api/recordings/301/audio"
}
```

**[C28] 单位进字段名。** `trimmedStartMs` / `assessedMs` 取代了原来的
`trimmed.start`（采样数）和 `seconds`（浮点秒）。原来一个响应里并存三种时间单位
而文档只规定了其中一种，是歧义的温床。**这是刻意的破坏性变更，趁只有一个客户端时做。**
通则见 §7.2。

**[C29]** `traceId` 让客户端能把一次失败的练习和服务端流水对上。
配合 §12 给 `recording` 加的 `trace_id` 列，形成双向可查。

**200 `unreliable`** — 字段与 `scored` 相同，`outcome` 不同。

**[C30] 客户端必须降级呈现，具体是**：
- **不展示** `scores`（任何一项）
- **不展示** `words` 的逐词标红
- **展示** `recognized`，并提示「系统听到的是这样，请重录」
- 提示重录

理由写在 `core/scoring/assess.ts` 里——纯白噪声的准确度是 71 分，
照 `scored` 渲染会把噪声当成「读得还行」端给用户，而准确度是主打维度。
`recognized` 保留是因为它在 unreliable 时**恰恰是最有用的信息**：
用户看到系统听成了什么，就理解了为什么不可信。
把这条降级要求写进契约，是因为它是**产品正确性**，不能留给客户端自己发挥。

**200 `no_speech`**
```json
{ "outcome": "no_speech", "trimmedStartMs": 3000, "persisted": false, "traceId": "…" }
```

**[C31]** 两条来源合并成同一个 outcome，因为**对客户端是同一件事**——
「这次没录到声音，重录」。两者的区别只在计费和落库上，见 [C33]。

#### `persisted` 的语义

| `persisted` | `persistError` | 含义 | 客户端 |
| --- | --- | --- | --- |
| `true` | 不出现 | 已记录，`recordingId` / `audioUrl` 必然存在 | 正常显示 |
| `false` | 不出现 | **本来就没要求记录**（没给 `sentenceId`，或无成本的 `no_speech`） | 正常显示，不提示 |
| `false` | 有值 | **要求记录但写失败了** | 显示结果，并明确提示「这次没记上」 |

**[C32] 两种 `false` 必须分得开**，否则客户端不知道该不该提示。

**[C33] 落库的判据是「这次调用有没有产生成本」**，不是「有没有分数」：

| 情况 | 调了外部服务 | 落 `recording` | 落 `assessment` |
| --- | --- | --- | --- |
| `scored` | 是 | 是 | 是 |
| `unreliable` | 是 | 是 | 是（`reliable = 0`） |
| `no_speech`（服务识别不到） | **是** | **是** | 否 |
| `no_speech`（修剪后为空） | 否 | 否 | 否 |

第三行是第一轮 grill 抓出来的自相矛盾：我用「花了钱不落库会让账目对不上」
论证 `unreliable` 要落库，却让同样花了钱的 `no_speech` 不落库。
**一条规则统一两处：花了钱就必须留痕。** 那次录音也存下来，
用户可以回放确认自己到底录了什么。

**[C34]** `unreliable` 落库时 `assessment.reliable = 0`。
趋势曲线必须默认过滤 `reliable = 0`，否则被噪声记录污染，
而且**这件事发生时没有任何征兆**。需要 v4 迁移，见 §12。

**[C35] 写库失败返 200 而不是 500**：评分已经成功、钱已经花了，
把结果扔掉是第二次伤害。用户至少要看见这一次的结果。
但静默吞掉也不行——**练习记录丢一行是用户的数据没了，而且不会重新产生**。
所以：结果照给，失败照说。

这条**不能照抄 `operations` 的「写流水永不抛」**。
流水丢一行只是少个运维记录，业务表丢一行是丢用户资产。同一个仓库里
两处采取相反策略是对的，不要为了一致性统一掉——和 TTS 缓存 / 评分不缓存同理。

#### 错误

`400 rejected`、`404 not_found`（`sentenceId` 不存在）、`413 too_long`、
`503 unavailable`（评分未配置），以及 §7.4 的通用错误。校验细则见 §9。

**[C36] 幂等：否。每次调用都真实付费。客户端一律不得自动重试。**

### 6.7 `GET /api/recordings/{id}/audio` — 新增

返回 `audio/wav`，`Cache-Control: public, max-age=31536000, immutable`（内容寻址）。
**错误**：`404 not_found`、`400 rejected`（`{id}` 不是整数）。

**[C37] 为什么必须有这条**：`recording.audio_key` 是 `NOT NULL`，
我们被表结构逼着存音频。不给读的入口，等于把 F12 在小一号的尺度上重犯一遍——
存了但没人能用。

**[C38] 录音音频与 TTS 分开存储。**
`FileAudioStore` 的键是**请求参数派生**的，语义是「同样的请求复用同一段音频」。
录音正好相反——同一句话录十次是十份必须各自保留的音频，去重就是数据丢失。
录音走独立目录 + **内容哈希**（对编码后的 WAV 取 sha256）。

**[C39] 存修剪后的那一份**，因为那才是真正送去评分、也是计费依据的字节。
存原始的，将来复盘会和分数对不上。

### 6.8 `GET /api/audio/{64位哈希}.{wav|mp3}` — **不变**

---

## 7. 通用约定

### 7.1 时间

**[C40]** 所有绝对时间是 **Unix 毫秒整数**（`Date.now()`），UTC，字段名以 `Ms` 结尾。
客户端负责本地化显示。服务端不返回格式化过的时间字符串。

### 7.2 单位进字段名

**[C41]** 任何带单位的数值字段，名字必须以单位结尾。
这不是新规矩，是把你代码里已有的惯例提成明文：
`durationMs` / `costMicros` / `latencyMs` / `audioBytes` / `textLength`。

| 后缀 | 单位 |
| --- | --- |
| `…Ms` | 毫秒 |
| `…Bytes` | 字节 |
| `…Micros` | 微元 |
| `…Chars` | 字符数 |
| `…Seconds` | 秒（仅用于配置里的整数秒） |

**[C42] 量纲。** 无单位后缀的数值字段，量纲在这里定死：

| 字段 | 量纲 |
| --- | --- |
| `scores.accuracy` / `fluency` / `completeness` / `prosody` / `overall` | **0–100** |
| `words[].accuracy` / `phonemes[].accuracy` | **0–100** |
| `words[].monotone` | **0–1** |
| `snr` | 分贝（dB），可正可负 |

**同一个响应里 `accuracy` 是 0–100 而 `monotone` 是 0–1**，这是 provider 的既成事实，
不在契约层归一化（归一化会让 `monotone` 和 `types.ts` 的定义脱节）。
但**必须写下来**，否则客户端把 `0.8` 渲染成「0.8 分」或「80%」都说得通。

### 7.3 缺席的表达 —— HTTP 层两态，数据库层三态

**[C43] HTTP 响应里一律用「字段不出现」表达缺席，绝不发 `null`。**
这与现有实现一致（`server.ts` 里到处是 `...(cond ? { x } : {})`），
也免掉客户端区分 `null` 与 `undefined` 的负担。

| 字段 | 不出现的含义 |
| --- | --- |
| `scores.prosody` | 本次未产出——音频被截断、参考文本无效，或非 en-US。**不是 0 分** |
| `snr` | 服务端没返回。**不是信噪比为 0** |
| `words[].monotone` / `breakError` | 该词没有这项数据 |
| `recordingId` / `assessmentId` / `audioUrl` | `persisted` 为 `false` |
| `persistError` | 没有发生落库失败 |

**数据库层保留完整三态**，因为存储要区分「不知道」和「确实是零」：
`cost_micros` 为 `NULL` 是「没配费率，不知道」，为 `0` 是「确实免费」——
`ServerDeps.rates` 的注释已经把这条论证清楚了，业务表沿用。
`assessment.prosody` / `snr` / `reliable` 同理。

**[C44] 客户端不得把缺席渲染成 0。** 语调没测出来就不显示语调那一行，
显示「语调 0 分」是在撒谎。

### 7.4 错误

统一形状 `{ "error": <取值>, "message": <中文说明> }`。`error` 是封闭集合：

| `error` | 状态码 | 客户端该做什么 |
| --- | --- | --- |
| `rejected` | 400 | 改输入再试。**不自动重试** |
| `not_found` | 404 | 刷新列表；id 可能已失效 |
| `forbidden` | 403 | 不该发生，报 bug |
| `method_not_allowed` | 405 | 不该发生，报 bug |
| `too_long` | 413 | 缩短输入。**不自动重试** |
| `network` | 502 | 提示用户手动重试 |
| `empty` | 502 | 提示用户手动重试 |
| `unknown` | 500 | 提示用户手动重试 |
| `auth` | 500 | 提示「服务端配置有问题」，用户做不了什么 |
| `quota` | 503 | 同上 |
| `unavailable` | 503 | 功能未配置，禁用相关入口 |
| `internal` | 500 | 兜底，报 bug |

**[C45]** `auth` / `quota` 是 5xx 而不是 4xx，因为密钥是本机配的，
**浏览器端的用户没做错任何事**。这条分类逻辑已经在 `server.ts` 的 `STATUS` 表里，
写进契约是为了让客户端知道「这类错误不该向用户追责」。

**[C46]** `message` 是给人看的，客户端可以直接显示，
但**不得解析它做分支**。分支只能基于 `error`。
message 的措辞随时可能改，不算破坏性变更。

### 7.5 幂等与重试

**[C47] v0 不提供任何幂等保证。**
写路径（所有 POST）：客户端**一律不自动重试**。每次 `POST /api/assess` 都真实付费。
读路径（所有 GET）：可以自动重试。

**[C48]** `clientRequestId` 是为 F4（in-flight 去重）**预留的位置**，
v0 服务端只把它记进 `operations.meta`。预留一个字段比将来加一个字段便宜一个数量级——
加字段要两端同时改并兼容旧客户端，预留只要现在多写一行。

### 7.6 超时

**[C49] 服务端不承诺任何响应时间上限。**
`POST /api/assess` 最坏情况是 3 次请求 + 500ms + 1000ms 退避
（`core/scoring/assess.ts` 的 `RETRY`）。
**客户端必须自己设超时，建议 60 秒**，超时后提示用户但**不得自动重发**——
请求可能已经在服务端执行并计费了。

---

## 8. 客户端的承诺

契约有两个方向，这一节是常被漏掉的那一半。以下由**客户端**保证，服务端据此不做防御：

- **[C50]** 上传给 `POST /api/assess` 的是 **16 kHz、单声道、Float32、小端** 的原始采样，
  采样率取自 `GET /api/config`。
- **[C51]** 三个 capture 参数是 `getSettings()` 的**回读值**，不是请求值。见 [C27]。
- **[C52]** 不自动重试任何 POST。见 [C36] [C47]。
- **[C53]** 不解析 `message` 做逻辑分支。见 [C46]。
- **[C54]** 不缓存 `assessable`。见 [C17]。
- **[C55]** 不对 id 做算术、排序或猜测。见 [C7]。
- **[C56]** v0 假设**单标签页、单操作**：不并发发起两次 assess，
  不在一次 assess 未返回时发起第二次。服务端不做并发保护（F4 未修）。

服务端**不校验** [C50] 的采样率——它拿到的只是一串浮点数，无从判断。
违反它的后果是时长算错、计费算错，且**不报错**。
这就是为什么 [C3] 的常量下发和 §14 的一致性测试是必须的。

---

## 9. 输入校验边界

**[C57]** 所有路径参数 `{id}` 必须是十进制正整数。
不是 → `400 rejected`（**不是 404**：格式错和不存在是两件事）。

| 输入 | 上限 / 规则 | 违反时 |
| --- | --- | --- |
| **[C58]** `title` | 非空，≤ `maxTitleChars`（200） | `400 rejected` |
| **[C59]** `text`（materials） | 非空，请求体 ≤ `MAX_JSON_BYTES`（64 KiB） | `400` / `413 too_long` |
| **[C60]** 分句结果 | 非空，句子数 ≤ `maxSentencesPerMaterial`（500） | `400 rejected`，提示拆分材料 |
| **[C61]** 单句 `text` | 无上限，入库原样保存 | 超过 `maxReferenceChars` 时 `assessable: false` |
| **[C62]** `limit` | 整数，1–200；非整数或越界一律 **clamp**，不报错 | 读路径宽容，写路径严格 |
| **[C63]** `source` | 枚举，v0 仅 `"paste"` | `400 rejected` |
| **[C64]** `clientRequestId` | UUID v4 格式，36 字符 | 格式不符 → `400 rejected`。**不静默丢弃**：`META_KEYS` 的单值上限是 512 字符且超限是静默截断，一个残缺的 id 进流水比没有更糟 |
| **[C65]** assess body | 非空，长度是 4 的倍数，≤ `maxUploadBytes` | `400` / `413` |
| **[C66]** capture 三参数 | 严格 `"true"` / `"false"`；其他值 → `400 rejected` | 不把 `"1"` 当真 |

**读路径宽容、写路径严格**：`limit` 越界 clamp 而不报错，因为它不改变任何状态；
写路径的任何可疑输入都拒绝，因为它会落进改不动的库里。

---

## 10. 副作用矩阵

| 路由 | material | sentence | recording | assessment | phoneme_score | operations | 音频落盘 | 花钱 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/config` | | | | | | | | |
| `POST /api/materials` | 写 | 写 | | | | | | |
| `GET /api/materials[/{id}]` | | | | | | | | |
| `POST /api/tts` | | | | | | 写 | 未命中缓存时 | 未命中时 |
| `POST /api/assess` | | | 写¹ | 写² | 写² | 写 | 写¹ | 见 [C33] |
| `GET /api/recordings/{id}/audio` | | | | | | | | |
| `GET /api/audio/…` | | | | | | | | |

¹ 见 [C33]：判据是「这次调用有没有产生成本」。
² 仅 `scored` / `unreliable`。`assessment` 与 `phoneme_score` 在**同一个事务**里。

### 音频落盘与数据库事务的顺序

**[C67]** **文件系统不参与 SQLite 事务**，所以「三张表一个事务」不能覆盖落盘。顺序写死：

```
1. 编码 WAV，算内容哈希
2. 写音频文件（临时文件 + rename，沿用 F15 的原子写法）
3. 开事务 → 写 recording / assessment / phoneme_score → 提交
```

**只能是这个顺序。** 两种失败的后果不对称：

| 失败点 | 后果 | 可容忍？ |
| --- | --- | --- |
| 第 2 步失败 | 什么都没写，返回 `persisted:false` + `persistError` | 是 |
| 第 3 步失败 | **孤儿音频文件**：占磁盘，没人引用 | 是 |
| 如果反过来先写库 | **悬空引用**：记录看起来完全正常，读音频 404 | **否** |

孤儿文件是浪费磁盘，悬空引用是用户看到坏记录。**宁可浪费磁盘。**

孤儿文件的回收和 F8（缓存无上界、无淘汰）是同一件事，一起做。
在那之前孤儿文件只增不减，这是 v0 已知且接受的代价。

这一条是第一轮 grill 抓出来的最严重遗漏——**F15 刚踩过同类的坑（非原子写入），
而我在文档里引用了 F15 却没意识到自己正在制造第二个。**

---

## 11. 服务端明确不承诺什么

显式的非承诺比沉默有用得多。以下三件事**客户端一定会假设，而它们全都不成立**：

- **[C68]** `words` 的长度**不**等于参考文本的词数。
  `Omission` 和 `Insertion` 会让它们不等，按下标对齐必然错位。
- **[C69]** `recognized` **不**等于 `reference`。它是服务端听到的，
  两者的差异正是评分的信息来源。
- **[C70]** `scores.overall` **不是**其他四项的任何固定加权，
  也不承诺加权方式稳定。客户端不得自己重算它，也不得反推权重。

外加：

- **[C71]** 不承诺 `words` 的顺序对应音频的时间顺序（provider 未声明）。
- [C49] 不承诺任何响应时间上限。见 §7.6。
- **[C72]** 不承诺 `GET` 响应的大小上限。一份 500 句的材料详情可能有数百 KB，
  客户端要能处理。

---

## 12. 需要的迁移与代码改动

### v4 迁移

```sql
ALTER TABLE assessment ADD COLUMN reliable INTEGER;
ALTER TABLE recording  ADD COLUMN trace_id TEXT;
```

**都是可空列。** 沿用 v2 / v3 的规矩：**老行是 NULL 而不是被猜一个值**——
我们确实不知道那些行属于哪一侧。

- `reliable`：`1` = `scored`，`0` = `unreliable`，`NULL` = v4 之前。见 [C34]。
  **[C73]** 写入必须走 `records.ts` 的 `toFlag()`，不能直接绑 JS boolean——
  F17 记录了 `node:sqlite` 的布尔绑定行为随 Node 版本变，已实测到差异。
- `trace_id`：**[C74]** 把业务记录和 `operations` 流水双向打通。
  没有它，排查「那次练习为什么失败」时从业务记录跳不到流水，
  而这两处正在记录同一次调用。

### 非迁移的代码改动

- **[C75]** `src/storage/operations.ts` 的 `META_KEYS` 增加
  `"clientRequestId"` 与 `"sentenceId"`。
  **不在白名单里的键是静默丢弃的**，忘了加就等于没记，而且不报错。
- 新增录音音频 store（内容哈希 + 独立目录），不复用 `FileAudioStore`。见 [C38]。
- 新建 `src/http/contract.ts` 作为共享常量的唯一来源，`GET /api/config` 的每个值
  都从它来。`server.ts` 原样再导出 `RECORDING_SAMPLE_RATE` / `MAX_PCM_BYTES` /
  `MAX_AUDIO_BYTES`——现有路由测试 import 的是这几个，再导出让它们一行不改，
  同时避开 `contract.ts ↔ server.ts` 的循环 import。取值规则见 §4「这些值从哪里来」。
- `sendJson()` 增加可选的响应头参数（默认不传、行为不变），用来发 [C6] 的 `no-store`。

---

## 13. 客户端必须改的地方

| # | 改什么 | 位置 |
| --- | --- | --- |
| 1 | 启动时 `GET /api/config`，校验 `contractVersion`，删掉两处硬编码 | `recorder.js:18`、`index.html:144` |
| 2 | `scoringAvailable` 为 false 时禁用录音入口 | `index.html` |
| 3 | 新增「建材料 / 选材料 / 选句子」界面 | 新增 |
| 4 | 录音结束后回读 `getSettings()` 并随请求上传 | `recorder.js` |
| 5 | `POST /api/assess` 改发 `sentenceId`，不再发 `reference` | `index.html:277` |
| 6 | 生成并携带 `clientRequestId`；设 60 秒超时 | `index.html` |
| 7 | 处理 `unreliable`（按 [C30] 降级）与 `persisted:false`（区分两种） | `index.html` `render()` |
| 8 | `assessable: false` 的句子禁用录音按钮 | 新增 |
| 9 | ✅ 改用 `trimmedStartMs` / `trimmedEndMs` / `assessedMs`，删掉本地的采样数换算 | `index.html:368` |

---

## 14. 契约测试清单

**完整性判据：每一条可测条款至少被一个测试引用。**
条款分两类——**可测条款**必须有测试；**说明性条款**记录的是判断依据或
「不承诺什么」，无法用测试守，在下面显式列出，不计入判据。

新增条款时必须同时归类，可测的必须同时新增引用它的测试。

### 服务端契约测试

| # | 测试 | 守哪条 |
| --- | --- | --- |
| 1 | `contractVersion` 出现在响应里；`config` 响应头是 `no-store` | C1 C6 |
| 2 | `deps.scoring` 未配置时 `scoringAvailable` 为 `false` | C5 |
| 3 | `sentenceId` 与 `reference` 同时给 → 400 | C24 |
| 4 | `sentenceId` 不存在 → 404；`{id}` 非整数 → 400 | C57 |
| 5 | 参考文本取自 `sentence.text`：改库里的文本后重跑，断言送给 provider 的是库里的那份 | C25 |
| 6 | 落库失败（注入会抛的 db）→ 200 + `persisted:false` + `persistError`，且结果字段完整 | C32 C35 |
| 7 | 四种 outcome × 落库组合逐行核对（[C33] 那张表） | C11 C33 |
| 8 | `unreliable` 落库且 `reliable = 0`；写入走 `toFlag()` | C34 C73 |
| 9 | 无成本的 `no_speech` → 四张业务表零新增行 | C33 |
| 10 | **响应 JSON 里不出现 `null`**——遍历所有路由的成功响应断言 | C43 |
| 11 | §7.4 每个 `error` 取值至少一条用例，且断言状态码 | C14 C45 |
| 12 | 分句结果与直接调 `split()` 一致；`assessable` 边界（900 / 901 字符） | C15 C16 |
| 13 | `assessable: false` 的句子仍入库、仍出现在列表与详情里 | C18 |
| 14 | §9 每条校验边界的正反例 | C57–C66 |
| 15 | 同一段文本 POST 两次 → 两个不同的 `materialId` | C19 |
| 16 | `source: "ai"` → 400；`ord` 从 0 开始且连续 | C9 C10 |
| 17 | `GET /api/materials` 按 id 降序；`limit` 缺省 50、越界 clamp 到 200 | C8 C20 |
| 18 | `GET /api/audio/…` 与 `GET /api/recordings/{id}/audio` 都带 `immutable` | C22 C37 |
| 19 | **同一句话录两次 → 两个不同的 `audio_key`**，且都能读回。录音 store 与 TTS store 目录不同 | C38 |
| 20 | **落盘 WAV 的时长等于 `assessedMs`**（存的是修剪后那一份，不是原始录音） | C39 |
| 21 | capture 三参数落库；缺席时落 `NULL` 而不是 `0` | C27 |
| 22 | `traceId` 出现在响应里，且等于 `recording.trace_id` 与 `operations.trace_id` | C29 C74 |
| 23 | `META_KEYS` 包含 `clientRequestId` 与 `sentenceId`，且一次 assess 后能在流水里读回 | C48 C75 |
| 24 | 枚举映射：`errorType` 七个取值、`breakError` 两个取值全覆盖 | C12 C13 |
| 25 | 单位断言：`trimmedStartMs` / `assessedMs` 对已知采样数的换算正确；`createdAtMs` 是毫秒整数 | C28 C40 C41 |
| 26 | 量纲断言：`scores.*` 与 `words[].accuracy` 在 0–100，`monotone` 在 0–1 | C42 |

### 跨层测试

| # | 测试 | 守哪条 |
| --- | --- | --- |
| 27 | **采样率与秒数一致性**：断言 `public/recorder.js` 导出的 `TARGET_SAMPLE_RATE` 等于 `GET /api/config` 的 `recordingSampleRate`，`maxRecordingSeconds` 同理。**不允许 import 服务端常量来断言**——值必须一边取自 `public/`、一边取自 HTTP 响应，否则测的是自己等于自己。测试文件里带一条自检用例，读自己的源码守着这条禁令 | C3 C50 |
| 28 | **副作用矩阵逐行核对**：断言**不该被写的表确实没被写**。需要一个统一 helper（跑前后 diff 六张表的行数），只断言「该写的写了」抓不到多写 | C33 §10 |
| 29 | **落盘顺序**：注入会抛的 db → 断言音频文件**已存在**（孤儿而非悬空）；注入会抛的文件写 → 断言库里零新增行 | C67 |

### 客户端契约测试

现在 `public/` 零测试覆盖，这几条**目前一条都没有**。
它们守的是客户端对服务端的承诺（§8），服务端无从校验，只能在客户端测。

| # | 测试 | 守哪条 |
| --- | --- | --- |
| 30 | `contractVersion` 不匹配时客户端明确报错并停止工作 | C4 |
| 31 | `scoringAvailable: false` 时录音入口被禁用 | C5 |
| 32 | `unreliable` 时不渲染 `scores` 与 `words`，只渲染 `recognized` | C30 |
| 33 | `persisted:false` + `persistError` 时提示「没记上」；无 `persistError` 时不提示 | C32 |
| 34 | 任何 POST 失败后不自动重发；60 秒超时后也不重发；一次 assess 未返回时录音入口保持禁用（单操作） | C36 C47 C49 C52 C56 |
| 35 | 缺席字段不渲染成 0（构造无 `prosody` / 无 `snr` 的响应） | C44 |
| 36 | 上传的采样是 16 kHz 单声道 Float32 小端，采样率取自 config 而非硬编码 | C50 |
| 37 | capture 参数取自 `getSettings()` 回读值，不是请求值 | C51 C27 |
| 38 | `assessable` 每次从服务端取，不走本地缓存 | C17 C54 |
| 39 | 不解析 `message` 做分支；不对 id 做算术或排序 | C7 C46 C53 C55 |

### 覆盖状态

| 类别 | 条款数 | 状态 |
| --- | --- | --- |
| 服务端可测 | 47 | 由 #1–#26 覆盖 |
| 跨层可测 | 3 | 由 #27–#29 覆盖 |
| 客户端可测 | 15 | 由 #30–#39 覆盖，**但 `public/` 目前零测试基础设施** |
| 说明性，不可测 | 10 | 见下 |

**说明性条款**（记录判断依据或非承诺，无法用测试守，不计入完整性判据）：

| 条款 | 内容 |
| --- | --- |
| C2 | `cached` 标记为 deprecated——这是一条约定，不是行为 |
| C21 | 为什么 TTS 不加 `sentenceId` |
| C23 | 为什么参数走 query string |
| C26 | 为什么 `sentenceId` 可选 |
| C31 | 为什么两条 `no_speech` 合并成一个 outcome |
| C68 | 不承诺 `words` 长度等于词数 |
| C69 | 不承诺 `recognized` 等于 `reference` |
| C70 | 不承诺 `overall` 是固定加权 |
| C71 | 不承诺 `words` 顺序对应时间顺序 |
| C72 | 不承诺 `GET` 响应大小上限 |

**C68–C72 是负面陈述，原理上测不了**——测试能证明某件事成立，
不能证明「我没承诺它成立」。它们的作用是防止客户端把巧合当保证：
今天 `words.length` 恰好等于词数，不代表明天还等于。

**已知缺口**：客户端测试（#30–#39）需要先给 `public/` 搭测试基础设施，
这在 roadmap 上还没有对应的里程碑。在那之前 §8 的客户端承诺全靠自觉——
**这是 v0 契约最薄的一环，必须写明而不是假装它不存在。**

## 15. 破坏性变更的定义

### 算破坏（必须两端同时发布）

1. **改变任何字段的语义，即使形状不变。**
   这是最阴险的一类——类型没变、字段没删、所有测试照绿，
   客户端悄悄显示错误的数字。例：把 `assessedMs` 从「修剪后」改成「修剪前」。
   **排第一位是因为它最难被发现，不是因为它最少见。**
2. 删除或重命名任何请求 / 响应字段
3. 把可选字段变必填
4. **收窄任何枚举**（`error` / `outcome` / `source` / `errorType` / `breakError`）
5. 改变 id 的形状或含义
6. 改变 `GET /api/config` 里某个常量的**语义**
7. 收紧任何校验规则（§9）

### 不算破坏

- 新增可选请求字段
- 新增响应字段
- 放宽限额、放宽校验
- **改变 `GET /api/config` 里某个常量的值**——那正是把它做成下发字段的全部目的
- 改 `message` 的措辞
- `assessable` 的**取值**变化（[C17] 已声明，客户端不得缓存）
- `core/` 内的任何实现改动

---

## 16. v0 明确不包含

写下来是为了防止将来有人以为是漏了。

| 不做 | 理由 | 什么时候做 |
| --- | --- | --- |
| 聚合读路径（`GET /api/stats`） | 聚合的**形状**最容易随产品反馈设计变——「只展示分档不展示原始百分数」还没落到界面上，现在承诺一个聚合结构等于自缚 | 界面定下来之后。§2 的时序里已标明这是**第二个用户故事**，v0 的故事到「回放自己这一次」为止。M05 验收的三问用 `scripts/` 直接查库满足 |
| `/v1` 前缀与版本协商 | 单客户端、同版本发布，成本大于收益。[C1] 的 `contractVersion` 已经守住了假设 | 出现第二个客户端时 |
| 幂等 / in-flight 去重 | F4 的事。v0 只预留 `clientRequestId` | M07 |
| 孤儿音频文件回收 | 和 F8（缓存无上界、无淘汰）是同一件事 | M07，与 F8 一起 |
| 软删除 | 没有删除入口 | 有删除需求时 |
| 分页游标 | 单用户，`limit` 够了 | 材料上千时 |
| 鉴权与额度 | Stage 0 本机单用户。**将来加只能加在 `http/` 层，永远不进 `core/`**，沿用 `server.ts` 已声明的边界纪律 | Stage 2 |
| 并发保护 | [C56] 由客户端承诺单操作 | F4 修好时 |

---

## 17. 落地顺序

按**止血 → 打地基 → 建楼**排，不按「难改的先做」排。

**进度：1–5 已完成，只剩第 6 步客户端。**

| # | 做什么 | 状态 | 为什么排这里 |
| --- | --- | --- | --- |
| 1 | `GET /api/config` + 契约测试 **#1、#2、#27** | ✅ | **唯一现在就在流血的**，且不依赖任何其他改动。三条测试都只依赖 config 路由：#1 守 contractVersion 与 `no-store`，#2 守 `scoringAvailable`，#27 是那条**跨层一致性**断言——原文此处误写成「清单 #1」，一致性测试是 #27 |
| 2 | v4 迁移 + `META_KEYS` | ✅ | 表结构最难改，后面 3–5 全依赖它 |
| 3 | `POST /api/materials` + 列表 / 详情 | ✅ | 分配 `sentenceId`，打通身份 |
| 4 | 录音音频 store（内容哈希，独立目录）+ 落盘顺序 [C67] | ✅ | assess 落库的前置。原子写抽成共享函数，见决策 0043 |
| 5 | `POST /api/assess` 改造 + 落库 + `persisted` 语义 | ✅ | **F12 已关闭**：练一次，四张表各多一行 |
| 6 | 客户端跟上（§13 那九条） | 🔨 | 依赖 1–5 全部就位。第 9 条（改用 `Ms` 字段）已随第 5 步一起做了，否则界面会读到不存在的字段 |
