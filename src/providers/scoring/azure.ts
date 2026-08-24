import type {
  AssessmentRequest,
  AssessmentResult,
  ScoringProvider,
} from "./types";
import { ServiceError, classify } from "@/core/errors";
import { buildAssessmentHeader, MAX_REFERENCE_CHARS } from "./config";
import { parseAssessment } from "./parse";
import { parseWav, assertAssessable, MAX_ASSESSABLE_SECONDS } from "@/core/audio/wav";
import {
  fetchWithTimeout,
  requestIdOf,
  retryAfterMs,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
} from "@/core/http/fetch-like";

/**
 * Azure 发音评估，走 REST 接口。
 *
 * 和 TTS provider 同构：同样注入 fetch、同样复用 classify()、同样零依赖。
 * 理由见 docs/decisions.md 0010 与 0015。
 *
 * 三处刻意与 TTS 不同：
 *
 *   1. **不缓存。** TTS 的前提是「同样的文本必然产出同样的音频」，所以缓存省钱；
 *      评分的输入是每次都不同的录音，缓存永远不会命中。
 *
 *   2. **返回 null 而不是抛错**，当服务端没识别到语音时。用户确实录了一段
 *      没有语音的东西，这是要如实告诉他的结果，不是异常。
 *
 *   3. **送出前自己校验音频**。服务端会静默截断超长音频——73 秒的音频
 *      完整度只给 49，HTTP 200、状态 Success、没有任何警告。
 */

export interface AzureScoringConfig {
  key: string;
  region: string;
  /** 默认 en-US。语调评估目前只支持这个区域设置。 */
  language?: string;
  timeoutMs?: number;
  userAgent?: string;
  /** 注入点：测试传假 fetch，生产用全局 fetch。 */
  fetch?: FetchLike;
}

const DEFAULT_LANGUAGE = "en-US";
const DEFAULT_USER_AGENT = "Inkling";

export class AzureScoringProvider implements ScoringProvider {
  readonly engine = "azure";
  readonly maxSeconds = MAX_ASSESSABLE_SECONDS;
  readonly maxReferenceChars = MAX_REFERENCE_CHARS;

  private readonly key: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: AzureScoringConfig) {
    // 配置错误要在构造时就炸，而不是等到第一次评分才发现。
    if (!config.key?.trim()) {
      throw new ServiceError("auth", "Azure key 未配置");
    }
    if (!config.region?.trim()) {
      throw new ServiceError("auth", "Azure region 未配置");
    }

    const language = config.language ?? DEFAULT_LANGUAGE;
    // 语调只支持 en-US。用别的区域设置不会报错，只是 ProsodyScore 静默缺席——
    // 而语调是这个产品的主打维度，所以这里当场拒绝而不是让它悄悄降级。
    if (language !== DEFAULT_LANGUAGE) {
      throw new ServiceError(
        "rejected",
        `语调评估只支持 ${DEFAULT_LANGUAGE}，收到 ${language}。` +
          `换别的区域设置会让语调分静默缺席，而它是本项目的主打维度。`,
      );
    }

    this.key = config.key.trim();
    const region = config.region.trim().toLowerCase();
    this.endpoint =
      `https://${region}.stt.speech.microsoft.com` +
      `/speech/recognition/conversation/cognitiveservices/v1?language=${language}`;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async assess(request: AssessmentRequest): Promise<AssessmentResult | null> {
    // 1. 音频先自己验一遍。服务端会静默截断超长音频，等它返回一个
    //    莫名其妙的低完整度再去猜原因，是这个产品最难查的一类问题。
    const info = parseWav(request.audio);
    assertAssessable(info);

    // 2. 参考文本的校验在 buildAssessmentHeader 里做——空参考会触发
    //    无参考评估并返回一个看起来正常的高分，必须挡在送出之前。
    const assessmentHeader = buildAssessmentHeader({ reference: request.reference });

    let response;
    try {
      response = await fetchWithTimeout(
        this.fetchImpl,
        this.endpoint,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": this.key,
            // 采样率照实声明。服务端其实读 WAV 头、忽略这个值，
            // 但声明得对能在抓包排障时省掉一轮困惑。
            "Content-Type": `audio/wav; codecs=audio/pcm; samplerate=${info.sampleRate}`,
            "Pronunciation-Assessment": assessmentHeader,
            Accept: "application/json",
            "User-Agent": this.userAgent,
          },
          body: request.audio,
        },
        this.timeoutMs,
      );
    } catch (err) {
      // 超时已经被包成 ServiceError，原样抛。
      if (err instanceof ServiceError) throw err;
      throw new ServiceError("network", `Azure 评分请求失败：${describe(err)}`, { cause: err });
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      const id = requestIdOf(response);
      const wait = response.status === 429 ? retryAfterMs(response) : null;

      throw new ServiceError(
        classify({ status: response.status, message: detail }),
        `Azure 评分返回 ${response.status}${detail ? `：${detail}` : ""}` +
          (wait === null ? "" : `（${Math.ceil(wait / 1000)} 秒后可重试）`) +
          (id ? `（RequestId ${id}）` : ""),
      );
    }

    const body = await response.text();
    // 解析层负责区分「没识别到语音」（返回 null）和「响应结构坏掉」（抛错）。
    // 这两者混在一起的话，用户会为服务端的问题反复重录。
    return parseAssessment(body);
  }
}

/** 错误体可能很长或读取失败，都不能影响主流程抛出正确的错误类型。 */
async function readErrorBody(response: { text(): Promise<string> }): Promise<string> {
  try {
    const text = await response.text();
    return text.trim().slice(0, 300);
  } catch {
    return "";
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
