import { describe, test, expect } from "vitest";
import { IN_MEMORY, SqliteDatabase } from "@/storage/db";
import { memoryDb } from "./helpers/db";

/**
 * schema 与 SQLite 的地雷。
 *
 * 这一组测试守的不是我们写的逻辑，是**SQLite 的默认行为和我们的假设一致**。
 * 官方 quirks 页列的坑，每一条的失败方式都是静默的：不报错，只是
 * 存进去的东西和你以为的不一样。所以必须逐条钉死，而不是靠记忆。
 *
 * 另一半是 JS 与 SQLite 之间的类型边界——undefined 不能绑定、
 * 大整数会溢出、外部 JSON 里的 __proto__ 是原型污染入口。
 * 这些在 Node 官方的 test-sqlite-*.js 里都有对应用例，抄过来。
 */

const ts = 1_700_000_000_000;

function seedMaterial(db: ReturnType<typeof memoryDb>): number {
  const r = db
    .prepare("INSERT INTO material (title, source, created_at) VALUES (?, ?, ?)")
    .run("t", "imported", ts);
  return Number(r.lastInsertRowid);
}

describe("STRICT——弹性类型的解药", () => {
  test("INTEGER 列拒绝字符串", () => {
    const db = memoryDb();
    expect(() =>
      db
        .prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)")
        .run("not-a-number", "t", "request"),
    ).toThrow(/cannot store TEXT value in INTEGER column/);
    db.close();
  });

  test("没有 STRICT 的表会照单全收——这就是为什么每张表都要加", () => {
    const db = new SqliteDatabase(IN_MEMORY);
    db.exec("CREATE TABLE loose (n INTEGER NOT NULL)");
    db.prepare("INSERT INTO loose VALUES (?)").run("wxyz");
    // 不报错，静默存了个字符串进 INTEGER 列。
    expect(db.prepare("SELECT n FROM loose").get()).toEqual({ n: "wxyz" });
    db.close();
  });

  test("所有业务表都是 STRICT", () => {
    const db = memoryDb();
    const rows = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    expect(rows.length).toBeGreaterThan(0);
    for (const raw of rows) {
      const r = raw as Record<string, unknown>;
      expect(String(r["sql"]), `${String(r["name"])} 缺 STRICT`).toMatch(/\)\s*STRICT\s*$/);
    }
    db.close();
  });
});

