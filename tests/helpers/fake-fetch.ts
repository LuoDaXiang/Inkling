import type { FetchLike, FetchResponse } from "@/core/http/fetch-like";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
  /** 有没有传超时信号。没传就说明调用方绕过了 fetchWithTimeout。 */
  signal?: AbortSignal | undefined;
}

export interface FakeResponse {
  status?: number;
  /** 200 时返回的字节。 */
  audio?: Uint8Array;
  /** 响应体文本。非 200 时是错误文案，200 时可以是 JSON。 */
  text?: string;
  /** 响应头。键名大小写随意，查询时不敏感。 */
  headers?: Record<string, string>;
  /** 设置后，读取响应体时抛错，用来测「错误体读不出来」这条路径。 */
  bodyThrows?: boolean;
  /**
   * 设置后，这次请求永不 resolve，只在 signal 中止时抛 AbortError。
   *
   * 模拟的是实测遇到过的最坏情况：服务端不返回响应头，客户端一直等。
   * 原来的假 fetch 表达不了这个形态，于是超时这条路径从来没被测过。
   */
  hangs?: boolean;
}

/**
 * 假 fetch。
 *
 * 有了它，provider 的每一条路径都能在不联网、不花钱、不等待的前提下
 * 被走到——包括 401、429、502、超时这些平时根本制造不出来的情况。
 *
 * 相比第一版多了三样，都是实测逼出来的：
 *
 *   headers  429 的 Retry-After、所有响应的 X-RequestId。没有这个字段时，
 *            这两样都表达不了，也就没人会想到写处理它们的代码。
 *   hangs    服务端不返回响应头这一形态，超时路径靠它才测得了。
 *   signal   记录下来，用于断言调用方确实走了带超时的那条路。
 */
export function fakeFetch(
  responses: FakeResponse | FakeResponse[] | (() => never),
): FetchLike & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const queue = typeof responses === "function" ? [] : ([] as FakeResponse[]).concat(responses);

  const impl = (async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });

    if (typeof responses === "function") responses();

    const spec = queue.length > 1 ? queue.shift()! : (queue[0] ?? {});

    if (spec.hangs) return hangUntilAborted(init.signal);

    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: headersOf(spec.headers ?? {}),
      async text() {
        if (spec.bodyThrows) throw new Error("body read failed");
        return spec.text ?? "";
      },
      async arrayBuffer() {
        if (spec.bodyThrows) throw new Error("body read failed");
        const audio = spec.audio ?? new Uint8Array([1, 2, 3, 4]);
        return audio.buffer.slice(
          audio.byteOffset,
          audio.byteOffset + audio.byteLength,
        ) as ArrayBuffer;
      },
    };
  }) as FetchLike & { requests: RecordedRequest[] };

  impl.requests = requests;
  return impl;
}

/**
 * 真实 fetch 的 Headers 查询是大小写不敏感的，假实现必须照做。
 * 否则会出现「测试写 Retry-After 能取到，生产返回 retry-after 取不到」
 * 这种测试通过而线上失效的情况。
 */
function headersOf(raw: Record<string, string>): FetchResponse["headers"] {
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) lower.set(key.toLowerCase(), value);
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

/** 永不 resolve，只在中止时抛出和真实 fetch 同形状的 AbortError。 */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return; // 没有信号就真的永远挂着——正好暴露「忘了传超时」
    if (signal.aborted) return reject(abortError());
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}
