import { describe, test, expect } from "vitest";
import { readPragma } from "@/storage/db";
import { OperationLog } from "@/storage/operations";
import { fileDb } from "./helpers/db";

/**
 * 并发。
 *
 * **这一整个文件都必须用真实文件库。** 内存库没有文件锁、WAL 设了不生效、
 * 永远不会有 SQLITE_BUSY——拿它测并发是测了个寂寞。
 *
 * SQLite 同时只允许一个写者。HTTP 服务上两个用户同时提交录音就是并发写，
 * 所以这不是理论问题。`BEGIN IMMEDIATE` 会立刻取写锁，用它把竞争
 * 造成确定性的，而不是靠 sleep 碰运气。
 */

describe("写锁", () => {
  test("持锁期间另一个连接写会撞 BUSY", async () => {
    const temp = await fileDb();
    const holder = temp.connect(0); // busy_timeout = 0，撞上立刻抛
    const other = temp.connect(0);

    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(1, "a", "request");

    expect(() =>
      other.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(2, "b", "request"),
    ).toThrow(/database is locked|BUSY/i);

    holder.exec("COMMIT");
    await temp.cleanup();
  });

  test("锁释放后另一个连接就写得进去了", async () => {
    const temp = await fileDb();
    const holder = temp.connect(0);
    const other = temp.connect(0);

    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(1, "a", "request");
    holder.exec("COMMIT");

    expect(() =>
      other.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(2, "b", "request"),
    ).not.toThrow();

    await temp.cleanup();
  });

  test("busy_timeout 是每连接的——一个连接设了不影响另一个", async () => {
    const temp = await fileDb();
    const a = temp.connect(0);
    const b = temp.connect(3000);
    expect(readPragma(a, "busy_timeout")).toBe(0);
    expect(readPragma(b, "busy_timeout")).toBe(3000);
    await temp.cleanup();
  });
});

describe("WAL 的读写并发", () => {
  test("写者持锁时，读者仍然读得到已提交的数据", async () => {
    // 这就是开 WAL 的理由。默认的 rollback journal 模式下，
    // 写者会把读者一起挡住。
    const temp = await fileDb();
    const writer = temp.connect(0);
    const reader = temp.connect(0);

    writer.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(1, "committed", "request");

    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(2, "pending", "request");

    // 读者不被阻塞
    const rows = reader.prepare("SELECT trace_id FROM operations ORDER BY id").all();
    expect(rows.map((r) => (r as Record<string, unknown>)["trace_id"])).toEqual(["committed"]);

    writer.exec("COMMIT");
    await temp.cleanup();
  });

  test("未提交的写，别的连接看不见", async () => {
    const temp = await fileDb();
    const writer = temp.connect(0);
    const reader = temp.connect(0);

    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(1, "x", "request");

    const before = reader.prepare("SELECT COUNT(*) c FROM operations").get() as Record<string, unknown>;
    expect(Number(before["c"])).toBe(0);

    writer.exec("COMMIT");

    const after = reader.prepare("SELECT COUNT(*) c FROM operations").get() as Record<string, unknown>;
    expect(Number(after["c"])).toBe(1);

    await temp.cleanup();
  });

  test("回滚的写，别的连接永远看不见", async () => {
    const temp = await fileDb();
    const writer = temp.connect(0);
    const reader = temp.connect(0);

    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(1, "x", "request");
    writer.exec("ROLLBACK");

    const row = reader.prepare("SELECT COUNT(*) c FROM operations").get() as Record<string, unknown>;
    expect(Number(row["c"])).toBe(0);
    await temp.cleanup();
  });
});

describe("流水在并发下的契约", () => {
  test("撞锁时 append 返回 false，不抛——业务请求不受牵连", async () => {
    // 这是整个流水设计里最重要的一条：它是可观测性设施，
    // 自己挂了不能把评分请求一起带走。并发是它最可能挂的场景。
    const temp = await fileDb();
    const holder = temp.connect(0);
    const loser = temp.connect(0);

    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(1, "a", "request");

    const errors: unknown[] = [];
    const log = new OperationLog(loser, { onError: (e) => errors.push(e) });

    expect(() => log.append({ traceId: "b", kind: "request" })).not.toThrow();
    expect(log.append({ traceId: "b", kind: "request" })).toBe(false);
    expect(errors.length).toBeGreaterThan(0);

    holder.exec("COMMIT");
    await temp.cleanup();
  });

  test("锁释放后流水自动恢复，不需要重建 OperationLog", async () => {
    const temp = await fileDb();
    const holder = temp.connect(0);
    const loser = temp.connect(0);
    const log = new OperationLog(loser);

    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(1, "a", "request");
    expect(log.append({ traceId: "b", kind: "request" })).toBe(false);

    holder.exec("COMMIT");

    // 同一个 log 实例，缓存的 statement 还能用。
    expect(log.append({ traceId: "b", kind: "request" })).toBe(true);
    expect(log.byTrace("b")).toHaveLength(1);

    await temp.cleanup();
  });

  test("busy_timeout 会等：给了足够时间的连接不会立刻失败", async () => {
    const temp = await fileDb();
    const holder = temp.connect(0);
    const patient = temp.connect(200);

    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(1, "a", "request");

    const started = Date.now();
    const log = new OperationLog(patient);
    const ok = log.append({ traceId: "b", kind: "request" });
    const waited = Date.now() - started;

    // 它失败了（锁一直没放），但确实等满了超时才放弃——
    // 证明 busy_timeout 生效，而不是设了个寂寞。
    expect(ok).toBe(false);
    expect(waited).toBeGreaterThanOrEqual(150);

    holder.exec("COMMIT");
    await temp.cleanup();
  });
});

describe("多连接下的迁移", () => {
  test("已迁移的库上再开连接，看到的是同一个版本", async () => {
    const temp = await fileDb();
    const second = temp.connect();
    expect(readPragma(second, "user_version")).toBe(readPragma(temp.db, "user_version"));
    await temp.cleanup();
  });

  test("一个连接写的数据，另一个连接读得到", async () => {
    const temp = await fileDb();
    const second = temp.connect();
    temp.db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(1, "shared", "request");
    const row = second.prepare("SELECT trace_id FROM operations").get() as Record<string, unknown>;
    expect(row["trace_id"]).toBe("shared");
    await temp.cleanup();
  });
});
