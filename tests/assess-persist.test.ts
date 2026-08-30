import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getRecordingAudio,
  postAssess,
  postMaterials,
  type BytesResult,
  type JsonResult,
  type ServerDeps,
} from "@/http/server";
import { RECORDING_SAMPLE_RATE } from "@/http/contract";
import type { ScoringProvider } from "@/providers/scoring/types";
import { parseWav } from "@/core/audio/wav";
import { FileAudioStore } from "@/storage/file-audio-store";
import { RecordingStore } from "@/storage/recording-store";
import { OperationLog } from "@/storage/operations";
import { FakeTtsProvider } from "./helpers/fake-provider";
import { FakeScoringProvider, scores, noiseScores, err } from "./helpers/fake-scoring-provider";
import { memoryDb } from "./helpers/db";

/**
 * `POST /api/assess` 落库 —— 契约 §6.6 / §6.7，测试清单 #3–#10、#18–#23、#28–#29。
 *
 * **做完这一步 F12 关闭**：练一次，四张业务表各多一行。
 *
 * 这里最要紧的两组：
 *
 *   `persisted` 的三态（[C32]）——「本来就没要求记录」和「要求了但写失败了」
 *   必须分得开，否则客户端不知道该不该提示用户「这次没记上」。
 *
 *   落盘顺序（[C67]）——文件系统不参与 SQLite 事务。先写文件后写库，
 *   失败态是孤儿文件；反过来是悬空引用，那是用户看到坏记录。
 */

let dir: string;
let db: ReturnType<typeof memoryDb>;
let recordings: RecordingStore;
let log: OperationLog;
let deps: ServerDeps;

/** 库已经关掉的那一台，用来制造落库失败。 */
let brokenDb: ReturnType<typeof memoryDb>;
let brokenRecordings: RecordingStore;
let brokenDeps: ServerDeps;

let current: FakeScoringProvider;
const proxy: ScoringProvider = {
  engine: "fake",
  maxSeconds: 30,
  maxReferenceChars: 900,
  assess: (r) => current.assess(r),
};
const use = (options: ConstructorParameters<typeof FakeScoringProvider>[0]): FakeScoringProvider => {
  current = new FakeScoringProvider(options);
  return current;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkling-persist-"));
  db = memoryDb();
  recordings = new RecordingStore(join(dir, "recordings"));
  log = new OperationLog(db);
  deps = {
    provider: new FakeTtsProvider({}),
    scoring: proxy,
    store: new FileAudioStore(join(dir, "audio")),
    defaultVoice: "en-US-AvaNeural",
    db,
    recordings,
    log,
  };

  brokenDb = memoryDb();
  brokenRecordings = new RecordingStore(join(dir, "broken-recordings"));
  brokenDeps = {
    provider: new FakeTtsProvider({}),
    scoring: proxy,
    store: new FileAudioStore(join(dir, "broken-audio")),
    defaultVoice: "en-US-AvaNeural",
    db: brokenDb,
    recordings: brokenRecordings,
  };
});

afterAll(async () => {
  try {
    db.close();
  } catch {
    /* 已关 */
  }
  try {
    brokenDb.close();
  } catch {
    /* 已关 */
  }
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  use({ results: [scores()] });
  db.exec("DELETE FROM material");
  db.exec("DELETE FROM operations");
});

const speech = (seconds: number): Float32Array =>
  Float32Array.from({ length: Math.round(seconds * RECORDING_SAMPLE_RATE) }, (_, i) =>
    0.25 * Math.sin(i / 4),
  );

/** 建一份材料，返回第一句的 id。 */
async function makeSentence(text = "The quick brown fox.", at?: ServerDeps): Promise<number> {
  const result = (await postMaterials(
    { raw: JSON.stringify({ title: "t", source: "paste", text }) },
    at ?? deps,
  )) as JsonResult;
  const made = result.body as { sentences: Array<{ id: number }> };
  return made.sentences[0]!.id;
}

/**
 * 评分。仍然收一条 query string，因为用例表达的就是「客户端发了这几个参数」。
 * 这里做的解析和适配器里那一行是同一件事（M2.5）。
 */
