import { describe, test, expect } from "vitest";
import { split } from "@/core/text/split";

/**
 * 输入空间划分：句点的每一种非句末用途，各占一类。
 *   A. 退化输入
 *   B. 基本断句
 *   C. 缩写（头衔 / 歧义 / 首字母）
 *   D. 数字（小数 / 货币 / 时间 / 编号）
 *   E. 技术文本（URL / 邮箱 / 文件名）
 *   F. 连续标点与省略号
 *   G. 成对符号
 *   H. 换行与列表
 *   I. 非 ASCII（中日文 / emoji / 全角）
 *   J. 不变量（拼回去必须等于原文的可见部分）
 */

type Case = [name: string, input: string, expected: string[]];

const run = (cases: Case[]): void => {
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(split(input)).toEqual(expected);
    });
  }
};

describe("split", () => {
  describe("A. 退化输入", () => {
    run([
      ["空字符串", "", []],
      ["纯空格", "   ", []],
      ["纯换行", "\n\n", []],
      ["单个字符", "a", ["a"]],
      ["单个句号", ".", ["."]],
      ["只有标点", "!!!", ["!!!"]],
      ["没有任何终止符", "hello world", ["hello world"]],
      ["末尾没有标点", "First one. Second one", ["First one.", "Second one"]],
    ]);
  });

  describe("B. 基本断句", () => {
    run([
      [
        "两个陈述句",
        "This is a test. This is another test.",
        ["This is a test.", "This is another test."],
      ],
      ["问句与陈述句", "Are you sure? I am.", ["Are you sure?", "I am."]],
      ["感叹句", "Watch out! It is coming.", ["Watch out!", "It is coming."]],
      [
        "破折号不断句",
        "This is a test — yes, it is.",
        ["This is a test — yes, it is."],
      ],
      [
        "逗号不断句",
        "I came, I saw, I conquered.",
        ["I came, I saw, I conquered."],
      ],
    ]);
  });

  describe("C. 缩写", () => {
    run([
      ["头衔 Dr. 后跟大写名字", "Dr. Smith is here.", ["Dr. Smith is here."]],
      ["头衔 Mr.", "Mr. Smith arrived.", ["Mr. Smith arrived."]],
      [
        "头衔后接新句",
        "Dr. Smith is here. At 10 a.m. I saw him.",
        ["Dr. Smith is here.", "At 10 a.m. I saw him."],
      ],
      [
        "歧义缩写后接小写 —— 不断",
        "I went to Dr. Smith this morning at 10 a.m. and said hi.",
        ["I went to Dr. Smith this morning at 10 a.m. and said hi."],
      ],
      [
        "页码缩写 p.",
        "Please turn to p. 55.",
        ["Please turn to p. 55."],
      ],
      ["山名缩写 Mt.", "I can see Mt. Fuji from here.", ["I can see Mt. Fuji from here."]],
      [
        "同一缩写大小写两次",
        "St. Michael's Church is on 5th st. near the light.",
        ["St. Michael's Church is on 5th st. near the light."],
      ],
      [
        "公司缩写后接小写",
        "They closed the deal with Pitt, Briggs & Co. at noon.",
        ["They closed the deal with Pitt, Briggs & Co. at noon."],
      ],
      [
        "首字母缩写 U.S.A. 后接小写",
        "I visited the U.S.A. last year.",
        ["I visited the U.S.A. last year."],
      ],
      [
        "首字母缩写 J.R.R. 后接大写",
        "J.R.R. Tolkien wrote The Lord of the Rings.",
        ["J.R.R. Tolkien wrote The Lord of the Rings."],
      ],
      [
        "缩写加所有格",
        "That is JFK Jr.'s book.",
        ["That is JFK Jr.'s book."],
      ],
      [
        "etc. 后接大写 —— 断",
        "Apples, etc. Pears are also good.",
        ["Apples, etc.", "Pears are also good."],
      ],
      [
        "反例：词尾像缩写但不是",
        "He hit the drums. Then he hit the cymbals.",
        ["He hit the drums.", "Then he hit the cymbals."],
      ],
    ]);
  });

  describe("D. 数字", () => {
    run([
      [
        "小数",
        "The price is $4.99. Do you want it?",
        ["The price is $4.99.", "Do you want it?"],
      ],
      [
        "金额以小数结尾",
        "She has $100.00. It is in her bag.",
        ["She has $100.00.", "It is in her bag."],
      ],
      [
        "句子以数字开头和结尾",
        "10 people came in 2025. 20 people came in 2026.",
        ["10 people came in 2025.", "20 people came in 2026."],
      ],
      [
        "圆周率",
        "The result is 3.14. It is an approximation.",
        ["The result is 3.14.", "It is an approximation."],
      ],
      [
        "电话号码",
        "Call me at 555-1234. Or write to me.",
        ["Call me at 555-1234.", "Or write to me."],
      ],
      ["时间", "Meet me at 12:34. Do not be late.", ["Meet me at 12:34.", "Do not be late."]],
    ]);
  });

  describe("E. 技术文本", () => {
    run([
      [
        "网址",
        "Visit https://example.com. It is a great site!",
        ["Visit https://example.com.", "It is a great site!"],
      ],
      [
        "带子域名的网址",
        "Visit https://test.example.com. Great site!",
        ["Visit https://test.example.com.", "Great site!"],
      ],
      [
        "带查询参数的网址",
        "Visit https://www.example.com?query=test. It is useful.",
        ["Visit https://www.example.com?query=test.", "It is useful."],
      ],
      [
        "邮箱",
        "Her email is Jane.Doe@example.com. I wrote to her.",
        ["Her email is Jane.Doe@example.com.", "I wrote to her."],
      ],
      [
        "库名带点",
        "Kokoro.js is powered by Transformers.js, a library by Hugging Face.",
        ["Kokoro.js is powered by Transformers.js, a library by Hugging Face."],
      ],
      [
        "文件名",
        "The files are /path/to/file.txt, VIDEO.MP4 and image.jpg.",
        ["The files are /path/to/file.txt, VIDEO.MP4 and image.jpg."],
      ],
    ]);
  });

  describe("F. 连续标点与省略号", () => {
    run([
      [
        "连续感叹号与问号",
        "Wait!!!! Are you sure??? This is insane!!!",
        ["Wait!!!!", "Are you sure???", "This is insane!!!"],
      ],
      ["混合标点", "Hello?! Is that you?", ["Hello?!", "Is that you?"]],
      [
        "省略号后接小写 —— 不断",
        "That is all folks... or is it?",
        ["That is all folks... or is it?"],
      ],
      [
        "省略号后接大写 —— 断",
        "Wait... What just happened?",
        ["Wait...", "What just happened?"],
      ],
      ["省略号结尾", "I do not understand...", ["I do not understand..."]],
    ]);
  });

  describe("G. 成对符号", () => {
    run([
      [
        "引号内的句号不断句",
        'She said, "Hello there. How are you?". I replied.',
        ['She said, "Hello there. How are you?".', "I replied."],
      ],
      [
        "括号内不断句",
        "This is an example (This is cool. Another one). Do you agree?",
        ["This is an example (This is cool. Another one).", "Do you agree?"],
      ],
      [
        "括号在句末",
        "This is useful (very much so). Do you agree?",
        ["This is useful (very much so).", "Do you agree?"],
      ],
      [
        "嵌套括号",
        "A nested case (outer (inner) done). Next sentence.",
        ["A nested case (outer (inner) done).", "Next sentence."],
      ],
      [
        "收尾引号归前一句",
        'He said "yes." Then he left.',
        ['He said "yes."', "Then he left."],
      ],
    ]);
  });

  describe("H. 换行与列表", () => {
    run([
      ["单换行断句", "First line\nSecond line", ["First line", "Second line"]],
      [
        "项目符号列表",
        "- First point.\n- Second point.\n- Third point.",
        ["- First point.", "- Second point.", "- Third point."],
      ],
      [
        "段落间空行",
        "Para one.\n\nPara two.",
        ["Para one.", "Para two."],
      ],
    ]);

    test("breakOnNewline=false 时换行不断句", () => {
      expect(split("First line\nSecond line", { breakOnNewline: false })).toEqual([
        "First line\nSecond line",
      ]);
    });
  });

  describe("I. 非 ASCII", () => {
    run([
      ["中文句号", "这是一句话。这是第二句。", ["这是一句话。", "这是第二句。"]],
      ["日文句号", "これはテストです。次の文です。", ["これはテストです。", "次の文です。"]],
      [
        "中英混排",
        "English sentence. 这是一句中文。 Another English one!",
        ["English sentence.", "这是一句中文。", "Another English one!"],
      ],
      [
        "emoji 分隔",
        "I love pizza! 🍕 Do you? 😊",
        ["I love pizza!", "🍕 Do you?", "😊"],
      ],
      ["纯 emoji 不崩", "🍕🍔🍟🍦", ["🍕🍔🍟🍦"]],
    ]);
  });

  describe("J. 不变量", () => {
    const SAMPLES = [
      "This is a test. This is another test.",
      "Dr. Smith is here. At 10 a.m. I saw him.",
      'She said, "Hello there. How are you?". I replied.',
      "这是一句话。这是第二句。",
      "- First point.\n- Second point.",
      "Wait!!!! Are you sure???",
      "",
      "no terminator at all",
    ];

    for (const s of SAMPLES) {
      test(`不丢字符: ${JSON.stringify(s.slice(0, 30))}`, () => {
        // 把结果拼回去，去掉所有空白后必须与原文一致 —— 保证既不丢也不重
        const rejoined = split(s).join("").replace(/\s/g, "");
        expect(rejoined).toBe(s.replace(/\s/g, ""));
      });

      test(`无空句: ${JSON.stringify(s.slice(0, 30))}`, () => {
        for (const piece of split(s)) {
          expect(piece.trim()).not.toBe("");
        }
      });
    }
  });
});
