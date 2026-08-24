import { ServiceError } from "@/core/errors";

/**
 * 可注入的 fetch 契约。
 *
 * 整个项目对网络的依赖只有这一个类型。provider 接收它作为参数，
 * 测试塞假实现进去——不联网、不花钱、不等待就能走遍每一条路径，
 * 包括 401、429、502 这些平时根本制造不出来的情况。
 *
 * 相比原来 TTS 那版多了两样东西，两样都是实测逼出来的：
 *
 *   headers  429 会带 Retry-After，所有响应带 X-RequestId（报障时的唯一凭据）。
 *            原来的假 fetch 没有 headers 字段，于是这两个都表达不了，
 *            也就没人会想到去写处理它们的代码。
 *
 *   signal   实测约 13000 字符的参考文本会让服务端**不返回响应头**，
 *            客户端一直等到默认超时。没有显式超时的话，一个坏输入
 *            能把请求链挂住。
 */

export interface FetchResponse {
  ok: boolean;
  status: number;
  /**
   * 响应头。取值大小写不敏感——真实 fetch 的 Headers 就是这样，
   * 假实现必须照做，否则测试通过而生产取不到值。
   */
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

/** 默认超时。合成 30 秒音频实测约 3 秒，20 秒留了足够余量。 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 带超时的请求。
 *
 * 超时归入 network 分类——它是可重试的，和「密钥错」「额度尽」不同。
 * 这一点必须对：把超时判成不可重试，一次网络抖动就让用户白读一遍。
 */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: Omit<FetchInit, "signal">,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    // AbortError 是我们自己触发的，要翻译成有意义的错误。
    // 直接抛原始错误的话，用户看到的是「The operation was aborted」，
    // 既不知道是超时，也不知道等了多久。
    if (isAbortError(err)) {
      throw new ServiceError("network", `请求超过 ${timeoutMs / 1000} 秒未响应`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  );
}

/**
 * 从 429 响应里读出该等多久。
 *
 * Retry-After 有两种合法形态：秒数，或 HTTP 日期。两种都要认——
 * 只认秒数的话，遇到日期形态会静默退化成默认退避，而默认退避
 * 可能远短于服务端要求的时间，结果是连续撞限流。
 *
 * 返回毫秒；读不出来返回 null，由调用方决定默认退避。
 */
export function retryAfterMs(response: FetchResponse, now: number = Date.now()): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 形态一：秒数。规范只允许非负整数。
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  // 形态二：HTTP 日期。
  //
  // 这里必须先排除「看起来像数字但不合法」的输入。Date.parse 很宽松，
  // "-5" 会被当成公元前 5 年、"1.5" 会被当成 2001 年——两者都能解析成功，
  // 于是一个不合法的 Retry-After 会变成一个巨大的等待时间。
  // 测试第一版就是这么抓到的。
  if (/^[+-]?[\d.]/.test(trimmed)) return null;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;

  // 服务端时钟可能比我们快，算出负数时按 0 处理而不是当作读取失败——
  // 头存在就说明服务端确实在限流，只是时间已经过了。
  return Math.max(0, at - now);
}

/** 报障时唯一能给服务商的凭据。取不到就返回 null，不要编一个。 */
export function requestIdOf(response: FetchResponse): string | null {
  return (
    response.headers.get("x-requestid") ??
    response.headers.get("apim-request-id") ??
    response.headers.get("x-request-id")
  );
}
