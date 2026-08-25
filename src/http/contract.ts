import { MAX_ASSESSABLE_SECONDS } from "@/core/audio/wav";
import { MAX_REFERENCE_CHARS } from "@/providers/scoring/config";

/**
 * 客户端契约的共享常量与 `GET /api/config` 的响应构造。
 *
 * 见 `docs/api-contract.md` §4。这个文件是**共享常量的唯一来源**。
 *
 * ## 为什么要有这个文件
 *
 * 录音采样率和最长秒数此前是两边各硬编码一份，而**没有一条测试看过客户端那一份**。
 *
 * 服务端那一侧其实被既有测试用字面量钉着（变异实测：改采样率红 1 条，
 * 改秒数红 7 条）。但反方向——改客户端那份 16000——**全绿**。
 * 而那恰恰是更容易发生的方向：改前端的人不会去跑服务端测试。
 * 后果是时长算错、修剪切错、计费算错，而且不报错。
 *
 * 解法不是加一条断言，是消灭这一整类问题：服务端成为唯一来源，客户端启动时取。
 *
 * ## 一条硬约束
 *
 * **这里的值要么自己持有，要么 import 求值，绝不重新写一遍字面量。**
 *
 * `maxReferenceChars` 是最容易踩的：它是派生量
 * （`MAX_ASSESSABLE_SECONDS × CHARS_PER_SECOND × HEADROOM`，当前求值 900），
 * 不是自由常量。在这里写死 `900`，有人调整 30 秒上限时它会**静默错位**——
 * 那就不是在消灭分叉，是在制造第三份拷贝。
 */

/**
 * 契约版本。
 *
 * 适用条件是「客户端与服务端同仓库、同版本发布，全系统只有一个客户端」。
 * 这个字段让那个假设**可被检测**：客户端启动时发现不匹配，必须明确报错并停止，
 * 而不是继续以诡异的方式工作。声明一个假设而不给检测手段，等于没有假设。
 *
 * 客户端会内置一份自己的副本——这份重复是**刻意的**，正是比对的两端。
 */
export const CONTRACT_VERSION = "v0";

/**
 * 请求体上限。框架会替你做这件事，手写就得自己做。
 *
 * 按路由分开，因为两类请求的量级差三个数量级：
 *
 *   JSON  一段待合成的文本，几 KB 顶天
 *   音频  16kHz 单声道 16bit = 32,000 字节/秒，30 秒就是 960KB
 *
 * 之前只有一个 64KB 的常量，当时脑子里想的是 JSON。等 M03 上传录音时，
 * **任何超过 2 秒的录音都会被自己的服务器拒掉**——而错误信息会说
 * 「请求体过大」，看不出真正的原因。趁还没写录音路由先分开。
 */
export const MAX_JSON_BYTES = 64 * 1024;

/** 30 秒 16kHz 单声道音频约 960KB，留一点余量。 */
export const MAX_AUDIO_BYTES = 1024 * 1024;

/**
 * 录音上传的上限。
 *
 * 浏览器发的是**原始 Float32 采样**，不是编码好的 WAV——因为转换、
 * 修剪、编码这三步都在服务端做，那里有 171 个用例覆盖。浏览器层
 * 因此可以做到零业务逻辑，而它恰恰是唯一测不了的一层。
 *
 * 代价是上传体积翻倍：Float32 每采样 4 字节，30 秒 16kHz 是
 * 30 × 16000 × 4 = 1,920,000 字节。所以这个上限必须比 MAX_AUDIO_BYTES
 * 大一倍多。两个数字的关系有对账测试守着。
 */
export const MAX_PCM_BYTES = 2 * 1024 * 1024;

/**
 * 录音的采样率。
 *
 * 浏览器端和服务端必须一致，否则时长会算错。此前靠人记得，
 * 现在靠 `GET /api/config` 下发 + `tests/contract-consistency.test.ts` 盯着。
 */
export const RECORDING_SAMPLE_RATE = 16000;

/**
 * 材料标题上限。契约 §9 [C58]。
 *
 * 这里是它的唯一定义处——`POST /api/materials` 的校验直接用它，
 * 不要在校验代码里另写一个数。
 */
export const MAX_TITLE_CHARS = 200;

/**
 * 一份材料最多多少句。契约 §9 [C60]。
 *
 * 超过就让用户拆分材料，而不是默默截断。同上，唯一定义处。
 */
export const MAX_SENTENCES_PER_MATERIAL = 500;

/** `GET /api/config` 的响应。字段与顺序对应契约 §4。 */
export interface ContractConfig {
  contractVersion: string;
  recordingSampleRate: number;
  maxRecordingSeconds: number;
  maxUploadBytes: number;
  maxReferenceChars: number;
  maxTitleChars: number;
  maxSentencesPerMaterial: number;
  scoringAvailable: boolean;
}

/**
 * 构造 config 响应。
 *
 * `scoringAvailable` 是 [C5]：服务端一直知道评分没配，但此前没有任何办法
 * 告诉客户端——用户只能录完 30 秒再吃一个 503。
 */
export function buildConfig(options: { scoringAvailable: boolean }): ContractConfig {
  return {
    contractVersion: CONTRACT_VERSION,
    recordingSampleRate: RECORDING_SAMPLE_RATE,
    maxRecordingSeconds: MAX_ASSESSABLE_SECONDS,
    maxUploadBytes: MAX_PCM_BYTES,
    maxReferenceChars: MAX_REFERENCE_CHARS,
    maxTitleChars: MAX_TITLE_CHARS,
    maxSentencesPerMaterial: MAX_SENTENCES_PER_MATERIAL,
    scoringAvailable: options.scoringAvailable,
  };
}