describe("外键", () => {
  test("引用不存在的父行会被拒", () => {
    const db = memoryDb();
    expect(() =>
      db
        .prepare("INSERT INTO sentence (material_id, ord, text, created_at) VALUES (?, ?, ?, ?)")
        .run(999, 0, "hi", ts),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.close();
  });

  test("ON DELETE CASCADE 一路清到最深一层", () => {
    const db = memoryDb();
    const materialId = seedMaterial(db);
    const sentenceId = Number(
      db
        .prepare("INSERT INTO sentence (material_id, ord, text, created_at) VALUES (?, ?, ?, ?)")
        .run(materialId, 0, "hi", ts).lastInsertRowid,
    );
    const recordingId = Number(
      db
        .prepare(
          "INSERT INTO recording (sentence_id, audio_key, duration_ms, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(sentenceId, "k", 1000, ts).lastInsertRowid,
    );
    const assessmentId = Number(
      db
        .prepare(`
          INSERT INTO assessment
            (recording_id, engine, accuracy, fluency, completeness, overall, recognized, words_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(recordingId, "azure", 90, 90, 90, 90, "hi", "[]", ts).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO phoneme_score (assessment_id, word_index, word, phoneme, accuracy) VALUES (?, ?, ?, ?, ?)",
    ).run(assessmentId, 0, "hi", "h", 90);

    db.prepare("DELETE FROM material WHERE id = ?").run(materialId);

    for (const table of ["sentence", "recording", "assessment", "phoneme_score"]) {
      const row = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as Record<string, unknown>;
      expect(Number(row["c"]), `${table} 没被级联删掉`).toBe(0);
    }
    db.close();
  });

  test("流水不挂在任何外键上——它要能比业务数据活得久", () => {
    const db = memoryDb();
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'operations'")
      .get() as Record<string, unknown>;
    expect(String(sql["sql"])).not.toMatch(/REFERENCES/);
    db.close();
  });
});

describe("唯一约束", () => {
  test("同一材料里序号不能重复", () => {
    const db = memoryDb();
    const materialId = seedMaterial(db);
    const insert = db.prepare(
      "INSERT INTO sentence (material_id, ord, text, created_at) VALUES (?, ?, ?, ?)",
    );
    insert.run(materialId, 0, "a", ts);
    expect(() => insert.run(materialId, 0, "b", ts)).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  test("不同材料可以有相同序号", () => {
    const db = memoryDb();
    const a = seedMaterial(db);
    const b = seedMaterial(db);
    const insert = db.prepare(
      "INSERT INTO sentence (material_id, ord, text, created_at) VALUES (?, ?, ?, ?)",
    );
    insert.run(a, 0, "a", ts);
    expect(() => insert.run(b, 0, "b", ts)).not.toThrow();
    db.close();
  });
});

describe("append-only 触发器", () => {
  test("UPDATE 流水被数据库拒绝", () => {
    const db = memoryDb();
    db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(
      ts,
      "t",
      "request",
    );
    expect(() => db.exec("UPDATE operations SET kind = 'error'")).toThrow(/append-only/);
    db.close();
  });

  test("DELETE 是允许的——保留策略要靠它", () => {
    const db = memoryDb();
    db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(
      ts,
      "t",
      "request",
    );
    expect(() => db.exec("DELETE FROM operations")).not.toThrow();
    db.close();
  });

  test("被拒的 UPDATE 不留下痕迹", () => {
    const db = memoryDb();
    db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(
      ts,
      "t",
      "request",
    );
    try {
      db.exec("UPDATE operations SET kind = 'error'");
    } catch {
      // 预期内
    }
    const row = db.prepare("SELECT kind FROM operations").get() as Record<string, unknown>;
    expect(row["kind"]).toBe("request");
    db.close();
  });
});

describe("JS 与 SQLite 的类型边界", () => {
  test("undefined 不能绑定——而失败路径上到处是 undefined", () => {
    // 注意这里的 cast：TypeScript **在编译期就拒绝** undefined 绑定，
    // 所以这个 bug 在类型层已经跑不掉了。运行时行为仍然要钉住，
    // 因为 meta 之类的动态数据绕得过类型检查。
    const db = memoryDb();
    const stmt = db.prepare(
      "INSERT INTO operations (ts, trace_id, kind, provider) VALUES (?, ?, ?, ?)",
    );
    expect(() => stmt.run(ts, "t", "request", undefined as never)).toThrow(/cannot be bound/);
    db.close();
  });

  test("null 可以绑定", () => {
    const db = memoryDb();
    expect(() =>
      db
        .prepare("INSERT INTO operations (ts, trace_id, kind, provider) VALUES (?, ?, ?, ?)")
        .run(ts, "t", "request", null),
    ).not.toThrow();
    db.close();
  });

  test("参数给少了按 NULL 处理，撞上 NOT NULL 才报错", () => {
    const db = memoryDb();
    expect(() =>
      db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(ts, "t"),
    ).toThrow(/NOT NULL constraint failed/);
    db.close();
  });

  test("参数给多了报越界", () => {
    const db = memoryDb();
    expect(() =>
      db
        .prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)")
        .run(ts, "t", "request", "extra"),
    ).toThrow(/column index out of range/);
    db.close();
  });

  test("读回的行是 null 原型——外部 JSON 里的 __proto__ 不会污染原型链", () => {
    const db = memoryDb();
    db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(
      ts,
      "t",
      "request",
    );
    const row = db.prepare("SELECT trace_id FROM operations").get();
    expect(Object.getPrototypeOf(row)).toBeNull();
    db.close();
  });

  test("epoch 毫秒离 Number.MAX_SAFE_INTEGER 还很远——但微秒和纳秒不是", () => {
    // 这条不是防御性测试，是把一个取舍钉在纸面上：
    // ts 用毫秒。改成纳秒会直接越过 2^53，读回来就不是原值了。
    const nowMs = Date.now();
    expect(nowMs).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(nowMs * 1_000_000).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  test("超过 2^53 的整数读回来要显式开 BigInt，否则抛错", () => {
    const db = memoryDb();
    const big = 9_007_199_254_740_993n;
    db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)").run(
      big,
      "big",
      "request",
    );
    const stmt = db.prepare("SELECT ts FROM operations WHERE trace_id = 'big'");
    expect(() => stmt.get()).toThrow(/too large/);

    stmt.setReadBigInts(true);
    expect((stmt.get() as Record<string, unknown>)["ts"]).toBe(big);
    db.close();
  });

  test("布尔绑定在这个 Node 版本上直接抛——toFlag() 是必需的，不是糖", () => {
    // Node main 的 test-sqlite-data-types.js 里 true 会被转成 1。
    // 但在 Node v22.22.3 的 node:sqlite 上它直接抛。
    // 上游文档和你的运行时不是一回事——所以这条要用测试钉住，
    // 将来 Node 升级把行为改回去时，这条会红，提醒我们重新决策。
    const db = memoryDb();
    const materialId = seedMaterial(db);
    const sentenceId = Number(
      db
        .prepare("INSERT INTO sentence (material_id, ord, text, created_at) VALUES (?, ?, ?, ?)")
        .run(materialId, 0, "hi", ts).lastInsertRowid,
    );
    const insert = db.prepare(`
      INSERT INTO recording (sentence_id, audio_key, duration_ms, echo_cancellation, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    expect(() => insert.run(sentenceId, "k", 1000, true as never, ts)).toThrow(
      /cannot be bound/,
    );

    // 转成 0/1 就没问题——这正是 records.ts 里 toFlag() 干的事。
    insert.run(sentenceId, "k", 1000, 1, ts);
    const row = db
      .prepare("SELECT echo_cancellation FROM recording")
      .get() as Record<string, unknown>;
    expect(row["echo_cancellation"]).toBe(1);
    db.close();
  });
});

describe("其他 quirks", () => {
  test("双引号不会被当成字符串字面量——列名打错会报错而不是静默返回空", () => {
    const db = memoryDb();
    expect(() => db.prepare('SELECT * FROM operations WHERE trace_id = "nope"').all()).toThrow(
      /no such column/,
    );
    db.close();
  });

  test("1 = '1' 为假：SQLite 区分整数和文本", () => {
    const db = memoryDb();
    const row = db.prepare("SELECT (1 = '1') AS eq").get() as Record<string, unknown>;
    expect(Number(row["eq"])).toBe(0);
    db.close();
  });
});

describe("statement 生命周期", () => {
  test("数据库关闭后再用 statement 会抛，而不是返回脏数据", () => {
    const db = memoryDb();
    const stmt = db.prepare("SELECT 1 AS x");
    db.close();
    expect(() => stmt.get()).toThrow(/finalized/);
  });

  test("空结果：get 返回 undefined，all 返回空数组", () => {
    const db = memoryDb();
    expect(db.prepare("SELECT * FROM operations WHERE trace_id = 'none'").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM operations WHERE trace_id = 'none'").all()).toEqual([]);
    db.close();
  });

  test("迭代器提前 break 之后不会继续吐数据", () => {
    const db = memoryDb();
    const insert = db.prepare("INSERT INTO operations (ts, trace_id, kind) VALUES (?, ?, ?)");
    for (let i = 0; i < 5; i++) insert.run(ts + i, `t${i}`, "request");

    const it = db.prepare("SELECT trace_id FROM operations ORDER BY id").iterate();
    const seen: string[] = [];
    for (const raw of it) {
      seen.push(String((raw as Record<string, unknown>)["trace_id"]));
      break;
    }
    expect(seen).toEqual(["t0"]);
    expect(it.next().done).toBe(true);
    db.close();
  });
});
