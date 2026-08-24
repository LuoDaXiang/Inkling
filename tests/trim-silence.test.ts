import { describe, test, expect } from "vitest";
import {
  trimSilence,
  dbfsToInt16,
  DEFAULT_THRESHOLD_DBFS,
  ONSET_PADDING_MS,
} from "@/core/audio/trim-silence";

/**
 * 输入空间分类（判据一，见 docs/decisions.md 0006）
 *
 *   A. 正常修剪 —— 开头、结尾、两头
 *   B. 退化输入 —— 全静音、无静音、空、极短
 *   C. 阈值 —— 单位换算、边界前后、可配置
 *   D. 不能误伤真实语音 —— 轻辅音、起音余量、中间停顿  ⭐
 *   E. 抗干扰 —— 单次爆音、直流偏置
 *   F. 不变量 —— 连续子段、峰值保留、幂等
 *
 * 为什么这些类是穷尽的：这个函数在一维信号上找两个下标。
 * 找错有四种方式——**找不到**（B）、**找偏**（C、E）、
 * **切多了**（D）、**切少了**（A）。F 用不变量兜住枚举不到的组合。
 *
 * **D 组是这个文件里最重要的一组**，理由值得写下来：
 * 其余三个音频模块出错会崩或产生噪声，一眼能发现；
 * 这个模块出错**只是分数不对**，而你无从察觉。
 * 掐掉一个词尾的 -t，准确度就低了几分，没有任何东西会报错。
 */

const SR = 16000;
const ms = (n: number): number => Math.round((n * SR) / 1000);

/** 造一段信号：静音 + 语音 + 静音，语音是正弦波。 */
function signal(parts: Array<{ ms: number; amplitude: number }>): Int16Array {
  const total = parts.reduce((sum, p) => sum + ms(p.ms), 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    const n = ms(part.ms);
    for (let i = 0; i < n; i++) {
      out[offset + i] = Math.round(part.amplitude * Math.sin((offset + i) / 4));
    }
    offset += n;
  }
  return out;
}

const LOUD = 8000;
const trim = (samples: Int16Array, overrides = {}) =>
  trimSilence(samples, { sampleRate: SR, ...overrides });

describe("A. 正常修剪", () => {
  test("掐掉开头的静音", () => {
    const input = signal([
      { ms: 1000, amplitude: 0 },
      { ms: 500, amplitude: LOUD },
    ]);
    const { samples, trimmedStart } = trim(input);

    expect(trimmedStart).toBeGreaterThan(0);
    expect(samples.length).toBeLessThan(input.length);
    // 掐掉的应该接近 1 秒，减去起音余量。
    expect(trimmedStart).toBeLessThanOrEqual(ms(1000));
    expect(trimmedStart).toBeGreaterThan(ms(1000) - ms(ONSET_PADDING_MS) - ms(20));
  });

  test("掐掉结尾的静音", () => {
    const input = signal([
      { ms: 500, amplitude: LOUD },
      { ms: 1000, amplitude: 0 },
    ]);
    const { trimmedEnd } = trim(input);
    expect(trimmedEnd).toBeGreaterThan(ms(500));
  });

  test("两头都掐", () => {
    const input = signal([
      { ms: 800, amplitude: 0 },
      { ms: 600, amplitude: LOUD },
      { ms: 900, amplitude: 0 },
    ]);
    const { samples, trimmedStart, trimmedEnd } = trim(input);

    expect(trimmedStart).toBeGreaterThan(0);
    expect(trimmedEnd).toBeGreaterThan(0);
    expect(trimmedStart + samples.length + trimmedEnd).toBe(input.length);
  });

  test("修剪后时长明显缩短 —— 这才是做这件事的理由", () => {
    // 用户点「录音」到开口总有一两秒空白，这段静音会拉低流利度分数，
    // 而它和发音水平毫无关系。
    const input = signal([
      { ms: 2000, amplitude: 0 },
      { ms: 1000, amplitude: LOUD },
      { ms: 2000, amplitude: 0 },
    ]);
    const { samples } = trim(input);
    expect(samples.length / SR).toBeLessThan(1.5);
  });
});

