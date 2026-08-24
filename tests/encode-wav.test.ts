import { describe, test, expect } from "vitest";
import { encodeWav } from "@/core/audio/encode-wav";
import { parseWav, InvalidWavError, MAX_ASSESSABLE_SECONDS } from "@/core/audio/wav";
import { MAX_AUDIO_BYTES } from "@/http/server";

/**
 * 输入空间分类（判据一，见 docs/decisions.md 0006）
 *
 *   A. 往返一致 —— 编码后用 parseWav 读回来，头部字段与采样数据都对
 *   B. 字节级正确 —— 小端、魔数、长度字段
 *   C. 长度边界 —— 空、单采样、30 秒满额
 *   D. 参数校验 —— 采样率、声道数
 *   E. 内存视图 —— byteOffset 不为零的 Int16Array
 *   F. 跨层约束 —— 编出来的东西必须能过 assertAssessable 和请求体上限（判据五）
 *
 * 为什么这些类是穷尽的：编码器只做两件事——**写 44 字节头**（B、D）和
 * **写采样数据**（B、E）。A 是这两件事都做对的充要证明，C 覆盖长度维度的
 * 三个端点，F 是它和相邻两层的接缝。
 *
 * 判据四的落法：验证器用的是 parseWav —— **另一套独立写的代码**，
 * 不是照着编码器反推的。往返一致因此是真的交叉验证，不是自说自话。
 */

const tone = (n: number, amplitude = 8000): Int16Array =>
  Int16Array.from({ length: n }, (_, i) => Math.round(amplitude * Math.sin(i / 8)));

describe("A. 往返一致 —— parseWav 是独立的验证器", () => {
  test("头部字段全部正确", () => {
    const info = parseWav(encodeWav(tone(16000), { sampleRate: 16000 }));
    expect(info.sampleRate).toBe(16000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.dataBytes).toBe(32000);
    expect(info.duration).toBeCloseTo(1, 5);
  });

  test("采样数据一个字节都不差", () => {
    const samples = tone(1000);
    const wav = encodeWav(samples, { sampleRate: 16000 });

    // 跳过 44 字节头，逐个采样读回来比对。
    const view = new DataView(wav.buffer, wav.byteOffset + 44, samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      expect(view.getInt16(i * 2, true)).toBe(samples[i]);
    }
  });

  test.each([[8000], [16000], [22050], [24000], [44100], [48000]])(
    "%i Hz 往返正确",
    (sampleRate) => {
      const info = parseWav(encodeWav(tone(sampleRate), { sampleRate }));
      expect(info.sampleRate).toBe(sampleRate);
      expect(info.duration).toBeCloseTo(1, 5);
    },
  );

  test("极值采样往返不失真", () => {
    const extremes = Int16Array.from([-32768, -1, 0, 1, 32767]);
    const wav = encodeWav(extremes, { sampleRate: 16000 });
    const view = new DataView(wav.buffer, wav.byteOffset + 44);

    for (let i = 0; i < extremes.length; i++) {
      expect(view.getInt16(i * 2, true)).toBe(extremes[i]);
    }
  });
});

describe("B. 字节级正确", () => {
  const wav = encodeWav(tone(100), { sampleRate: 16000 });
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...wav.slice(offset, offset + length));

  test("四个魔数在正确的位置", () => {
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(ascii(36, 4)).toBe("data");
  });

  test("多字节字段是小端 —— 写反了文件能播但全是噪声", () => {
    // 这一条必须断言具体字节。parseWav 也按小端读，两边同时写反的话
    // 往返测试照样通过，只有听才知道错。
    const view = new DataView(wav.buffer, wav.byteOffset);
    // 16000 = 0x3E80，小端存储是 80 3E 00 00
    expect(wav[24]).toBe(0x80);
    expect(wav[25]).toBe(0x3e);
    expect(view.getUint32(24, true)).toBe(16000);
  });

  test("RIFF 长度字段 = 总长度 - 8", () => {
    const view = new DataView(wav.buffer, wav.byteOffset);
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
  });

  test("data 长度字段 = 采样数 × 2", () => {
    const view = new DataView(wav.buffer, wav.byteOffset);
    expect(view.getUint32(40, true)).toBe(200);
  });

  test("字节率与块对齐算对了", () => {
    const view = new DataView(wav.buffer, wav.byteOffset);
    expect(view.getUint32(28, true)).toBe(32000); // 16000 × 2
    expect(view.getUint16(32, true)).toBe(2);
  });

  test("总长度 = 44 + 采样数 × 2", () => {
    expect(wav.byteLength).toBe(44 + 200);
  });
});