const assess = async (
  query: string,
  pcm = speech(2),
  at?: ServerDeps,
): Promise<JsonResult> => {
  const params = new URLSearchParams(query);
  const q: Record<string, string | undefined> = {};
  for (const [k, v] of params) q[k] = v;
  return (await postAssess({ query: q, body: Buffer.from(pcm.buffer) }, at ?? deps)) as JsonResult;
};

const bodyOf = async (res: JsonResult): Promise<Record<string, unknown>> =>
  res.body as Record<string, unknown>;

/**
 * 回放。`audioUrl` 是 `/api/recordings/{id}/audio`，这里把 id 抠出来直接调
 * handler——断言的仍然是同一组 header 与同一段字节。
 */
const playback = async (audioUrl: string, at?: ServerDeps): Promise<BytesResult | JsonResult> => {
  const id = audioUrl.split("/")[3] ?? "";
  return getRecordingAudio({ id }, at ?? deps);
};

/**
 * 在「坏库」那一台上建一条句子，然后砍掉落库要写的三张表。
 *
 * 关掉整个库不行——那样 `getSentence()` 会先抛，请求在参数解析阶段就 500 了，
 * 测不到我们要测的东西。要制造的是**读得到句子、写不进记录**的局面。
 */
async function brokenSentence(): Promise<number> {
  brokenDb.exec("DROP TABLE IF EXISTS phoneme_score");
  brokenDb.exec("DROP TABLE IF EXISTS assessment");
  const id = await makeSentence("Broken db sentence.", brokenDeps);
  brokenDb.exec("DROP TABLE IF EXISTS recording");
  return id;
}

const count = (table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as Record<string, unknown>)["c"]);

/** 副作用矩阵用：跑前跑后 diff 六张表的行数。只断言「该写的写了」抓不到多写。 */
const snapshot = (): Record<string, number> =>
  Object.fromEntries(
    ["material", "sentence", "recording", "assessment", "phoneme_score", "operations"].map((t) => [
      t,
      count(t),
    ]),
  );

describe("#3 #4 参数校验", () => {
  test("sentenceId 与 reference 同时给 → 400 [C24]", async () => {
    // 不是「以某个为准」：同一个事实存两份且可能不一致，
    // 是契约必须在边界上杀死的东西。
    const id = await makeSentence();
    const res = await assess(`sentenceId=${id}&reference=hello`);
    expect(res.status).toBe(400);
    expect((await bodyOf(res))["error"]).toBe("rejected");
  });

  test("两个都不给 → 400", async () => {
    expect((await assess("")).status).toBe(400);
  });

  test("sentenceId 不存在 → 404", async () => {
    const res = await assess("sentenceId=999999");
    expect(res.status).toBe(404);
    expect((await bodyOf(res))["error"]).toBe("not_found");
  });

  test("sentenceId 不是正整数 → 400，不是 404 [C57]", async () => {
    for (const bad of ["abc", "1.5", "-3", "0"]) {
      const res = await assess(`sentenceId=${bad}`);
      expect(res.status, bad).toBe(400);
    }
  });

  test("clientRequestId 不是 UUID v4 → 400 [C64]", async () => {
    // 不静默丢弃：META_KEYS 的单值上限是 512 字符且超限是静默截断，
    // 一个残缺的 id 进流水比没有更糟。
    const id = await makeSentence();
    for (const bad of ["nope", "123", "0d5f8f5e-6c1e-1a5b-9a4e-2f7c1b3d4e5f"]) {
      const res = await assess(`sentenceId=${id}&clientRequestId=${bad}`);
      expect(res.status, bad).toBe(400);
    }
  });

  test("capture 参数只接受 true / false，不把 1 当真 [C66]", async () => {
    const id = await makeSentence();
    for (const bad of ["1", "0", "yes", "TRUE", ""]) {
      const res = await assess(`sentenceId=${id}&echoCancellation=${bad}`);
      expect(res.status, bad).toBe(400);
    }
    expect((await assess(`sentenceId=${id}&echoCancellation=false`)).status).toBe(200);
  });
});

