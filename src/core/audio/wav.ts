/**
 * WAV 结构校验。
 *
 * 音频没有「正确答案」——同一段文字合成两次，字节可能都不一样。
 * 所以不能比对内容，只能验证结构。这个做法来自微软 Speech SDK 的测试
 * （tests/SpeechSynthesisTests.ts 的 CheckRiffPcmComplete）。
 *
 * 它能抓到的最重要的一类问题是「音频被截断」：文件头声称有 10 秒，
 * 实际只传了 3 秒。这种文件能播放、不报错，只是短了一截——
 * 在跟读场景里会表现为「评分莫名其妙地低」，极难定位。
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  /** 秒。 */
  duration: number;
}

export class InvalidWavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWavError";
  }
}

const HEADER_BYTES = 44;

function ascii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/**
 * 解析并校验一个 RIFF PCM WAV。任何一项不符就抛错。
 * 返回的 duration 可以用来做「时长是否合理」的断言。
 */
export function parseWav(audio: Uint8Array): WavInfo {
  if (audio.byteLength < HEADER_BYTES) {
    throw new InvalidWavError(
      `长度 ${audio.byteLength} 字节，不足一个 ${HEADER_BYTES} 字节的 WAV 头`,
    );
  }

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);

  const riff = ascii(view, 0, 4);
  if (riff !== "RIFF") throw new InvalidWavError(`期望 RIFF，实际 "${riff}"`);

  const wave = ascii(view, 8, 4);
  if (wave !== "WAVE") throw new InvalidWavError(`期望 WAVE，实际 "${wave}"`);

  const fmt = ascii(view, 12, 4);
  if (fmt !== "fmt ") throw new InvalidWavError(`期望 "fmt "，实际 "${fmt}"`);

  const audioFormat = view.getUint16(20, true);
  if (audioFormat !== 1) {
    throw new InvalidWavError(`期望 PCM（格式码 1），实际 ${audioFormat}`);
  }

  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const byteRate = view.getUint32(28, true);
  const bitsPerSample = view.getUint16(34, true);

  if (channels === 0) throw new InvalidWavError("声道数为 0");
  if (sampleRate === 0) throw new InvalidWavError("采样率为 0");
  if (byteRate === 0) throw new InvalidWavError("字节率为 0");

  const data = ascii(view, 36, 4);
  if (data !== "data") throw new InvalidWavError(`期望 data 块，实际 "${data}"`);

  const dataBytes = view.getUint32(40, true);
  if (dataBytes === 0) throw new InvalidWavError("data 块长度为 0，音频是空的");

  // 这一条是截断检测：文件头声明的长度必须和实际字节数对得上
  const expected = dataBytes + HEADER_BYTES;
  if (audio.byteLength !== expected) {
    throw new InvalidWavError(
      `音频被截断或有多余数据：头部声明 ${expected} 字节，实际 ${audio.byteLength} 字节`,
    );
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
    duration: dataBytes / byteRate,
  };
}

/** 构造一个合法的 WAV，供测试使用。 */
export function buildWav(options: {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  samples?: number;
} = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 24000;
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const samples = options.samples ?? 24000;

  const blockAlign = (channels * bitsPerSample) / 8;
  const dataBytes = samples * blockAlign;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);

  return new Uint8Array(buffer);
}
