/**
 * Electron Forge 配置。
 *
 * 三个 Vite 构建：main / preload / renderer。Forge 的 vite 插件会把
 * `MAIN_WINDOW_VITE_DEV_SERVER_URL` 与 `MAIN_WINDOW_VITE_NAME` 注入主进程，
 * 所以 `main.ts` 里那两行 `declare const` 不是凭空写的。
 *
 * maker 只留 zip：这个项目现在只在本机跑，dmg / squirrel 的签名和公证是
 * 另一件事，没到那一步之前装上它们只会让 `npm run make` 无缘无故失败。
 */
export default {
  packagerConfig: { asar: true, name: "Inkling" },
  makers: [{ name: "@electron-forge/maker-zip" }],
  plugins: [
    {
      name: "@electron-forge/plugin-vite",
      config: {
        build: [
          { entry: "src/electron/main.ts", config: "vite.main.config.ts", target: "main" },
          { entry: "src/electron/preload.ts", config: "vite.preload.config.ts", target: "preload" },
        ],
        renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
      },
    },
  ],
};