describe("#5 参考文本取自库里那份 [C25]", () => {
  test("客户端不传 reference，服务端从 sentence.text 读", async () => {
    const id = await makeSentence("Original sentence here.");
    const provider = use({ results: [scores()] });
    await assess(`sentenceId=${id}`);
    expect(provider.calls[0]?.reference).toBe("Original sentence here.");
  });

  test("改了库里的文本，送给 provider 的跟着变", async () => {
    // 这条守的是「id 是权威，不是客户端手里那份文本」。客户端传 reference 的话，
    // 用户在界面上改了文本而 id 没变，评分就会挂到错误的句子上。
    const id = await makeSentence("Before edit.");
    db.prepare("UPDATE sentence SET text = ? WHERE id = ?").run("After edit.", id);
    const provider = use({ results: [scores()] });
    await assess(`sentenceId=${id}`);
    expect(provider.calls[0]?.reference).toBe("After edit.");
  });
});

describe("#7 #9 四种走向 × 落库组合 [C33]", () => {
  test("scored → recording + assessment + phoneme_score 都写", async () => {
    const id = await makeSentence();
    const body = await bodyOf(await assess(`sentenceId=${id}`));
    expect(body["outcome"]).toBe("scored");
    expect(body["persisted"]).toBe(true);
    expect(count("recording")).toBe(1);
    expect(count("assessment")).toBe(1);
    expect(count("phoneme_score")).toBeGreaterThan(0);
  });

  test("unreliable → 同样落库，因为同样花了钱", async () => {
    const id = await makeSentence();
    use({ results: [noiseScores()] });
    const body = await bodyOf(await assess(`sentenceId=${id}`));
    expect(body["outcome"]).toBe("unreliable");
    expect(body["persisted"]).toBe(true);
    expect(count("assessment")).toBe(1);
  });

  test("no_speech（服务识别不到）→ 只落 recording，不落 assessment", async () => {
    // 这一行是第一轮 grill 抓出来的自相矛盾：同样花了钱却不落库。
    // 一条规则统一两处：**花了钱就必须留痕**。那次录音也存下来，
    // 用户可以回放确认自己到底录了什么。
    const id = await makeSentence();
    use({ results: [null] });
    const body = await bodyOf(await assess(`sentenceId=${id}`));
    expect(body["outcome"]).toBe("no_speech");
    expect(body["persisted"]).toBe(true);
    expect(count("recording")).toBe(1);
    expect(count("assessment")).toBe(0);
  });

  test("no_speech（修剪后为空）→ 四张业务表零新增行", async () => {
    // 根本没调外部服务，没有成本，所以不留痕。
    const id = await makeSentence();
    const before = snapshot();
    const body = await bodyOf(await assess(`sentenceId=${id}`, new Float32Array(RECORDING_SAMPLE_RATE)));

    expect(body["outcome"]).toBe("no_speech");
    expect(body["persisted"]).toBe(false);
    expect(body["persistError"]).toBeUndefined();

    const after = snapshot();
    for (const table of ["recording", "assessment", "phoneme_score"]) {
      expect(after[table], table).toBe(before[table]);
    }
  });

  test("#28 副作用矩阵：assess 不碰 material 与 sentence", async () => {
    const id = await makeSentence();
    const before = snapshot();
    await assess(`sentenceId=${id}`);
    const after = snapshot();
    expect(after["material"]).toBe(before["material"]);
    expect(after["sentence"]).toBe(before["sentence"]);
  });
});

describe("#8 reliable [C34][C73]", () => {
  test("scored → reliable = 1", async () => {
    const id = await makeSentence();
    await assess(`sentenceId=${id}`);
    const row = db.prepare("SELECT reliable FROM assessment").get() as Record<string, unknown>;
    expect(row["reliable"]).toBe(1);
  });

  test("unreliable → reliable = 0", async () => {
    // 趋势曲线必须默认过滤 reliable = 0，否则被噪声污染——
    // 而这件事发生时没有任何征兆：纯白噪声的准确度是 71 分。
    const id = await makeSentence();
    use({ results: [noiseScores()] });
    await assess(`sentenceId=${id}`);
    const row = db.prepare("SELECT reliable FROM assessment").get() as Record<string, unknown>;
    expect(row["reliable"]).toBe(0);
  });

  test("存的是整数，不是 JS boolean", async () => {
    // [C73]：node:sqlite 的布尔绑定行为随 Node 版本变（F17 已实测到差异），
    // 所以必须走 toFlag()。这条守着那次转换真的发生了。
    const id = await makeSentence();
    await assess(`sentenceId=${id}`);
    const row = db.prepare("SELECT reliable FROM assessment").get() as Record<string, unknown>;
    expect(typeof row["reliable"]).toBe("number");
  });
});

