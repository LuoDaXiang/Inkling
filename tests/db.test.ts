import { describe, test, expect } from "vitest";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { IN_MEMORY, SqliteDatabase, backupTo, openDatabase, readPragma } from "@/storage/db";
import { OperationLog } from "@/storage/operations";
import { migrate } from "@/storage/migrations";
import { fileDb, memoryDb } from "./helpers/db";

/**
 * 连接层。
 *
 * SQLite 的危险在于它的默认值：外键不强制、撞锁立刻抛、弹性类型。
 * 这些失败全是静默的——不报错，只是行为和你以为的不一样。
 * 所以每一条都要有测试盯着，不能靠「我记得设过」。
 */

describe("pragma", () => {
  test("外键强制打开", () => {
    const db = memoryDb();
    expect(readPragma(db, "foreign_keys")).toBe(1);
    db.close();
  });

  test("外键即使被关掉，openDatabase 也会重新打开", () => {
    // 直接用裸的 DatabaseSync 关掉外键，再走我们的 configure。
    const raw = new SqliteDatabase(IN_MEMORY);
    raw.exec("PRAGMA foreign_keys = OFF");
    expect(readPragma(raw, "foreign_keys")).toBe(0);
    raw.close();

    const db = openDatabase(IN_MEMORY);
    expect(readPragma(db, "foreign_keys")).toBe(1);
    db.close();
  });

  test("busy_timeout 有默认值", () => {
    const db = openDatabase(IN_MEMORY);
    expect(readPragma(db, "busy_timeout")).toBe(5000);
    db.close();
  });

  test("busy_timeout 可以覆盖", () => {
    const db = openDatabase(IN_MEMORY, { busyTimeoutMs: 250 });
    expect(readPragma(db, "busy_timeout")).toBe(250);
    db.close();
  });

  test("busy_timeout 是每连接属性，不写进文件——新连接必须重设", async () => {
    const temp = await fileDb(250);
    expect(readPragma(temp.db, "busy_timeout")).toBe(250);

    // 同一个文件，新连接。如果 busy_timeout 是数据库属性，这里会是 250。
    const raw = new SqliteDatabase(temp.path);
    expect(readPragma(raw, "busy_timeout")).not.toBe(250);
    raw.close();

    // 走 openDatabase 就会被重设。
    const second = temp.connect(250);
    expect(readPragma(second, "busy_timeout")).toBe(250);

    await temp.cleanup();
  });
});

describe("WAL", () => {
  test("文件库开 WAL", async () => {
    const temp = await fileDb();
    expect(readPragma(temp.db, "journal_mode")).toBe("wal");
    await temp.cleanup();
  });

  test("内存库不开 WAL——所以并发测试不能用内存库", () => {
    const db = openDatabase(IN_MEMORY);
    expect(readPragma(db, "journal_mode")).toBe("memory");
    db.close();
  });

  test("写入后确实产生了 -wal 附属文件", async () => {
    const temp = await fileDb();
    temp.db
      .prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)")
      .run(1, "t", "request");

    // 这就是「备份只拷 .db 会丢数据」的物证：数据这会儿在 -wal 里。
    expect(existsSync(`${temp.path}-wal`)).toBe(true);
    expect(statSync(`${temp.path}-wal`).size).toBeGreaterThan(0);

    await temp.cleanup();
  });
});

describe("auto_vacuum", () => {
  test("文件库上真的生效——不是设了个寂寞", async () => {
    // 这条用例是补的。第一版 configure() 把 journal_mode=WAL 写在
    // auto_vacuum 前面，结果 auto_vacuum 静默停留在 0，而当时的测试
    // 只在内存库上跑，抓不到。真实启动一次才发现。
    const temp = await fileDb();
    expect(readPragma(temp.db, "auto_vacuum")).toBe(2); // 2 = INCREMENTAL
    await temp.cleanup();
  });

  test("pragma 顺序：WAL 排在前面会把 auto_vacuum 焊成 0", async () => {
    // 直接对着裸连接复现那个 bug，把「顺序不能动」这件事钉在测试里。
    // 将来有人重排 configure() 里的 pragma，这条会红。
    const temp = await fileDb();
    const wrong = join(temp.dir, "wrong-order.db");
    const db = new SqliteDatabase(wrong);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("CREATE TABLE t (a TEXT) STRICT");
    expect(readPragma(db, "auto_vacuum")).toBe(0); // 静默失效，不报错
    db.close();
    await temp.cleanup();
  });

  test("prune 之后文件真的变小——DELETE 单独做不到", async () => {
    const temp = await fileDb();
    const log = new OperationLog(temp.db, { now: () => 1000 });
    const filler = "x".repeat(400);
    for (let i = 0; i < 4000; i++) {
      log.append({ traceId: `t${i}`, kind: "error", meta: { reason: filler } });
    }
    temp.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const before = statSync(temp.path).size;

    expect(log.prune(2000)).toBe(4000);
    temp.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const after = statSync(temp.path).size;

    // 没有 auto_vacuum=INCREMENTAL 的话，这两个数字会完全相等。
    expect(after).toBeLessThan(before / 2);
    await temp.cleanup();
  });
});

describe("备份", () => {
  test("VACUUM INTO 的副本包含还在 WAL 里、尚未 checkpoint 的数据", async () => {
    const temp = await fileDb();
    temp.db
      .prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)")
      .run(42, "trace-backup", "request");

    const dest = join(temp.dir, "backup.db");
    backupTo(temp.db, dest);

    // 副本是独立文件，用一个全新连接打开——不共享任何状态。
    const restored = new SqliteDatabase(dest);
    const row = restored
      .prepare("SELECT trace_id, ts FROM operations")
      .get() as Record<string, unknown>;
    expect(row["trace_id"]).toBe("trace-backup");
    expect(Number(row["ts"])).toBe(42);
    restored.close();

    await temp.cleanup();
  });

  test("副本保留了 schema 版本", async () => {
    const temp = await fileDb();
    const dest = join(temp.dir, "backup2.db");
    backupTo(temp.db, dest);

    const restored = new SqliteDatabase(dest);
    expect(readPragma(restored, "user_version")).toBe(readPragma(temp.db, "user_version"));
    restored.close();

    await temp.cleanup();
  });
});

describe("readPragma", () => {
  test("读得到数值型 pragma", () => {
    const db = memoryDb();
    expect(typeof readPragma(db, "user_version")).toBe("number");
    db.close();
  });

  test("读得到字符串型 pragma", () => {
    const db = memoryDb();
    expect(typeof readPragma(db, "journal_mode")).toBe("string");
    db.close();
  });

  test("未知 pragma 抛错，而不是静默返回 undefined", () => {
    const db = memoryDb();
    expect(() => readPragma(db, "definitely_not_a_pragma")).toThrow();
    db.close();
  });
});

describe("内存库的隔离性", () => {
  test("两个 :memory: 是两个互不相干的库", () => {
    const a = openDatabase(IN_MEMORY);
    const b = openDatabase(IN_MEMORY);
    migrate(a);

    expect(a.prepare("SELECT COUNT(*) c FROM operations").get()).toBeDefined();
    // b 没跑迁移，表不存在——证明它们不共享。
    expect(() => b.prepare("SELECT COUNT(*) c FROM operations").get()).toThrow();

    a.close();
    b.close();
  });
});
