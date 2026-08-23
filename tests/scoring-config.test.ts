import { describe, test, expect } from "vitest";
import {
  buildAssessmentHeader,
  decodeAssessmentHeader,
  prepareReference,
  InvalidReferenceError,
  MAX_REFERENCE_CHARS,
  CHARS_PER_SECOND,
} from "@/providers/scoring/config";
import { MAX_ASSESSABLE_SECONDS } from "@/core/audio/wav";

/**
 * 输入空间分类（判据一，见 docs/decisions.md 0006）
 *
 *   A. 退化输入 —— 空串、纯空白、各种不可见字符组成的「看起来非空」
 *   B. 长度边界 —— 上限前后一个字符、远超上限
 *   C. 规范化 —— 复用 normalize 之后，哪些差异被抹平了
 *   D. 编码正确性 —— base64 往返、非 ASCII、JSON 需要转义的字符
 *   E. 参数组合 —— granularity 与 prosody 的每个取值
 *   F. 跨层约束 —— 字符上限、音频时长上限、请求头大小三者对不对得上（判据五）
 *
 * 为什么这些类是穷尽的：这一层只做三件事——**校验**（A、B）、
 * **归一化**（C）、**编码**（D、E）。F 不是这一层的行为，
 * 是它和相邻两层的接缝，单独成类是因为那种 bug 任何单层测试都抓不到。
 *
 * 刻意不测注入：这一层是 JSON + base64，`JSON.stringify` 处理引号和反斜杠，
 * base64 保证输出是纯 ASCII。注入是 SSML 那一层的风险（见 ssml.test.ts 的
 * 5 个注入用例），不是这里的。D 组只验证编码往返无损。
 */

const SENTENCE = "The quick brown fox jumps over the lazy dog.";

describe("prepareReference", () => {
  describe("A. 退化输入必须拒绝", () => {
    // 这一整类的存在理由是实测出来的：空参考文本不会报错，
    // 它会触发无参考评估并返回准确度 90 / 总分 92.2 的高分。
    // 用户看到一个完全正常的分数，而它毫无意义——最坏的一类失败。

    test("空字符串", () => {
      expect(() => prepareReference("")).toThrow(InvalidReferenceError);
      expect(() => prepareReference("")).toThrow(/为空/);
    });

    test.each([
      ["纯空格", "     "],
      ["纯制表符", "\t\t"],
      ["纯换行", "\n\n\n"],
      ["空格加换行混合", "  \n \t \r\n  "],
    ])("%s", (_name, input) => {
      expect(() => prepareReference(input)).toThrow(InvalidReferenceError);
    });

    test.each([
      ["零宽空格", "\u200b\u200b"],
      ["BOM", "\ufeff"],
      ["不间断空格", "\u00a0\u00a0"],
      ["零宽连接符", "\u200d"],
    ])("看起来非空但其实是空的：%s", (_name, input) => {
      // 这些字符 length > 0，光判断 `!text` 会放过去。
      // normalize 把它们清掉之后才露出真面目。
      expect(input.length).toBeGreaterThan(0);
      expect(() => prepareReference(input)).toThrow(/为空/);
    });
  });

  describe("B. 长度边界", () => {
    test("恰好等于上限时通过", () => {
      const text = "a".repeat(MAX_REFERENCE_CHARS);
      expect(prepareReference(text)).toHaveLength(MAX_REFERENCE_CHARS);
    });

    test("超出一个字符就拒绝", () => {
      const text = "a".repeat(MAX_REFERENCE_CHARS + 1);
      expect(() => prepareReference(text)).toThrow(InvalidReferenceError);
      expect(() => prepareReference(text)).toThrow(/超过/);
    });

    test("远超上限时报出真实长度，方便排障", () => {
      expect(() => prepareReference("a".repeat(13000))).toThrow(/13000 字符/);
    });

    test("长度按归一化之后算，不是归一化之前", () => {
      // 前后各一堆空白，去掉后正好在限内。按原始长度算会误拒。
      const padded = "   ".repeat(100) + "a".repeat(MAX_REFERENCE_CHARS) + "   ".repeat(100);
      expect(padded.length).toBeGreaterThan(MAX_REFERENCE_CHARS);
      expect(prepareReference(padded)).toHaveLength(MAX_REFERENCE_CHARS);
    });

    test("单个字符是合法的最短参考", () => {
      expect(prepareReference("a")).toBe("a");
    });
  });

  describe("C. 规范化 —— 复用 TTS 那一套", () => {
    test("首尾空白去掉", () => {
      expect(prepareReference(`  ${SENTENCE}  `)).toBe(SENTENCE);
    });

    test("CRLF 归一", () => {
      expect(prepareReference("Hello\r\nworld.")).toBe("Hello\nworld.");
    });

    test("全角标点转半角", () => {
      expect(prepareReference("Really？")).toBe("Really?");
    });

    test("零宽字符被清掉，但词本身留着", () => {
      expect(prepareReference("qu\u200bick")).toBe("quick");
    });

    test("正常句子原样通过", () => {
      expect(prepareReference(SENTENCE)).toBe(SENTENCE);
    });

    test("幂等 —— 归一化两次结果不变", () => {
      const once = prepareReference(`  Hello\r\nworld？  `);
      expect(prepareReference(once)).toBe(once);
    });
  });
});

