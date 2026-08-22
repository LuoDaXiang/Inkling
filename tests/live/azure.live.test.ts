import { describe, test, expect, beforeAll } from "vitest";
import { AzureTtsProvider } from "@/providers/tts/azure";
import { parseWav } from "@/core/audio/wav";
import { synthesize } from "@/core/tts/synthesize";
import { MemoryAudioStore } from "@/storage/audio-store";

/**
 * 真实调用 Azure。要密钥、要网络、会消耗免费额度。
 *
 *   npm run test:live
 *
 * 没配 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION 时整组跳过而不是失败——
 * 否则任何人克隆仓库跑测试都是红的。
 *
 * 断言原则（学微软自己的 SDK 测试）：不比对音频内容，只验证结构完整、
 * 时长合理、参数正确。同一段文字合成两次字节可能不同，比对内容必然不稳定。
 */

const KEY = process.env["AZURE_SPEECH_KEY"];
const REGION = process.env["AZURE_SPEECH_REGION"];
const VOICE = process.env["AZURE_TTS_VOICE"] ?? "en-US-AvaNeural";

const ready = Boolean(KEY && REGION);
const describeIf = ready ? describe : describe.skip;

/** 12 词，正常语速约 4 秒。 */
const SAMPLE = "The quick brown fox jumps over the lazy dog while the cat watches.";

describeIf("Azure TTS live", () => {
  let provider: AzureTtsProvider;

  beforeAll(() => {
    provider = new AzureTtsProvider({ key: KEY!, region: REGION! });
  });

  test("合成一句话，返回结构完整的 WAV", async () => {
    const result = await provider.synthesize({ text: SAMPLE, voice: VOICE });

    // parseWav 会验证 RIFF/WAVE/fmt/PCM/data，以及声明长度与实际字节数是否一致
    const info = parseWav(result.audio);

    expect(info.sampleRate).toBe(24000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(result.format).toBe("wav");
    expect(result.sampleRate).toBe(info.sampleRate);
  });

  test("时长落在合理区间", async () => {
    const result = await provider.synthesize({ text: SAMPLE, voice: VOICE });
    const { duration } = parseWav(result.audio);

    // 12 词，宽松地卡在 2-10 秒。太紧会因为音色语速差异而 flaky
    expect(duration).toBeGreaterThan(2);
    expect(duration).toBeLessThan(10);
  });

  test("两次合成时长相差不超过 10%", async () => {
    const a = parseWav((await provider.synthesize({ text: SAMPLE, voice: VOICE })).audio);
    const b = parseWav((await provider.synthesize({ text: SAMPLE, voice: VOICE })).audio);

    // 不能断言字节相等——非确定性输出只能比对容差
    const longer = Math.max(a.duration, b.duration);
    expect(Math.abs(a.duration - b.duration) / longer).toBeLessThan(0.1);
  });

  test("降低语速会让音频变长", async () => {
    const normal = parseWav((await provider.synthesize({ text: SAMPLE, voice: VOICE })).audio);
    const slow = parseWav(
      (await provider.synthesize({ text: SAMPLE, voice: VOICE, speed: 0.7 })).audio,
    );

    expect(slow.duration).toBeGreaterThan(normal.duration * 1.1);
  });

  test("含特殊字符的文本能正常合成（转义生效）", async () => {
    const tricky = `Tom & Jerry's "<show>" is on at 5 p.m.`;

    const result = await provider.synthesize({ text: tricky, voice: VOICE });

    expect(() => parseWav(result.audio)).not.toThrow();
  });

  test("无效密钥返回 auth 而不是别的分类", async () => {
    const bad = new AzureTtsProvider({ key: "invalid-key-for-test", region: REGION! });

    await expect(bad.synthesize({ text: "hi", voice: VOICE })).rejects.toMatchObject({
      kind: "auth",
    });
  });

  test("无效音色名返回 rejected", async () => {
    await expect(
      provider.synthesize({ text: "hi", voice: "en-US-NoSuchVoiceNeural" }),
    ).rejects.toMatchObject({ kind: "rejected" });
  });

  test("经过编排层：第二次命中缓存，不再请求 Azure", async () => {
    const store = new MemoryAudioStore();
    const deps = { provider, store };
    const req = { text: SAMPLE, voice: VOICE };

    const first = await synthesize(req, deps);
    const second = await synthesize(req, deps);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.key).toBe(first.key);
  });
});

if (!ready) {
  describe("Azure TTS live", () => {
    test.skip("未配置 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION，跳过", () => {
      expect(true).toBe(true);
    });
  });
}
