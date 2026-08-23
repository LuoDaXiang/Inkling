import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AzureTtsProvider } from "@/providers/tts/azure";
import { FileAudioStore } from "@/storage/file-audio-store";
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

const KEY = process.env["AZURE_SPEECH_KEY"];
const REGION = process.env["AZURE_SPEECH_REGION"];
const VOICE = process.env["AZURE_TTS_VOICE"] ?? "en-US-AvaNeural";
const PORT = Number(process.env["PORT"] ?? 5173);

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

const store = new FileAudioStore(join(root, "data", "audio"));

const app = createApp({
  provider,
  store,
  publicDir: join(root, "public"),
  defaultVoice: VOICE,
});

app.listen(PORT, () => {
  console.log(`Inkling → http://localhost:${PORT}  (音色 ${VOICE})`);
});