describe("B. 退化输入", () => {
  test("全是静音 → 返回空，让上层判为「没听到声音」", () => {
    const { samples, trimmedStart } = trim(new Int16Array(ms(1000)));
    expect(samples.length).toBe(0);
    expect(trimmedStart).toBe(ms(1000));
  });

  test("空输入原样返回", () => {
    const { samples, trimmedStart, trimmedEnd } = trim(new Int16Array(0));
    expect(samples.length).toBe(0);
    expect(trimmedStart).toBe(0);
    expect(trimmedEnd).toBe(0);
  });

  test("完全没有静音 → 一点都不掐", () => {
    const input = signal([{ ms: 1000, amplitude: LOUD }]);
    const { samples, trimmedStart, trimmedEnd } = trim(input);
    expect(trimmedStart).toBe(0);
    expect(trimmedEnd).toBe(0);
    expect(samples.length).toBe(input.length);
  });

  test("比一个窗口还短的信号也能处理", () => {
    const input = signal([{ ms: 3, amplitude: LOUD }]);
    expect(() => trim(input)).not.toThrow();
    expect(trim(input).samples.length).toBeGreaterThan(0);
  });

  test("单个采样", () => {
    expect(() => trim(Int16Array.from([LOUD]))).not.toThrow();
  });
});

describe("C. 阈值", () => {
  test("dBFS 换算成 Int16 单位", () => {
    expect(dbfsToInt16(0)).toBeCloseTo(32768, 0);
    expect(dbfsToInt16(-50)).toBeCloseTo(103.6, 1);
    expect(dbfsToInt16(-6)).toBeCloseTo(16423, -1);
  });

  test("参考实现的 -100 dBFS 低于一个量化单位 —— 照抄等于不修剪", () => {
    // 这条钉住的是一个真实教训：Enjoy 结尾用 -100 dBFS，
    // 换算成 16 位整数是 0.33 —— 低于 1，意味着「恰好为 0」。
    // 任何一点底噪都掐不动，结尾那一半等于白做。
    expect(dbfsToInt16(-100)).toBeLessThan(1);
    expect(dbfsToInt16(DEFAULT_THRESHOLD_DBFS)).toBeGreaterThan(1);
  });

  test("低于阈值的底噪被当作静音", () => {
    const quiet = Math.round(dbfsToInt16(-70)); // 约 10，远低于阈值
    const input = signal([
      { ms: 500, amplitude: quiet },
      { ms: 500, amplitude: LOUD },
    ]);
    expect(trim(input).trimmedStart).toBeGreaterThan(0);
  });

  test("高于阈值的底噪不被当作静音", () => {
    const audible = Math.round(dbfsToInt16(-30)); // 约 1036，高于阈值
    const input = signal([
      { ms: 500, amplitude: audible },
      { ms: 500, amplitude: LOUD },
    ]);
    expect(trim(input).trimmedStart).toBe(0);
  });

  test("阈值可配置 —— 调严会掐掉更多", () => {
    const input = signal([
      { ms: 500, amplitude: Math.round(dbfsToInt16(-40)) },
      { ms: 500, amplitude: LOUD },
    ]);
    const lenient = trim(input, { thresholdDbfs: -50 }).trimmedStart;
    const strict = trim(input, { thresholdDbfs: -30 }).trimmedStart;
    expect(strict).toBeGreaterThan(lenient);
  });
});

