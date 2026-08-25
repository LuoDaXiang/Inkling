import { describe, test, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "@/http/server";
import { FileAudioStore } from "@/storage/file-audio-store";
import { FakeTtsProvider } from "./helpers/fake-provider";
import { TARGET_SAMPLE_RATE } from "../public/recorder.js";

/**
 * 跨层一致性 —— 契约测试清单 #27，守 C3 与 C50。
 *
 * ## 这个文件存在的唯一理由
 *
 * 录音采样率和最长秒数，此前是**两边各硬编码一份，没有任何东西盯着它们相等**：
 *
 *   16000  `src/http/server.ts` RECORDING_SAMPLE_RATE
 *   16000  `public/recorder.js` TARGET_SAMPLE_RATE
 *      30  `src/core/audio/wav.ts` MAX_ASSESSABLE_SECONDS
 *      30  `public/index.html`     MAX_SECONDS
 *
 * 改服务端那一份，全部测试照绿，浏览器仍然发 16000——时长算错、
 * 修剪切错、计费算错，而且**不报错**。这正撞在 README 判据五
 * 「跨层约束要有整条链的断言」上。
 *
 * ## 一条禁令
 *
 * **本文件不得 import `@/http/server` 或 `@/core/**` 的任何常量。**
 *
 * 服务端的值只能从 HTTP 响应里来，客户端的值只能从 `public/` 里来。
 * 一旦为了「写起来简洁」而 import 服务端常量去断言，这条测试就退化成
 * 自己等于自己——那正是这个 bug 至今没被发现的原因，不是没人写测试，
 * 是写的测试两边取的是同一个值。
 *
 * 允许 import 的只有 `createApp`：那是被测系统本身，不是被断言的值。
 *
 * ## 第 6 步之后这条测试要改
 *
 * 现在它断言「两份拷贝相等」。等客户端改成从 `GET /api/config` 取值
 * （契约 §13 第 1 条），拷贝就只剩一份，届时这里应该改成断言
 * **客户端里已经没有这个字面量**。到那时它变红不是它坏了，是它该退休了。
 */

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

let dir: string;
let server: Server;
let config: Record<string, unknown>;

const portOf = (s: Server): number => (s.address() as AddressInfo).port;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkling-consistency-"));
  server = await new Promise<Server>((resolve) => {
    const s = createApp({
      provider: new FakeTtsProvider({}),
      store: new FileAudioStore(join(dir, "audio")),
      publicDir: PUBLIC_DIR,
      defaultVoice: "en-US-AvaNeural",
    }).listen(0, () => resolve(s));
  });
  const res = await fetch(`http://127.0.0.1:${portOf(server)}/api/config`);
  config = (await res.json()) as Record<string, unknown>;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

/**
 * 从 `public/index.html` 里抠出一个字面量常量。
 *
 * 它内联在 `<script type="module">` 里，没法 import，只能解析文本。
 * 抠不到就直接失败，不静默跳过——一条悄悄不跑的测试比没有更糟：
 * 它会让人以为这个约束有人守着。
 */
async function literalFromIndexHtml(name: string): Promise<number> {
  const source = await readFile(join(PUBLIC_DIR, "index.html"), "utf8");
  const match = new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`).exec(source);
  if (!match) {
    throw new Error(
      `在 public/index.html 里找不到 const ${name} —— ` +
        `要么它被改名了，要么已经改成从 /api/config 取值。` +
        `如果是后者，这条测试该按文件头说的退休了。`,
    );
  }
  return Number(match[1]);
}

describe("#27 录音采样率", () => {
  test("客户端的 TARGET_SAMPLE_RATE 等于服务端下发的 recordingSampleRate [C3][C50]", () => {
    // 左边来自 public/recorder.js，右边来自 HTTP 响应。两个独立来源。
    expect(TARGET_SAMPLE_RATE).toBe(config["recordingSampleRate"]);
  });

  test("客户端那份确实是个写死的字面量——所以才需要这条断言", async () => {
    const source = await readFile(join(PUBLIC_DIR, "recorder.js"), "utf8");
    expect(source).toMatch(/const\s+TARGET_SAMPLE_RATE\s*=\s*\d+/);
  });
});

describe("#27 最长录音秒数", () => {
  test("index.html 的 MAX_SECONDS 等于服务端下发的 maxRecordingSeconds [C3]", async () => {
    // 不一致的后果：用户录完 40 秒才被打回，而服务端上限是 30。
    expect(await literalFromIndexHtml("MAX_SECONDS")).toBe(config["maxRecordingSeconds"]);
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
        !line.includes("createApp"),
    );
    expect(offending).toEqual([]);
  });
});
