import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AzureTtsProvider } from "@/providers/tts/azure";
import { AzureScoringProvider } from "@/providers/scoring/azure";
import { FileAudioStore } from "@/storage/file-audio-store";
import { FilePitchStore } from "@/storage/pitch-store";
import { RecordingStore } from "@/storage/recording-store";
import { openDatabase } from "@/storage/db";
import { migrate } from "@/storage/migrations";
import { OperationLog } from "@/storage/operations";
import type { Rates } from "@/core/cost";
import type { ServerDeps } from "@/http/server";
import type { DatabaseSync } from "node:sqlite";

/**
 * 组装 `ServerDeps`。
 *
 * 从 `src/http/main.ts` 抽出来的**同一段逻辑**——store、库、迁移、流水、费率。
 * 抽出来是因为它现在有两个调用者：HTTP 那条路（`npm run dev:http`）和
 * Electron 主进程。让它们各写一份，两边的配置校验一定会分叉，
 * 而分叉的表现是「某一边悄悄没记花费」这种不报错的毛病。
 *
 * **这一层不做任何业务判断**，只把配置读出来、把设施建好。
 * 校验放在启动时而不是第一次请求时，理由和 `AzureTtsProvider` 在构造函数里
 * 就校验一样：配置错误要在启动时暴露。
 */

/**
 * 组装结果。
 *
 * 缺配置时**不给一个半成品的 deps**——`AzureTtsProvider` 的构造函数在
 * key/region 为空时就抛（那是它刻意的设计：配置错误要在构造时炸）。
 * 硬塞空字符串进去只会把一个清楚的「缺配置」变成一个来路不明的异常。
 */
export type BuiltDeps =
  | { ok: true; deps: ServerDeps; db: DatabaseSync; voice: string }
  | { ok: false; problems: string[] };

/**
 * 空字符串等于没填。
 *
 * 这一行是踩出来的：`.env.local` 里写 `AZURE_TTS_VOICE=` 时，环境变量的值是 ""
 * 而不是 undefined，所以 `?? 默认值` 不会兜底——空音色名一路送到 Azure，
 * 换回一个 400。配置读取一律走这里，不要直接用 `??`。
 */
export function env(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : undefined;
}

/**
 * 数值型配置。填了但不是合法非负数时**报告出来**，不静默忽略——
 * 一个悄悄变成 undefined 的费率会让成本报表永远是 0，而那看起来一切正常。
 */
function numericEnv(name: string, problems: string[]): number | undefined {
  const raw = env(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    problems.push(`配置 ${name} 不是合法的非负数：${raw}`);
    return undefined;
  }
  return value;
}

export function buildDeps(options: { dataDir: string }): BuiltDeps {
  const problems: string[] = [];

  const key = env("AZURE_SPEECH_KEY");
  const region = env("AZURE_SPEECH_REGION");
  const voice = env("AZURE_TTS_VOICE") ?? "en-US-AvaNeural";

  if (!key || !region) {
    problems.push(
      [
        "缺少 Azure 配置。",
        "",
        "  cp .env.example .env.local",
        "  # 然后填 AZURE_SPEECH_KEY 和 AZURE_SPEECH_REGION",
        "",
        "密钥在 Azure 门户 → Speech 资源 → 「密钥和终结点」。",
      ].join("\n"),
    );
    return { ok: false, problems };
  }

  mkdirSync(options.dataDir, { recursive: true });

  /**
   * 开库和迁移都在启动时做完。
   *
   * `openDatabase()` 里的 `PRAGMA auto_vacuum = INCREMENTAL` 必须跑在
   * `migrate()` 之前——这个 pragma 只在**建任何表之前**生效，之后再设是
   * 静默无效的（设了读回来还是 0），要补救得停服跑全库 VACUUM。
   */
  const db = openDatabase(join(options.dataDir, "inkling.db"));
  migrate(db);

  /**
   * 流水。onError 一定要接上：`append()` 永不抛是它的契约，但「不抛」
   * 不等于「不报」——流水静默失效是最坏的情况，你以为有记录，出事时才发现没有。
   */
  const log = new OperationLog(db, {
    onError: (err) => console.error(`[ops] 流水写入失败：${String(err)}`),
  });

  const ttsRate = numericEnv("TTS_MICROS_PER_MILLION_CHARS", problems);
  const scoringRate = numericEnv("SCORING_MICROS_PER_AUDIO_HOUR", problems);
  const rates: Rates | undefined =
    ttsRate === undefined && scoringRate === undefined
      ? undefined
      : { ttsPerMillionChars: ttsRate ?? 0, scoringPerAudioHour: scoringRate ?? 0 };

  const deps: ServerDeps = {
    // 16kHz 是发音评估唯一接受的采样率。TTS 这边本可以用更高的，
    // 但统一成 16k 可以让录音链路和范本音频对齐，少一次重采样。
    provider: new AzureTtsProvider({
      key,
      region,
      outputFormat: "riff-16khz-16bit-mono-pcm",
    }),
    scoring: new AzureScoringProvider({ key, region }),
    store: new FileAudioStore(join(options.dataDir, "audio")),
    // 用户录音独立目录：F8 将来要给 TTS 缓存加淘汰，混在一起会把用户的
    // 录音一起删掉——那是用户资产，不是缓存（[C38]）。
    recordings: new RecordingStore(join(options.dataDir, "recordings")),
    // 参考曲线的键和 TTS 音频共用，目录分开，理由同上。
    pitch: new FilePitchStore(join(options.dataDir, "pitch")),
    defaultVoice: voice,
    log,
    db,
    ...(rates ? { rates } : {}),
  };

  // 费率格式不对不是致命错误——记不了花费而已，链路照常。如实报出来。
  for (const problem of problems) console.error(problem);

  return { ok: true, deps, db, voice };
}
