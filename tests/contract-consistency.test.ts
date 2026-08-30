import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, type JsonResult } from "@/http/server";
import { FileAudioStore } from "@/storage/file-audio-store";
import { FakeTtsProvider } from "./helpers/fake-provider";
import { TARGET_SAMPLE_RATE } from "@renderer/lib/recorder";

/**
 * 跨层一致性 —— 契约测试清单 #27，守 C3 与 C50。
 *
 * ## 这个文件存在的唯一理由
 *
 * 录音采样率和最长秒数，此前是两边各硬编码一份：
 *
 *   16000  `src/http/contract.ts` RECORDING_SAMPLE_RATE
 *   16000  `src/renderer/lib/recorder.ts` TARGET_SAMPLE_RATE
 *      30  `src/core/audio/wav.ts` MAX_ASSESSABLE_SECONDS
 *      30  `public/index.html`     MAX_SECONDS（M3 之后不存在了，见下）
 *
 * **而没有一条测试看过客户端那一份。** 变异实测（这个文件落地之前）：
 *
 *   服务端 RECORDING_SAMPLE_RATE  16000 → 8000  红 1 条
 *   服务端 MAX_ASSESSABLE_SECONDS    30 → 40    红 7 条，5 个文件
 *   客户端 TARGET_SAMPLE_RATE     16000 → 8000  **红 0 条**
 *   客户端 MAX_SECONDS               30 → 40    **红 0 条**
 *
 * 服务端那一侧被既有测试用字面量钉着，客户端那一侧一条都没有——
 * 而那恰恰是更容易发生的方向：改前端的人不会去跑服务端测试。
 * 后果是时长算错、修剪切错、计费算错，而且**不报错**。
 * 这正撞在 README 判据五「跨层约束要有整条链的断言」上：链条只有半条。
 *
 * ## 一条禁令
 *
 * **本文件不得 import `@/http/server` 或 `@/core/**` 的任何常量。**
 *
 * 服务端的值只能从被测系统的输出里来，客户端的值只能从 `src/renderer/` 里来。
 * 一旦为了「写起来简洁」而 import 服务端常量去断言，这条测试就退化成
 * 自己等于自己——**而且退化之后它照样是绿的**，没有任何东西会报警。
 *
 * 缺口原本不是「测试取错了值」，是**客户端那一侧压根没有测试**。
 * 这条禁令防的是把新补上的那一侧再退化回去。
 *
 * 允许 import 的只有 `getConfig`（M2.5 之前是 `createApp`）：
 * 那是**被测系统本身**，不是被断言的值。换成 `getConfig` 之后这条禁令
 * 一个字没松——它禁的始终是 import **常量**，而不是 import 被测函数。
 *
 * ## 第 6 步之后这条测试要改
 *
 * 现在它断言「两份拷贝相等」。等客户端改成从 `GET /api/config` 取值
 * （契约 §13 第 1 条），拷贝就只剩一份，届时这里应该改成断言
 * **客户端里已经没有这个字面量**。到那时它变红不是它坏了，是它该退休了。
 */

const RENDERER_DIR = fileURLToPath(new URL("../src/renderer/", import.meta.url));

let dir: string;
let config: Record<string, unknown>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkling-consistency-"));
  // M2.5：值仍然只从**被测系统的输出**里来，不从 import 的常量里来。
  // 变的只是取输出的方式：以前经过一个 socket，现在直接调那个 handler。
  const result = (await getConfig({
    provider: new FakeTtsProvider({}),
    store: new FileAudioStore(join(dir, "audio")),
    defaultVoice: "en-US-AvaNeural",
  })) as JsonResult;
  config = result.body as Record<string, unknown>;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 渲染层的全部源码，用来搜「客户端里还有没有某个写死的常量」。 */
async function rendererSources(): Promise<string> {
  const files = await readdir(RENDERER_DIR, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(
    files
      .filter((f) => f.isFile() && /\.(ts|tsx)$/.test(f.name))
      .map((f) => readFile(join(f.parentPath ?? RENDERER_DIR, f.name), "utf8")),
  );
  return texts.join("\n");
}

describe("#27 录音采样率", () => {
  test("客户端的 TARGET_SAMPLE_RATE 等于服务端下发的 recordingSampleRate [C3][C50]", () => {
    // 左边来自 src/renderer/lib/recorder.ts，右边来自被测系统的输出。
    // **两个独立来源**——这句话是这条用例的全部意义，M3 换了传输之后
    // 来源的名字变了，「独立」这件事没变。
    expect(TARGET_SAMPLE_RATE).toBe(config["recordingSampleRate"]);
  });

  test("客户端那份确实是个写死的字面量——所以才需要这条断言", async () => {
    const source = await readFile(join(RENDERER_DIR, "lib", "recorder.ts"), "utf8");
    expect(source).toMatch(/const\s+TARGET_SAMPLE_RATE\s*=\s*\d+/);
  });
});

describe("#27 最长录音秒数 —— 这一条按文件头说的退休了", () => {
  test("客户端里已经没有 MAX_SECONDS 这个字面量了", async () => {
    // 文件头第 6 步写着：「等客户端改成从 config 取值，拷贝就只剩一份，
    // 届时这里应该改成断言**客户端里已经没有这个字面量**」。
    //
    // M3 的 React 界面直接读 `config.maxRecordingSeconds`（见 App.tsx 的
    // `maxSamples`），第二份拷贝没有了。所以现在守的是「它没有回来」——
    // 有人图省事在渲染层写回一个 30，这一条会红。
    expect(await rendererSources()).not.toMatch(/const\s+MAX_SECONDS\s*=/);
  });

  test("上限确实从主进程下发的 config 里来", async () => {
    // 退休的是「比对两份拷贝」，不是「这个约束不用守了」。
    // 值仍然必须存在且为正——它现在是界面唯一的来源。
    expect(typeof config["maxRecordingSeconds"]).toBe("number");
    expect(config["maxRecordingSeconds"] as number).toBeGreaterThan(0);
  });
});

describe("禁令自检", () => {
  test("本文件没有 import 服务端常量", async () => {
    // 这条守的是这个测试文件自己。将来有人为了写起来简洁而 import
    // RECORDING_SAMPLE_RATE，上面两条断言就变成自己等于自己，
    // 而且不会有任何东西报警——除了这一条。
    const self = await readFile(fileURLToPath(import.meta.url), "utf8");
    const imports = self.match(/^import .*$/gm) ?? [];
    const offending = imports.filter(
      (line) =>
        (line.includes("@/http/server") || line.includes("@/core/")) &&
        !line.includes("getConfig"),
    );
    expect(offending).toEqual([]);
  });
});
