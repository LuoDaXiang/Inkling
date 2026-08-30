import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // 和 vite.renderer.config.ts 保持一致。渲染层的模块用这个前缀 import，
      // 两处对不上会在跑测试时才炸——所以它们必须一起改。
      "@renderer": fileURLToPath(new URL("./src/renderer", import.meta.url)),
    },
  },
  test: {
    // 日常测试：不联网、不碰真实模型。live 测试单独用 vitest.live.config.ts 跑。
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/live/**"],
    /**
     * 默认仍是 node —— 服务端那 1000 多条用例不需要 DOM，
     * 给它们套一个 jsdom 只是白白拖慢每一次运行。
     *
     * 需要 DOM 的用例用目录级覆盖：`tests/client/` 与 `tests/components/`。
     */
    environment: "node",
    environmentMatchGlobs: [
      ["tests/components/**", "jsdom"],
      ["tests/client/**", "jsdom"],
    ],
    setupFiles: ["tests/setup-dom.ts"],
  },
});
