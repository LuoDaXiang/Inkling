import { describe, test, expect } from "vitest";
import { readPragma } from "@/storage/db";
import { MIGRATIONS, currentVersion, latestVersion, migrate } from "@/storage/migrations";
import type { Migration } from "@/storage/migrations";
import { emptyMemoryDb } from "./helpers/db";

/**
 * 迁移。
 *
 * 这里的验收标准来自 roadmap：「改一次表结构后重跑，老记录不丢」。
 * 测法照搬 Atlas 的 `migrate test` 四步——迁到旧版本、塞老数据、
 * 跑待测迁移、断言老数据还在。别人把这个模式做成了产品功能，
 * 说明它是这类测试的标准形状。
 *
 * 另一半是原子性：表结构和版本号必须同生共死。迁移跑到一半进程被杀，
 * 下次打开要么是完整的旧版本、要么是完整的新版本，不能是「一半一半」。
 */

const upTo = (version: number): Migration[] =>
  MIGRATIONS.filter((m) => m.version <= version);

describe("版本号", () => {
  test("空库是 0", () => {
    const db = emptyMemoryDb();
    expect(currentVersion(db)).toBe(0);
    db.close();
  });

  test("迁完等于 latestVersion", () => {
    const db = emptyMemoryDb();
    expect(migrate(db)).toBe(latestVersion());
    expect(currentVersion(db)).toBe(latestVersion());
    db.close();
  });

  test("版本号存在 user_version 里，不占额外的表", () => {
    const db = emptyMemoryDb();
    migrate(db);
    expect(readPragma(db, "user_version")).toBe(latestVersion());

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as Record<string, unknown>)["name"]);
    expect(tables).not.toContain("schema_migrations");
    db.close();
  });
});

describe("幂等", () => {
  test("跑两次不报错，版本号不变", () => {
    const db = emptyMemoryDb();
    migrate(db);
    const after = currentVersion(db);
    expect(() => migrate(db)).not.toThrow();
    expect(currentVersion(db)).toBe(after);
    db.close();
  });

  test("第二次不会重跑已应用的迁移（重跑会因表已存在而失败）", () => {
    const db = emptyMemoryDb();
    migrate(db);
    migrate(db);
    migrate(db);
    // 能走到这里就说明没重跑 CREATE TABLE。
    expect(currentVersion(db)).toBe(latestVersion());
    db.close();
  });

  test("数据在重复迁移后原样保留", () => {
    const db = emptyMemoryDb();
    migrate(db);
    db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(
      1,
      "keep-me",
      "request",
    );
    migrate(db);
    const rows = db.prepare("SELECT trace_id FROM operations").all();
    expect(rows).toHaveLength(1);
    db.close();
  });
});

