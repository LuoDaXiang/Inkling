import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * 渲染进程。
 *
 * `@renderer/` 指向 `src/renderer/`——和从参考实现搬过来的那批 shadcn 组件
 * 里的 import 路径一致，省得逐个改。`@/` 刻意**不给**：渲染层不该 import
 * `src/core` 或 `src/storage`，那些东西只在主进程跑（迁移计划 M3.4 的同一条纪律）。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": fileURLToPath(new URL("./src/renderer", import.meta.url)),
    },
  },
});
