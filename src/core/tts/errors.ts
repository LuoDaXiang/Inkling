/**
 * TTS 错误分类。
 *
 * 「失败了」不是有用的信息。有用的是「哪一种失败」，因为每一种的处置不同：
 *   auth      —— 密钥错，重试一万次也没用，要提示用户去改配置
 *   quota     —— 额度用完，重试没用，Stage 3 要引导充值
 *   network   —— 网络抖动，应该重试
 *   rejected  —— 内容被服务商拒绝，要提示用户改文本
 *   too_long  —— 文本超过模型上限，应该先拆分再重试
 *   empty     —— 调用成功但音频是空的。最阴险的一种：不报错，但结果不可用
 */

export type TtsErrorKind =
  | "auth"
  | "quota"
  | "network"
  | "rejected"
  | "too_long"
  | "empty"
  | "unknown";

/** 只有这一种重试有意义，其余重试只是浪费时间和额度。 */
const RETRYABLE: ReadonlySet<TtsErrorKind> = new Set<TtsErrorKind>(["network"]);

export class TtsError extends Error {
  readonly kind: TtsErrorKind;

  constructor(kind: TtsErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TtsError";
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
export function classify(err: unknown): TtsErrorKind {
  if (err instanceof TtsError) return err.kind;
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

export function toTtsError(err: unknown, context: string): TtsError {
  if (err instanceof TtsError) return err;
  return new TtsError(classify(err), `${context}: ${describe(err)}`, { cause: err });
}