describe("老记录不丢（roadmap 的验收标准）", () => {
  test("v1 写入的流水，迁到 v2 之后还在", () => {
    const db = emptyMemoryDb();

    // 1. 迁到待测迁移的前一个版本
    migrate(db, upTo(1));
    expect(currentVersion(db)).toBe(1);

    // 2. 塞老数据
    db.prepare(
      "INSERT INTO operations (ts, trace_id, kind, provider, status) VALUES (?, ?, ?, ?, ?)",
    ).run(1700000000000, "old-trace", "result", "azure", 200);

    // 3. 跑剩下的全部迁移
    migrate(db);
    expect(currentVersion(db)).toBe(latestVersion());

    // 4. 断言老数据一字未变
    const row = db.prepare("SELECT * FROM operations").get() as Record<string, unknown>;
    expect(row["trace_id"]).toBe("old-trace");
    expect(Number(row["ts"])).toBe(1700000000000);
    expect(row["provider"]).toBe("azure");
    expect(Number(row["status"])).toBe(200);

    db.close();
  });

  test("v2 新增的是可空列，老行是 NULL 而不是被填了默认值", () => {
    // Atlas 的 MY101 / MF103 检查的就是这个：加非空列会把老行静默填零，
    // 那等于篡改历史。这条测试守住我们没那么干。
    const db = emptyMemoryDb();
    migrate(db, upTo(1));
    db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(
      1,
      "before-v2",
      "request",
    );
    migrate(db);

    const row = db
      .prepare("SELECT cost_micros FROM operations WHERE trace_id = ?")
      .get("before-v2") as Record<string, unknown>;
    expect(row["cost_micros"]).toBeNull();
    db.close();
  });

  test("v2 写入的流水，迁到 v3 之后还在，且 service 是 NULL", () => {
    // v3 加的 service 列同样是可空的。老行我们**确实不知道**属于
    // TTS 还是评分那一侧——猜一个值就是伪造历史。
    const db = emptyMemoryDb();
    migrate(db, upTo(2));
    db.prepare(
      "INSERT INTO operations (ts, trace_id, kind, cost_micros) VALUES (?, ?, ?, ?)",
    ).run(1700000000000, "before-v3", "result", 3000);

    migrate(db);
    expect(currentVersion(db)).toBe(3);

    const row = db
      .prepare("SELECT * FROM operations WHERE trace_id = ?")
      .get("before-v3") as Record<string, unknown>;
    expect(Number(row["cost_micros"])).toBe(3000);
    expect(row["service"]).toBeNull();
    db.close();
  });

  test("v1 建的索引和触发器在 v2 之后仍然在", () => {
    const db = emptyMemoryDb();
    migrate(db, upTo(1));
    migrate(db);

    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('index','trigger')")
      .all()
      .map((r) => String((r as Record<string, unknown>)["name"]));
    expect(names).toContain("idx_operations_trace");
    expect(names).toContain("operations_no_update");
    db.close();
  });
});

describe("原子性", () => {
  const boom: Migration = {
    version: 99,
    name: "故意炸掉的迁移",
    up(db) {
      db.exec("CREATE TABLE half_done (a TEXT) STRICT");
      throw new Error("boom");
    },
  };

  test("迁移抛错时整个事务回滚，半张表不会留下", () => {
    const db = emptyMemoryDb();
    migrate(db);
    const before = currentVersion(db);

    expect(() => migrate(db, [boom])).toThrow(/迁移 99/);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String((r as Record<string, unknown>)["name"]));
    expect(tables).not.toContain("half_done");
    expect(currentVersion(db)).toBe(before);
    db.close();
  });

  test("回滚后原有数据完好", () => {
    const db = emptyMemoryDb();
    migrate(db);
    db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(
      1,
      "survivor",
      "request",
    );

    expect(() => migrate(db, [boom])).toThrow();

    const row = db.prepare("SELECT trace_id FROM operations").get() as Record<string, unknown>;
    expect(row["trace_id"]).toBe("survivor");
    db.close();
  });

  test("原始错误挂在 cause 上，不被吞掉", () => {
    const db = emptyMemoryDb();
    migrate(db);
    try {
      migrate(db, [boom]);
      expect.unreachable("应该抛");
    } catch (err) {
      expect((err as Error).cause).toBeInstanceOf(Error);
      expect(((err as Error).cause as Error).message).toBe("boom");
    }
    db.close();
  });

  test("DDL 是事务性的：CREATE TABLE 也能回滚", () => {
    // SQLite 和 MySQL 在这一点上相反。整个迁移策略建立在这条性质上，
    // 所以要有一条测试直接盯着它，而不是假设。
    const db = emptyMemoryDb();
    db.exec("BEGIN");
    db.exec("CREATE TABLE rollback_me (a TEXT) STRICT");
    db.exec("ROLLBACK");

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String((r as Record<string, unknown>)["name"]));
    expect(tables).not.toContain("rollback_me");
    db.close();
  });
});

describe("迁移表本身", () => {
  test("版本号严格递增且不重复", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("每个迁移都有名字", () => {
    for (const m of MIGRATIONS) {
      expect(m.name.length).toBeGreaterThan(0);
    }
  });
});
