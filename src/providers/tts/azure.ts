import type { TtsProvider, TtsRequest, TtsResult } from "./types";
import { ServiceError, classify } from "@/core/errors";
import { buildSsml } from "./ssml";
import {
  fetchWithTimeout,
  requestIdOf,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
} from "@/core/http/fetch-like";

export type { FetchLike };

/**
 * Azure 语音服务的 TTS 实现，走 REST 接口。
 *
 * 为什么用 REST 而不是官方 SDK：
 *   - 零依赖，用 Node 自带的 fetch
 *   - 错误是标准 HTTP 状态码，直接对上我们已有的 classify()；
 *     SDK 会把错误包成自己的 CancellationDetails，还要再翻译一层
 *   - fetch 可以注入，整个 provider 不联网就能测
 *
 * 代价：REST 拿不到词/句边界的时间戳事件（那需要 SDK 的 WebSocket）。
 * 我们按句合成、按句缓存，暂时不需要句边界；将来做逐词高亮时再评估。
 *
 * 接口文档：https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech
 */

/** 只列 RIFF（WAV）格式——我们的 parseWav 只认这个。 */
export const AZURE_WAV_FORMATS = {
  "riff-16khz-16bit-mono-pcm": 16000,
  "riff-22050hz-16bit-mono-pcm": 22050,
  "riff-24khz-16bit-mono-pcm": 24000,
  "riff-44100hz-16bit-mono-pcm": 44100,
  "riff-48khz-16bit-mono-pcm": 48000,
} as const;

export type AzureWavFormat = keyof typeof AZURE_WAV_FORMATS;

export interface AzureTtsConfig {
  key: string;
  region: string;
  outputFormat?: AzureWavFormat;
  /**
   * 单次请求的字符上限。
   *
   * 注意：这不是 Azure 文档里的字符限制——官方只写了「音频超过 10 分钟会被截断」，
   * 没有给出字符数上限。这里的默认值是我们自己设的保守闸门，用途是在跟读场景里
   * 拦住异常长的输入，而不是贴着服务端的真实上限走。
   */
  maxChars?: number;
  userAgent?: string;
  /**
   * 请求超时（毫秒）。
   *
   * 必须有。实测过服务端会在某些输入下**不返回响应头**，
   * 没有显式超时的话一个坏输入能把请求链挂住。
   */
  timeoutMs?: number;
  /** 注入点：测试传假 fetch，生产用全局 fetch。 */
  fetch?: FetchLike;
}

const DEFAULT_FORMAT: AzureWavFormat = "riff-24khz-16bit-mono-pcm";
const DEFAULT_MAX_CHARS = 3000;
const DEFAULT_USER_AGENT = "Inkling";

export class AzureTtsProvider implements TtsProvider {
  readonly engine = "azure";
  readonly model: string;
  readonly maxChars: number;

  private readonly key: string;
  private readonly endpoint: string;
  private readonly outputFormat: AzureWavFormat;
  private readonly sampleRate: number;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: AzureTtsConfig) {
    // 配置错误要在构造时就炸，而不是等到第一次合成才发现。
    if (!config.key?.trim()) {
      throw new ServiceError("auth", "Azure key 未配置");
    }
    if (!config.region?.trim()) {
      throw new ServiceError("auth", "Azure region 未配置");
    }

    const format = config.outputFormat ?? DEFAULT_FORMAT;
    if (!(format in AZURE_WAV_FORMATS)) {
      throw new ServiceError("rejected", `不支持的输出格式：${format}`);
    }

    this.key = config.key.trim();
    const region = config.region.trim().toLowerCase();
    this.endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    this.outputFormat = format;
    this.sampleRate = AZURE_WAV_FORMATS[format];
    this.model = format;
    this.maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;
    this.userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const ssml = buildSsml({
      text: request.text,
      voice: request.voice,
      speed: request.speed,
    });

    let response;
    try {
      response = await fetchWithTimeout(
        this.fetchImpl,
        this.endpoint,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": this.key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": this.outputFormat,
            "User-Agent": this.userAgent,
          },
          body: ssml,
        },
        this.timeoutMs,
      );
    } catch (err) {
      // 超时已经被 fetchWithTimeout 包成 ServiceError，原样抛出。
      if (err instanceof ServiceError) throw err;
      // 其余 fetch 抛错 = 连不上，一律算网络问题（可重试）
      throw new ServiceError("network", `Azure 请求失败：${describe(err)}`, { cause: err });
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      // RequestId 是报障时唯一能给服务商的凭据，务必带上。
      const id = requestIdOf(response);
      throw new ServiceError(
        classify({ status: response.status, message: detail }),
        `Azure 返回 ${response.status}${detail ? `：${detail}` : ""}` +
          (id ? `（RequestId ${id}）` : ""),
      );
    }

    const buffer = await response.arrayBuffer();
    const audio = new Uint8Array(buffer);

    // 200 不代表结果可用。空响应体要当失败，否则会存下一个播不出声的文件。
    if (audio.byteLength === 0) {
      throw new ServiceError("empty", "Azure 返回 200 但响应体为空");
    }

    return { audio, format: "wav", sampleRate: this.sampleRate };
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
