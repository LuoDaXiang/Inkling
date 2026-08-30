import { fileURLToPath } from "node:url";

/** `@/` 指向 `src/`，和 tsconfig 的 paths 保持一致。两处对不上会在打包时才炸。 */
export const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};
