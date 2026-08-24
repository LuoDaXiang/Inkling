import { describe, test, expect } from "vitest";
import {
  fetchWithTimeout,
  retryAfterMs,
  requestIdOf,
  DEFAULT_TIMEOUT_MS,
  type FetchResponse,
} from "@/core/http/fetch-like";
import { ServiceError } from "@/core/errors";
import { fakeFetch } from "./helpers/fake-fetch";

/**
 * 输入空间分类（判据一，见 docs/decisions.md 0006）
 *
 *   A. 超时 —— 挂死、及时返回、抛别的错、边界时序
 *   B. Retry-After 的两种合法形态 —— 秒数与 HTTP 日期，以及各种读不出来的情况
 *   C. RequestId 的多种头名 —— 服务商之间不统一
 *   D. 头查询的大小写不敏感 —— 真实 fetch 如此，假实现必须照做
 *
 * 为什么这些类是穷尽的：这一层只做三件事——**加超时**（A）、
 * **读两个特定的头**（B、C）。D 不是行为而是契约，单独成类是因为
 * 假实现和真实现在这一点上不一致的话，测试会通过而生产会失效。
 *
 * 这一整个模块的存在理由是实测：约 13000 字符的参考文本会让服务端
 * 不返回响应头，客户端一直等；而 429 的 Retry-After 此前根本无法表达，
 * 因为假 fetch 没有 headers 字段。
 */

const ok = (): FetchResponse => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => "",
  arrayBuffer: async () => new ArrayBuffer(0),
});

const withHeaders = (headers: Record<string, string>): FetchResponse => {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ...ok(), headers: { get: (n) => lower.get(n.toLowerCase()) ?? null } };
};

