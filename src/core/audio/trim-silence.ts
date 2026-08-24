/**
 * 掐掉首尾静音。
 *
 * 用户点「录音」到真正开口，中间总有一两秒空白；读完到点「停止」也一样。
 * **这段静音会拉低流利度分数，而它和发音水平毫无关系。**
 * 参考实现在落盘前做这一步，这条值得抄。
 *
 * 但它的参数照抄不得。四件事这一层必须自己想清楚：
 *
 * **一、阈值的单位。** 参考实现结尾用 -100 dBFS，换算成 16 位整数是
 * **0.33 个量化单位**——低于 1，意味着「恰好为 0」。任何一点底噪都掐不动，
 * 结尾这一半等于白做。我们两端都用 -50 dBFS（约 104 个 Int16 单位），
 * 那是个真实的底噪高度。
 *
 * **二、窗口而不是单点，而且要看占比不看能量。** 按单个采样判断的话，
 * 录音开头一声电流爆音就能让整段静音一点都掐不掉。改成看窗口仍不够——
 * 均方根会被离群值放大，一个爆音就能把 10ms 窗口的 RMS 拉到阈值的 20 倍。
 * 所以判据是「窗口内超过阈值的采样占多大比例」。**这个缺陷是测试抓出来的。**
 *
 * **三、起音余量。** p / t / k 的起音是陡峭瞬态，从几乎无声跳到峰值。
 * 切在阈值交越点会削掉起音前沿，听感变闷，**准确度分数下降**。
 * 所以找到语音起点后往前退一段。
 *
 * **四、直流偏置。** 有些麦克风的「静音」段绝对值恒定不为零，
 * 直接算绝对值的话修剪完全失效且不报错。所以测量能量前先去掉均值。
 *
 * 中间的停顿**绝不能碰**——句中停顿是语调评分的素材（服务端会检测
 * 该停没停、不该停却停了），掐掉等于篡改用户的表现。
 */

/** 默认阈值。-50 dBFS ≈ 104 个 Int16 单位，是个真实的底噪高度。 */
export const DEFAULT_THRESHOLD_DBFS = -50;

/** 能量窗口。10 毫秒足够跨过一个音素，又不至于漏掉短促的辅音。 */
export const WINDOW_MS = 10;

/** 起音余量。找到语音起点后往前退这么多，保住爆破音的前沿。 */
export const ONSET_PADDING_MS = 50;

/** 结尾余量。比起音余量长一点，因为词尾的气声衰减得慢。 */
export const TAIL_PADDING_MS = 80;

/**
 * 一个窗口里至少要有这个比例的采样超过阈值，才算「有人在说话」。
 *
 * **不能用均方根。** 平方会放大离群值：一个 30000 的爆音落在 160 个
 * 采样的窗口里，RMS 就被拉到 2371，远超阈值 103——单次咔哒声足以让
 * 整段静音一点都掐不掉。这个缺陷是测试抓出来的，不是想出来的。
 *
 * 按占比就稳健得多：一个爆音只占 1/160 ≈ 0.6%，而正弦语音在
 * 阈值以上的时间占 99%，轻辅音也有 88%。20% 这条线把两者分得很开。
 */
export const MIN_LOUD_FRACTION = 0.2;

export interface TrimOptions {
  sampleRate: number;
  thresholdDbfs?: number;
  windowMs?: number;
  minLoudFraction?: number;
  onsetPaddingMs?: number;
  tailPaddingMs?: number;
}

export interface TrimResult {
  /** 修剪后的采样。全是静音时长度为 0。 */
  samples: Int16Array;
  /** 掐掉了多少个采样，用于日志与排障。 */
  trimmedStart: number;
  trimmedEnd: number;
}

/** dBFS 换算成 Int16 的线性幅度。满量程 32768。 */
export function dbfsToInt16(dbfs: number): number {
  return 10 ** (dbfs / 20) * 32768;
}

