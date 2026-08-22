/**
 * 文本规范化：把各种来源的文本拉到同一个基准形态。
 *
 * 用户的文本来自复制粘贴——Word、网页、PDF、微信。每种来源都会
 * 带上自己的脏东西：Windows 的 CRLF、网页的零宽字符、中文输入法的全角标点。
 * 这些差异如果不在入口处抹平，会一路渗透到分句、缓存键、TTS 请求里。
 *
 * 规则：只做无损的形态统一，不改变文字内容本身。
 */

/** 零宽字符与 BOM：肉眼不可见，但会破坏分句正则和缓存键。 */
const INVISIBLE = /[​-‍⁠﻿]/g;

/** 全角 ASCII（！到～）与全角空格，映射回半角。 */
const FULLWIDTH_ASCII = /[！-～]/g;
const IDEOGRAPHIC_SPACE = /　/g;

/** 各种花式空白（不间断空格、细空格等）统一成普通空格。 */
const EXOTIC_SPACE = /[   -   ]/g;

/** Unicode 省略号统一成三个点，让分句只需处理一种形态。 */
const ELLIPSIS = /…/g;

export function normalize(raw: string): string {
  if (typeof raw !== "string") return "";

  let text = raw;

  // 1. 去掉不可见字符（含 BOM）
  text = text.replace(INVISIBLE, "");

  // 2. 换行统一成 LF：CRLF 和单独的 CR 都要处理
  text = text.replace(/\r\n?/g, "\n");

  // 3. 空白统一
  text = text.replace(EXOTIC_SPACE, " ").replace(IDEOGRAPHIC_SPACE, " ");

  // 4. 全角 ASCII 转半角（！→ ! ，？→ ? ，Ａ→ A）
  text = text.replace(FULLWIDTH_ASCII, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );

  // 5. 省略号统一
  text = text.replace(ELLIPSIS, "...");

  // 6. 行内空白折叠，行尾空白清除
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n");

  // 7. 三个以上连续换行压成两个（段落间隔最多空一行）
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