describe("buildAssessmentHeader", () => {
  describe("D. 编码正确性", () => {
    test("解回来是完整的配置对象", () => {
      const decoded = decodeAssessmentHeader(buildAssessmentHeader({ reference: SENTENCE }));
      expect(decoded).toEqual({
        ReferenceText: SENTENCE,
        GradingSystem: "HundredMark",
        Granularity: "Phoneme",
        Dimension: "Comprehensive",
        EnableProsodyAssessment: "True",
      });
    });

    test("输出是纯 ASCII —— 请求头不能带非 ASCII 字节", () => {
      const header = buildAssessmentHeader({ reference: "咖啡 café 🎧 naïve" });
      expect(header).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    test.each([
      ["双引号", 'He said "hello" loudly.'],
      ["反斜杠", "Path is C:\\Users\\test"],
      ["双引号加反斜杠", 'A \\"quoted\\" thing'],
      ["单引号", "It's Bob's book."],
      ["尖括号与和号", "The <quick> & brown fox."],
      ["中文", "敏捷的棕色狐狸"],
      ["emoji", "Hello 👋 world 🌍"],
      ["重音字母", "café naïve résumé"],
      ["弯引号", "\u201cSmart quotes\u201d and \u2019apostrophes\u2019"],
    ])("往返无损：%s", (_name, text) => {
      const decoded = decodeAssessmentHeader(buildAssessmentHeader({ reference: text }));
      // 注意比对的是归一化之后的文本，不是原文——全角标点会被转换。
      expect(decoded["ReferenceText"]).toBe(prepareReference(text));
    });

    test("同样的输入产出同样的头 —— 确定性", () => {
      expect(buildAssessmentHeader({ reference: SENTENCE })).toBe(
        buildAssessmentHeader({ reference: SENTENCE }),
      );
    });

    test("首尾空白差异不改变结果", () => {
      expect(buildAssessmentHeader({ reference: `  ${SENTENCE}  ` })).toBe(
        buildAssessmentHeader({ reference: SENTENCE }),
      );
    });
  });

  describe("E. 参数组合", () => {
    test("默认开启语调评估 —— Enjoy 缺的就是这一项", () => {
      const decoded = decodeAssessmentHeader(buildAssessmentHeader({ reference: SENTENCE }));
      expect(decoded["EnableProsodyAssessment"]).toBe("True");
    });

    test("服务端要的是字符串 True/False，不是布尔值", () => {
      const on = decodeAssessmentHeader(
        buildAssessmentHeader({ reference: SENTENCE, prosody: true }),
      );
      const off = decodeAssessmentHeader(
        buildAssessmentHeader({ reference: SENTENCE, prosody: false }),
      );
      expect(on["EnableProsodyAssessment"]).toBe("True");
      expect(off["EnableProsodyAssessment"]).toBe("False");
      expect(typeof on["EnableProsodyAssessment"]).toBe("string");
    });

    test("默认粒度是 Phoneme —— 音素明细是发音纠错的素材", () => {
      const decoded = decodeAssessmentHeader(buildAssessmentHeader({ reference: SENTENCE }));
      expect(decoded["Granularity"]).toBe("Phoneme");
    });

    test.each([["Phoneme"], ["Word"], ["FullText"]] as const)("粒度 %s 透传", (g) => {
      const decoded = decodeAssessmentHeader(
        buildAssessmentHeader({ reference: SENTENCE, granularity: g }),
      );
      expect(decoded["Granularity"]).toBe(g);
    });

    test("参考文本的校验对 buildAssessmentHeader 同样生效", () => {
      expect(() => buildAssessmentHeader({ reference: "   " })).toThrow(InvalidReferenceError);
      expect(() =>
        buildAssessmentHeader({ reference: "a".repeat(MAX_REFERENCE_CHARS + 1) }),
      ).toThrow(InvalidReferenceError);
    });
  });

  // 判据五（见 decisions 0026）：凡是一个约束跨越两个模块，
  // 就写一条把整条链算出来的测试，让数字自己对账。
  //
  // 这一类的必要性来自一个真实教训：MAX_BODY_BYTES = 64KB 是按 JSON 想的，
  // 而 16kHz 音频是 32,000 字节/秒，64KB 只够 2 秒。两个模块各自自洽，
  // 拼起来是坏的，任何单层测试都抓不到。
  describe("F. 跨层约束对账", () => {
    test("上限是推导出来的，不是拍的 —— 音频上限改了它会跟着变", () => {
      expect(MAX_REFERENCE_CHARS).toBe(MAX_ASSESSABLE_SECONDS * CHARS_PER_SECOND * 2);
    });

    test("参考文本上限能覆盖 30 秒音频念得完的内容", () => {
      // 音频上限 30 秒，英语朗读约 15 字符/秒 → 450 字符。
      // 参考文本上限必须大于这个数，否则用户念满 30 秒反而被拒。
      const maxSpeakable = MAX_ASSESSABLE_SECONDS * CHARS_PER_SECOND;
      expect(MAX_REFERENCE_CHARS).toBeGreaterThan(maxSpeakable);
    });

    test("上限内的参考文本，编码后远小于常见的 8KB 请求头上限", () => {
      // 实测约 13000 字符的参考文本会让请求挂死——编码后约 17KB，
      // 超过常见请求头上限，服务端直接不响应，不是返回 4xx。
      const header = buildAssessmentHeader({ reference: "a".repeat(MAX_REFERENCE_CHARS) });
      expect(Buffer.byteLength(header, "ascii")).toBeLessThan(4096);
    });

    test("最坏情况：全部是四字节字符时，编码后仍在安全线内", () => {
      // base64 涨 1/3，UTF-8 下 emoji 占 4 字节。全是 emoji 是最坏情况。
      // 注意 emoji 的 .length 是 2（代理对），所以重复次数取上限的一半。
      const emoji = "🎧".repeat(MAX_REFERENCE_CHARS / 2);
      expect(emoji.length).toBe(MAX_REFERENCE_CHARS);
      const header = buildAssessmentHeader({ reference: emoji });
      expect(Buffer.byteLength(header, "ascii")).toBeLessThan(4096);
    });
  });
});
