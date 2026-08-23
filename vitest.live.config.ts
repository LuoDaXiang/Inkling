import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

/**
 * .env.local 由这里显式加载并注入。
 *
 * 之前没有这一步：`.env.example` 让人把密钥填进 `.env.local`，测试读 process.env，
 * 中间没有任何东西负责把文件搬进环境变量。结果是填好密钥仍然整组跳过，
 * 而且不报错——「没配置就跳过」的逻辑分不清「没配」和「配了但没加载」。
 *
 * 不用 dotenv，因为解析这几行不值得一个依赖。见 docs/decisions.md 0014。
 */
function loadEnvLocal(): Record<string, string> {
  const path = fileURLToPath(new URL("./.env.local", import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {}; // 没有这个文件是正常情况，live 测试会自己跳过
  }

  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (value) env[key] = value; // 空值等于没填，不要覆盖掉真实的环境变量
  }
  return env;
}

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // 真实调用 TTS 服务/模型。要密钥、要网络、慢、可能失败。手动跑。
    include: ["tests/live/**/*.live.test.ts"],
    env: loadEnvLocal(),
    testTimeout: 120_000,
    retry: 2,
    fileParallelism: false,
  },
});
