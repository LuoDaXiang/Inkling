import { describe, test, expect } from "vitest";
import { NO_COST, scoringCostMicros, ttsCostMicros, type Rates } from "@/core/cost";

/**
 * 花费换算。
 *
 * 纯函数，没有 IO，所以能测得很彻底——而它值得测彻底：
 * 这个数字将来要拿去和 Azure 的账单对账，差一个数量级不会有任何东西报错。
 *
 * 输入空间：正常值 / 零 / 负数 / 非有限数 / 极小值（取整边界）/ 极大值。
 */

/** $16 / 1M 字符，$1 / 小时。数量级取自常见的 Azure 定价，仅用于测试。 */
const RATES: Rates = { ttsPerMillionChars: 16_000_000, scoringPerAudioHour: 1_000_000 };

describe("TTS 按字符计", () => {
  test("100 万字符正好等于费率本身", () => {
    expect(ttsCostMicros(1_000_000, RATES)).toBe(16_000_000);
  });

  test("一句 50 字符", () => {
    expect(ttsCostMicros(50, RATES)).toBe(800); // 50 × 16
  });

  test("线性：字符翻倍花费翻倍", () => {
    expect(ttsCostMicros(200, RATES)).toBe(2 * ttsCostMicros(100, RATES));
  });
});

describe("评分按音频时长计", () => {
  test("一小时正好等于费率本身", () => {
    expect(scoringCostMicros(3_600_000, RATES)).toBe(1_000_000);
  });

  test("5 秒", () => {
    // 5000ms × 1_000_000 / 3_600_000 = 1388.9 → 向上取整
    expect(scoringCostMicros(5_000, RATES)).toBe(1389);
  });

  test("线性：时长翻倍花费翻倍", () => {
    expect(scoringCostMicros(20_000, RATES)).toBe(2 * scoringCostMicros(10_000, RATES));
  });

  test("30 秒（评分服务的上限）", () => {
    expect(scoringCostMicros(30_000, RATES)).toBe(8334);
  });
});

describe("取整方向：向上", () => {
  test("任何非零用量都至少算 1 微元，不会被抹成 0", () => {
    // 系统性向下取整会让「很多次很便宜的调用」总额显著偏低。
    expect(ttsCostMicros(1, { ttsPerMillionChars: 1, scoringPerAudioHour: 0 })).toBe(1);
    expect(scoringCostMicros(1, { ttsPerMillionChars: 0, scoringPerAudioHour: 1 })).toBe(1);
  });

  test("有小数时向上而不是四舍五入", () => {
    // 5000ms → 1388.89，四舍五入是 1389，向下是 1388。这里要 1389。
    expect(scoringCostMicros(5_000, RATES)).toBe(1389);
    // 3600ms → 正好 1000，整除时不该被向上推到 1001
    expect(scoringCostMicros(3_600, RATES)).toBe(1000);
  });

  test("累加一万次小额调用不会漂——整数运算没有浮点误差", () => {
    let total = 0;
    for (let i = 0; i < 10_000; i++) total += ttsCostMicros(50, RATES);
    expect(total).toBe(10_000 * 800);
    expect(Number.isInteger(total)).toBe(true);
  });
});

describe("边界与非法输入", () => {
  test("零用量是零花费", () => {
    expect(ttsCostMicros(0, RATES)).toBe(0);
    expect(scoringCostMicros(0, RATES)).toBe(0);
  });

  test("零费率是零花费", () => {
    expect(ttsCostMicros(1000, NO_COST)).toBe(0);
    expect(scoringCostMicros(1000, NO_COST)).toBe(0);
  });

  test("负数用量回 0，不回负花费", () => {
    expect(ttsCostMicros(-100, RATES)).toBe(0);
    expect(scoringCostMicros(-100, RATES)).toBe(0);
  });

  test("负费率回 0——配置写错了不该产生负账单", () => {
    expect(ttsCostMicros(100, { ttsPerMillionChars: -16, scoringPerAudioHour: 0 })).toBe(0);
  });

  test("NaN / Infinity 回 0 而不是抛", () => {
    // 这条链路的终点是写流水，而写流水永不抛（0038）。
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(ttsCostMicros(bad, RATES)).toBe(0);
      expect(scoringCostMicros(bad, RATES)).toBe(0);
      expect(ttsCostMicros(100, { ttsPerMillionChars: bad, scoringPerAudioHour: bad })).toBe(0);
    }
  });

  test("结果永远是整数——INTEGER 列不接受小数", () => {
    for (const chars of [1, 7, 33, 999, 12345]) {
      expect(Number.isInteger(ttsCostMicros(chars, RATES))).toBe(true);
    }
    for (const ms of [1, 7, 333, 4321, 29_999]) {
      expect(Number.isInteger(scoringCostMicros(ms, RATES))).toBe(true);
    }
  });

  test("大用量仍在安全整数范围内", () => {
    // 一次不可能这么大，但确认换算本身不会溢出。
    const huge = ttsCostMicros(1_000_000_000, RATES);
    expect(Number.isSafeInteger(huge)).toBe(true);
  });
});
