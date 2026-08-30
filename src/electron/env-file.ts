import { readFileSync } from "node:fs";

/**
 * 开发时把 `.env.local` 读进 `process.env`。
 *
 * HTTP 那条路上这件事由 `node --env-file-if-exists=.env.local` 做；
 * Electron 起进程的方式不同，没有那个开关，所以要自己读一次。
 *
 * 不用 dotenv——解析这几行不值得一个依赖（decisions 0014 定的同一条）。
 *
 * **只在开发时调用。** 打包后的应用不该从工作目录旁边捡一个文件当配置：
 * 那个文件不在应用包里，路径取决于用户从哪儿双击的，而「配置有时生效
 * 有时不生效」是最难查的一类问题。生产环境的密钥另有出路（还没做，
 * 见 roadmap）——在那之前，打包版本会明确报「缺少 Azure 配置」。
 */
export function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // 没有这个文件是正常情况
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    // 空值等于没填，不要覆盖掉真实的环境变量；已经有值的也不覆盖，
    // 命令行传进来的应当赢过文件。
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
}
