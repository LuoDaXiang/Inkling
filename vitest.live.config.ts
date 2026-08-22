import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // 真实调用 TTS 服务/模型。要密钥、要网络、慢、可能失败。手动跑。
    include: ["tests/live/**/*.live.test.ts"],
    testTimeout: 120_000,
    retry: 2,
    fileParallelism: false,
  },
});
