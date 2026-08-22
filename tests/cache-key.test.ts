import { describe, test, expect } from "vitest";
import { cacheKey } from "@/core/tts/cache-key";

/**
 * 缓存键的两条性质，方向相反，都必须成立：
 *   稳定性 —— 不影响发音的差异必须命中同一个键（否则白花钱重复生成）
 *   区分性 —— 影响发音的差异必须产生不同的键（否则播出错误的音频）
 *
 * 第二条出错比第一条严重得多：用户点了 A 音色，听到的却是 B 音色的旧缓存。
 */

const base = {
  text: "Hello world.",
  engine: "kokoro",
  model: "kokoro-82m",
  voice: "af_heart",
};

describe("cacheKey", () => {
  test("返回 64 位十六进制（sha256）", () => {
    expect(cacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  describe("稳定性：这些差异应该命中同一个键", () => {
    const SAME: Array<[name: string, text: string]> = [
      ["首尾空格", "  Hello world.  "],
      ["词间多空格", "Hello    world."],
      ["制表符代替空格", "Hello\tworld."],
      ["换行代替空格", "Hello\nworld."],
      ["混合空白", " \t Hello \n  world. \t "],
    ];

    for (const [name, text] of SAME) {
      test(name, () => {
        expect(cacheKey({ ...base, text })).toBe(cacheKey(base));
      });
    }

    test("重复调用结果一致", () => {
      expect(cacheKey(base)).toBe(cacheKey(base));
    });

    test("speed 省略等同于 speed=1", () => {
      expect(cacheKey({ ...base, speed: 1 })).toBe(cacheKey(base));
    });
  });

  describe("区分性：这些差异必须产生不同的键", () => {
    const DIFFERENT: Array<[name: string, patch: Partial<typeof base> & { speed?: number }]> = [
      ["文本不同", { text: "Goodbye world." }],
      ["大小写不同", { text: "hello world." }],
      ["标点不同", { text: "Hello world!" }],
      ["末尾多一个句号", { text: "Hello world.." }],
      ["音色不同", { voice: "am_michael" }],
      ["模型不同", { model: "kokoro-82m-v2" }],
      ["引擎不同", { engine: "azure" }],
      ["语速不同", { speed: 0.8 }],
    ];

    for (const [name, patch] of DIFFERENT) {
      test(name, () => {
        expect(cacheKey({ ...base, ...patch })).not.toBe(cacheKey(base));
      });
    }
  });

  describe("字段边界不能串味", () => {
    // 如果用普通字符（比如冒号）拼接字段，这两组会拼成同一个字符串
    test("文本尾部与引擎头部的切分不能混淆", () => {
      const a = cacheKey({ ...base, text: "ab", engine: "cd" });
      const b = cacheKey({ ...base, text: "a", engine: "bcd" });

      expect(a).not.toBe(b);
    });

    test("音色与模型的切分不能混淆", () => {
      const a = cacheKey({ ...base, model: "xy", voice: "z" });
      const b = cacheKey({ ...base, model: "x", voice: "yz" });

      expect(a).not.toBe(b);
    });
  });

  describe("极端输入不崩", () => {
    test("空文本", () => {
      expect(cacheKey({ ...base, text: "" })).toMatch(/^[0-9a-f]{64}$/);
    });

    test("超长文本", () => {
      expect(cacheKey({ ...base, text: "a".repeat(100_000) })).toMatch(/^[0-9a-f]{64}$/);
    });

    test("emoji 与中日文", () => {
      expect(cacheKey({ ...base, text: "🍕 这是测试 テスト" })).toMatch(/^[0-9a-f]{64}$/);
    });

    test("代理对不会被截断（emoji 是两个 UTF-16 码元）", () => {
      expect(cacheKey({ ...base, text: "🍕" })).not.toBe(
        cacheKey({ ...base, text: "🍔" }),
      );
    });
  });
});
