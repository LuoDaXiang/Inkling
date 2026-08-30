import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  postAssess as assessHandler,
  postTts as ttsHandler,
  type JsonResult,
  type ServerDeps,
} from "@/http/server";
import { RECORDING_SAMPLE_RATE } from "@/http/contract";
import type { ScoringProvider } from "@/providers/scoring/types";
import type { TtsProvider, TtsRequest, TtsResult } from "@/providers/tts/types";
import { FileAudioStore } from "@/storage/file-audio-store";
import { OperationLog } from "@/storage/operations";
import { scoringCostMicros, ttsCostMicros, type Rates } from "@/core/cost";
import { FakeTtsProvider } from "./helpers/fake-provider";
import { FakeScoringProvider, err } from "./helpers/fake-scoring-provider";
import { memoryDb } from "./helpers/db";

/**
 * 流水在 HTTP 层的接线。
 *
 * 存储层自己的用例已经把流水本身测透了，这里测的是**接缝**：
 * 路由有没有在该记的地方记、记的内容对不对、以及最重要的那条契约——
 *
 *   **流水挂了，业务请求必须照常成功。**
 *
 * 前面所有关于「不抛」的用例都是在存储层验证的。但真正决定这条契约
 * 成不成立的是调用点：路由里只要有一个地方 await 了它、或者把它
 * 放进了 try 之外，契约就破了。所以必须在这一层再验一次。
 *
 * ## M2.5：驱动方式换了，断言一条没换
 *
 * 此前每个用例组都自己 `createApp()` 起一台监听在随机端口上的服务器——
 * 这个文件里一共有五处。现在它们都只是一个 `ServerDeps` 字面量，
 * 用例直接调 `ttsHandler` / `assessHandler`。
 *
 * 「接缝」这个测试目标一点没变：流水写在哪、写了什么、以及那条最重要的
 * 「流水挂了业务照常」——它们守的是 handler 内部的调用点，
 * 而调用点并不因为外面是 HTTP 还是 IPC 而不同。
 */

let deps: ServerDeps;
let dir: string;
let db: ReturnType<typeof memoryDb>;
let log: OperationLog;
let tts: FakeTtsProvider;
let scoring: FakeScoringProvider;

/** 代理：换实现不重启服务器，沿用 assess-route.test.ts 的做法。 */
const ttsProxy: TtsProvider = {
  engine: "fake",
  model: "fake-1",
  maxChars: 500,
  synthesize: (r: TtsRequest): Promise<TtsResult> => tts.synthesize(r),
};
const scoringProxy: ScoringProvider = {
  engine: "fake",
  maxSeconds: 30,
  maxReferenceChars: 900,
  assess: (r) => scoring.assess(r),
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkling-ops-"));
  db = memoryDb();
  log = new OperationLog(db);
  deps = {
    provider: ttsProxy,
    scoring: scoringProxy,
    store: new FileAudioStore(join(dir, "audio")),
    defaultVoice: "en-US-AvaNeural",
    log,
  };
});

afterAll(async () => {
  try {
    db.close();
  } catch {
    // 某些用例故意把它关掉了
  }
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  tts = new FakeTtsProvider({});
  scoring = new FakeScoringProvider();
  db.exec("DELETE FROM operations");
});

const rows = () => db.prepare("SELECT * FROM operations ORDER BY id").all() as Array<
  Record<string, unknown>
>;

const speech = (seconds: number): Float32Array =>
  Float32Array.from(
    { length: Math.round(seconds * RECORDING_SAMPLE_RATE) },
    (_, i) => 0.25 * Math.sin(i / 4),
  );

/** 静音 + 语音 + 静音，用来验证「按修剪后的时长计费」。 */
const withSilence = (leadSec: number, speechSec: number, tailSec: number): Float32Array => {
  const out = new Float32Array(
    Math.round((leadSec + speechSec + tailSec) * RECORDING_SAMPLE_RATE),
  );
  out.set(speech(speechSec), Math.round(leadSec * RECORDING_SAMPLE_RATE));
  return out;
};

const postTts = async (text: string, at?: ServerDeps): Promise<JsonResult> =>
  (await ttsHandler({ raw: JSON.stringify({ text }) }, at ?? deps)) as JsonResult;