describe("C. 长度边界", () => {
  test("空采样被拒绝 —— 和 parseWav 的判定保持一致", () => {
    // 两边不一致的话，会编出一个自己读不回来的文件。
    expect(() => encodeWav(new Int16Array(0), { sampleRate: 16000 })).toThrow(InvalidWavError);
  });

  test("单个采样是合法的最短音频", () => {
    const info = parseWav(encodeWav(Int16Array.from([1234]), { sampleRate: 16000 }));
    expect(info.dataBytes).toBe(2);
  });

  test("30 秒满额", () => {
    const info = parseWav(encodeWav(tone(480_000), { sampleRate: 16000 }));
    expect(info.duration).toBeCloseTo(30, 5);
  });
});

describe("D. 参数校验", () => {
  test.each([[0], [-1], [1.5], [NaN]])("采样率 %s 被拒绝", (sampleRate) => {
    expect(() => encodeWav(tone(10), { sampleRate })).toThrow(InvalidWavError);
  });

  test("多声道被拒绝 —— 对跟读没有意义", () => {
    expect(() => encodeWav(tone(10), { sampleRate: 16000, channels: 2 })).toThrow(
      /只支持单声道/,
    );
  });

  test("显式传 1 声道是允许的", () => {
    expect(() => encodeWav(tone(10), { sampleRate: 16000, channels: 1 })).not.toThrow();
  });
});

describe("E. 内存视图 —— byteOffset 不为零", () => {
  test("从大缓冲区切出来的视图，只编它自己那一段", () => {
    // Int16Array 可以是大 buffer 上的一个切片。直接读 .buffer 会拿到
    // 整个底层缓冲，把别人的数据也编进音频里——而且不报错。
    const big = new Int16Array([9999, 9999, 111, 222, 333, 9999]);
    const slice = big.subarray(2, 5);
    expect(slice.byteOffset).toBe(4);

    const wav = encodeWav(slice, { sampleRate: 16000 });
    const view = new DataView(wav.buffer, wav.byteOffset + 44);

    expect(parseWav(wav).dataBytes).toBe(6);
    expect(view.getInt16(0, true)).toBe(111);
    expect(view.getInt16(2, true)).toBe(222);
    expect(view.getInt16(4, true)).toBe(333);
  });

  test("视图的内容和独立数组编出来的一致", () => {
    const big = new Int16Array([1, 2, 3, 4, 5]);
    const fromView = encodeWav(big.subarray(1, 4), { sampleRate: 16000 });
    const fromOwn = encodeWav(Int16Array.from([2, 3, 4]), { sampleRate: 16000 });
    expect(Array.from(fromView)).toEqual(Array.from(fromOwn));
  });
});

// 判据五（decisions 0026）：跨层约束要有整条链的断言，让数字自己对账。
// 上一次失守的形态是 MAX_BODY_BYTES = 64KB 而 30 秒音频是 960KB——
// 两个模块各自自洽，拼起来是坏的。
describe("F. 跨层约束对账", () => {
  test("30 秒 16kHz 音频编码后能过请求体上限", () => {
    const wav = encodeWav(tone(MAX_ASSESSABLE_SECONDS * 16000), { sampleRate: 16000 });
    expect(wav.byteLength).toBeLessThan(MAX_AUDIO_BYTES);
  });

  test("30 秒 48kHz 音频会超请求体上限 —— 所以必须在浏览器端就录 16kHz", () => {
    // 这条不是在测失败，是在把「为什么必须 16kHz」这个约束钉死。
    // 有人哪天改成 48kHz，这里会告诉他后果。
    const wav = encodeWav(tone(MAX_ASSESSABLE_SECONDS * 48000), { sampleRate: 48000 });
    expect(wav.byteLength).toBeGreaterThan(MAX_AUDIO_BYTES);
  });

  test("编出来的 30 秒音频恰好能过 assertAssessable", () => {
    const info = parseWav(encodeWav(tone(MAX_ASSESSABLE_SECONDS * 16000), { sampleRate: 16000 }));
    expect(info.duration).toBeLessThanOrEqual(MAX_ASSESSABLE_SECONDS);
  });
});