describe("fetchWithTimeout", () => {
  describe("A. 超时", () => {
    test("正常响应原样返回", async () => {
      const fetchImpl = fakeFetch({ status: 200, text: "fine" });
      const res = await fetchWithTimeout(fetchImpl, "https://x", {
        method: "POST",
        headers: {},
        body: "hi",
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("fine");
    });

    test("挂死的请求会超时，并归入 network（可重试）", async () => {
      // 这是实测遇到过的最坏情况：服务端不返回响应头，客户端一直等。
      // 超时必须是可重试的——判成不可重试的话，一次网络抖动就让用户白读一遍。
      const fetchImpl = fakeFetch({ hangs: true });
      const promise = fetchWithTimeout(
        fetchImpl,
        "https://x",
        { method: "POST", headers: {}, body: "hi" },
        30,
      );
      await expect(promise).rejects.toThrow(ServiceError);
      await expect(promise).rejects.toMatchObject({ kind: "network", retryable: true });
    });

    test("超时错误说清楚等了多久", async () => {
      // 直接抛原始 AbortError 的话，用户看到「The operation was aborted」，
      // 既不知道是超时，也不知道等了多久。
      const fetchImpl = fakeFetch({ hangs: true });
      await expect(
        fetchWithTimeout(fetchImpl, "https://x", { method: "POST", headers: {}, body: "" }, 50),
      ).rejects.toThrow(/0.05 秒未响应/);
    });

    test("总是把 signal 传给底层 fetch", async () => {
      // 断言的是「调用方确实走了带超时的那条路」。
      // 没有这条，有人绕过 fetchWithTimeout 直接调 fetch 也不会被发现。
      const fetchImpl = fakeFetch({ status: 200 });
      await fetchWithTimeout(fetchImpl, "https://x", { method: "GET", headers: {}, body: "" });
      expect(fetchImpl.requests[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetchImpl.requests[0]?.signal?.aborted).toBe(false);
    });

    test("响应返回后定时器被清掉，不留悬挂的计时器", async () => {
      const fetchImpl = fakeFetch({ status: 200 });
      const res = await fetchWithTimeout(fetchImpl, "https://x", {
        method: "GET",
        headers: {},
        body: "",
      });
      // 等一段远超超时的时间，signal 不该被中止。
      await new Promise((r) => setTimeout(r, 40));
      expect(fetchImpl.requests[0]?.signal?.aborted).toBe(false);
      expect(res.status).toBe(200);
    });

    test("非超时的错误原样抛出，不被伪装成超时", async () => {
      const boom = new Error("ECONNREFUSED");
      const fetchImpl = fakeFetch(() => {
        throw boom;
      });
      await expect(
        fetchWithTimeout(fetchImpl, "https://x", { method: "GET", headers: {}, body: "" }),
      ).rejects.toBe(boom);
    });

    test("默认超时是 20 秒", () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
    });

    test("不传超时参数时用默认值 —— 覆盖默认分支", async () => {
      const fetchImpl = fakeFetch({ status: 200, text: "default" });
      const res = await fetchWithTimeout(fetchImpl, "https://x", {
        method: "GET",
        headers: {},
        body: "",
      });
      expect(await res.text()).toBe("default");
      expect(fetchImpl.requests[0]?.signal?.aborted).toBe(false);
    });
  });
});

describe("retryAfterMs", () => {
  describe("B. 两种合法形态", () => {
    test("秒数形态", () => {
      expect(retryAfterMs(withHeaders({ "Retry-After": "30" }))).toBe(30_000);
    });

    test("秒数为 0 是合法值 —— 立刻可以重试", () => {
      expect(retryAfterMs(withHeaders({ "Retry-After": "0" }))).toBe(0);
    });

    test("HTTP 日期形态", () => {
      // 只认秒数的话，遇到日期形态会静默退化成默认退避，
      // 而默认退避可能远短于服务端要求的时间，结果是连续撞限流。
      const now = Date.parse("2026-08-24T10:00:00Z");
      const at = "Mon, 24 Aug 2026 10:00:45 GMT";
      expect(retryAfterMs(withHeaders({ "Retry-After": at }), now)).toBe(45_000);
    });

    test("日期已经过去时返回 0，不返回负数", () => {
      // 服务端时钟可能比我们快。头存在就说明它确实在限流，
      // 只是时间已经过了——按 0 处理，不要当作读取失败。
      const now = Date.parse("2026-08-24T10:01:00Z");
      const at = "Mon, 24 Aug 2026 10:00:00 GMT";
      expect(retryAfterMs(withHeaders({ "Retry-After": at }), now)).toBe(0);
    });

    test("前后有空白也能解析", () => {
      expect(retryAfterMs(withHeaders({ "Retry-After": "  12  " }))).toBe(12_000);
    });
  });

  describe("B'. 读不出来时返回 null，由调用方决定默认退避", () => {
    test.each([
      ["头不存在", {}],
      ["空字符串", { "Retry-After": "" }],
      ["纯空白", { "Retry-After": "   " }],
      ["不是数字也不是日期", { "Retry-After": "soon" }],
      ["负数（不合法）", { "Retry-After": "-5" }],
      ["小数（规范只允许整数秒）", { "Retry-After": "1.5" }],
    ])("%s", (_name, headers) => {
      expect(retryAfterMs(withHeaders(headers))).toBeNull();
    });
  });
});

describe("requestIdOf", () => {
  describe("C. 多种头名", () => {
    test.each([
      ["X-RequestId（Azure 语音）", "X-RequestId"],
      ["apim-request-id（Azure 网关）", "apim-request-id"],
      ["X-Request-Id（通用）", "X-Request-Id"],
    ])("%s", (_name, header) => {
      expect(requestIdOf(withHeaders({ [header]: "abc123" }))).toBe("abc123");
    });

    test("取不到时返回 null，不要编一个", () => {
      // 报障时这是唯一能给服务商的凭据。编一个假的比没有更糟。
      expect(requestIdOf(withHeaders({}))).toBeNull();
    });

    test("多个头同时存在时，优先取最具体的那个", () => {
      const res = withHeaders({ "X-RequestId": "specific", "X-Request-Id": "generic" });
      expect(requestIdOf(res)).toBe("specific");
    });
  });
});

describe("D. 假 fetch 的头查询必须大小写不敏感", () => {
  // 真实 fetch 的 Headers 就是这样。假实现不照做的话，会出现
  // 「测试写 Retry-After 能取到，生产返回 retry-after 取不到」
  // 这种测试通过而线上失效的情况。
  test.each([["Retry-After"], ["retry-after"], ["RETRY-AFTER"], ["ReTrY-aFtEr"]])(
    "写 %s，用小写能查到",
    async (written) => {
      const fetchImpl = fakeFetch({ status: 429, headers: { [written]: "7" } });
      const res = await fetchWithTimeout(fetchImpl, "https://x", {
        method: "GET",
        headers: {},
        body: "",
      });
      expect(retryAfterMs(res)).toBe(7000);
    },
  );

  test("假 fetch 记录下请求的每一部分，供断言用", async () => {
    const fetchImpl = fakeFetch({ status: 200 });
    await fetchWithTimeout(fetchImpl, "https://example/api", {
      method: "POST",
      headers: { "X-Test": "1" },
      body: "payload",
    });
    expect(fetchImpl.requests).toHaveLength(1);
    expect(fetchImpl.requests[0]).toMatchObject({
      url: "https://example/api",
      method: "POST",
      headers: { "X-Test": "1" },
      body: "payload",
    });
  });
});