const postAssess = async (pcm: Float32Array, reference = "hello world"): Promise<JsonResult> =>
  (await assessHandler(
    { query: { reference }, body: Buffer.from(pcm.buffer) },
    deps,
  )) as JsonResult;

describe("TTS 路由", () => {
  test("成功一次记两行：request + result", async () => {
    const res = await postTts("hello");
    expect(res.status).toBe(200);

    const all = rows();
    expect(all.map((r) => r["kind"])).toEqual(["request", "result"]);
    expect(all[0]?.["provider"]).toBe("fake");
    expect(all[1]?.["status"]).toBe(200);
    expect(Number(all[1]?.["latency_ms"])).toBeGreaterThanOrEqual(0);
  });

  test("同一次请求的两行 trace_id 相同", async () => {
    await postTts("hello");
    const all = rows();
    expect(all[0]?.["trace_id"]).toBe(all[1]?.["trace_id"]);
  });

  test("两次请求的 trace_id 不同", async () => {
    await postTts("one");
    await postTts("two");
    const traces = new Set(rows().map((r) => String(r["trace_id"])));
    expect(traces.size).toBe(2);
  });

  test("缓存命中会被记下来——这是省钱那条路的证据", async () => {
    await postTts("same text");
    db.exec("DELETE FROM operations");
    await postTts("same text");

    const result = rows().find((r) => r["kind"] === "result");
    expect(JSON.parse(String(result?.["meta"]))).toMatchObject({ cached: true });
    expect(tts.callCount).toBe(1); // 第二次没调 provider
  });

  test("provider 报错记成 error，带分类和状态码", async () => {
    tts.alwaysError = err("quota");
    // 文本必须是没被缓存过的，否则命中缓存就根本不会调 provider。
    const res = await postTts("quota failure case");
    expect(res.status).toBe(503);

    const all = rows();
    expect(all.map((r) => r["kind"])).toEqual(["request", "error"]);
    expect(all[1]?.["error_kind"]).toBe("quota");
    expect(all[1]?.["status"]).toBe(503);
  });

  test("参数校验失败不记流水——请求根本没到达外部服务", async () => {
    const res = await ttsHandler({ raw: JSON.stringify({ notText: 1 }) }, deps);
    expect(res.status).toBe(400);
    // 流水记的是「调用外部服务」这件事。参数错在我们这边就被挡下了，
    // 记进去只会让「失败率」这个指标失真。
    expect(rows()).toHaveLength(0);
  });
});

describe("评分路由", () => {
  test("成功一次记两行", async () => {
    const res = await postAssess(speech(2));
    expect(res.status).toBe(200);
    expect(rows().map((r) => r["kind"])).toEqual(["request", "result"]);
  });

  test("整段静音记成 result 不是 error", async () => {
    // 用户确实录了一段没有语音的东西，这是结果不是故障。
    // 记成 error 会让失败率虚高，排查时被误导。
    const res = await postAssess(new Float32Array(RECORDING_SAMPLE_RATE));
    expect(res.status).toBe(200);
    const all = rows();
    expect(all.map((r) => r["kind"])).toEqual(["request", "result"]);
    expect(JSON.parse(String(all[1]?.["meta"]))).toMatchObject({
      reason: "no_speech_after_trim",
    });
  });

  test("评分服务报错记成 error", async () => {
    scoring = new FakeScoringProvider({ results: [err("network")] });
    const res = await postAssess(speech(2));
    expect(res.status).toBe(502);
    const all = rows();
    expect(all[1]?.["kind"]).toBe("error");
    expect(all[1]?.["error_kind"]).toBe("network");
  });

  test("请求行记下了音频时长和字节数", async () => {
    await postAssess(speech(2));
    const meta = JSON.parse(String(rows()[0]?.["meta"])) as Record<string, unknown>;
    expect(meta["durationMs"]).toBe(2000);
    expect(Number(meta["audioBytes"])).toBe(2 * RECORDING_SAMPLE_RATE * 4);
  });
});

describe("隐私", () => {
  test("参考文本的内容不进流水，只进长度", async () => {
    const secret = "my private sentence about something personal";
    await postAssess(speech(2), secret);

    const dump = JSON.stringify(rows());
    expect(dump).not.toContain("private");
    expect(dump).not.toContain(secret);
    // 长度是有用的诊断信息，且不泄漏内容。
    const meta = JSON.parse(String(rows()[0]?.["meta"])) as Record<string, unknown>;
    expect(meta["textLength"]).toBe(secret.length);
  });

  test("待合成的文本内容也不进流水", async () => {
    await postTts("a sentence I would rather not have logged");
    const dump = JSON.stringify(rows());
    expect(dump).not.toContain("rather not");
  });
});

