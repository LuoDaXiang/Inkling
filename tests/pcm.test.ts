import { describe, test, expect } from "vitest";
import {
  floatToInt16,
  concatFloat32,
  copyChunk,
  INT16_MIN,
  INT16_MAX,
} from "@/core/audio/pcm";

/**
 * 输入空间分类（判据一，见 docs/decisions.md 0006）
 *
 *   A. 数值映射 —— 零、满量程、中间值、正负不对称
 *   B. 削波 —— 超出 [-1,1]、无穷大
 *   C. 退化输入 —— 空、单个采样、NaN、-0
 *   D. 不变量 —— 长度、值域、单调性
 *   E. 分块累积 —— 拼接、缓冲区复用（AudioWorklet 的真实形态）
 *
 * 为什么这些类是穷尽的：这一层只做两件事——**逐个采样做数值变换**
 * （A、B、C、D）和**把小块拼成大块**（E）。数值变换的输入是一个实数，
 * 它只有「在范围内 / 超范围 / 不是数」三种可能，A/B/C 覆盖三种，
 * D 用不变量兜住 A 没枚举到的中间值。
 */

const f32 = (...values: number[]): Float32Array => Float32Array.from(values);

describe("floatToInt16", () => {
  describe("A. 数值映射", () => {
    test("0 映射到 0", () => {
      expect(Array.from(floatToInt16(f32(0)))).toEqual([0]);
    });

    test("满量程正负两端", () => {
      // 这是最容易写错的一处：满量程是 32768，但正方向的上限只到 32767。
      // 用同一个系数乘，输入 1.0 会得到 32768 —— 溢出成 -32768，
      // 也就是在最大音量处产生一个反相的爆音。
      expect(floatToInt16(f32(1))[0]).toBe(INT16_MAX);
      expect(floatToInt16(f32(-1))[0]).toBe(INT16_MIN);
    });

    test("正负系数不同，所以 1.0 和 -1.0 的绝对值差 1", () => {
      const positive = floatToInt16(f32(1))[0] as number;
      const negative = floatToInt16(f32(-1))[0] as number;
      expect(Math.abs(negative) - Math.abs(positive)).toBe(1);
    });

    test("中间值按比例映射", () => {
      expect(floatToInt16(f32(0.5))[0]).toBe(Math.round(0.5 * INT16_MAX));
      expect(floatToInt16(f32(-0.5))[0]).toBe(-Math.round(0.5 * 32768));
    });

    test("多个采样按顺序处理", () => {
      const out = floatToInt16(f32(0, 1, -1, 0.5));
      expect(out.length).toBe(4);
      expect(out[0]).toBe(0);
      expect(out[1]).toBe(INT16_MAX);
      expect(out[2]).toBe(INT16_MIN);
    });
  });

  describe("B. 削波", () => {
    test.each([
      [1.5, INT16_MAX],
      [2, INT16_MAX],
      [100, INT16_MAX],
      [-1.5, INT16_MIN],
      [-2, INT16_MIN],
      [-100, INT16_MIN],
      [Infinity, INT16_MAX],
      [-Infinity, INT16_MIN],
    ])("%s 夹到 %s，而不是回绕", (input, expected) => {
      // 不夹的话，一次轻微过载会变成刺耳的爆音——
      // 数字回绕失真比模拟削波难听得多。
      expect(floatToInt16(f32(input))[0]).toBe(expected);
    });

    test("恰好在边界上不被夹", () => {
      expect(floatToInt16(f32(0.99999))[0]).toBeLessThanOrEqual(INT16_MAX);
      expect(floatToInt16(f32(-0.99999))[0]).toBeGreaterThanOrEqual(INT16_MIN);
    });
  });

  describe("C. 退化输入", () => {
    test("空输入给空输出", () => {
      expect(floatToInt16(new Float32Array(0)).length).toBe(0);
    });

    test("NaN 变成 0 —— 设备切换时真的会出现", () => {
      // NaN 的任何比较都是 false，所以必须显式判断。
      // 不判的话它会穿过所有 if 落到乘法里，结果是未定义的。
      expect(floatToInt16(f32(NaN))[0]).toBe(0);
    });

    test("NaN 混在正常采样里，不影响其他采样", () => {
      const out = floatToInt16(f32(0.5, NaN, -0.5));
      expect(out[0]).toBeGreaterThan(0);
      expect(out[1]).toBe(0);
      expect(out[2]).toBeLessThan(0);
    });

    test("负零得到正零 —— 不能是 -0", () => {
      // Object.is(-0, 0) 为假。让 -0 流出去的话，
      // 用 toBe(0) 的断言会在别处莫名其妙地挂掉。
      const out = floatToInt16(f32(-0))[0] as number;
      expect(Object.is(out, 0)).toBe(true);
    });

    test("极小值向零舍入", () => {
      expect(floatToInt16(f32(1e-9))[0]).toBe(0);
      expect(floatToInt16(f32(-1e-9))[0]).toBe(0);
    });
  });

  describe("D. 不变量", () => {
    const sweep = Float32Array.from({ length: 401 }, (_, i) => (i - 200) / 100);

    test("长度不变", () => {
      expect(floatToInt16(sweep).length).toBe(sweep.length);
    });

    test("每个输出都在 Int16 值域内", () => {
      for (const v of floatToInt16(sweep)) {
        expect(v).toBeGreaterThanOrEqual(INT16_MIN);
        expect(v).toBeLessThanOrEqual(INT16_MAX);
      }
    });

    test("单调不减 —— 输入更大，输出不更小", () => {
      const out = floatToInt16(sweep);
      for (let i = 1; i < out.length; i++) {
        expect(out[i] as number).toBeGreaterThanOrEqual(out[i - 1] as number);
      }
    });

    test("输出确实是 Int16Array，不是普通数组", () => {
      expect(floatToInt16(f32(0.5))).toBeInstanceOf(Int16Array);
    });
  });
});

