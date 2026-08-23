import { describe, test, expect } from "vitest";
import { parseWav, buildWav, assertAssessable, InvalidWavError } from "@/core/audio/wav";
import type { WavInfo } from "@/core/audio/wav";

/**
 * 校验器本身也要被测——而且要正反两面都测：
 *   合法的必须通过（否则会误报，把好音频当坏的）
 *   非法的必须拒绝（否则会漏报，校验形同虚设）
 * 只测其中一面是新手最常见的错误。
 */

describe("parseWav", () => {
  describe("合法输入必须通过", () => {
    test("默认 1 秒 24kHz 单声道", () => {
      const info = parseWav(buildWav());

      expect(info.sampleRate).toBe(24000);
      expect(info.channels).toBe(1);
      expect(info.bitsPerSample).toBe(16);
      expect(info.duration).toBeCloseTo(1, 5);
    });

    test("立体声", () => {
      const info = parseWav(buildWav({ channels: 2, samples: 48000 }));

      expect(info.channels).toBe(2);
      expect(info.duration).toBeCloseTo(2, 5);
    });

    test("不同采样率", () => {
      const info = parseWav(buildWav({ sampleRate: 16000, samples: 8000 }));

      expect(info.sampleRate).toBe(16000);
      expect(info.duration).toBeCloseTo(0.5, 5);
    });

    test("最短的合法音频（1 个采样）", () => {
      const info = parseWav(buildWav({ samples: 1 }));

      expect(info.dataBytes).toBe(2);
    });
  });

  describe("非法输入必须拒绝", () => {
    const expectReject = (audio: Uint8Array, pattern: RegExp): void => {
      expect(() => parseWav(audio)).toThrow(InvalidWavError);
      expect(() => parseWav(audio)).toThrow(pattern);
    };

    test("空字节", () => {
      expectReject(new Uint8Array(0), /不足一个/);
    });

    test("只有半个头", () => {
      expectReject(buildWav().slice(0, 20), /不足一个/);
    });

    test("恰好 43 字节（差一个字节的边界）", () => {
      expectReject(new Uint8Array(43), /不足一个/);
    });

    test("RIFF 标记错误（可能是 MP3 被当成 WAV）", () => {
      const audio = buildWav();
      audio.set([0x49, 0x44, 0x33, 0x33], 0); // "ID33"
      expectReject(audio, /期望 RIFF/);
    });

    test("WAVE 标记错误", () => {
      const audio = buildWav();
      audio.set([0x41, 0x56, 0x49, 0x20], 8); // "AVI "
      expectReject(audio, /期望 WAVE/);
    });

    test("非 PCM 格式码（压缩音频）", () => {
      const audio = buildWav();
      new DataView(audio.buffer).setUint16(20, 3, true); // IEEE float
      expectReject(audio, /期望 PCM/);
    });

    test("采样率为 0", () => {
      const audio = buildWav();
      new DataView(audio.buffer).setUint32(24, 0, true);
      expectReject(audio, /采样率为 0/);
    });

    test("data 块长度为 0（空音频）", () => {
      const audio = buildWav();
      new DataView(audio.buffer).setUint32(40, 0, true);
      expectReject(audio, /音频是空的/);
    });

    test("音频被截断 —— 这是最重要的一条", () => {
      // 头部说有 1 秒，实际只传了一半。文件能播、不报错、只是短了一截。
      const full = buildWav();
      const truncated = full.slice(0, 44 + (full.byteLength - 44) / 2);

      expectReject(truncated, /被截断/);
    });

    test("尾部有多余数据", () => {
      const full = buildWav();
      const padded = new Uint8Array(full.byteLength + 100);
      padded.set(full, 0);

      expectReject(padded, /多余数据/);
    });
  });

  // RIFF 是块结构，不是固定布局。此前这里按「data 一定在偏移 36」硬读，
  // 凡是 ffmpeg 转出来的文件（带 LIST INFO 块）一概拒收——而 Azure 照单全收。
  // 我们自己的 TTS 和测试数据恰好都产干净的 44 字节头，所以整套测试全部漏过。
  describe("真实世界的 WAV 变体必须接受", () => {
    /** fmt 和 data 之间插一个块，模拟 ffmpeg / Audacity 的产物。 */
    const withChunk = (id: string, payload: string, samples = 1600): Uint8Array => {
      const dataBytes = samples * 2;
      const pad = payload.length % 2; // RIFF 规范：奇数长度的块要补一个字节
      const total = 12 + 24 + (8 + payload.length + pad) + 8 + dataBytes;
      const buffer = new ArrayBuffer(total);
      const view = new DataView(buffer);
      let offset = 0;
      const text = (s: string): void => {
        for (const ch of s) view.setUint8(offset++, ch.charCodeAt(0));
      };
      const u32 = (x: number): void => {
        view.setUint32(offset, x, true);
        offset += 4;
      };
      const u16 = (x: number): void => {
        view.setUint16(offset, x, true);
        offset += 2;
      };

      text("RIFF");
      u32(total - 8);
      text("WAVE");
      text("fmt ");
      u32(16);
      u16(1);
      u16(1);
      u32(16000);
      u32(32000);
      u16(2);
      u16(16);
      text(id);
      u32(payload.length);
      for (const ch of payload) view.setUint8(offset++, ch.charCodeAt(0));
      offset += pad;
      text("data");
      u32(dataBytes);
      return new Uint8Array(buffer);
    };

    test("LIST INFO 块，偶数长度", () => {
      const info = parseWav(withChunk("LIST", "INFOISFT\u0000Lavf58.29.10\u0000"));
      expect(info.sampleRate).toBe(16000);
      expect(info.channels).toBe(1);
    });

    test("LIST INFO 块，奇数长度需要填充字节", () => {
      const info = parseWav(withChunk("LIST", "INFOISFT\u0000Lavf58.29.100\u0000"));
      expect(info.dataBytes).toBe(3200);
    });

    test("fact 块", () => {
      const info = parseWav(withChunk("fact", "\u0000\u0000\u0000\u0000"));
      expect(info.sampleRate).toBe(16000);
    });

    test("多个块连续出现", () => {
      const info = parseWav(withChunk("cue ", "0123456789abcdef"));
      expect(info.channels).toBe(1);
    });
  });
});

describe("assertAssessable", () => {
  const at = (seconds: number): WavInfo => ({
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    dataBytes: seconds * 32000,
    duration: seconds,
  });

  test("30 秒以内放行", () => {
    expect(() => assertAssessable(at(29.9))).not.toThrow();
  });

  test("恰好 30 秒放行（边界）", () => {
    expect(() => assertAssessable(at(30))).not.toThrow();
  });

  test("超过 30 秒拒绝", () => {
    // 实测：73 秒的音频，Azure 返回 HTTP 200、状态 Success、完整度 49
    // （约等于 35/73）。它静默截断，不报错。用户完整读完却看到完整度腰斩，
    // 会以为自己漏读了一半。这一条必须在送出前挡住。
    expect(() => assertAssessable(at(30.1))).toThrow(InvalidWavError);
    expect(() => assertAssessable(at(73))).toThrow(/静默截断/);
  });
});