export function trimSilence(samples: Int16Array, options: TrimOptions): TrimResult {
  const { sampleRate } = options;
  const threshold = dbfsToInt16(options.thresholdDbfs ?? DEFAULT_THRESHOLD_DBFS);
  const windowSize = Math.max(1, Math.round(((options.windowMs ?? WINDOW_MS) * sampleRate) / 1000));
  const onsetPad = Math.round(((options.onsetPaddingMs ?? ONSET_PADDING_MS) * sampleRate) / 1000);
  const tailPad = Math.round(((options.tailPaddingMs ?? TAIL_PADDING_MS) * sampleRate) / 1000);
  const minFraction = options.minLoudFraction ?? MIN_LOUD_FRACTION;

  if (samples.length === 0) {
    return { samples, trimmedStart: 0, trimmedEnd: 0 };
  }

  // 去掉直流偏置再测能量。不去的话，带 DC 的麦克风录出来的「静音」
  // 绝对值恒定不为零，修剪会完全失效——而且不报错。
  const mean = averageOf(samples);

  const firstLoud = findFirstLoudWindow(samples, mean, threshold, windowSize, minFraction);
  // 一个响的窗口都没有 = 整段都是静音。返回空，让上层判为「没听到声音」。
  if (firstLoud < 0) {
    return { samples: samples.subarray(0, 0), trimmedStart: samples.length, trimmedEnd: 0 };
  }

  const lastLoud = findLastLoudWindow(samples, mean, threshold, windowSize, minFraction, firstLoud);

  const start = Math.max(0, firstLoud - onsetPad);
  const end = Math.min(samples.length, lastLoud + windowSize + tailPad);

  return {
    // subarray 是视图不是副本，不复制字节。编码器逐个采样写，
    // 不依赖底层缓冲区的起点，所以视图是安全的。
    samples: samples.subarray(start, end),
    trimmedStart: start,
    trimmedEnd: samples.length - end,
  };
}

/** 从头找第一个能量超过阈值的窗口，返回它的起始下标。 */
function findFirstLoudWindow(
  samples: Int16Array,
  mean: number,
  threshold: number,
  windowSize: number,
  minFraction: number,
): number {
  for (let start = 0; start < samples.length; start += windowSize) {
    const end = Math.min(start + windowSize, samples.length);
    if (isLoud(samples, start, end, mean, threshold, minFraction)) return start;
  }
  return -1;
}

/**
 * 从尾找最后一个响的窗口，返回它的起始下标。
 *
 * 扫到 firstLoud 就停——那个窗口调用方已经确认是响的，所以一定有结果。
 * 这样写不需要「一个都没找到」的分支：那条分支永远走不到，
 * 而不可达代码写不出测试，也就没有东西能保证它是对的。见 decisions 0029。
 */
function findLastLoudWindow(
  samples: Int16Array,
  mean: number,
  threshold: number,
  windowSize: number,
  minFraction: number,
  firstLoud: number,
): number {
  // 从末尾对齐着往回扫，保证最后一个窗口不会因为长度不足被漏掉。
  for (let end = samples.length; end > firstLoud + windowSize; end -= windowSize) {
    const start = Math.max(0, end - windowSize);
    if (isLoud(samples, start, end, mean, threshold, minFraction)) return start;
  }
  return firstLoud;
}

/**
 * 这个窗口里有没有人在说话。
 *
 * 判据是「超过阈值的采样占多大比例」，不是均方根——见 MIN_LOUD_FRACTION
 * 的注释：平方会放大离群值，一次咔哒声就能骗过 RMS。
 *
 * 每个采样都先减去全局均值，这样带直流偏置的麦克风也能正确判断。
 * 不减的话，「静音」段的绝对值恒定不为零，修剪会完全失效且不报错。
 */
function isLoud(
  samples: Int16Array,
  start: number,
  end: number,
  mean: number,
  threshold: number,
  minFraction: number,
): boolean {
  let loud = 0;
  for (let i = start; i < end; i++) {
    if (Math.abs((samples[i] as number) - mean) >= threshold) loud++;
  }
  return loud / Math.max(1, end - start) >= minFraction;
}

function averageOf(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] as number;
  return sum / samples.length;
}
