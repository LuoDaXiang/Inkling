import { describe, test, expect } from "vitest";
import { decodeWav } from "@/core/audio/decode-wav";
import { encodeWav } from "@/core/audio/encode-wav";
import { buildWav, InvalidWavError, parseWav } from "@/core/audio/wav";

/**
 * 输入空间分类
 *
 *   A. 往返一致 —— encodeWav 编进去的采样，decodeWav 要一个不差地读回来
 *   B. 块布局 —— data 不在固定偏移上时也要读对  ⭐
 *   C. 位深 —— 只认 16 位，别的当场抛
 *   D. 多声道 —— 取第一声道，不混音
 *
 * **B 组是这里最要紧的一组。** RIFF 是块结构，`data` 块前面可以插
 * `LIST` / `fact` / `cue ` 等任意多个块——ffmpeg 就会插 `LIST INFO`。
 * 按「data 一定在偏移 44」硬读的解码器，遇到这类文件会把块头当采样读，
 * **解出来的是噪声，而且不报错**。`parseWav` 的注释记着这个坑（它自己
 * 就是被这个坑改成遍历的），解码器复用它的 `dataOffset` 正是为了不重犯。
 */

const SR = 16000;

function tone(hz: number, n: number): Int16Array {
  return Int16Array.from({ length: n }, (_, i) =>
    Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / SR)),
  );
}

/** 在 fmt 和 data 之间插一个块，模拟 ffmpeg 的输出。 */
function withChunkBefore(wav: Uint8Array, id: string, payload: string): Uint8Array {
  const extra = 8 + payload.length + (payload.length % 2);
  const out = new Uint8Array(wav.byteLength + extra);
  // 头 36 字节：RIFF 头 12 + fmt 块 24。
  out.set(wav.subarray(0, 36), 0);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) view.setUint8(36 + i, id.charCodeAt(i));
  view.setUint32(40, payload.length, true);
  for (let i = 0; i < payload.length; i++) view.setUint8(44 + i, payload.charCodeAt(i));
  out.set(wav.subarray(36), 36 + extra);
  // RIFF 总长度要跟着涨，否则尾部会被当成多余数据。
  view.setUint32(4, view.getUint32(4, true) + extra, true);
  return out;
}

describe("A. 往返一致", () => {
  test("采样值逐个读回来（除以 32768）", () => {
    const pcm = Int16Array.from([0, 16384, -16384, 32767, -32768]);
    const { samples } = decodeWav(encodeWav(pcm, { sampleRate: SR }));

    expect(samples.length).toBe(5);
    expect(samples[0]).toBeCloseTo(0, 6);
    expect(samples[1]).toBeCloseTo(0.5, 6);
    expect(samples[2]).toBeCloseTo(-0.5, 6);
    expect(samples[3]).toBeCloseTo(32767 / 32768, 6);
    expect(samples[4]).toBeCloseTo(-1, 6);
  });

  test("采样率原样带回来", () => {
    for (const sampleRate of [8000, 16000, 24000, 44100]) {
      const { sampleRate: back } = decodeWav(encodeWav(tone(220, 100), { sampleRate }));
      expect(back).toBe(sampleRate);
    }
  });

  test("采样个数与 data 块声明的一致", () => {
    const wav = encodeWav(tone(220, 1234), { sampleRate: SR });
    expect(decodeWav(wav).samples.length).toBe(1234);
  });
});

describe("B. data 不在固定偏移上", () => {
  test("fmt 与 data 之间插了别的块，采样照样读对", () => {
    const pcm = Int16Array.from([0, 16384, -16384, 32767]);
    const plain = encodeWav(pcm, { sampleRate: SR });
    const padded = withChunkBefore(plain, "LIST", "INFOhand-written");

    // 先确认这份文件本身是合法的，且 data 确实挪位了。
    expect(parseWav(padded).dataOffset).toBeGreaterThan(parseWav(plain).dataOffset);

    expect(Array.from(decodeWav(padded).samples)).toEqual(
      Array.from(decodeWav(plain).samples),
    );
  });

  test("解码器读的是 parseWav 报的 dataOffset，不是硬编码的 44", () => {
    const wav = withChunkBefore(encodeWav(tone(220, 64), { sampleRate: SR }), "fact", "    ");
    expect(parseWav(wav).dataOffset).not.toBe(44);
    expect(decodeWav(wav).samples.length).toBe(64);
  });
});

describe("C. 位深", () => {
  test("8 位 → 抛 InvalidWavError，不按 16 位硬读", () => {
    // 硬读的话会解出一段噪声，而且不报错。
    const wav = buildWav({ bitsPerSample: 8, samples: 100, sampleRate: SR });
    expect(() => decodeWav(wav)).toThrow(InvalidWavError);
  });

  test("24 位同样抛", () => {
    const wav = buildWav({ bitsPerSample: 24, samples: 100, sampleRate: SR });
    expect(() => decodeWav(wav)).toThrow(InvalidWavError);
  });

  test("结构本身坏掉时把 parseWav 的错原样抛出来", () => {
    expect(() => decodeWav(new Uint8Array(10))).toThrow(InvalidWavError);
  });
});

describe("D. 多声道", () => {
  test("取第一声道，帧数按 channels 折算", () => {
    const wav = buildWav({ channels: 2, samples: 50, sampleRate: SR });
    expect(decodeWav(wav).samples.length).toBe(50);
  });
});
