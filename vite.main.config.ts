import { defineConfig } from "vite";
import { alias } from "./vite.base.config";

/**
 * 主进程。
 *
 * `node:sqlite` 与 electron 都必须留给运行时——打进 bundle 里的话，
 * 一个是原生模块打不动，一个是 Electron 自己的注入。
 *
 * **输出必须是 ESM。** `package.json` 里有 `"type": "module"`，
 * 于是 Node 把 `.js` 一律当 ES module 读；而 Forge 的 vite 插件默认出 CJS，
 * 两者一撞就是启动时 `require is not defined in ES module scope`。
 * 改这里而不是去掉 `"type": "module"`：那个字段管的是整个仓库，
 * 而服务端代码和测试全都是 ESM 写的。
 */
export default defineConfig({
  resolve: { alias },
  build: {
    /**
     * 必须整个给出 `build.lib`，不能只改 `rollupOptions.output`。
     *
     * Forge 的 vite 插件是这么写的（`config/vite.main.config.js`）：
     * `if (userConfig.build?.lib == null) { … formats: ['cjs'] }`——
     * 也就是说只要我们没给 `lib`，它就会塞一个 CJS 的进来，
     * 而 `lib.formats` 赢过 `rollupOptions.output.format`。
     * 只改 output 的话，构建照样出 CJS，且**不报错**，
     * 要到启动时才炸在 `require is not defined`。
     */
    lib: {
      entry: "src/electron/main.ts",
      fileName: () => "[name].js",
      formats: ["es"],
    },
    rollupOptions: {
      /*
       * `@divisey/js-mdict` 和 `node:sqlite` 一样留给运行时：
       * 前者是 CJS 且自己读文件，打进 ESM bundle 之后加载会失败——
       * 而失败的表现是「词典功能整个不见了」，不是一条报错。
       */
      external: ["electron", "node:sqlite", "@divisey/js-mdict"],
    },
  },
});
