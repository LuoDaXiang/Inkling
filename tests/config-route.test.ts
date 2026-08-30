import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, type JsonResult, type ServerDeps } from "@/http/server";
import { FileAudioStore } from "@/storage/file-audio-store";
import { FakeTtsProvider } from "./helpers/fake-provider";
import { FakeScoringProvider } from "./helpers/fake-scoring-provider";

/**
 * `GET /api/config` —— 契约 §4，测试清单 #1 与 #2。
 *
 * 守的条款：C1（contractVersion 存在）、C5（scoringAvailable）、
 * C6（no-store）、C43（响应里不出现 null）。
 *
 * **这里不断言任何常量的字面值。**
 *
 * 契约 §15「不算破坏」明写：「改变 `GET /api/config` 里某个常量的值——
 * 那正是把它做成下发字段的全部目的」。在这里写
 * `expect(recordingSampleRate).toBe(16000)` 就是把一件被明确允许的改动
 * 变成会让测试变红的改动，方向反了。
 *
 * 这里只守**形状**：字段在不在、类型对不对、有没有 null。
 * 值相等的断言属于跨层一致性测试（#27，`contract-consistency.test.ts`），
 * 那里比的是客户端和服务端两份独立定义，不是和一个写死的字面量比。
 *
 * 唯一的例外是 `contractVersion`——它不是可调的常量，是契约标识本身（C1/C4）。
 *
 * ## M2.5：驱动方式换了，断言一条没换
 *
 * 此前这些用例靠 `createApp(deps)` 起一个真端口加真实 `fetch` 驱动。
 * 现在直接 `await getConfig(deps)`——**同一个函数，同一组断言**，
 * 只是不再经过一个 socket。这正是 M2.5 的全部目的：M3 换成 IPC 时，
 * 下面这些用例一行都不用动。
 *
 * M3 之后连那条 405 也退役了：它守的是 HTTP 路由分派，而 HTTP 没了。
 * 见文件末尾那段说明。
 */

/** 契约 §4 规定的数值字段，一个不能少。 */
const NUMERIC_FIELDS = [
  "recordingSampleRate",
  "maxRecordingSeconds",
  "maxUploadBytes",
  "maxReferenceChars",
  "maxTitleChars",
  "maxSentencesPerMaterial",
] as const;

let dir: string;
let withScoring: ServerDeps;
let withoutScoring: ServerDeps;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkling-config-"));
  const base: ServerDeps = {
    provider: new FakeTtsProvider({}),
    store: new FileAudioStore(join(dir, "audio")),
    defaultVoice: "en-US-AvaNeural",
  };
  withScoring = Object.assign({}, base, { scoring: new FakeScoringProvider() });
  withoutScoring = base;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const get = async (deps: ServerDeps): Promise<JsonResult> =>
  (await getConfig(deps)) as JsonResult;

const body = async (deps: ServerDeps): Promise<Record<string, unknown>> =>
  (await get(deps)).body as Record<string, unknown>;

/** 序列化之后的样子。[C43] 那两条断言的是「线上真的没有 null」。 */
const text = async (deps: ServerDeps): Promise<string> => JSON.stringify((await get(deps)).body);

describe("#1 契约版本与缓存头", () => {
  test("200", async () => {
    expect((await get(withScoring)).status).toBe(200);
  });

  test("contractVersion 出现在响应里 [C1]", async () => {
    // 没有它，「单客户端、同版本发布」这个假设就不可检测——
    // 而声明一个假设却不给检测手段，等于没有假设。
    expect((await body(withScoring))["contractVersion"]).toBe("v0");
  });

  test("响应头是 Cache-Control: no-store [C6]", async () => {
    // 这份 config 的全部目的是消灭「两边不一致」。
    // 让它自己被缓存住是自相矛盾——客户端会拿着上一版的常量跑。
    expect((await get(withScoring)).headers?.["Cache-Control"]).toBe("no-store");
  });

  test("是 JSON 结果，不是二进制", async () => {
    // Content-Type 由适配器统一加（`send()` 里那一处），handler 只表明
    // 自己产出的是 JSON 而不是字节流。断言这一点等价于此前断言
    // `content-type: application/json`，而且不依赖传输。
    expect("bytes" in (await getConfig(withScoring))).toBe(false);
  });
});

describe("#2 scoringAvailable [C5]", () => {
  test("配了评分 provider → true", async () => {
    expect((await body(withScoring))["scoringAvailable"]).toBe(true);
  });

  test("没配 → false", async () => {
    // 服务端一直知道评分没配，但此前没有任何办法告诉客户端，
    // 用户只能录完 30 秒再吃一个 503。
    expect((await body(withoutScoring))["scoringAvailable"]).toBe(false);
  });

  test("是布尔，不是字符串或 0/1", async () => {
    expect(typeof (await body(withoutScoring))["scoringAvailable"]).toBe("boolean");
  });
});

describe("响应形状", () => {
  test("§4 规定的数值字段全都在，且是正整数", async () => {
    const config = await body(withScoring);
    for (const field of NUMERIC_FIELDS) {
      const value = config[field];
      expect(typeof value, `${field} 应该是数字`).toBe("number");
      expect(Number.isInteger(value), `${field} 应该是整数`).toBe(true);
      expect(value as number, `${field} 应该为正`).toBeGreaterThan(0);
    }
  });

  test("没有多余字段——契约之外的字段是无意的承诺", async () => {
    const expected = ["contractVersion", "scoringAvailable"].concat(NUMERIC_FIELDS as unknown as string[]);
    expect(Object.keys(await body(withScoring)).sort()).toEqual(expected.sort());
  });

  test("响应里不出现 null [C43]", async () => {
    // 传输层用「字段不出现」表达缺席，绝不发 null。
    expect(await text(withScoring)).not.toContain("null");
  });

  test("没配评分时也不出现 null", async () => {
    expect(await text(withoutScoring)).not.toContain("null");
  });
});

describe("无副作用、幂等", () => {
  test("连调两次响应完全相同", async () => {
    expect(await text(withScoring)).toBe(await text(withScoring));
  });

  /*
   * 原本这里还有一条「POST /api/config 落到 405」。
   *
   * 它测的是 **HTTP 路由分派**，而 M3 把 HTTP 适配器整个删了
   * （禁区 #3 / #4：桌面应用不开无鉴权端口，也不让两套入口并存）。
   * IPC 没有「方法」这个维度——一个频道就是一个 handler，调不到的频道
   * 会在 `ipcRenderer.invoke` 那里直接报 "No handler registered"。
   *
   * 所以这一条不是被删掉，是**它守的那个东西不存在了**。
   * 这属于计划里说的「唯一一次允许掉测试」：随传输一起退役。
   */
});
