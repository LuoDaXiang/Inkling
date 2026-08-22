import { describe, test, expect, beforeEach } from "vitest";
import { synthesize } from "@/core/tts/synthesize";
import { TtsError } from "@/core/tts/errors";
import { MemoryAudioStore } from "@/storage/audio-store";
import { FakeTtsProvider } from "./helpers/fake-provider";

/**
 * 这份测试完全不联网、不写磁盘、不装模型，却覆盖了 TTS 功能的全部决策逻辑。
 * 能做到这一点，只因为 synthesize() 的两个外部依赖都是参数传进来的。
 *
 * 分支覆盖清单（synthesize() 里每个 if 都要有测试走到）：
 *   1. 空文本      → rejected
 *   2. 超长文本    → too_long
 *   3. 缓存命中    → 不调用 provider
 *   4. provider 抛错 → 归类后抛出
 *   5. 空音频      → empty
 *   6. 正常路径    → 落盘
 */

describe("synthesize", () => {
  let provider: FakeTtsProvider;
  let store: MemoryAudioStore;

  beforeEach(() => {
    provider = new FakeTtsProvider({ maxChars: 100 });
    store = new MemoryAudioStore();
  });

  const req = { text: "Hello world.", voice: "af_heart" };
  const deps = () => ({ provider, store });

  describe("正常路径", () => {
    test("返回存储结果且标记为非缓存", async () => {
      const result = await synthesize(req, deps());

      expect(result.cached).toBe(false);
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.format).toBe("wav");
      expect(result.key).toMatch(/^[0-9a-f]{64}$/);
    });

    test("provider 收到的是去掉首尾空白的文本", async () => {
      await synthesize({ ...req, text: "  Hello world.  " }, deps());

      expect(provider.calls[0]?.text).toBe("Hello world.");
    });

    test("存进去的字节就是 provider 返回的字节", async () => {
      provider.nextAudio = new Uint8Array([1, 2, 3, 4, 5]);

      const result = await synthesize(req, deps());

      expect(Array.from(store.raw(result.key)!)).toEqual([1, 2, 3, 4, 5]);
    });

    test("语速被透传给 provider", async () => {
      await synthesize({ ...req, speed: 0.8 }, deps());

      expect(provider.calls[0]?.speed).toBe(0.8);
    });
  });

  describe("缓存", () => {
    test("第二次相同请求命中缓存，不再调用 provider", async () => {
      const first = await synthesize(req, deps());
      const second = await synthesize(req, deps());

      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.key).toBe(first.key);
      // 这一条是整个缓存机制的核心断言：省钱靠它
      expect(provider.callCount).toBe(1);
    });

    test("只有空白差异的文本命中同一份缓存", async () => {
      await synthesize({ ...req, text: "Hello   world." }, deps());
      const second = await synthesize({ ...req, text: "Hello world." }, deps());

      expect(second.cached).toBe(true);
      expect(provider.callCount).toBe(1);
    });

    test("换音色不命中缓存", async () => {
      await synthesize(req, deps());
      const second = await synthesize({ ...req, voice: "am_michael" }, deps());

      expect(second.cached).toBe(false);
      expect(provider.callCount).toBe(2);
      expect(store.size).toBe(2);
    });

    test("换语速不命中缓存", async () => {
      await synthesize(req, deps());
      const second = await synthesize({ ...req, speed: 0.8 }, deps());

      expect(second.cached).toBe(false);
      expect(provider.callCount).toBe(2);
    });

    test("换引擎不命中缓存", async () => {
      await synthesize(req, deps());

      const other = new FakeTtsProvider({ engine: "other", maxChars: 100 });
      const second = await synthesize(req, { provider: other, store });

      expect(second.cached).toBe(false);
      expect(store.size).toBe(2);
    });

    test("大小写不同视为不同文本（发音确实不同）", async () => {
      await synthesize({ ...req, text: "hello world." }, deps());
      const second = await synthesize({ ...req, text: "Hello world." }, deps());

      expect(second.cached).toBe(false);
    });
  });

  describe("拒绝：不该送到 provider 的输入", () => {
    const REJECTED: Array<[name: string, text: string]> = [
      ["空字符串", ""],
      ["纯空格", "     "],
      ["纯制表符", "\t\t"],
      ["纯换行", "\n\n"],
    ];

    for (const [name, text] of REJECTED) {
      test(`${name} 抛 rejected 且不调用 provider`, async () => {
        await expect(synthesize({ ...req, text }, deps())).rejects.toThrow(TtsError);
        // 关键：不能白花一次额度
        expect(provider.callCount).toBe(0);
      });
    }

    test("空文本的错误类型是 rejected", async () => {
      await expect(synthesize({ ...req, text: "" }, deps())).rejects.toMatchObject({
        kind: "rejected",
      });
    });
  });

  describe("超长：必须拒绝，不能静默截断", () => {
    test("超过 maxChars 抛 too_long 且不调用 provider", async () => {
      const long = "a".repeat(101);

      await expect(synthesize({ ...req, text: long }, deps())).rejects.toMatchObject({
        kind: "too_long",
      });
      expect(provider.callCount).toBe(0);
    });

    test("恰好等于 maxChars 可以通过（边界值）", async () => {
      const exact = "a".repeat(100);

      const result = await synthesize({ ...req, text: exact }, deps());

      expect(result.cached).toBe(false);
      expect(provider.callCount).toBe(1);
    });

    test("长度按去空白后计算", async () => {
      const padded = "  " + "a".repeat(100) + "  ";

      await expect(synthesize({ ...req, text: padded }, deps())).resolves.toBeDefined();
    });

    test("too_long 不可重试", async () => {
      const long = "a".repeat(101);

      await synthesize({ ...req, text: long }, deps()).catch((err: TtsError) => {
        expect(err.retryable).toBe(false);
      });
      expect.assertions(1);
    });
  });

  describe("失败：provider 抛错", () => {
    const FAILURES: Array<[name: string, err: unknown, kind: string, retryable: boolean]> = [
      ["401 密钥错", { status: 401, message: "Unauthorized" }, "auth", false],
      ["429 额度用尽", { status: 429, message: "Too Many Requests" }, "quota", false],
      ["500 服务端错误", { status: 500, message: "Internal Error" }, "network", true],
      ["连接被重置", Object.assign(new Error("socket"), { code: "ECONNRESET" }), "network", true],
      ["400 内容被拒", { status: 400, message: "Bad Request" }, "rejected", false],
      ["认不出来的错误", new Error("something odd"), "unknown", false],
    ];

    for (const [name, err, kind, retryable] of FAILURES) {
      test(`${name} → kind=${kind}, retryable=${retryable}`, async () => {
        provider.nextError = err;

        await expect(synthesize(req, deps())).rejects.toMatchObject({ kind, retryable });
      });
    }

    test("失败时不写入存储", async () => {
      provider.nextError = { status: 500, message: "boom" };

      await expect(synthesize(req, deps())).rejects.toThrow();
      expect(store.size).toBe(0);
    });

    test("失败后重试成功，第二次能写入", async () => {
      provider.nextError = { status: 500, message: "boom" };
      await expect(synthesize(req, deps())).rejects.toThrow();

      const result = await synthesize(req, deps());

      expect(result.cached).toBe(false);
      expect(store.size).toBe(1);
    });

    test("错误信息里带上引擎名，便于定位", async () => {
      provider.nextError = new Error("boom");

      await expect(synthesize(req, deps())).rejects.toThrow(/fake/);
    });
  });

  describe("空音频：调用成功但结果不可用", () => {
    test("零字节音频抛 empty", async () => {
      provider.nextAudio = new Uint8Array(0);

      await expect(synthesize(req, deps())).rejects.toMatchObject({ kind: "empty" });
    });

    test("空音频不写入存储", async () => {
      provider.nextAudio = new Uint8Array(0);

      await expect(synthesize(req, deps())).rejects.toThrow();
      expect(store.size).toBe(0);
    });
  });
});
