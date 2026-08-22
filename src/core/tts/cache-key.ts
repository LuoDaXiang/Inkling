import { createHash } from "node:crypto";

/**
 * 缓存键。
 *
 * TTS 要花钱或花算力，所以同样的请求必须只生成一次。
 * 键由「内容本身」决定，不绑任何业务实体——同一句话出现在两篇文章里，
 * 应该共用同一段音频。（Enjoy 用 sourceId + section + segment 做键，
 * 结果是同一句话重复生成，见 docs/decisions.md 0004。）
 */

export interface CacheKeyInput {
  text: string;
  engine: string;
  model: string;
  voice: string;
  speed?: number;
}

/** 空白差异不影响发音，归一化掉，让它们命中同一份缓存。 */
function canonicalText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 分隔符用 U+0000。它不可能出现在任何一个字段里，
 * 因此 ("ab", "c") 和 ("a", "bc") 不会拼成同一个字符串。
 * 用普通字符（比如冒号）做分隔符就会撞。
 */
const SEP = "\u0000";

export function cacheKey(input: CacheKeyInput): string {
  const parts = [
    canonicalText(input.text),
    input.engine,
    input.model,
    input.voice,
    String(input.speed ?? 1),
  ];
  return createHash("sha256").update(parts.join(SEP), "utf8").digest("hex");
}
