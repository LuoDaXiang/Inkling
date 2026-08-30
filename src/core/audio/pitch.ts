import { AMDF } from "pitchfinder";

/**
 * 音高曲线：逐窗取基频，再把邻域里离群的点抹成 null。
 *
 * 架构抄参考实现（AMDF 逐窗 → 邻域去噪置 null → 前端叠在波形上画），
 * **参数一个都不抄**。理由值得写在这里，因为它是这个文件存在的全部原因。
 *
 * 参考实现的 `extractFrequencies`（`enjoy/src/utils.ts:4`）有两个叠加的错误：
 *
 * ```js
 * const duration = peaks.length / sampleRate;
 * const bpm = peaks.length / duration / 60;   // duration 被约掉，恒等于 sampleRate/60
 * Pitchfinder.frequencies(detectPitch, peaks, { tempo: bpm, quantization: bpm });
 * //                                          ↑ 从不传 sampleRate，库内恒用默认 44100
 * ```
 *
 * `frequencies()` 的窗口大小是 `round(config.sampleRate * 60 / (quantization * tempo))`，
 * 而它拿到的 `config.sampleRate` 永远是默认的 44100。两个错误在 8000 Hz 下**恰好抵消**，
 * 得到 149 个采样的窗口（18.6 ms，装得下 4.1 个 220 Hz 周期），所以它一直是对的——
 * 因为参考实现从不给 wavesurfer 传 `sampleRate`，用的是 v7 的默认值 8000。
 *
 * 实测（2 秒 220 Hz 正弦，跑它的原参数）：
 *
 * ```
 * sr= 8000  chunkSize=149 (18.6ms)  有效 107/107    落在 150–300Hz 107 (100%)
 * sr=16000  chunkSize= 37 ( 2.3ms)  有效 788/864    落在 150–300Hz   0 (0%)
 * sr=44100  chunkSize=  5 ( 0.1ms)  有效   0/17640  落在 150–300Hz   0 (0%)
 * ```
 *
 * **Inkling 录音是 16000 Hz。** 照抄这段，91% 的窗口会**返回数字**——不是 null，
 * 不抛错——但没有一个落在人声频段。曲线画得出来，形状是噪声。
 * 算错而且不报错，是这个仓库最不能接受的那一类缺陷。
 *
 * 所以这里做三件参考实现没做的事：
 *
 * 1. **不用 `Pitchfinder.frequencies()`**，自己按 `windowMs` / `hopMs` 切窗。
 *    窗口长度是显式的毫秒数，不是从 bpm 反推出来的。
 * 2. **`AMDF` 的 `sampleRate` / `minFrequency` / `maxFrequency` 三项全部显式传。**
 *    默认值就是上面那个坑。
 * 3. **窗口装不下 3 个基频周期时，返回 null 或抛错，绝不返回数字。**
 *    见 `MIN_PERIODS_PER_WINDOW`。
 */

/** 分析窗口。40 ms 在 16 kHz 下是 640 个采样，装得下 8.8 个 220 Hz 周期。 */
export const DEFAULT_WINDOW_MS = 40;

/** 帧移。20 ms 即 50% 重叠——曲线要够密才画得平滑。 */
export const DEFAULT_HOP_MS = 20;

/** 人声基频下界。低于它的多半是嗡声或直流。 */
export const DEFAULT_MIN_HZ = 60;

/** 人声基频上界。高于它的多半是齿音或谐波误判。 */
export const DEFAULT_MAX_HZ = 500;

/**
 * 一个窗口至少要装下这么多个基频周期，结果才作数。
 *
 * **这是把参考实现那个坑变成可见错误的那一行。** AMDF 是逐点求差的方法：
 * 窗口里连 3 个周期都没有时，它照样会给出一个数字——那个数字是噪声，
 * 但它不是 null，也不抛错。
 *
 * 3 是下限不是舒适值：2 个周期只够算出一次差分，任何抖动都会翻倍地放大。
 */
