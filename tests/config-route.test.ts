import { describe, test, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@/http/server";
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
let withScoring: Server;
let withoutScoring: Server;

const portOf = (s: Server): number => (s.address() as AddressInfo).port;
const listen = (deps: Parameters<typeof createApp>[0]): Promise<Server> =>
  new Promise((resolve) => {
    const s = createApp(deps).listen(0, () => resolve(s));
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkling-config-"));
  const base = {
    provider: new FakeTtsProvider({}),
    store: new FileAudioStore(join(dir, "audio")),
    publicDir: join(dir, "public"),
    defaultVoice: "en-US-AvaNeural",
  };
  withScoring = await listen({ scoring: new FakeScoringProvider(), ...base });
  withoutScoring = await listen(base);
});

afterAll(async () => {
  await new Promise<void>((r) => withScoring.close(() => r()));
  await new Promise<void>((r) => withoutScoring.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

const get = (server: Server): Promise<Response> =>
  fetch(`http://127.0.0.1:${portOf(server)}/api/config`);

const body = async (server: Server): Promise<Record<string, unknown>> =>
  (await (await get(server)).json()) as Record<string, unknown>;

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
    const res = await get(withScoring);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("Content-Type 是 JSON", async () => {
    const res = await get(withScoring);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
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
    // HTTP 层用「字段不出现」表达缺席，绝不发 null。
    const raw = await (await get(withScoring)).text();
    expect(raw).not.toContain("null");
  });

  test("没配评分时也不出现 null", async () => {
    const raw = await (await get(withoutScoring)).text();
    expect(raw).not.toContain("null");
  });
});

describe("无副作用、幂等", () => {
  test("连调两次响应完全相同", async () => {
    const first = await (await get(withScoring)).text();
    const second = await (await get(withScoring)).text();
    expect(second).toBe(first);
  });

  test("POST /api/config 不被当成路由，落到 405", async () => {
    const res = await fetch(`http://127.0.0.1:${portOf(withScoring)}/api/config`, {
      method: "POST",
    });
    expect(res.status).toBe(405);
  });
});
