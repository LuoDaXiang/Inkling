import { describe, test, expect } from "vitest";
import { normalize } from "@/core/text/normalize";

/**
 * 输入空间划分：文本从哪来，就会带上哪种脏东西。
 *   A. 退化输入   —— 空、纯空白、纯换行
 *   B. 换行形态   —— LF / CRLF / CR / 混合
 *   C. 不可见字符 —— BOM、零宽空格、零宽连接符
 *   D. 全角半角   —— 中文输入法产物
 *   E. 空白变体   —— 不间断空格、制表符、连续空格
 *   F. 标点变体   —— Unicode 省略号
 *   G. 幂等性     —— 规范化两次结果必须一样
 */

describe("normalize", () => {
  describe("A. 退化输入", () => {
    const CASES: Array<[name: string, input: string]> = [
      ["空字符串", ""],
      ["单个空格", " "],
      ["多个空格", "     "],
      ["制表符", "\t\t"],
      ["单个换行", "\n"],
      ["多个换行", "\n\n\n\n"],
      ["空白与换行混合", "  \n \t \n  "],
      ["只有不可见字符", "﻿​‍"],
    ];
    for (const [name, input] of CASES) {
      test(`${name} → 空字符串`, () => {
        expect(normalize(input)).toBe("");
      });
    }

    test("非字符串输入不抛异常", () => {
      // 运行时可能收到 undefined —— 类型系统挡不住来自 IPC / JSON 的数据
      expect(normalize(undefined as unknown as string)).toBe("");
      expect(normalize(null as unknown as string)).toBe("");
    });
  });

  describe("B. 换行形态", () => {
    test("CRLF 转 LF（Windows 粘贴）", () => {
      expect(normalize("First line.\r\nSecond line.")).toBe(
        "First line.\nSecond line.",
      );
    });

    test("单独的 CR 转 LF（老 Mac / 某些 PDF）", () => {
      expect(normalize("First line.\rSecond line.")).toBe(
        "First line.\nSecond line.",
      );
    });

    test("混合换行统一", () => {
      expect(normalize("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    });

    test("三个以上连续换行压成两个", () => {
      expect(normalize("Para one.\n\n\n\n\nPara two.")).toBe(
        "Para one.\n\nPara two.",
      );
    });

    test("两个换行保留（段落间隔）", () => {
      expect(normalize("Para one.\n\nPara two.")).toBe("Para one.\n\nPara two.");
    });
  });

  describe("C. 不可见字符", () => {
    test("BOM 被移除", () => {
      expect(normalize("﻿Hello.")).toBe("Hello.");
    });

    test("词中间的零宽空格被移除", () => {
      // 从网页复制常见：看起来是 "Hello"，实际是 "Hel​lo"
      expect(normalize("Hel​lo.")).toBe("Hello.");
    });

    test("零宽连接符被移除", () => {
      expect(normalize("A‍B")).toBe("AB");
    });

    test("移除不可见字符后不留下多余空格", () => {
      expect(normalize("Hello​ World.")).toBe("Hello World.");
    });
  });

  describe("D. 全角转半角", () => {
    const CASES: Array<[input: string, expected: string]> = [
      ["这是什么？", "这是什么?"],
      ["太好了！", "太好了!"],
      ["（括号）", "(括号)"],
      ["Ｈｅｌｌｏ", "Hello"],
      ["１２３", "123"],
      ["中文　空格", "中文 空格"],
      ["混合！Mixed？", "混合!Mixed?"],
    ];
    for (const [input, expected] of CASES) {
      test(`"${input}" → "${expected}"`, () => {
        expect(normalize(input)).toBe(expected);
      });
    }

    test("中文句号不转换（它不是全角 ASCII）", () => {
      // 。不在 ！-～ 区间内，应原样保留，交给分句处理
      expect(normalize("这是一句话。")).toBe("这是一句话。");
    });
  });

  describe("E. 空白变体", () => {
    test("不间断空格转普通空格", () => {
      expect(normalize("Hello World.")).toBe("Hello World.");
    });

    test("连续空格折叠", () => {
      expect(normalize("Hello      World.")).toBe("Hello World.");
    });

    test("制表符折叠", () => {
      expect(normalize("Hello\t\tWorld.")).toBe("Hello World.");
    });

    test("行尾空白清除", () => {
      expect(normalize("Line one.   \nLine two.   ")).toBe(
        "Line one.\nLine two.",
      );
    });

    test("换行不被折叠成空格", () => {
      // 换行是段落信息，不能当成普通空白吃掉
      expect(normalize("Line one.\nLine two.")).toBe("Line one.\nLine two.");
    });
  });

  describe("F. 标点变体", () => {
    test("Unicode 省略号转三个点", () => {
      expect(normalize("Wait… what?")).toBe("Wait... what?");
    });

    test("弯引号保留（TTS 能正确处理，不需要转换）", () => {
      expect(normalize("It’s fine.")).toBe("It’s fine.");
    });
  });

  describe("G. 幂等性", () => {
    const SAMPLES = [
      "Hello, World.",
      "﻿Mixed\r\n全角！　text​ here…",
      "Para one.\n\n\nPara two.",
      "",
      "   ",
    ];
    for (const s of SAMPLES) {
      test(`normalize(normalize(x)) === normalize(x): ${JSON.stringify(s.slice(0, 24))}`, () => {
        const once = normalize(s);
        expect(normalize(once)).toBe(once);
      });
    }
  });
});
