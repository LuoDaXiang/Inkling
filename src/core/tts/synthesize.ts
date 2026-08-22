import type { TtsProvider } from "@/providers/tts/types";
import type { AudioStore, StoredAudio } from "@/storage/audio-store";
import { cacheKey } from "./cache-key";
import { TtsError, toTtsError } from "./errors";

/**
 * TTS 编排层：查缓存 → 调 provider → 落盘。
 *
 * 这个函数是整个功能的心脏，它不知道用的是哪家 TTS、音频存在哪里——
 * 两者都是参数传进来的。所以它可以在不联网、不写磁盘的情况下被完整测试。
 */

export interface SynthesizeRequest {
  text: string;
  voice: string;
  speed?: number;
}

export interface SynthesizeDeps {
  provider: TtsProvider;
  store: AudioStore;
}

export interface SynthesizeResult extends StoredAudio {
  /** true 表示命中缓存，没有调用 provider。 */
  cached: boolean;
}

export async function synthesize(
  request: SynthesizeRequest,
  deps: SynthesizeDeps,
): Promise<SynthesizeResult> {
  const { provider, store } = deps;
  const text = request.text.trim();

  // 1. 空文本不该走到 provider —— 有的服务商会为此收费并返回一段静音。
  if (!text) {
    throw new TtsError("rejected", "文本为空，无法合成");
  }

  // 2. 超长文本在这里拒绝，而不是让模型静默截断。
  //    Kokoro 的做法是 truncation: true，音频短一截且不报错，
  //    这种 bug 在跟读场景里极难定位。见 docs/decisions.md。
  if (text.length > provider.maxChars) {
    throw new TtsError(
      "too_long",
      `文本长度 ${text.length} 超过 ${provider.engine} 的上限 ${provider.maxChars}`,
    );
  }

  const key = cacheKey({
    text,
    engine: provider.engine,
    model: provider.model,
    voice: request.voice,
    speed: request.speed,
  });

  // 3. 先查缓存。命中就绝不调用 provider —— 这条是省钱的关键，必须有测试守住。
  const hit = await store.get(key);
  if (hit) return { ...hit, cached: true };

  let result;
  try {
    result = await provider.synthesize({
      text,
      voice: request.voice,
      speed: request.speed,
    });
  } catch (err) {
    throw toTtsError(err, `${provider.engine} 合成失败`);
  }

  // 4. 调用成功不等于结果可用。空音频要当作失败，
  //    否则会存下一个 0 字节的文件，播放时静默无声。
  if (!result.audio || result.audio.byteLength === 0) {
    throw new TtsError("empty", `${provider.engine} 返回了空音频`);
  }

  const stored = await store.put(key, result.audio, result.format);
  return { ...stored, cached: false };
}
