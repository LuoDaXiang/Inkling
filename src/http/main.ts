import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { AzureTtsProvider } from "@/providers/tts/azure";
import { AzureScoringProvider } from "@/providers/scoring/azure";
import { FileAudioStore } from "@/storage/file-audio-store";
import { openDatabase } from "@/storage/db";
import { migrate } from "@/storage/migrations";
import { OperationLog } from "@/storage/operations";
import type { Rates } from "@/core/cost";
import { createApp } from "./server";

/**
 * 开发服务器入口。
 *
 *   npm run dev
 *
 * 配置从环境变量来，由 --env-file-if-exists=.env.local 加载。
 * 缺配置时明确说缺什么，而不是等第一次合成时才炸——
 * 配置错误应该在启动时暴露，这也是 AzureTtsProvider 在构造函数里就校验的原因。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 空字符串等于没填。
 *
 * 这一行是踩出来的：`.env.local` 里写 `AZURE_TTS_VOICE=` 时，环境变量的值是 ""
 * 而不是 undefined，所以 `?? 默认值` 不会兜底——空音色名一路送到 Azure，
 * 换回一个 400。配置读取一律走这里，不要直接用 ?? 。
 */
function env(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : undefined;
}

/**
 * 数值型配置。填了但不是合法正数时**直接退出**，不静默忽略——
 * 一个悄悄变成 undefined 的费率会让成本报表永远是 0，而那看起来一切正常。
 */
function numericEnv(name: string): number | undefined {
  const raw = env(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`配置 ${name} 不是合法的非负数：${raw}`);
    process.exit(1);
  }
  return value;
}

const KEY = env("AZURE_SPEECH_KEY");
const REGION = env("AZURE_SPEECH_REGION");
const VOICE = env("AZURE_TTS_VOICE") ?? "en-US-AvaNeural";
const PORT = Number(env("PORT") ?? 5173);

if (!KEY || !REGION) {
  console.error(
    [
      "",
      "缺少 Azure 配置，服务没法启动。",
      "",
      "  cp .env.example .env.local",
      "  # 然后填 AZURE_SPEECH_KEY 和 AZURE_SPEECH_REGION",
      "",
      "密钥在 Azure 门户 → Speech 资源 → 「密钥和终结点」。",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const provider = new AzureTtsProvider({
  key: KEY,
  region: REGION,
  // 16kHz 是发音评估唯一接受的采样率。TTS 这边本可以用更高的，
  // 但统一成 16k 可以让 M03 的录音链路和范本音频对齐，少一次重采样。
  outputFormat: "riff-16khz-16bit-mono-pcm",
});

const scoring = new AzureScoringProvider({ key: KEY, region: REGION });

const store = new FileAudioStore(join(root, "data", "audio"));

/**
 * 数据库。
 *
 * 开库和迁移都在启动时做完——和 Azure 密钥校验同一个道理：
 * 配置和 schema 的问题要在启动时暴露，而不是等第一次请求才炸。
 *
 * 注意 openDatabase() 里的 `PRAGMA auto_vacuum = INCREMENTAL` 必须
 * 跑在 migrate() 之前。这个 pragma 只在**建任何表之前**生效，
 * 之后再设是静默无效的（设了读回来还是 0），要补救得停服跑全库 VACUUM。
 */
mkdirSync(join(root, "data"), { recursive: true });
const db = openDatabase(join(root, "data", "inkling.db"));
migrate(db);

/**
 * 操作流水。
 *
 * onError 一定要接上。`append()` 永不抛是它的契约，但「不抛」不等于
 * 「不报」——流水静默失效是最坏的情况：你以为有记录，出事时才发现什么都没有。
 */
const log = new OperationLog(db, {
  onError: (err) => console.error(`[ops] 流水写入失败：${String(err)}`),
});

/**
 * 计费费率。单位是**微元**（百万分之一美元）。
 *
 * 不写死在代码里：费率随 Azure 的定价层级、区域和你的具体合同变化，
 * 写死的费率一定会过期，**而且过期时不报错**。
 *
 * 两个都没配就不记花费——记 `null` 而不是记 `0`。
 * 「没配费率」和「确实免费」必须分得开，否则成本报表会看起来一切正常，
 * 直到收到账单。
 */
const TTS_RATE = numericEnv("TTS_MICROS_PER_MILLION_CHARS");
const SCORING_RATE = numericEnv("SCORING_MICROS_PER_AUDIO_HOUR");
const rates: Rates | undefined =
  TTS_RATE === undefined && SCORING_RATE === undefined
    ? undefined
    : { ttsPerMillionChars: TTS_RATE ?? 0, scoringPerAudioHour: SCORING_RATE ?? 0 };

if (!rates) {
  console.warn("未配置计费费率，流水不会记录花费。见 .env.example。");
}

const app = createApp({
  provider,
  scoring,
  store,
  publicDir: join(root, "public"),
  defaultVoice: VOICE,
  log,
  ...(rates ? { rates } : {}),
});

const server = app.listen(PORT, () => {
  console.log(`Inkling → http://localhost:${PORT}  (音色 ${VOICE})`);
});

/**
 * 关库必须做。
 *
 * 开了 WAL 之后，最近的事务在 .db-wal 里；正常关闭会做一次 checkpoint
 * 把它们合回主文件。进程被硬杀不会丢数据（下次打开会自动恢复），
 * 但留着一个没合并的 -wal 文件，会让「只拷 .db 当备份」的人丢数据。
 */
function shutdown(signal: string): void {
  console.log(`\n收到 ${signal}，正在关闭……`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
