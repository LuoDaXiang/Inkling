import type { FetchLike } from "@/providers/tts/azure";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeResponse {
  status?: number;
  /** 200 时返回的音频字节。 */
  audio?: Uint8Array;
  /** 非 200 时返回的错误文案。 */
  text?: string;
  /** 设置后，读取响应体时抛错，用来测「错误体读不出来」这条路径。 */
  bodyThrows?: boolean;
}

/**
 * 假 fetch。
 *
 * 有了它，Azure provider 的每一条路径都能在不联网、不花钱、不等待的
 * 前提下被走到——包括 401、429、502 这些平时根本制造不出来的情况。
 */
export function fakeFetch(
  responses: FakeResponse | FakeResponse[] | (() => never),
): FetchLike & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const queue = typeof responses === "function" ? [] : ([] as FakeResponse[]).concat(responses);

  const impl = (async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });

    if (typeof responses === "function") responses();

    const spec = queue.length > 1 ? queue.shift()! : (queue[0] ?? {});
    const status = spec.status ?? 200;

    return {
      ok: status >= 200 && status < 300,
      status,
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
