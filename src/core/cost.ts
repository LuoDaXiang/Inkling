/**
 * 花费计算。
 *
 * 单位一律是**微元**（micro-USD，百万分之一美元）。用整数不用浮点：
 * 花费要累加，而浮点累加会漂——一年几万次调用之后，总额对不上账单。
 *
 * 这里只做换算，不知道费率是多少。费率从配置注入（见 http/main.ts），
 * 因为它随 Azure 的定价层级、区域、以及你的具体合同变化，
 * **写死在代码里的费率一定会过期，而且过期时不报错**。
 *
 * 两个原则：
 *
 *   1. **缓存命中花费为零。** 没调外部服务就没有花费。这是 TTS 缓存
 *      存在的全部理由，必须能在流水里看出来。
 *   2. **失败不计费。** 401、429、网络断——都没有产生可计费的用量。
 *      把它们算进去会让成本看起来比实际高，而成本数据的用途是决策。
 *
 * 这两条都不在这个文件里执行，在调用点执行（http/server.ts）。
 * 这里只保证：给定用量和费率，算出来的数是对的。
 */

export interface Rates {
  /**
   * TTS：每 **100 万字符** 多少微元。
   *
   * 例：$16 / 1M 字符 → 16_000_000。
   */
  ttsPerMillionChars: number;
  /**
   * 发音评分：每 **小时音频** 多少微元。
   *
   * 例：$1 / 小时 → 1_000_000。
   */
  scoringPerAudioHour: number;
}

/** 费率全为零。没配置费率时用它——算出来是 0，但调用点会跳过记录。 */
export const NO_COST: Rates = { ttsPerMillionChars: 0, scoringPerAudioHour: 0 };

const CHARS_PER_UNIT = 1_000_000;
const MS_PER_HOUR = 3_600_000;

/**
 * TTS 的花费。
 *
 * 按**字符数**计，不是按合成出来的音频长度——Azure 是这么计的。
 * 传进来的应该是实际送给服务的文本长度。
 */
export function ttsCostMicros(chars: number, rates: Rates): number {
  return scale(chars, rates.ttsPerMillionChars, CHARS_PER_UNIT);
}

/**
 * 发音评分的花费。
 *
 * 按**音频时长**计。传进来的应该是实际送出去的那段音频的时长——
 * 也就是**掐掉首尾静音之后**的长度，不是用户按住录音键的时长。
 */
export function scoringCostMicros(durationMs: number, rates: Rates): number {
  return scale(durationMs, rates.scoringPerAudioHour, MS_PER_HOUR);
}

/**
 * 用量 × 费率 ÷ 计价单位，向上取整到微元。
 *
 * 取整方向选**向上**：宁可把成本估高一点点也不要估低。
 * 成本数据是拿来做决策的（还要不要继续用这家、要不要加缓存），
 * 系统性偏低的估算会让决策偏向「再撑撑」。
 *
 * 非法输入一律回 0 而不是抛——这条链路的终点是写流水，
 * 而写流水永不抛（决策 0038）。一个算不出来的花费不该拖垮请求。
 */
function scale(amount: number, rate: number, unit: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(rate)) return 0;
  if (amount <= 0 || rate <= 0) return 0;
  return Math.ceil((amount * rate) / unit);
}
