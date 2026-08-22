import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // 日常测试：不联网、不碰真实模型。live 测试单独用 vitest.live.config.ts 跑。
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**"],
  },
});
