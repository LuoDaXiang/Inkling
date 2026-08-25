import { describe, test, expect } from "vitest";
import { OperationLog, META_KEYS, serializeMeta } from "@/storage/operations";
import { emptyMemoryDb, fakeClock, memoryDb } from "./helpers/db";

/**
 * 操作流水。
 *
 * 三条硬约束，各占一个 describe：
 *   1. 写流水永远不抛——它挂了不能把业务带走
 *   2. 排序靠 id 不靠 ts——Date.now() 不单调
 *   3. meta 只收白名单——否则密钥和用户语音内容会进库
 *
 * 剩下的是「不该记的时候不能记」这一类反向断言。paper_trail 的测试里
 * 这类占了很大比重，纯数据库的测试反而没有——因为它是应用层的问题。
 */

const trace = "trace-1";

describe("追加与回放", () => {
  test("写进去的字段原样读回来", () => {
    const db = memoryDb();
    const log = new OperationLog(db, { now: () => 1000 });

    log.append({
      traceId: trace,
      kind: "result",
      provider: "azure",
      status: 200,
      latencyMs: 431,
      costMicros: 3000,
    });

    const [row] = log.byTrace(trace);
    expect(row).toMatchObject({
      ts: 1000,
      traceId: trace,
      kind: "result",
      provider: "azure",
      status: 200,
      latencyMs: 431,
      costMicros: 3000,
      errorKind: null,
      meta: null,
    });
    db.close();
  });

  test("可选字段缺席时存 null，不是 undefined 也不是 0", () => {
    const db = memoryDb();
    const log = new OperationLog(db);
    log.append({ traceId: trace, kind: "request" });

    const [row] = log.byTrace(trace);
    expect(row?.provider).toBeNull();
    expect(row?.status).toBeNull();
    expect(row?.latencyMs).toBeNull();
    expect(row?.costMicros).toBeNull();
    db.close();
  });

  test("一次请求的重试链完整串起来", () => {
    const db = memoryDb();
    const clock = fakeClock();
    const log = new OperationLog(db, { now: clock.now });

    log.append({ traceId: trace, kind: "request", provider: "azure" });
    clock.tick(120);
    log.append({ traceId: trace, kind: "error", status: 429, errorKind: "quota", meta: { retryAfterSec: 2 } });
    clock.tick(2000);
    log.append({ traceId: trace, kind: "retry", meta: { attempt: 1, waitedMs: 2000 } });
    clock.tick(300);
    log.append({ traceId: trace, kind: "result", status: 200, latencyMs: 300 });

    const rows = log.byTrace(trace);
    expect(rows.map((r) => r.kind)).toEqual(["request", "error", "retry", "result"]);
    expect(rows[1]?.meta).toEqual({ retryAfterSec: 2 });
    expect(rows[2]?.meta).toEqual({ attempt: 1, waitedMs: 2000 });
    db.close();
  });

  test("别的 trace 不会混进来", () => {
    const db = memoryDb();
    const log = new OperationLog(db);
    log.append({ traceId: "a", kind: "request" });
    log.append({ traceId: "b", kind: "request" });
    expect(log.byTrace("a")).toHaveLength(1);
    db.close();
  });

  test("查不存在的 trace 返回空数组，不是 null", () => {
    const db = memoryDb();
    const log = new OperationLog(db);
    expect(log.byTrace("nope")).toEqual([]);
    db.close();
  });
});

describe("排序靠 id，不靠 ts", () => {
  test("时钟回跳后，回放顺序仍然是写入顺序", () => {
    // NTP 校时会让 Date.now() 往回走。如果按 ts 排序，
    // 这四条的顺序就乱了，而「先重试还是先失败」恰恰是排查的关键。
    const db = memoryDb();
    const clock = fakeClock(1_700_000_000_000);
    const log = new OperationLog(db, { now: clock.now });

    log.append({ traceId: trace, kind: "request" });
    clock.set(1_700_000_000_000 - 5000); // 时钟往回跳 5 秒
    log.append({ traceId: trace, kind: "error", errorKind: "network" });
    clock.set(1_700_000_000_000 - 9000); // 再往回跳
    log.append({ traceId: trace, kind: "retry" });

    const rows = log.byTrace(trace);
    expect(rows.map((r) => r.kind)).toEqual(["request", "error", "retry"]);
    // 证明 ts 确实是乱的——排序对了不是因为 ts 恰好递增
    expect(rows[1]!.ts).toBeLessThan(rows[0]!.ts);
    expect(rows[2]!.ts).toBeLessThan(rows[1]!.ts);
    db.close();
  });

  test("同一毫秒内的多条也保持写入顺序", () => {
    const db = memoryDb();
    const log = new OperationLog(db, { now: () => 42 });
    for (let i = 0; i < 10; i++) log.append({ traceId: trace, kind: "retry", status: i });

    const rows = log.byTrace(trace);
    expect(rows.map((r) => r.status)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(rows.map((r) => r.ts)).size).toBe(1);
    db.close();
  });

  test("id 严格递增", () => {
    const db = memoryDb();
    const log = new OperationLog(db);
    for (let i = 0; i < 5; i++) log.append({ traceId: trace, kind: "request" });
    const ids = log.byTrace(trace).map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    db.close();
  });
});