export const MIN_PERIODS_PER_WINDOW = 3;

/**
 * 去噪阈值：一个点偏离左右邻居均值超过这个比例，就当它是野点。
 *
 * 0.2 抄自参考实现——**这个数字它没算错**，人声相邻 20 ms 之间的基频
 * 跳变超过 20% 的确不正常。抄的是数字，不是那段实现（见 `removeNoise`）。
 */
export const DEFAULT_NOISE_THRESHOLD = 0.2;

/** 参数本身就不成立时抛这个，而不是安静地返回一串垃圾数字。 */
export class PitchConfigError extends Error {
  override readonly name = "PitchConfigError";
}

export interface ExtractPitchInput {
  samples: Float32Array;
  sampleRate: number;
  /** 分析窗口长度，毫秒。默认 40。 */
  windowMs?: number;
  /** 帧移，毫秒。默认 20。 */
  hopMs?: number;
  /** 基频下界，Hz。默认 60。 */
  minHz?: number;
  /** 基频上界，Hz。默认 500。 */
  maxHz?: number;
}

/**
 * 逐窗提取基频。返回值与窗口一一对应，测不出音高的位置是 `null`。
 *
 * `null` 与数字的分界是这个函数的全部价值：静音、噪声、窗口装不下 3 个周期，
 * 三种情况都返回 `null`，**绝不返回一个看起来像基频的数字**。
 *
 * @throws {PitchConfigError} 参数不成立，或窗口短到整个 `[minHz, maxHz]`
 *   区间都测不了——那时候没有任何一个窗口的结果作数，逐个返回 null 是
 *   在掩盖配置错误，所以直接抛。
 */
export function extractPitch(input: ExtractPitchInput): (number | null)[] {
  const {
    samples,
    sampleRate,
    windowMs = DEFAULT_WINDOW_MS,
    hopMs = DEFAULT_HOP_MS,
    minHz = DEFAULT_MIN_HZ,
    maxHz = DEFAULT_MAX_HZ,
  } = input;

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new PitchConfigError(`sampleRate 必须是正数，收到 ${sampleRate}`);
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new PitchConfigError(`windowMs 必须是正数，收到 ${windowMs}`);
  }
  if (!Number.isFinite(hopMs) || hopMs <= 0) {
    throw new PitchConfigError(`hopMs 必须是正数，收到 ${hopMs}`);
  }
  if (!Number.isFinite(minHz) || minHz <= 0 || !Number.isFinite(maxHz) || maxHz <= minHz) {
    throw new PitchConfigError(`需要 0 < minHz < maxHz，收到 minHz=${minHz} maxHz=${maxHz}`);
  }

  const windowSamples = Math.round((sampleRate * windowMs) / 1000);
  const hopSamples = Math.max(1, Math.round((sampleRate * hopMs) / 1000));

  if (windowSamples < 1) {
    throw new PitchConfigError(
      `窗口 ${windowMs}ms 在 ${sampleRate}Hz 下不足一个采样`,
    );
  }

  // 这个窗口能确认的最低频率。低于它的读数装不下 3 个周期，一律不作数。
  const resolvableFloorHz = (MIN_PERIODS_PER_WINDOW * sampleRate) / windowSamples;

  if (resolvableFloorHz > maxHz) {
    // 整个区间都测不了。这正是参考实现在 16 kHz / 44.1 kHz 下的处境——
    // 它在这里返回了 788 个数字，我们在这里抛错。
    throw new PitchConfigError(
      `窗口 ${windowMs}ms（${windowSamples} 个采样 @ ${sampleRate}Hz）装不下 ` +
        `${MIN_PERIODS_PER_WINDOW} 个周期的任何目标频率：` +
        `最低可测 ${resolvableFloorHz.toFixed(1)}Hz，已超过 maxHz=${maxHz}Hz。` +
        `把 windowMs 调大到至少 ${Math.ceil((MIN_PERIODS_PER_WINDOW * 1000) / maxHz)}ms。`,
    );
  }

  const detect = AMDF({ sampleRate, minFrequency: minHz, maxFrequency: maxHz });

  const raw: (number | null)[] = [];
  for (let start = 0; start + windowSamples <= samples.length; start += hopSamples) {
    raw.push(detectOne(samples.subarray(start, start + windowSamples)));
  }

  return removeNoise(raw);

  function detectOne(window: Float32Array): number | null {
    // 全静音没有音高。不先挡掉的话 AMDF 会对一段零信号给出一个数字——
    // 又是「算错且不报错」。
    if (!hasEnergy(window)) return null;

    const hz = detect(window);
    if (hz === null || !Number.isFinite(hz)) return null;
    if (hz < minHz || hz > maxHz) return null;
    // 落在区间内但窗口装不下 3 个周期：读数存在，可信度不存在。
    if (hz < resolvableFloorHz) return null;
    return hz;
  }
}

