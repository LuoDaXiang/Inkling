import { describe, test, expect } from "vitest";
import { classify, toTtsError, TtsError } from "@/core/tts/errors";
import type { TtsErrorKind } from "@/core/tts/errors";

/**
 * 错误分类决定了程序的行为：重试、提示改配置、还是引导充值。
 * 分错了比不分更糟——对着一个密钥错误重试 10 次，用户等 30 秒才看到错。
 *
 * 各家 SDK 的错误对象长得都不一样，所以分类器要认三种线索，
 * 每种线索都要有测试。
 */

const expectKind = (err: unknown, kind: TtsErrorKind): void => {
  expect(classify(err)).toBe(kind);
};

describe("classify", () => {
  describe("线索一：HTTP 状态码", () => {
    const CASES: Array<[status: number, kind: TtsErrorKind]> = [
      [400, "rejected"],
      [401, "auth"],
      [402, "quota"],
      [403, "auth"],
      [422, "rejected"],
      [429, "quota"],
      [500, "network"],
      [502, "network"],
      [503, "network"],
    ];

    for (const [status, kind] of CASES) {
      test(`${status} → ${kind}`, () => {
        expectKind({ status }, kind);
      });
    }

    test("statusCode 字段也认（不同 SDK 用不同字段名）", () => {
      expectKind({ statusCode: 429 }, "quota");
    });

    test("404 不属于已知分类", () => {
      expectKind({ status: 404 }, "unknown");
    });
  });

  describe("线索二：Node errno", () => {
    const CODES = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "ECONNABORTED",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ];

    for (const code of CODES) {
      test(`${code} → network`, () => {
        expectKind(Object.assign(new Error("x"), { code }), "network");
      });
    }

    test("大小写不敏感", () => {
      expectKind(Object.assign(new Error("x"), { code: "econnreset" }), "network");
    });

    test("无关的 errno 不误判", () => {
      expectKind(Object.assign(new Error("x"), { code: "ENOENT" }), "unknown");
    });
  });

  describe("线索三：错误文案", () => {
    const CASES: Array<[message: string, kind: TtsErrorKind]> = [
      ["Unauthorized", "auth"],
      ["Invalid API key provided", "auth"],
      ["Incorrect authentication credentials", "auth"],
      ["Forbidden", "auth"],
      ["You exceeded your current quota", "quota"],
      ["Rate limit reached for requests", "quota"],
      ["Too many requests", "quota"],
      ["Insufficient credits", "quota"],
      ["Input too long", "too_long"],
      ["Text exceeds the maximum length", "too_long"],
      ["Request timed out", "network"],
      ["fetch failed", "network"],
      ["socket hang up", "network"],
      ["Connection closed unexpectedly", "network"],
    ];

    for (const [message, kind] of CASES) {
      test(`"${message}" → ${kind}`, () => {
        expectKind(new Error(message), kind);
      });
    }

    test("大小写不敏感", () => {
      expectKind(new Error("INVALID API KEY"), "auth");
    });

    test("认不出来的文案归入 unknown", () => {
      expectKind(new Error("something went sideways"), "unknown");
    });
  });

  describe("优先级：状态码盖过文案", () => {
    test("401 加上像超时的文案，仍判为 auth", () => {
      // 否则会去重试一个永远不会成功的请求
      expectKind({ status: 401, message: "connection timed out" }, "auth");
    });
  });

  describe("退化输入", () => {
    test("null", () => expectKind(null, "unknown"));
    test("undefined", () => expectKind(undefined, "unknown"));
    test("字符串", () => expectKind("boom", "unknown"));
    test("数字", () => expectKind(42, "unknown"));
    test("空对象", () => expectKind({}, "unknown"));
    test("没有 message 的 Error", () => expectKind(new Error(), "unknown"));

    test("含有关键词的字符串也能认出来", () => {
      expectKind("Rate limit exceeded", "quota");
    });
  });

  describe("已经是 TtsError 的原样返回", () => {
    test("保留原分类，不重新判断", () => {
      const err = new TtsError("empty", "空音频");
      expectKind(err, "empty");
    });
  });
});

describe("retryable", () => {
  const EXPECTATIONS: Array<[kind: TtsErrorKind, retryable: boolean]> = [
    ["network", true],
    ["auth", false],
    ["quota", false],
    ["rejected", false],
    ["too_long", false],
    ["empty", false],
    ["unknown", false],
  ];

  for (const [kind, retryable] of EXPECTATIONS) {
    test(`${kind} → ${retryable ? "可重试" : "不可重试"}`, () => {
      expect(new TtsError(kind, "x").retryable).toBe(retryable);
    });
  }

  test("unknown 保守地不重试", () => {
    // 不知道重试是否安全时，宁可让用户看到错误，也不要盲目重发请求
    expect(new TtsError("unknown", "x").retryable).toBe(false);
  });
});

describe("toTtsError", () => {
  test("包装普通错误并保留分类", () => {
    const err = toTtsError({ status: 429, message: "slow down" }, "合成失败");

    expect(err).toBeInstanceOf(TtsError);
    expect(err.kind).toBe("quota");
    expect(err.message).toContain("合成失败");
    expect(err.message).toContain("slow down");
  });

  test("保留原始错误在 cause 上，便于排查", () => {
    const original = new Error("boom");
    const err = toTtsError(original, "上下文");

    expect(err.cause).toBe(original);
  });

  test("已经是 TtsError 的不重复包装", () => {
    const original = new TtsError("empty", "空音频");
    const err = toTtsError(original, "上下文");

    expect(err).toBe(original);
    expect(err.message).toBe("空音频");
  });

  test("非 Error 值也能包装", () => {
    const err = toTtsError("裸字符串", "上下文");

    expect(err).toBeInstanceOf(TtsError);
    expect(err.message).toContain("裸字符串");
  });
});