describe("#32 persisted 的三态 [C32]", () => {
  test("没给 sentenceId → persisted:false 且没有 persistError", async () => {
    // 「本来就没要求记录」——匿名试用，客户端不该提示用户。
    const body = await bodyOf(await assess("reference=hello%20world"));
    expect(body["persisted"]).toBe(false);
    expect(body["persistError"]).toBeUndefined();
    expect(body["recordingId"]).toBeUndefined();
    expect(count("recording")).toBe(0);
  });

  test("#6 落库失败 → 200 + persisted:false + persistError，且结果字段完整", async () => {
    // [C35] 评分已经成功、钱已经花了，把结果扔掉是第二次伤害。
    // 但静默吞掉也不行——练习记录丢一行是用户的数据没了。
    const id = await brokenSentence();
    const res = await assess(`sentenceId=${id}`, speech(2), brokenDeps);
    expect(res.status).toBe(200);

    const body = await bodyOf(res);
    expect(body["persisted"]).toBe(false);
    expect(typeof body["persistError"]).toBe("string");
    // 结果照给：分数和逐词明细一个不少。
    expect(body["outcome"]).toBe("scored");
    expect(body["scores"]).toBeDefined();
    expect(body["words"]).toBeDefined();
    expect(body["assessedMs"]).toBeDefined();
  });

  test("#29 落盘顺序：库写失败时音频文件已经在盘上（孤儿而非悬空）[C67]", async () => {
    // 先写文件后写库，所以失败态永远是「孤儿文件」——浪费磁盘。
    // 反过来是「悬空引用」——记录看起来正常，读音频 404。宁可浪费磁盘。
    const id = await brokenSentence();
    expect((await assess(`sentenceId=${id}`, speech(2), brokenDeps)).status).toBe(200);

    const left = await readdir(join(dir, "broken-recordings"));
    expect(left.filter((n) => n.endsWith(".wav")).length).toBeGreaterThan(0);
    expect(left.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("#19 #20 #37 录音落盘与回放", () => {
  test("同一句话录两次 → 两个不同的 audio_key，都能读回 [C38]", async () => {
    const id = await makeSentence();
    const first = await bodyOf(await assess(`sentenceId=${id}`, speech(2)));
    const second = await bodyOf(await assess(`sentenceId=${id}`, speech(3)));

    const keys = db
      .prepare("SELECT audio_key FROM recording ORDER BY id")
      .all()
      .map((r) => String((r as Record<string, unknown>)["audio_key"]));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);

    for (const body of [first, second]) {
      const res = (await playback(String(body["audioUrl"]))) as BytesResult;
      expect(res.status).toBe(200);
      expect(res.headers["Content-Type"]).toBe("audio/wav");
    }
  });

  test("回放带 immutable [C22][C37]", async () => {
    const id = await makeSentence();
    const body = await bodyOf(await assess(`sentenceId=${id}`));
    const res = (await playback(String(body["audioUrl"]))) as BytesResult;
    expect(res.headers["Cache-Control"]).toMatch(/immutable/);
  });

  test("落盘的 WAV 时长等于 assessedMs —— 存的是修剪后那一份 [C39]", async () => {
    // 存原始的，将来复盘会和分数对不上：修剪后的那份才是真正送去评分、
    // 也是计费依据的字节。
    const id = await makeSentence();
    const body = await bodyOf(await assess(`sentenceId=${id}`, speech(2)));
    const res = (await playback(String(body["audioUrl"]))) as BytesResult;
    const wav = res.bytes;

    const info = parseWav(wav);
    expect(Math.round(info.duration * 1000)).toBe(body["assessedMs"]);
  });

  test("录音与 TTS 音频分开存放 [C38]", async () => {
    // F8 将来要给 TTS 缓存加淘汰。混在一个目录里，淘汰会把用户的录音
    // 一起删掉——那是用户资产，不是缓存。
    const id = await makeSentence();
    const body = await bodyOf(await assess(`sentenceId=${id}`));
    const key = String(
      (db.prepare("SELECT audio_key FROM recording WHERE id = ?")
        .get(Number(body["recordingId"])) as Record<string, unknown>)["audio_key"],
    );

    // 录音落在 recordings/ 下
    expect(await readdir(join(dir, "recordings"))).toContain(`${key}.wav`);
    // 而 TTS 那个 store 对这个键一无所知
    expect(await new FileAudioStore(join(dir, "audio")).get(key)).toBeNull();
  });

  test("录音 id 不是正整数 → 400；不存在 → 404 [C57]", async () => {
    expect((await getRecordingAudio({ id: "abc" }, deps)).status).toBe(400);
    expect((await getRecordingAudio({ id: "999999" }, deps)).status).toBe(404);
  });
});

describe("#21 采集参数落库 [C27]", () => {
  test("给了就存，三态分明", async () => {
    const id = await makeSentence();
    await assess(`sentenceId=${id}&echoCancellation=false&noiseSuppression=true`);
    const row = db
      .prepare("SELECT echo_cancellation, noise_suppression, auto_gain_control FROM recording")
      .get() as Record<string, unknown>;
    expect(row["echo_cancellation"]).toBe(0);
    expect(row["noise_suppression"]).toBe(1);
    // 没给的那个是 NULL（不知道），不是 0（确定没开）。
    expect(row["auto_gain_control"]).toBeNull();
  });

  test("一个都不给 → 三列全是 NULL", async () => {
    const id = await makeSentence();
    await assess(`sentenceId=${id}`);
    const row = db
      .prepare("SELECT echo_cancellation, noise_suppression, auto_gain_control FROM recording")
      .get() as Record<string, unknown>;
    expect(row["echo_cancellation"]).toBeNull();
    expect(row["noise_suppression"]).toBeNull();
    expect(row["auto_gain_control"]).toBeNull();
  });
});

describe("#22 #23 traceId 双向可查 [C29][C74]", () => {
  test("响应里的 traceId 等于 recording.trace_id 与 operations.trace_id", async () => {
    const id = await makeSentence();
    const body = await bodyOf(await assess(`sentenceId=${id}`));
    const traceId = String(body["traceId"]);
    expect(traceId.length).toBeGreaterThan(0);

    const rec = db.prepare("SELECT trace_id FROM recording").get() as Record<string, unknown>;
    expect(rec["trace_id"]).toBe(traceId);
    expect(log.byTrace(traceId).length).toBeGreaterThan(0);
  });

  test("clientRequestId 与 sentenceId 进了流水 [C48][C75]", async () => {
    const id = await makeSentence();
    const uuid = "0d5f8f5e-6c1e-4a5b-9a4e-2f7c1b3d4e5f";
    const body = await bodyOf(await assess(`sentenceId=${id}&clientRequestId=${uuid}`));
    const meta = log.byTrace(String(body["traceId"]))[0]?.meta;
    expect(meta).toMatchObject({ clientRequestId: uuid, sentenceId: id });
  });

  test("匿名试用也有 traceId", async () => {
    const body = await bodyOf(await assess("reference=hello"));
    expect(typeof body["traceId"]).toBe("string");
  });
});

describe("#10 响应里不出现 null [C43]", () => {
  test("三种 outcome 的成功响应都不发 null", async () => {
    const id = await makeSentence();

    const cases: Array<[string, ConstructorParameters<typeof FakeScoringProvider>[0]]> = [
      ["scored", { results: [scores()] }],
      ["unreliable", { results: [noiseScores()] }],
      ["no_speech", { results: [null] }],
    ];
    for (const [name, options] of cases) {
      use(options);
      const res = await assess(`sentenceId=${id}`);
      expect(JSON.stringify(res.body), name).not.toContain("null");
    }
  });

  test("prosody 缺席时字段直接不出现，不是 null", async () => {
    const id = await makeSentence();
    const without = scores();
    delete without.scores.prosody;
    delete without.snr;
    use({ results: [without] });

    const body = await bodyOf(await assess(`sentenceId=${id}`));
    expect(body["snr"]).toBeUndefined();
    expect((body["scores"] as Record<string, unknown>)["prosody"]).toBeUndefined();
  });
});

describe("#36 失败路径不落库", () => {
  test("provider 报错 → 三张表零新增行", async () => {
    const id = await makeSentence();
    use({ results: [err("network")] });
    const before = snapshot();
    const res = await assess(`sentenceId=${id}`);
    expect(res.status).toBe(502);

    const after = snapshot();
    expect(after["recording"]).toBe(before["recording"]);
    expect(after["assessment"]).toBe(before["assessment"]);
  });
});
