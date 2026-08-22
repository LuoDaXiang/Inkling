import { describe, test, expect } from "vitest";
import { parseWav, buildWav, InvalidWavError } from "@/core/audio/wav";

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
});
