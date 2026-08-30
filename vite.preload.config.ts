import { defineConfig } from "vite";

/**
 * preload。刻意不给 `@/` alias：preload 不该 import 服务端的任何东西
 * （见 `src/electron/preload.ts` 里那段注释）。没有 alias 就是一道机械保证。
 */
export default defineConfig({
  build: {
    rollupOptions: {
      external: ["electron"],
      /**
       * preload 出 ESM，且文件名必须是 `.mjs`。
       *
       * Electron 只在扩展名是 `.mjs` 时把 preload 当 ES module 加载；
       * 叫 `.js` 的话它按 CJS 读，而 `package.json` 的 `"type": "module"`
       * 又让 Node 侧按 ESM 读——两边打架，表现是 preload 静默不生效，
       * 界面上每个按钮都报「preload 没有装上」。
       */
      output: { format: "es", entryFileNames: "[name].mjs" },
    },
  },
});
