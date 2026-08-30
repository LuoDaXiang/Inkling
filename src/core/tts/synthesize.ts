import type { TtsProvider } from "@/providers/tts/types";
import type { AudioStore, StoredAudio } from "@/storage/audio-store";
import { cacheKey } from "./cache-key";
import { TtsError, toTtsError } from "@/core/errors";
import { decodeWav } from "@/core/audio/decode-wav";
import { contourOf, type PitchContour } from "@/core/audio/pitch";
import type { PitchStore } from "@/storage/pitch-store";

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
  /**
   * 参考音高曲线的缓存。**可选**——缺席时合成照常，只是不带曲线。
   *
   * 和 `log` / `rates` / `db` 同一条纪律：可选设施不到位，主链路不能因此走不通。
   */
  pitch?: PitchStore;
}

export interface SynthesizeResult extends StoredAudio {
  /** true 表示命中缓存，没有调用 provider。 */
  cached: boolean;
  /**
   * 参考音的音高曲线。**缺席用「字段不出现」表达**（[C43]），不发 null。
   *
   * 三种情况下它不出现：没接 `pitch` store、音频不是 WAV（曲线要解码才算得出）、
   * 或者缓存命中但那份曲线还没落过盘（`pitch` store 是后加的，
   * 老的缓存条目只有音频）。
   */
  pitch?: PitchContour;
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
  //
  //    曲线也一样：命中时**只读不算**。这不是靠自觉——`store.get()` 只
  //    stat 不读字节，命中时手上根本没有音频可解码，所以「重算」在这条
  //    路上是不可能发生的。结构上做不到，比写一句注释可靠。
  const hit = await store.get(key);
  if (hit) {
    const cachedContour = await deps.pitch?.get(key);
    return { ...hit, cached: true, ...(cachedContour ? { pitch: cachedContour } : {}) };
  }

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

  // 5. 算参考曲线并落盘。**算不出来不算失败**——音频已经合成好了，
  //    钱也已经花了，为一条画图用的曲线把整次合成判死是第二次伤害。
  //    这和 [C35]（写库失败仍返 200）是同一条判断。
  const contour = await computeContour(deps, key, result.audio, result.format);

  return { ...stored, cached: false, ...(contour ? { pitch: contour } : {}) };
}

/**
 * 解码音频、算曲线、落盘。任何一步失败都返回 `null`，不抛。
 *
 * **但绝不静默返回一条错的曲线**：`decodeWav` 认不出的格式会抛，
 * `extractPitch` 在窗口装不下 3 个周期时会抛（见 `pitch.ts`）。
 * 两者都在这里变成「没有曲线」，而不是「一条形状是噪声的曲线」。
 */
async function computeContour(
  deps: SynthesizeDeps,
  key: string,
  audio: Uint8Array,
  format: string,
): Promise<PitchContour | null> {
  if (!deps.pitch) return null;
  // mp3 解不了。将来接了 mp3 的 provider，这里要先解码再算，而不是硬读。
  if (format !== "wav") return null;

  let contour: PitchContour;
  try {
    const decoded = decodeWav(audio);
    contour = contourOf({ samples: decoded.samples, sampleRate: decoded.sampleRate });
  } catch {
    return null;
  }

  try {
    await deps.pitch.put(key, contour);
  } catch {
    // 落盘失败只是下次要重算，曲线本身是好的，照样返回。
  }
  return contour;
}
