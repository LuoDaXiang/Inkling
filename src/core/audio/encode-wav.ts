import { InvalidWavError } from "./wav";

/**
 * Int16 采样编码成 WAV 字节。
 *
 * `buildWav()` 只能产静音、给测试造 WAV 头用；这个才是真正的编码器。
 *
 * 编码器出错的方式很隐蔽——字节序写反了文件照样能播，只是全是噪声；
 * 头部长度字段算错了播放器会截断或读出垃圾。这两种都不报错。
 * 好在 `parseWav()` 已经存在，编码完用它读回来断言，往返一致
 * 就是最强的验证：编码和解码是两套独立的代码。
 */

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;

export interface EncodeWavOptions {
  sampleRate: number;
  /** 只支持单声道。多声道对跟读没有意义，且会让评分接口的行为更难预测。 */
  channels?: number;
}

export function encodeWav(samples: Int16Array, options: EncodeWavOptions): Uint8Array {
  const { sampleRate } = options;
  const channels = options.channels ?? 1;

  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new InvalidWavError(`采样率必须是正整数，收到 ${sampleRate}`);
  }
  if (channels !== 1) {
    throw new InvalidWavError(`只支持单声道，收到 ${channels} 声道`);
  }
  // 空音频要在这里拒绝，和 parseWav 的「data 块长度为 0」判定保持一致。
  // 两边不一致的话，会编出一个自己读不回来的文件。
  if (samples.length === 0) {
    throw new InvalidWavError("没有采样数据，无法编码");
  }

  const blockAlign = (channels * BITS_PER_SAMPLE) / 8;
  const dataBytes = samples.length * blockAlign;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  let offset = 0;
  const ascii = (text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset++, text.charCodeAt(i));
  };
  // WAV 的所有多字节字段都是**小端**。写反了文件能播但全是噪声，
  // 而 parseWav 照样读得出头——只有听才知道错，所以测试要断言具体字节。
  const u32 = (value: number): void => {
    view.setUint32(offset, value, true);
    offset += 4;
  };
  const u16 = (value: number): void => {
    view.setUint16(offset, value, true);
    offset += 2;
  };

  ascii("RIFF");
  u32(36 + dataBytes);
  ascii("WAVE");
  ascii("fmt ");
  u32(16); // fmt 块长度
  u16(1); // 1 = PCM
  u16(channels);
  u32(sampleRate);
  u32(sampleRate * blockAlign); // 字节率
  u16(blockAlign);
  u16(BITS_PER_SAMPLE);
  ascii("data");
  u32(dataBytes);

  // 逐个写而不是整块 set。
  //
  // 直接用 new Uint8Array(samples.buffer) 会踩两个坑：
  //   1. samples 可能是大缓冲区上的一个视图（byteOffset 不为零），
  //      那样会把别人的数据也编进音频里
  //   2. 那种写法依赖运行平台的字节序，而 WAV 规定必须小端
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, samples[i] as number, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}
