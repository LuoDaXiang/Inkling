/**
 * 外部服务的错误分类。
 *
 * 「失败了」不是有用的信息。有用的是「哪一种失败」，因为每一种的处置不同：
 *   auth      —— 密钥错，重试一万次也没用，要提示用户去改配置
 *   quota     —— 额度用完，重试没用，Stage 3 要引导充值
 *   network   —— 网络抖动，应该重试
 *   rejected  —— 内容被服务商拒绝，要提示用户改文本
 *   too_long  —— 输入超过服务上限，应该先拆分再重试
 *   empty     —— 调用成功但结果是空的。最阴险的一种：不报错，但结果不可用
 */

export type ServiceErrorKind =
  | "auth"
  | "quota"
  | "network"
  | "rejected"
  | "too_long"
  | "empty"
  | "unknown";

/** 只有这一种重试有意义，其余重试只是浪费时间和额度。 */
const RETRYABLE: ReadonlySet<ServiceErrorKind> = new Set<ServiceErrorKind>(["network"]);

export class ServiceError extends Error {
  readonly kind: ServiceErrorKind;

  constructor(kind: ServiceErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ServiceError";
    this.kind = kind;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

interface HttpLike {
  status?: number;
  statusCode?: number;
  code?: string;
  message?: string;
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * 把各家 SDK 五花八门的错误对象归到我们自己的分类上。
 * 只认三种线索：HTTP 状态码、Node 的 errno 字符串、错误文案。
 * 三种都认不出来才归入 unknown —— unknown 不重试，因为不知道重试是否安全。
 */
export function classify(err: unknown): ServiceErrorKind {
  if (err instanceof ServiceError) return err.kind;
  if (err === null || err === undefined) return "unknown";

  const e = err as HttpLike;
  const status = e.status ?? e.statusCode;

  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota";
  // 415 是我们自己发错了 Content-Type，重试没用，归入 rejected
  if (status === 400 || status === 415 || status === 422) return "rejected";
  if (typeof status === "number" && status >= 500) return "network";

  const code = typeof e.code === "string" ? e.code.toUpperCase() : "";
  if (NETWORK_CODES.has(code)) return "network";

  const msg = (e.message ?? String(err)).toLowerCase();
  if (/unauthorized|invalid api key|invalid key|forbidden|authentication/.test(msg)) {
    return "auth";
  }
  if (/quota|rate limit|too many requests|insufficient|exceeded your current/.test(msg)) {
    return "quota";
  }
  if (/too long|maximum length|exceeds the maximum|input too large/.test(msg)) {
    return "too_long";
  }
  if (/timeout|timed out|network|socket hang up|fetch failed|connection/.test(msg)) {
    return "network";
  }

  return "unknown";
}

/**
 * 提取可读的错误信息。
 *
 * 不能只用 String(err)：很多 SDK 抛的是普通对象而不是 Error 实例，
 * String({status: 429, message: "slow down"}) 会得到 "[object Object]"，
 * 用户看到的报错里一点有用信息都没有。
 */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const e = err as HttpLike;
    if (typeof e.message === "string" && e.message) return e.message;
    const status = e.status ?? e.statusCode;
    if (typeof status === "number") return `HTTP ${status}`;
    try {
      return JSON.stringify(err);
    } catch {
      return "[无法序列化的错误对象]";
    }
  }
  return String(err);
}

export function toServiceError(err: unknown, context: string): ServiceError {
  if (err instanceof ServiceError) return err;
  return new ServiceError(classify(err), `${context}: ${describe(err)}`, { cause: err });
}

/**
 * 旧名字，保留为别名。
 *
 * 这一层从来就没有一处和 TTS 有关——它只认 HTTP 状态码、Node errno、
 * 错误文案三种线索。名字里的 Tts 是当初唯一的消费者留下的痕迹。
 *
 * 别名的作用是让搬家这件事**可验证**：434 个老用例一行不改就能跑，
 * 说明当初的抽象真的是 provider 无关的。如果搬完必须大改调用方，
 * 那就说明抽象漏了——那才是需要处理的问题。
 *
 * 新代码一律用 ServiceError。这些别名等评分层落地后再清。
 */
export const TtsError = ServiceError;
export type TtsError = ServiceError;
export type TtsErrorKind = ServiceErrorKind;
export const toTtsError = toServiceError;
