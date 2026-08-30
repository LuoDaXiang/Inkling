import { describe, test, expect } from "vitest";
import {
  extractPitch,
  removeNoise,
  PitchConfigError,
  MIN_PERIODS_PER_WINDOW,
  DEFAULT_MAX_HZ,
} from "@/core/audio/pitch";

/**
 * 输入空间分类
 *
 *   A. 正确性 —— 已知频率的正弦波，中位数必须落在真值附近
 *   B. 采样率无关 —— 同一段音在 8k / 16k / 44.1k 下都要对  ⭐
 *   C. 退化输入 —— 全静音、空、短于一个窗口
 *   D. 参数不成立 —— 窗口装不下 3 个周期、区间反了
 *   E. removeNoise 的不变量 —— 不改入参、0 不是缺席
 *
 * **B 组是这个文件里最重要的一组。** 参考实现（`enjoy/src/utils.ts:4`）
 * 恰恰是在这一组上栽的：它只在 8000 Hz 下对，换成 16000 Hz 后 91% 的窗口
 * 返回数字、无一落在人声频段，而且不抛错。一个只在某个采样率下正确的
 * 音高函数，和一个错的音高函数没有区别——因为你不会知道自己在哪一边。
 *
 * D 组是同一件事的另一面：把那种「测不了但照样给数字」的处境变成异常。
 */