// ⭐ 这一组最重要。其余模块出错会崩或产生噪声，一眼能发现；
// 这个模块出错只是分数不对，而你无从察觉。
describe("D. 不能误伤真实语音", () => {
  test("轻辅音不被掐掉", () => {
    // 词尾的 -t、-s、气声音量很低，激进的阈值会把它们当静音掐掉，
    // 直接损害准确度评分。
    const consonant = Math.round(dbfsToInt16(-35)); // 轻，但确实是语音
    const input = signal([
      { ms: 500, amplitude: 0 },
      { ms: 100, amplitude: consonant },
      { ms: 500, amplitude: LOUD },
    ]);
    const { trimmedStart } = trim(input);

    // 掐掉的部分不能越过那个轻辅音的起点。
    expect(trimmedStart).toBeLessThanOrEqual(ms(500));
  });

  test("留了起音余量 —— 切在阈值处会削掉爆破音的前沿", () => {
    // p / t / k 的起音是陡峭瞬态，从几乎无声跳到峰值。
    // 切在交越点会削掉前沿，听感变闷，准确度分数下降。
    const input = signal([
      { ms: 1000, amplitude: 0 },
      { ms: 500, amplitude: LOUD },
    ]);
    const { trimmedStart } = trim(input);

    // 语音从 1000ms 开始，修剪点必须早于它至少一个起音余量。
    expect(trimmedStart).toBeLessThan(ms(1000));
    expect(ms(1000) - trimmedStart).toBeGreaterThanOrEqual(ms(ONSET_PADDING_MS) - ms(15));
  });

  test("中间的停顿绝不能碰 —— 它是语调评分的素材", () => {
    // 服务端会检测「该停没停」「不该停却停了」。掐掉句中停顿
    // 等于篡改用户的表现。
    const input = signal([
      { ms: 400, amplitude: LOUD },
      { ms: 600, amplitude: 0 }, // 句中停顿
      { ms: 400, amplitude: LOUD },
    ]);
    const { samples } = trim(input);

    // 首尾都是语音，什么都不该掐，中间那 600ms 必须原样保留。
    expect(samples.length).toBe(input.length);
  });

  test("修剪不会掐掉一半以上 —— 掐太多说明阈值错了", () => {
    const input = signal([
      { ms: 200, amplitude: 0 },
      { ms: 2000, amplitude: LOUD },
      { ms: 200, amplitude: 0 },
    ]);
    const { samples } = trim(input);
    expect(samples.length).toBeGreaterThan(input.length / 2);
  });
});

describe("E. 抗干扰", () => {
  test("一次咔哒声不会让整段静音都掐不掉", () => {
    // 按单个采样判断的话，录音开头一声电流爆音就能让修剪完全失效。
    // 所以看窗口内的持续能量，不看单点。
    const input = signal([
      { ms: 1000, amplitude: 0 },
      { ms: 500, amplitude: LOUD },
    ]);
    input[100] = 30000; // 一个孤立的爆音采样

    const { trimmedStart } = trim(input);
    expect(trimmedStart).toBeGreaterThan(ms(500));
  });

  test("直流偏置不会让修剪失效", () => {
    // 有些麦克风的「静音」段绝对值恒定不为零。直接算绝对值的话
    // 修剪完全失效——而且不报错。所以测量能量前先去掉均值。
    const bias = 2000; // 远高于阈值的恒定偏置
    const input = signal([
      { ms: 1000, amplitude: 0 },
      { ms: 500, amplitude: LOUD },
    ]);
    const biased = Int16Array.from(input, (v) => v + bias);

    expect(trim(biased).trimmedStart).toBeGreaterThan(0);
  });

  test("带直流偏置时，修剪位置和不带时接近", () => {
    const input = signal([
      { ms: 1000, amplitude: 0 },
      { ms: 500, amplitude: LOUD },
    ]);
    const biased = Int16Array.from(input, (v) => v + 1500);

    const clean = trim(input).trimmedStart;
    const withBias = trim(biased).trimmedStart;
    expect(Math.abs(clean - withBias)).toBeLessThan(ms(50));
  });
});

describe("F. 不变量", () => {
  const input = signal([
    { ms: 700, amplitude: 0 },
    { ms: 900, amplitude: LOUD },
    { ms: 700, amplitude: 0 },
  ]);

  test("结果是原信号的连续子段，顺序不变", () => {
    const { samples, trimmedStart } = trim(input);
    for (let i = 0; i < samples.length; i++) {
      expect(samples[i]).toBe(input[trimmedStart + i]);
    }
  });

  test("三段长度相加等于原长", () => {
    const { samples, trimmedStart, trimmedEnd } = trim(input);
    expect(trimmedStart + samples.length + trimmedEnd).toBe(input.length);
  });

  test("峰值必须还在 —— 掐掉峰值说明逻辑错了", () => {
    const peakOf = (a: Int16Array): number => {
      let max = 0;
      for (const v of a) max = Math.max(max, Math.abs(v));
      return max;
    };
    expect(peakOf(trim(input).samples)).toBe(peakOf(input));
  });

  test("幂等 —— 修剪两次和修剪一次结果相同", () => {
    const once = trim(input).samples;
    const twice = trim(once).samples;
    expect(twice.length).toBe(once.length);
    expect(Array.from(twice)).toEqual(Array.from(once));
  });

  test("不修改原数组", () => {
    const copy = Int16Array.from(input);
    trim(input);
    expect(Array.from(input)).toEqual(Array.from(copy));
  });
});