describe("契约：流水挂了不能拖垮业务", () => {
  test("没有 log 时路由照常工作", async () => {
    // 这一套完全没接流水。
    const bare: ServerDeps = {
      provider: ttsProxy,
      store: new FileAudioStore(join(dir, "audio-bare")),
      defaultVoice: "en-US-AvaNeural",
    };

    expect((await postTts("no log here", bare)).status).toBe(200);
  });

  test("流水写入失败时请求仍然返回 200", async () => {
    // 把库关掉，模拟流水彻底不可用（磁盘满、文件被删、连接断）。
    const doomedDb = memoryDb();
    const doomedLog = new OperationLog(doomedDb);
    doomedDb.close();

    const doomed: ServerDeps = {
      provider: ttsProxy,
      store: new FileAudioStore(join(dir, "audio-doomed")),
      defaultVoice: "en-US-AvaNeural",
      log: doomedLog,
    };

    const res = await postTts("log is broken", doomed);

    // 这是整个设计里最重要的一条断言。
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)["key"]).toBeTypeOf("string");
  });

  test("流水失败会走 onError，不是静默消失", async () => {
    const doomedDb = memoryDb();
    const seen: unknown[] = [];
    const doomedLog = new OperationLog(doomedDb, { onError: (e) => seen.push(e) });
    doomedDb.close();

    const doomed: ServerDeps = {
      provider: ttsProxy,
      store: new FileAudioStore(join(dir, "audio-onerror")),
      defaultVoice: "en-US-AvaNeural",
      log: doomedLog,
    };

    await postTts("x", doomed);

    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("service 与花费（F13 / F14）", () => {
  const RATES: Rates = { ttsPerMillionChars: 16_000_000, scoringPerAudioHour: 1_000_000 };

  let ratedDeps: ServerDeps;
  let ratedDb: ReturnType<typeof memoryDb>;
  let ratedLog: OperationLog;

  beforeAll(async () => {
    ratedDb = memoryDb();
    ratedLog = new OperationLog(ratedDb);
    ratedDeps = {
      provider: ttsProxy,
      scoring: scoringProxy,
      store: new FileAudioStore(join(dir, "audio-rated")),
      defaultVoice: "en-US-AvaNeural",
      log: ratedLog,
      rates: RATES,
    };
  });

  afterAll(async () => {
    ratedDb.close();
  });

  beforeEach(() => {
    ratedDb.exec("DELETE FROM operations");
  });

  const ratedRows = () =>
    ratedDb.prepare("SELECT * FROM operations ORDER BY id").all() as Array<Record<string, unknown>>;

  const ratedTts = async (text: string): Promise<JsonResult> =>
    (await ttsHandler({ raw: JSON.stringify({ text }) }, ratedDeps)) as JsonResult;

  const ratedAssess = async (
    pcm: Float32Array,
    reference = "hello world",
  ): Promise<JsonResult> =>
    (await assessHandler(
      { query: { reference }, body: Buffer.from(pcm.buffer) },
      ratedDeps,
    )) as JsonResult;

  describe("service 标记", () => {
    test("TTS 路由记 tts", async () => {
      await ratedTts("mark tts");
      expect(ratedRows().map((r) => r["service"])).toEqual(["tts", "tts"]);
    });

    test("评分路由记 scoring", async () => {
      await ratedAssess(speech(2));
      expect(ratedRows().map((r) => r["service"])).toEqual(["scoring", "scoring"]);
    });

    test("失败的记录也带 service", async () => {
      tts.alwaysError = err("quota");
      await ratedTts("failure keeps service");
      const all = ratedRows();
      expect(all[1]?.["kind"]).toBe("error");
      expect(all[1]?.["service"]).toBe("tts");
    });
  });

  describe("花费", () => {
    test("TTS 按字符数计费", async () => {
      const text = "cost by characters";
      await ratedTts(text);
      const result = ratedRows().find((r) => r["kind"] === "result");
      expect(Number(result?.["cost_micros"])).toBe(ttsCostMicros(text.length, RATES));
    });

    test("缓存命中不计费——记 null 而不是 0", async () => {
      // 「没调服务」和「调了但免费」是两回事。记 0 会让人以为调过。
      const text = "cached costs nothing";
      await ratedTts(text);
      ratedDb.exec("DELETE FROM operations");
      await ratedTts(text);

      const result = ratedRows().find((r) => r["kind"] === "result");
      expect(JSON.parse(String(result?.["meta"]))).toMatchObject({ cached: true });
      expect(result?.["cost_micros"]).toBeNull();
    });

    test("失败不计费", async () => {
      tts.alwaysError = err("quota");
      await ratedTts("failed calls are free");
      const error = ratedRows().find((r) => r["kind"] === "error");
      expect(error?.["cost_micros"]).toBeNull();
    });

    test("request 行不计费——只有结果才知道调没调成", async () => {
      await ratedTts("request row has no cost");
      const request = ratedRows().find((r) => r["kind"] === "request");
      expect(request?.["cost_micros"]).toBeNull();
    });

    test("评分按**修剪后**的时长计费，不是用户按住录音键的时长", async () => {
      // 首尾静音没有送出去，不该计费。这是最容易记错的一条：
      // 直接用上传的采样数会把静音也算进账单。
      const res = await ratedAssess(withSilence(1.5, 2, 1.5)); // 上传 5 秒，实际约 2 秒
      const data = res.body as Record<string, unknown>;
      const assessedMs = Number(data["assessedMs"]);
      expect(assessedMs).toBeLessThan(3000); // 确认真的被修剪了

      const result = ratedRows().find((r) => r["kind"] === "result");
      const expected = scoringCostMicros(assessedMs, RATES);
      expect(Number(result?.["cost_micros"])).toBe(expected);

      // 而且明显小于按上传的 5 秒算出来的数
      expect(Number(result?.["cost_micros"])).toBeLessThan(
        scoringCostMicros(5000, RATES),
      );
    });

    test("修剪后什么都不剩时不计费——根本没调服务", async () => {
      const res = await ratedAssess(new Float32Array(RECORDING_SAMPLE_RATE));
      expect(res.status).toBe(200);
      const result = ratedRows().find((r) => r["kind"] === "result");
      expect(JSON.parse(String(result?.["meta"]))).toMatchObject({
        reason: "no_speech_after_trim",
      });
      expect(result?.["cost_micros"]).toBeNull();
    });

    test("服务返回「没识别到语音」仍然计费——音频确实送出去了", async () => {
      scoring = new FakeScoringProvider({ results: [null] });
      await ratedAssess(speech(2));
      const result = ratedRows().find((r) => r["kind"] === "result");
      expect(JSON.parse(String(result?.["meta"]))).toMatchObject({ reason: "no_speech" });
      expect(Number(result?.["cost_micros"])).toBeGreaterThan(0);
    });

    test("没配费率时一律不记花费", async () => {
      // 用主服务器，它没有 rates。
      await postTts("no rates configured");
      const result = rows().find((r) => r["kind"] === "result");
      expect(result?.["cost_micros"]).toBeNull();
    });
  });

  test("验收标准：练了几次、失败几次、花了多少", async () => {
    await ratedTts("listen once");          // 听范本
    await ratedAssess(speech(2));           // 练习 1
    await ratedAssess(speech(2));           // 练习 2
    scoring = new FakeScoringProvider({ results: [err("network")] });
    await ratedAssess(speech(2));           // 练习 3，失败

    const practice = ratedLog.summary(0, Date.now() + 1000, "scoring");
    expect(practice.requests).toBe(3);      // 练了三次，听范本不算
    expect(practice.failures).toBe(1);
    expect(practice.costMicros).toBeGreaterThan(0);

    // 听范本的花费单独看得见
    const listening = ratedLog.summary(0, Date.now() + 1000, "tts");
    expect(listening.requests).toBe(1);
  });
});

describe("summary 能回答 roadmap 的问题", () => {
  test("练了几次、失败几次", async () => {
    await postTts("summary one");
    await postTts("summary two");
    tts.alwaysError = err("network");
    await postTts("summary three");

    const s = log.summary(0, Date.now() + 1000);
    expect(s.requests).toBe(3);
    expect(s.failures).toBe(1);
  });
});
