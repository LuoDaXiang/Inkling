/**
 * SSML 构造。
 *
 * Azure 的 TTS REST 接口收的是 SSML（一种 XML），而我们的文本来自
 * 用户粘贴或 AI 生成——两条路径都不可信。文本里如果有 `<` `>` `&`，
 * 轻则合成失败，重则被当成标记执行：
 *
 *   text = '</voice><voice name="zh-CN-XiaoxiaoNeural">被劫持的内容'
 *
 * 微软自己的 SDK 测试里没有任何转义/注入用例（搜 `&amp;` / `escape` /
 * `injection` 全部零命中），所以这一层必须我们自己守住。
 *
 * 这个文件是纯函数，没有网络也没有状态，可以完整测试。
 */

/**
 * XML 1.0 不允许的控制字符。
 * 只有 \t \n \r 是合法的，其余会让整个请求变成非法 XML 被 400 拒掉。
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * 转义成 XML 文本内容。
 *
 * `&` 必须最先处理，否则会把后面替换产生的 `&lt;` 再转成 `&amp;lt;`。
 * 这里用单次正则替换避开这个顺序陷阱。
 */
export function escapeXml(text: string): string {
  return text.replace(ILLEGAL_XML_CHARS, "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/**
 * 从音色名推断语言标记。
 * Azure 的音色名格式是 `{locale}-{Name}Neural`，例如 en-US-AvaNeural。
 */
export function localeFromVoice(voice: string, fallback = "en-US"): string {
  const match = /^([a-z]{2,3}(?:-[A-Za-z]{2,8})+)-[^-]+$/.exec(voice);
  return match?.[1] ?? fallback;
}

export interface SsmlOptions {
  text: string;
  voice: string;
  /** 语速倍率，1 为原速。省略或等于 1 时不生成 prosody 标签。 */
  speed?: number;
  /** 覆盖自动推断的语言标记。 */
  locale?: string;
}

export function buildSsml(options: SsmlOptions): string {
  const { text, voice, speed, locale } = options;
  const lang = locale ?? localeFromVoice(voice);

  let body = escapeXml(text);
  if (speed !== undefined && speed !== 1) {
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new RangeError(`语速必须是正有限数，收到 ${speed}`);
    }
    // Azure 的 prosody rate 支持倍率写法：rate="0.9" 表示 0.9 倍速。
    body = `<prosody rate="${speed}">${body}</prosody>`;
  }

  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(lang)}">` +
    `<voice name="${escapeXml(voice)}">${body}</voice>` +
    `</speak>`
  );
}
