import { describe, test, expect } from "vitest";
import { parseWav } from "@/core/audio/wav";

/**
 * Live 测试：真的调用 TTS，会花时间、可能花钱、会因为网络失败。
 *
 * 用 `npm run test:live` 单独跑，不进日常流程（vitest.config.ts 已排除本目录）。
 * 没有配置密钥/模型时自动跳过，而不是失败——否则新克隆仓库的人一跑测试就是红的。
 *
 * 断言原则（来自微软 Speech SDK 的测试）：
 *   不比对音频内容，只验证结构完整、时长合理、格式正确。
 *   同一段文字合成两次字节可能不同，比对内容必然不稳定。
 */

const provider = process.env["INKLING_TTS_PROVIDER"];
const describeIf = provider ? describe : describe.skip;

describeIf(`TTS live [${provider ?? "未配置"}]`, () => {
  test("占位：接入真实 provider 后填写", () => {
    // 接入 Kokoro / Azure 后，这里应该：
    //   1. 合成一句话
    //   2. parseWav(result.audio) 不抛错（结构完整、未截断）
    //   3. duration 在合理区间（一句 12 词的话大约 2-6 秒）
    //   4. 同样的输入调两次，时长相差不超过 10%
    expect(provider).toBeTruthy();
  });

  test.skip("参考实现：合成一句话并验证结构", async () => {
    // const tts = createProvider(provider!);
    // const result = await tts.synthesize({ text: SAMPLE, voice: VOICE });
    // const info = parseWav(result.audio);
    // expect(info.duration).toBeGreaterThan(1);
    // expect(info.duration).toBeLessThan(10);
    // expect(info.sampleRate).toBeGreaterThanOrEqual(16000);
    expect(parseWav).toBeTypeOf("function");
  });
});