/** 造一段正弦波。 */
function sine(hz: number, sampleRate: number, seconds: number): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/** 非 null 读数的中位数。全是 null 时返回 null。 */
function median(values: readonly (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1
    ? (nums[mid] as number)
    : ((nums[mid - 1] as number) + (nums[mid] as number)) / 2;
}

/* ---- A. 正确性 ---- */

describe("已知频率的正弦波", () => {
  test("16 kHz / 220 Hz → 中位数 220 ± 5", () => {
    const hz = extractPitch({ samples: sine(220, 16000, 2), sampleRate: 16000 });
    expect(median(hz)).toBeCloseTo(220, -0.5);
    expect(median(hz)).toBeGreaterThan(215);
    expect(median(hz)).toBeLessThan(225);
  });

  test("16 kHz / 110 Hz → 中位数 110 ± 5", () => {
    const hz = extractPitch({ samples: sine(110, 16000, 2), sampleRate: 16000 });
    const m = median(hz);
    expect(m).not.toBeNull();
    expect(m as number).toBeGreaterThan(105);
    expect(m as number).toBeLessThan(115);
  });

  test("16 kHz / 330 Hz → 中位数 330 ± 5", () => {
    const hz = extractPitch({ samples: sine(330, 16000, 2), sampleRate: 16000 });
    const m = median(hz);
    expect(m).not.toBeNull();
    expect(m as number).toBeGreaterThan(325);
    expect(m as number).toBeLessThan(335);
  });

  test("绝大多数窗口都测得出，不是靠少数几个撑起中位数", () => {
    const hz = extractPitch({ samples: sine(220, 16000, 2), sampleRate: 16000 });
    const detected = hz.filter((v) => v !== null).length;
    expect(detected / hz.length).toBeGreaterThan(0.9);
  });

  test("窗口数按 windowMs / hopMs 算，不从别处反推", () => {
    // 2 秒 @16 kHz = 32000 采样；窗 640，帧移 320 → floor((32000-640)/320)+1
    const hz = extractPitch({ samples: sine(220, 16000, 2), sampleRate: 16000 });
    expect(hz.length).toBe(Math.floor((32000 - 640) / 320) + 1);
  });
});

/* ---- B. 采样率无关（参考实现栽在这里）---- */

describe("同一段音在不同采样率下都要对", () => {
  test.each([8000, 16000, 44100])("%i Hz / 220 Hz → 中位数 220 ± 5", (sampleRate) => {
    const hz = extractPitch({ samples: sine(220, sampleRate, 2), sampleRate });
    const m = median(hz);
    expect(m).not.toBeNull();
    expect(m as number).toBeGreaterThan(215);
    expect(m as number).toBeLessThan(225);
  });

  test("44.1 kHz 下有效窗口占比同样高", () => {
    const hz = extractPitch({ samples: sine(220, 44100, 2), sampleRate: 44100 });
    const detected = hz.filter((v) => v !== null).length;
    expect(detected / hz.length).toBeGreaterThan(0.9);
  });
});

/* ---- C. 退化输入 ---- */

describe("退化输入", () => {
  test("全零输入 → 全 null", () => {
    const hz = extractPitch({ samples: new Float32Array(32000), sampleRate: 16000 });
    expect(hz.length).toBeGreaterThan(0);
    expect(hz.every((v) => v === null)).toBe(true);
  });

  test("空输入 → 空数组，不抛", () => {
    expect(extractPitch({ samples: new Float32Array(0), sampleRate: 16000 })).toEqual([]);
  });

  test("短于一个窗口 → 空数组，不给半个窗口的读数", () => {
    // 639 < 640，凑不满一个窗口。补零凑满是在编造数据。
    const hz = extractPitch({ samples: sine(220, 16000, 639 / 16000), sampleRate: 16000 });
    expect(hz).toEqual([]);
  });

  test("恰好一个窗口 → 一个读数", () => {
    const hz = extractPitch({ samples: sine(220, 16000, 640 / 16000), sampleRate: 16000 });
    expect(hz.length).toBe(1);
  });
});

/* ---- D. 参数不成立时必须抛，不许返回数字 ---- */

describe("窗口装不下 3 个基频周期", () => {
  test("窗口短到整个区间都测不了 → 抛 PitchConfigError", () => {
    // 参考实现在 16 kHz 下的处境：37 个采样 ≈ 2.3 ms。
    expect(() =>
      extractPitch({ samples: sine(220, 16000, 2), sampleRate: 16000, windowMs: 2.3 }),
    ).toThrow(PitchConfigError);
  });

  test("参考实现在 44.1 kHz 下的处境（0.1 ms 窗）同样抛，不返回 17640 个数字", () => {
    expect(() =>
      extractPitch({ samples: sine(220, 44100, 2), sampleRate: 44100, windowMs: 0.1 }),
    ).toThrow(PitchConfigError);
  });

  test("错误信息说得出该把 windowMs 调到多少", () => {
    const needed = Math.ceil((MIN_PERIODS_PER_WINDOW * 1000) / DEFAULT_MAX_HZ);
    expect(() =>
      extractPitch({ samples: sine(220, 16000, 2), sampleRate: 16000, windowMs: 2.3 }),
    ).toThrow(new RegExp(`${needed}ms`));
  });

  test("落在区间内、但窗口装不下 3 个周期的读数 → null，不是数字", () => {
    // 窗 30 ms @16 kHz = 480 采样，最低可测 = 3*16000/480 = 100 Hz。
    // 80 Hz 在 [minHz, maxHz] 里，但这个窗口确认不了它。
    const hz = extractPitch({
      samples: sine(80, 16000, 2),
      sampleRate: 16000,
      windowMs: 30,
    });
    expect(hz.some((v) => v !== null && v < 100)).toBe(false);
  });

  test("同一段 80 Hz 换成够长的窗口就测得出——上一条不是「测不了低频」", () => {
    const hz = extractPitch({ samples: sine(80, 16000, 2), sampleRate: 16000, windowMs: 80 });
    const m = median(hz);
    expect(m).not.toBeNull();
    expect(m as number).toBeGreaterThan(75);
    expect(m as number).toBeLessThan(85);
  });

  test.each([
    ["sampleRate 为 0", { sampleRate: 0 }],
    ["windowMs 为 0", { windowMs: 0 }],
    ["hopMs 为负", { hopMs: -1 }],
    ["maxHz 不大于 minHz", { minHz: 300, maxHz: 300 }],
  ])("%s → 抛 PitchConfigError", (_name, overrides) => {
    expect(() =>
      extractPitch({ samples: sine(220, 16000, 1), sampleRate: 16000, ...overrides }),
    ).toThrow(PitchConfigError);
  });
});

/* ---- E. removeNoise 的不变量 ---- */

describe("removeNoise", () => {
  test("不修改入参数组", () => {
    const input: (number | null)[] = [200, 201, 900, 202, 203];
    const snapshot = [...input];
    removeNoise(input);
    expect(input).toEqual(snapshot);
  });

  test("返回的是新数组", () => {
    const input: (number | null)[] = [200, 201, 202];
    expect(removeNoise(input)).not.toBe(input);
  });

  test("野点被抹成 null，而且它两侧的点也一起被抹掉", () => {
    // 这不是缺陷，是这个判据的固有代价：判据是「偏离左右邻居的均值」，
    // 一个 900 落在 201 和 202 中间，会同时让**它自己**和**它的两个邻居**
    // 各自的邻域均值失真。三个点一起变 null。
    //
    // 方向是对的：抹多了只是曲线上少几个点（前端本来就在 null 处断开），
    // 留下来才是拿一个假的基频去画图。这个仓库一贯选前者。
    const out = removeNoise([200, 201, 900, 202, 203]);
    expect(out).toEqual([200, null, null, null, 203]);
  });

  test("连续两个野点都检得出——邻居从原始输入读，不读改到一半的结果", () => {
    // 参考实现原地改数组，第一个野点被置 null 后，第二个野点的 prev 变成
    // `null || num` = 自己，判据退化成「和自己比」，恒不越界，于是漏掉。
    const out = removeNoise([200, 900, 950, 202, 203]);
    expect(out[1]).toBeNull();
    expect(out[2]).toBeNull();
  });

  test("合法的 0 不被当成缺席", () => {
    // 参考实现用 `numbers[i-1] || num`，0 是 falsy，会被替换成当前值。
    // 用 `??` 的话 0 就是 0，邻域均值随之不同。
    const out = removeNoise([0, 0, 500, 0, 0]);
    expect(out[2]).toBeNull();
  });

  test("null 邻居回落到当前值，不参与运算", () => {
    const out = removeNoise([null, 220, null, 221, null]);
    expect(out[1]).toBe(220);
    expect(out[3]).toBe(221);
  });

  test("平稳序列一个都不抹", () => {
    const input = [220, 221, 219, 220, 222];
    expect(removeNoise(input)).toEqual(input);
  });

  test("阈值可配，放宽后野点留下", () => {
    const out = removeNoise([200, 201, 260, 202, 203], 0.5);
    expect(out[2]).toBe(260);
  });

  test("空数组 → 空数组", () => {
    expect(removeNoise([])).toEqual([]);
  });
});
