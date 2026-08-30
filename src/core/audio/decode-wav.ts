import { InvalidWavError, parseWav } from "./wav";

/**
 * 把一个 16 位 PCM WAV 解成 `Float32Array`，供音高分析用。
 *
 * 与 `encode-wav.ts` 成对：那边 Int16 → 字节，这边字节 → Float32。
 *
 * **结构校验不在这里做**，走 `parseWav`。它已经有一整套用例守着
 * 「音频被截断」这类问题，再写一遍块遍历就是第二份实现——
 * 0043 记的正是这条：同一件事有两份实现，将来只会改一处。
 * 所以 `WavInfo` 加了 `dataOffset`，解码器从那里开始读。
 *
 * **只认 16 位。** Azure 的五种输出格式全是 `16bit`（`azure.ts:30–34`），
 * 8 位和 24 位在这条链路上不会出现。真出现了就抛错，而不是按 16 位硬读——
 * 那会解出一段听起来像噪声的采样，然后音高曲线画出一堆合理但错误的数字。
 *
 * **多声道取第一声道**，不做混音。参考音是单声道 TTS，多声道只会来自
 * 用户导入的文件；取第一声道是可预测的行为，混音则要处理相位抵消。
 */
export interface DecodedWav {
  samples: Float32Array;
  sampleRate: number;
}

/** Int16 满量程。除以它而不是 32767，和 `pcm.ts` 的编码方向保持一致。 */
const INT16_SCALE = 32768;

export function decodeWav(audio: Uint8Array): DecodedWav {
  const info = parseWav(audio);

  if (info.bitsPerSample !== 16) {
    throw new InvalidWavError(
      `只支持 16 位 PCM，收到 ${info.bitsPerSample} 位`,
    );
  }

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const bytesPerSample = 2;
  const frameBytes = bytesPerSample * info.channels;
  const frames = Math.floor(info.dataBytes / frameBytes);

  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    // 只读第一声道。
    samples[i] = view.getInt16(info.dataOffset + i * frameBytes, true) / INT16_SCALE;
  }

  return { samples, sampleRate: info.sampleRate };
}