/**
 * 一条音高曲线，以及画它所需要的全部信息。
 *
 * `hopMs` 必须随 `hz` 一起走。只发数组的话，客户端就得自己知道帧移是多少——
 * 而那正是「客户端和服务端各硬编码一份常量」这一类问题，
 * `contract.ts` 存在的全部意义就是消灭它。
 */
export interface PitchContour {
  hz: (number | null)[];
  hopMs: number;
}

/**
 * `extractPitch` 的成品形态：连同帧移一起返回。
 *
 * 这是跨层传输用的那个函数。`extractPitch` 只回数组，因为它是纯算法；
 * 一旦这条曲线要过网络或过 IPC，帧移就必须跟着一起走。
 */
export function contourOf(input: ExtractPitchInput): PitchContour {
  return {
    hz: extractPitch(input),
    hopMs: input.hopMs ?? DEFAULT_HOP_MS,
  };
}

/** 窗口里有没有信号。阈值取 Int16 的一个量化单位，低于它就是数字静音。 */
const SILENCE_FLOOR = 1 / 32768;

function hasEnergy(window: Float32Array): boolean {
  for (let i = 0; i < window.length; i++) {
    if (Math.abs(window[i] as number) > SILENCE_FLOOR) return true;
  }
  return false;
}

/**
 * 把偏离邻域太远的点抹成 `null`。
 *
 * 参考实现（`enjoy/src/utils.ts:26`）的同名函数有两个缺陷，这里都不重犯：
 *
 * ```js
 * numbers.forEach((num, i) => { … numbers[i] = null; });  // 原地改入参
 * const prevNum = numbers[i - 1] || num;                   // 把合法的 0 当 falsy
 * ```
 *
 * **一、原地修改入参。** 调用方手里的数组被悄悄改掉，而且更糟的是——
 * 它一边写一边读：`numbers[i - 1]` 可能已经在上一轮被置成 `null` 了，
 * 于是 `null || num` 退化成 `num`，判据变成「和自己比」，恒不越界。
 * 也就是说**一旦出现第一个野点，紧跟其后的野点就再也检不出来**。
 * 这里返回新数组，邻居一律从原始输入读。
 *
 * **二、`||` 把 0 当缺席。** 0 Hz 是合法读数（表示测不出），`0 || num` 会
 * 把它换成当前值。这里用 `??`，只有真正的 `null` 才回落。
 */
export function removeNoise(
  values: readonly (number | null)[],
  threshold: number = DEFAULT_NOISE_THRESHOLD,
): (number | null)[] {
  const out = values.slice();

  for (let i = 0; i < values.length; i++) {
    const current = values[i];
    if (current === null || current === undefined) continue;
    // 第一个点没有左邻居，无从判断。留着，不猜。
    if (i === 0) continue;

    const prev = values[i - 1] ?? current;
    const next = values[i + 1] ?? current;
    const avgNeighbor = (prev + next) / 2;

    if (Math.abs(current - avgNeighbor) > threshold * Math.abs(avgNeighbor)) {
      out[i] = null;
    }
  }

  return out;
}
