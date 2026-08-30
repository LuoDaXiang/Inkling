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
  /**
   * `data` 块负载的起始字节偏移。
   *
   * RIFF 是块结构，`data` 不在固定偏移上（见 parseWav 里那段注释）。
   * 解码器要读采样就必须知道它从哪开始，而重新走一遍块遍历就是
   * 第二份实现——0043 的教训是同一件事不该有两份实现。
   */
  dataOffset: number;
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
  // 一个 PCM WAV 最小也要 44 字节：12 字节 RIFF 头 + 24 字节 fmt 块 + 8 字节 data 块头。
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

  // RIFF 是块结构，不是固定布局。fmt 和 data 之间可以插任意多个块——
  // ffmpeg 会插 LIST INFO，压缩格式会插 fact，fmt 块本身也可能是 18 或 40 字节
  // 而不是 16。此前这里按「data 一定在偏移 36」硬读，凡是 ffmpeg 转出来的
  // 文件一概拒收，而 Azure 照单全收。所以要遍历，不能算偏移。
  let fmtOffset = -1;
  let dataOffset = -1;
  let dataBytes = 0;

  let offset = 12;
  while (offset < audio.byteLength) {
    if (offset + 8 > audio.byteLength) {
      throw new InvalidWavError(
        `尾部有多余数据：剩余 ${audio.byteLength - offset} 字节，不足一个块头`,
      );
    }

    const id = ascii(view, offset, 4);
    // 块标识必须是四个可打印 ASCII 字符。补零填充、随机尾巴都会在这里被挡下。
    if (!/^[\x20-\x7e]{4}$/.test(id)) {
      throw new InvalidWavError(`尾部有多余数据：偏移 ${offset} 处不是合法的块标识`);
    }

    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + size > audio.byteLength) {
      throw new InvalidWavError(
        `音频被截断：${id} 块声明 ${size} 字节，实际只剩 ${audio.byteLength - payload} 字节`,
      );
    }

    if (id === "fmt ") fmtOffset = payload;
    if (id === "data") {
      // 空的 data 块要当场报「音频是空的」，不能等走到尾巴再报「有多余数据」——
      // 后者会把真正的原因盖掉。
      if (size === 0) throw new InvalidWavError("data 块长度为 0，音频是空的");
      dataOffset = payload;
      dataBytes = size;
    }

    // 块长度为奇数时补一个填充字节，这是 RIFF 规范要求的。
    offset = payload + size + (size % 2);
  }

  if (fmtOffset < 0) throw new InvalidWavError('缺少 "fmt " 块');
  if (dataOffset < 0) throw new InvalidWavError("期望 data 块，但整个文件里没有");

  const audioFormat = view.getUint16(fmtOffset, true);
  if (audioFormat !== 1) {
    throw new InvalidWavError(`期望 PCM（格式码 1），实际 ${audioFormat}`);
  }

  const channels = view.getUint16(fmtOffset + 2, true);
  const sampleRate = view.getUint32(fmtOffset + 4, true);
  const byteRate = view.getUint32(fmtOffset + 8, true);
  const bitsPerSample = view.getUint16(fmtOffset + 14, true);

  if (channels === 0) throw new InvalidWavError("声道数为 0");
  if (sampleRate === 0) throw new InvalidWavError("采样率为 0");
  if (byteRate === 0) throw new InvalidWavError("字节率为 0");

  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
    dataOffset,
    duration: dataBytes / byteRate,
  };
}

/**
 * 发音评估能不能吃这段音频。
 *
 * 和 parseWav 的结构校验分开：那一层管「这是不是一个合法 WAV」，
 * 这一层管「Azure 拿去评分会不会出问题」。
 *
 * 实测过的两件事，决定了这里挡什么、不挡什么：
 *
 *   - Azure **不强制**单声道或 16kHz。立体声、8kHz 送上去都能评，分数几乎一致。
 *     所以格式不符只是浪费带宽和钱，不会算错——不作为硬性拒绝理由。
 *   - Azure **会静默截断**超长音频。73 秒的音频完整度只给 49 分
 *     （约等于 35/73），HTTP 200、状态 Success、没有任何警告。
 *     用户完整读完却看到「完整度 49」，会以为自己漏读了一半。
 *     **这个必须挡。**
 */
export const MAX_ASSESSABLE_SECONDS = 30;

export function assertAssessable(info: WavInfo): void {
  if (info.duration > MAX_ASSESSABLE_SECONDS) {
    throw new InvalidWavError(
      `音频 ${info.duration.toFixed(1)} 秒，超过发音评估的 ${MAX_ASSESSABLE_SECONDS} 秒上限。` +
        `超长音频会被静默截断，完整度分数会莫名其妙地低——必须先拆句再评。`,
    );
  }
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