describe("E. 分块累积", () => {
  test("按顺序拼接", () => {
    const out = concatFloat32([f32(1, 2), f32(3), f32(4, 5, 6)]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("空数组列表给空结果", () => {
    expect(concatFloat32([]).length).toBe(0);
  });

  test("混着空块也能拼", () => {
    const out = concatFloat32([f32(1), new Float32Array(0), f32(2)]);
    expect(Array.from(out)).toEqual([1, 2]);
  });

  test("块大小不一致时正确累加 —— 渲染块大小不保证是 128", () => {
    // 规范说渲染块大小可能随时间变化。写死 128 会丢样本。
    const chunks = [128, 128, 64, 256, 1].map((n) => new Float32Array(n).fill(1));
    expect(concatFloat32(chunks).length).toBe(577);
  });

  test("三千多个块也能拼 —— 30 秒 16kHz 的真实量级", () => {
    const chunks = Array.from({ length: 3750 }, () => new Float32Array(128).fill(0.5));
    const out = concatFloat32(chunks);
    expect(out.length).toBe(480_000);
    expect(out[0]).toBeCloseTo(0.5);
    expect(out[479_999]).toBeCloseTo(0.5);
  });

  describe("缓冲区复用 —— AudioWorklet 的真实形态", () => {
    test("copyChunk 复制内容，不留引用", () => {
      // AudioWorklet 每次 process() 拿到的 Float32Array 会被下一次覆盖。
      // 保留引用的话，最后拿到的是同一块内存的 N 个别名，内容全是最后一块——
      // 表现是「录了 30 秒，播出来只有最后 8 毫秒在循环」。
      const live = f32(1, 2, 3);
      const copied = copyChunk(live);

      live[0] = 999; // 模拟 AudioWorklet 复用这块内存
      expect(copied[0]).toBe(1);
    });

    test("不复制的话数据会被覆盖 —— 这条演示 bug 的形态", () => {
      const live = f32(1, 2, 3);
      const kept = [live, live]; // 错误做法：直接保留引用

      live[0] = 999;
      expect(kept[0]?.[0]).toBe(999);
      expect(kept[1]?.[0]).toBe(999);
      // 两块内容一模一样，这就是 bug 的样子。
    });

    test("复制后的块参与拼接，结果正确", () => {
      const live = new Float32Array(2);
      const chunks: Float32Array[] = [];
      for (const value of [1, 2, 3]) {
        live.fill(value); // 复用同一块内存
        chunks.push(copyChunk(live));
      }
      expect(Array.from(concatFloat32(chunks))).toEqual([1, 1, 2, 2, 3, 3]);
    });
  });
});
