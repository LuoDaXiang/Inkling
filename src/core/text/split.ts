/**
 * 分句。
 *
 * 英文的核心难点：句点不只表示句末，还表示缩写、小数、域名、首字母缩写。
 * 这里的做法是「先找候选边界，再逐条否决」，而不是写一个巨大的正则——
 * 否决规则可以一条条加、一条条测，正则不行。
 */

/** 句末标点：英文与中日文两套。 */
const TERMINATORS = new Set([".", "!", "?", "。", "！", "？", "…"]);

/**
 * 中日文终止符不需要后接空白——CJK 文本词间无空格。
 * "这是一句话。这是第二句。" 里的句号后面直接就是下一句。
 */
const CJK_TERMINATORS = new Set(["。", "！", "？"]);

/** 成对符号：内部不断句。 */
const OPENERS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "“": "”",
  "‘": "’",
  "《": "》",
  "「": "」",
  "（": "）",
};
const CLOSERS = new Set(Object.values(OPENERS));

/** 句末允许尾随的收尾符号，属于前一句。 */
const TRAILING = new Set([
  '"', "”", "’", "'", ")", "]", "}", "》", "」", "）", "»",
]);

/**
 * 头衔类缩写：后面几乎总是跟名字，永远不断句。
 * 判断依据是「这个缩写通常不出现在句末」。
 */
const TITLE_ABBR = new Set([
  "mr", "mrs", "ms", "dr", "prof", "rev", "hon", "st", "mt", "ft",
  "jr", "sr", "gen", "sen", "rep", "col", "capt", "lt", "sgt", "gov",
  "fig", "no", "p", "pp", "vol", "ch", "sec", "vs", "v", "approx",
  "dept", "est", "min", "max",
]);

/**
 * 可出现在句末的缩写：靠下一个词的大小写来判断。
 * "at 10 a.m. I saw him"（大写 → 断） vs "at 10 a.m. and said hi"（小写 → 不断）
 */
const AMBIGUOUS_ABBR = new Set([
  "etc", "inc", "ltd", "co", "corp", "al", "am", "pm", "a.m", "p.m",
  "i.e", "e.g", "cf", "ca", "ibid", "u.s", "u.k", "u.s.a",
]);

/** 首字母缩写：J.R.R. / U.S.A. / A.B.C —— 单字母加点的连续串。 */
const INITIALS = /(?:^|[\s(\[{"'“‘])(?:[A-Za-z]\.){1,}[A-Za-z]$/;

/** 取候选边界左侧的「词」，含内部句点，用于查缩写表。 */
function wordBefore(text: string, dotIndex: number): string {
  let i = dotIndex;
  while (i > 0 && /[A-Za-z0-9.]/.test(text[i - 1]!)) i--;
  return text.slice(i, dotIndex);
}

/** 候选边界之后的第一个非空白字符。 */
function nextVisible(text: string, from: number): string | null {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (!/\s/.test(ch)) return ch;
  }
  return null;
}

function isUpperStart(ch: string | null): boolean {
  if (ch === null) return false;
  // 大写字母、数字、引号、CJK 都算「新句子的开头」
  return /[A-Z0-9"“'‘㐀-鿿＀-￯]/.test(ch);
}

export interface SplitOptions {
  /** 单个换行是否算句子边界。默认 true——列表和诗歌需要它。 */
  breakOnNewline?: boolean;
}

export function split(text: string, options: SplitOptions = {}): string[] {
  const { breakOnNewline = true } = options;
  if (!text) return [];

  const sentences: string[] = [];
  const stack: string[] = [];
  let start = 0;
  let i = 0;

  const flush = (end: number): void => {
    const piece = text.slice(start, end).trim();
    if (piece) sentences.push(piece);
    start = end;
  };

  while (i < text.length) {
    const ch = text[i]!;

    // 成对符号：进入时压栈，匹配时出栈。栈非空时不断句。
    if (OPENERS[ch]) {
      stack.push(OPENERS[ch]);
      i++;
      continue;
    }
    if (CLOSERS.has(ch) && stack[stack.length - 1] === ch) {
      stack.pop();
      i++;
      continue;
    }
    // 直引号无法区分开闭，用开关切换
    if (ch === '"') {
      if (stack[stack.length - 1] === '"') stack.pop();
      else stack.push('"');
      i++;
      continue;
    }

    if (breakOnNewline && ch === "\n" && stack.length === 0) {
      flush(i);
      i++;
      start = i;
      continue;
    }

    if (!TERMINATORS.has(ch)) {
      i++;
      continue;
    }

    // 收集连续的终止符：!!! ?! ... 都算一个整体
    let runEnd = i;
    while (runEnd < text.length && TERMINATORS.has(text[runEnd]!)) runEnd++;
    const run = text.slice(i, runEnd);

    // 吃掉尾随的引号和右括号，它们属于前一句
    let boundary = runEnd;
    while (boundary < text.length && TRAILING.has(text[boundary]!)) boundary++;

    if (stack.length > 0) {
      // 引号/括号内部通常不断句。唯一的例外：终止符之后紧跟着把所有
      // 未闭合符号依次收掉，且再往后是空白或文本结束——
      // 这时引号是随句子一起结束的（He said "yes." Then he left.）。
      if (!closesAllAt(text, runEnd, stack, boundary)) {
        i = runEnd;
        continue;
      }
      stack.length = 0;
    }

    if (!isBoundary(text, i, run, boundary)) {
      i = runEnd;
      continue;
    }

    flush(boundary);
    i = boundary;
  }

  flush(text.length);
  return sentences;
}

/**
 * 从 runEnd 开始，是否恰好依次收掉了栈里所有未闭合的符号，
 * 并且收完之后是空白或文本结束。
 */
function closesAllAt(
  text: string,
  runEnd: number,
  stack: string[],
  boundary: number,
): boolean {
  let j = runEnd;
  for (let k = stack.length - 1; k >= 0; k--) {
    if (text[j] !== stack[k]) return false;
    j++;
  }
  if (j !== boundary) return false;
  const after = text[j];
  return after === undefined || /\s/.test(after);
}

function isBoundary(
  text: string,
  dotIndex: number,
  run: string,
  boundary: number,
): boolean {
  const after = text[boundary];
  const nextCh = nextVisible(text, boundary);

  // 1. 后面必须是空白或文本结束。"3.14" / "example.com" 的内部句点在此被否决。
  //    中日文除外——CJK 词间无空格，句号后面直接就是下一句。
  const isCjk = [...run].every((c) => CJK_TERMINATORS.has(c));
  if (!isCjk && after !== undefined && !/\s/.test(after)) return false;

  // 只有纯句点的情况需要查缩写；! ? 。不存在缩写歧义
  const onlyDots = /^\.+$/.test(run);
  if (!onlyDots) return true;

  const word = wordBefore(text, dotIndex);
  const lower = word.toLowerCase();

  // 2. 首字母缩写：J.R.R. / U.S.A. —— 永不断句
  if (INITIALS.test(text.slice(Math.max(0, dotIndex - 12), dotIndex))) {
    return false;
  }

  // 3. 头衔类缩写：Dr. / Mr. / p. —— 永不断句
  if (TITLE_ABBR.has(lower)) return false;

  // 4. 歧义缩写与省略号：看下一个词的大小写
  if (AMBIGUOUS_ABBR.has(lower) || run.length >= 3) {
    return isUpperStart(nextCh);
  }

  return true;
}