describe("写流水永远不抛", () => {
  test("表根本不存在时返回 false，不抛", () => {
    const db = emptyMemoryDb(); // 没跑迁移
    const log = new OperationLog(db);
    expect(() => log.append({ traceId: trace, kind: "request" })).not.toThrow();
    expect(log.append({ traceId: trace, kind: "request" })).toBe(false);
    db.close();
  });

  test("数据库已关闭时返回 false，不抛", () => {
    const db = memoryDb();
    const log = new OperationLog(db);
    log.append({ traceId: trace, kind: "request" });
    db.close();
    expect(() => log.append({ traceId: trace, kind: "result" })).not.toThrow();
    expect(log.append({ traceId: trace, kind: "result" })).toBe(false);
  });

  test("失败会送到 onError，而不是静默消失", () => {
    // 「不抛」不等于「不报」。流水静默失效是最坏的情况：
    // 你以为有记录，出事时才发现什么都没有。
    const db = emptyMemoryDb();
    const seen: unknown[] = [];
    const log = new OperationLog(db, { onError: (e) => seen.push(e) });
    log.append({ traceId: trace, kind: "request" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Error);
    db.close();
  });

  test("成功时不调用 onError", () => {
    const db = memoryDb();
    const seen: unknown[] = [];
    const log = new OperationLog(db, { onError: (e) => seen.push(e) });
    log.append({ traceId: trace, kind: "request" });
    expect(seen).toHaveLength(0);
    db.close();
  });

  test("NaN / Infinity 不会让写入失败——存 null", () => {
    const db = memoryDb();
    const log = new OperationLog(db);
    // latencyMs 很容易算成 NaN：起始时间没记上就 now - undefined。
    expect(log.append({ traceId: trace, kind: "result", latencyMs: NaN })).toBe(true);
    expect(log.append({ traceId: trace, kind: "result", latencyMs: Infinity })).toBe(true);
    const rows = log.byTrace(trace);
    expect(rows.map((r) => r.latencyMs)).toEqual([null, null]);
    db.close();
  });

  test("小数被取整——INTEGER 列不接受 REAL 会报错", () => {
    const db = memoryDb();
    const log = new OperationLog(db);
    expect(log.append({ traceId: trace, kind: "result", latencyMs: 431.7 })).toBe(true);
    expect(log.byTrace(trace)[0]?.latencyMs).toBe(431);
    db.close();
  });
});

describe("meta 白名单", () => {
  test("白名单内的键保留", () => {
    expect(serializeMeta({ retryAfterSec: 2, attempt: 1 })).toBe('{"retryAfterSec":2,"attempt":1}');
  });

  test("白名单外的键被丢弃", () => {
    expect(serializeMeta({ notOnTheList: "x" })).toBeNull();
  });

  test("密钥类字段进不去——哪怕调用方顺手把整个 request 传进来", () => {
    const meta = {
      subscriptionKey: "super-secret-key",
      authorization: "Bearer abc",
      apiKey: "sk-123",
      attempt: 1,
    };
    const json = serializeMeta(meta);
    expect(json).toBe('{"attempt":1}');
    expect(json).not.toContain("secret");
    expect(json).not.toContain("sk-123");
  });

  test("用户语音内容进不去——reference 和 recognized 不在白名单里", () => {
    const json = serializeMeta({ reference: "the quick brown fox", recognized: "the quick" });
    expect(json).toBeNull();
  });

  test("白名单是个显式清单，改它要过 code review", () => {
    expect(META_KEYS).toContain("retryAfterSec");
    expect(META_KEYS).not.toContain("reference");
    expect(META_KEYS).not.toContain("apiKey");
  });

  test("超长字符串被截断", () => {
    const json = serializeMeta({ reason: "x".repeat(5000) });
    expect(json).not.toBeNull();
    expect(json!.length).toBeLessThan(1000);
    expect(json).toContain("…");
  });

  test("整页 HTML 错误响应不会撑爆流水", () => {
    // Azure 挂掉时会返回整页 HTML。不截断就整页进库。
    const db = memoryDb();
    const log = new OperationLog(db);
    log.append({
      traceId: trace,
      kind: "error",
      meta: { reason: `<html>${"a".repeat(1_000_000)}</html>` },
    });
    const stored = log.byTrace(trace)[0]?.meta?.["reason"];
    expect(String(stored).length).toBeLessThan(1000);
    db.close();
  });

  test("循环引用不抛，meta 变成 null", () => {
    const circular: Record<string, unknown> = { attempt: 1 };
    circular["reason"] = circular; // 对象值本来就会被丢弃，这里测的是不炸
    expect(() => serializeMeta(circular)).not.toThrow();
    expect(serializeMeta(circular)).toBe('{"attempt":1}');
  });

  test("BigInt 不会让 JSON.stringify 抛——转成字符串", () => {
    expect(serializeMeta({ audioBytes: 123n })).toBe('{"audioBytes":"123"}');
  });

  test("对象和数组值被丢弃——尺寸失控和隐私泄漏的入口", () => {
    expect(serializeMeta({ reason: { nested: "deep" } as unknown as string })).toBeNull();
    expect(serializeMeta({ attempt: [1, 2, 3] as unknown as number })).toBeNull();
  });

  test("undefined 值被跳过，不会变成绑定错误", () => {
    expect(serializeMeta({ attempt: undefined, retryAfterSec: 2 })).toBe('{"retryAfterSec":2}');
  });

  test("空 meta 和全部被过滤掉的 meta 都存 null", () => {
    expect(serializeMeta(undefined)).toBeNull();
    expect(serializeMeta({})).toBeNull();
    expect(serializeMeta({ junk: 1 })).toBeNull();
  });

  test("读回的 meta 是 null 原型——库里的 __proto__ 不会污染原型链", () => {
    const db = memoryDb();
    // 绕过白名单直接写一个恶意 JSON，模拟「库里已经有脏数据」的局面。
    db.prepare("INSERT INTO operations (ts, trace_id, kind, meta) VALUES (?, ?, ?, ?)").run(
      1,
      trace,
      "result",
      '{"__proto__":{"polluted":true}}',
    );
    const log = new OperationLog(db);
    const meta = log.byTrace(trace)[0]?.meta;
    expect(Object.getPrototypeOf(meta)).toBeNull();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    db.close();
  });

  test("被截断成非法 JSON 的 meta 读回来是 null，不抛", () => {
    const db = memoryDb();
    db.prepare("INSERT INTO operations (ts, trace_id, kind, meta) VALUES (?, ?, ?, ?)").run(
      1,
      trace,
      "result",
      '{"attempt":1',
    );
    const log = new OperationLog(db);
    expect(() => log.byTrace(trace)).not.toThrow();
    expect(log.byTrace(trace)[0]?.meta).toBeNull();
    db.close();
  });
});

describe("查询（roadmap 的验收标准）", () => {
  const seed = (log: OperationLog, clock: ReturnType<typeof fakeClock>): void => {
    // 两次成功 + 一次失败后重试成功
    log.append({ traceId: "t1", kind: "request" });
    log.append({ traceId: "t1", kind: "result", costMicros: 3000 });
    clock.tick(1000);
    log.append({ traceId: "t2", kind: "request" });
    log.append({ traceId: "t2", kind: "error", errorKind: "network" });
    log.append({ traceId: "t2", kind: "retry" });
    log.append({ traceId: "t2", kind: "result", costMicros: 3000 });
    clock.tick(1000);
    log.append({ traceId: "t3", kind: "request" });
    log.append({ traceId: "t3", kind: "error", errorKind: "quota" });
  };

  test("练了几次、失败几次、重试几次、花了多少", () => {
    const db = memoryDb();
    const clock = fakeClock(1000);
    const log = new OperationLog(db, { now: clock.now });
    seed(log, clock);

    expect(log.summary(0, 1_000_000)).toEqual({
      requests: 3,
      failures: 2,
      retries: 1,
      costMicros: 6000,
    });
    db.close();
  });

  test("时间范围左闭右开", () => {
    const db = memoryDb();
    const log = new OperationLog(db, { now: () => 100 });
    log.append({ traceId: "a", kind: "request" });

    expect(log.between(100, 101)).toHaveLength(1);
    expect(log.between(99, 100)).toHaveLength(0); // 右开
    expect(log.between(101, 200)).toHaveLength(0);
    db.close();
  });

  test("空区间的 summary 全是 0，不是 null", () => {
    const db = memoryDb();
    const log = new OperationLog(db);
    expect(log.summary(0, 1)).toEqual({ requests: 0, failures: 0, retries: 0, costMicros: 0 });
    db.close();
  });
});

describe("service 维度（F14）", () => {
  const seedBoth = (log: OperationLog): void => {
    // 听两次范本（TTS），跟读三次（评分），其中一次评分失败
    log.append({ traceId: "a", kind: "request", service: "tts" });
    log.append({ traceId: "a", kind: "result", service: "tts", costMicros: 800 });
    log.append({ traceId: "b", kind: "request", service: "tts" });
    log.append({ traceId: "b", kind: "result", service: "tts", costMicros: 800 });
    for (const t of ["c", "d"]) {
      log.append({ traceId: t, kind: "request", service: "scoring" });
      log.append({ traceId: t, kind: "result", service: "scoring", costMicros: 1389 });
    }
    log.append({ traceId: "e", kind: "request", service: "scoring" });
    log.append({ traceId: "e", kind: "error", service: "scoring", errorKind: "network" });
  };

  test("「练了几次」问的是评分次数，不含听范本", () => {
    const db = memoryDb();
    const log = new OperationLog(db, { now: () => 1000 });
    seedBoth(log);

    // 这就是 F14 修的东西：不带过滤会把听范本也算成练习。
    expect(log.summary(0, 9999, "scoring").requests).toBe(3);
    expect(log.summary(0, 9999, "tts").requests).toBe(2);
    expect(log.summary(0, 9999).requests).toBe(5);
    db.close();
  });

  test("失败次数也能按侧拆开", () => {
    const db = memoryDb();
    const log = new OperationLog(db, { now: () => 1000 });
    seedBoth(log);
    expect(log.summary(0, 9999, "scoring").failures).toBe(1);
    expect(log.summary(0, 9999, "tts").failures).toBe(0);
    db.close();
  });

  test("花费也能按侧拆开", () => {
    const db = memoryDb();
    const log = new OperationLog(db, { now: () => 1000 });
    seedBoth(log);
    expect(log.summary(0, 9999, "tts").costMicros).toBe(1600);
    expect(log.summary(0, 9999, "scoring").costMicros).toBe(2778);
    expect(log.summary(0, 9999).costMicros).toBe(4378);
    db.close();
  });

  test("service 写进去也读得回来", () => {
    const db = memoryDb();
    const log = new OperationLog(db);
    log.append({ traceId: "x", kind: "request", service: "scoring" });
    expect(log.byTrace("x")[0]?.service).toBe("scoring");
    db.close();
  });

  test("不带 service 的记录读回来是 null，不是空字符串", () => {
    const db = memoryDb();
    const log = new OperationLog(db);
    log.append({ traceId: "x", kind: "request" });
    expect(log.byTrace("x")[0]?.service).toBeNull();
    db.close();
  });

  test("v3 之前的老行（service 为 NULL）不会被算进任何一侧", () => {
    // 我们确实不知道那些行属于哪边，所以带过滤时它们两边都不算；
    // 不带过滤时仍然计入总数。把它们硬塞进某一侧就是伪造历史。
    const db = memoryDb();
    db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(
      1000,
      "legacy",
      "request",
    );
    const log = new OperationLog(db, { now: () => 1000 });
    log.append({ traceId: "new", kind: "request", service: "scoring" });

    expect(log.summary(0, 9999, "scoring").requests).toBe(1);
    expect(log.summary(0, 9999, "tts").requests).toBe(0);
    expect(log.summary(0, 9999).requests).toBe(2);
    db.close();
  });

  test("过滤仍然受时间范围约束", () => {
    const db = memoryDb();
    const clock = fakeClock(1000);
    const log = new OperationLog(db, { now: clock.now });
    log.append({ traceId: "old", kind: "request", service: "scoring" });
    clock.set(5000);
    log.append({ traceId: "new", kind: "request", service: "scoring" });

    expect(log.summary(4000, 9999, "scoring").requests).toBe(1);
    db.close();
  });
});

describe("保留策略", () => {
  test("prune 删掉早于某时刻的记录并返回行数", () => {
    const db = memoryDb();
    const clock = fakeClock(1000);
    const log = new OperationLog(db, { now: clock.now });
    log.append({ traceId: "old", kind: "request" });
    clock.set(5000);
    log.append({ traceId: "new", kind: "request" });

    expect(log.prune(3000)).toBe(1);
    expect(log.between(0, 10000).map((r) => r.traceId)).toEqual(["new"]);
    db.close();
  });

  test("prune 不受 append-only 触发器影响——触发器只拦 UPDATE", () => {
    const db = memoryDb();
    const log = new OperationLog(db, { now: () => 1000 });
    log.append({ traceId: "x", kind: "request" });
    expect(() => log.prune(2000)).not.toThrow();
    db.close();
  });

  test("prune 没删到东西时返回 0", () => {
    const db = memoryDb();
    const log = new OperationLog(db, { now: () => 5000 });
    log.append({ traceId: "x", kind: "request" });
    expect(log.prune(1000)).toBe(0);
    db.close();
  });
});
