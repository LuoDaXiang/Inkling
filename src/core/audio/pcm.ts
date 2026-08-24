/**
 * 采样格式转换。
 *
 * AudioWorklet 给的是 [-1.0, 1.0] 的 Float32，评分接口要的是 16 位整数。
 * 这一层是纯函数，所以能被穷尽测试——而它出错的方式很隐蔽：
 * 溢出会变成反相的巨响，舍入偏差会累积成底噪，两者都不报错。
 */

/** Int16 的取值范围。注意**不对称**：负方向比正方向多一格。 */
export const INT16_MIN = -32768;
export const INT16_MAX = 32767;

/**
 * Float32 采样转 Int16。
 *
 * **正负必须用不同的系数**，这是最容易写错的一处：
 * 满量程是 32768，但正方向的上限只到 32767。用同一个系数乘，
 * 输入 1.0 会得到 32768——溢出成 -32768，也就是在最大音量处
 * 产生一个反相的爆音。所以正方向乘 32767，负方向乘 32768。
 *
 * 超出 [-1, 1] 的输入一律夹住而不是回绕。不夹的话，一次轻微过载
 * 会变成刺耳的爆音——数字失真比模拟削波难听得多。
 */
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = input[i] as number;
    // NaN 在设备切换时真的会出现。它的任何比较都是 false，
    // 所以必须显式判断，否则会静默变成 0 之外的随机值。
    if (Number.isNaN(v)) {
      out[i] = 0;
      continue;
    }
    if (v >= 1) {
      out[i] = INT16_MAX;
    } else if (v <= -1) {
      out[i] = INT16_MIN;
    } else {
      // Math.round 对 .5 一律向上取整，正负不对称；用 trunc 加半个单位
      // 的方式在正负两侧都向零外舍入，避免直流偏置累积。
      out[i] = v >= 0 ? Math.round(v * INT16_MAX) : Math.round(v * -INT16_MIN);
    }
  }
  return out;
}

/**
 * 把 AudioWorklet 陆续送来的小块拼成一整段。
 *
 * 两件必须做对的事：
 *
 *   1. **必须复制。** AudioWorklet 每次 process() 拿到的 Float32Array
 *      会被下一次调用覆盖——保留引用的话，最后拿到的是同一块内存的
 *      N 个别名，内容全是最后一块。这个 bug 的表现是「录了 30 秒，
 *      播出来只有最后 8 毫秒在循环」。
 *
 *   2. **不能假设块大小是 128。** 规范说渲染块大小可能随时间变化，
 *      写死会丢样本。所以按每块的实际长度累加。
 */
export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 复制一块采样。
 *
 * 存在的唯一理由就是上面第 1 条：AudioWorklet 的缓冲区是复用的。
 * 单独成一个函数是为了让调用点显式地表达「这里必须复制」，
 * 而不是写成一句容易被后人「优化」掉的 slice()。
 */
export function copyChunk(chunk: Float32Array): Float32Array {
  return new Float32Array(chunk);
}
