import type { DatabaseSync } from "node:sqlite";
import { readPragma } from "./db";

/**
 * 迁移。
 *
 * 版本号存在 `PRAGMA user_version` 里——那是数据库文件头自带的一个整数，
 * 不用额外建表，也不会被 VACUUM 清掉。
 *
 * **每个迁移单独包一个事务。** SQLite 的 DDL 是事务性的（不像 MySQL），
 * 所以迁移跑到一半进程被杀，下次打开会自动回滚到干净状态，不会留下
 * 「一半新一半旧」的表。版本号的写入也在同一个事务里，因此
 * 「表改了但版本号没改」这种状态不可能出现。
 *
 * 所有表都加 STRICT。少了它，INTEGER 列能存字符串而不报错——
 * 类型写错不会在写入时暴露，要等到读出来才炸。
 *
 * 表结构定错了、里面还存着半年记录，那是真的难改。所以这里的注释
 * 解释「为什么这样建」，不解释「建了什么」——后者读 SQL 就知道。
 */

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "初始 schema",
    up(db) {
      db.exec(`
        CREATE TABLE material (
          id         INTEGER PRIMARY KEY,
          title      TEXT    NOT NULL,
          source     TEXT    NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE sentence (
          id          INTEGER PRIMARY KEY,
          material_id INTEGER NOT NULL REFERENCES material(id) ON DELETE CASCADE,
          ord         INTEGER NOT NULL,
          text        TEXT    NOT NULL,
          created_at  INTEGER NOT NULL,
          UNIQUE (material_id, ord)
        ) STRICT;

        CREATE TABLE recording (
          id          INTEGER PRIMARY KEY,
          sentence_id INTEGER NOT NULL REFERENCES sentence(id) ON DELETE CASCADE,
          audio_key   TEXT    NOT NULL,
          duration_ms INTEGER NOT NULL,
          echo_cancellation INTEGER,
          noise_suppression INTEGER,
          auto_gain_control INTEGER,
          created_at  INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE assessment (
          id           INTEGER PRIMARY KEY,
          recording_id INTEGER NOT NULL REFERENCES recording(id) ON DELETE CASCADE,
          engine       TEXT    NOT NULL,
          accuracy     REAL    NOT NULL,
          fluency      REAL    NOT NULL,
          completeness REAL    NOT NULL,
          prosody      REAL,
          overall      REAL    NOT NULL,
          recognized   TEXT    NOT NULL,
          snr          REAL,
          words_json   TEXT    NOT NULL,
          created_at   INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE phoneme_score (
          id            INTEGER PRIMARY KEY,
          assessment_id INTEGER NOT NULL REFERENCES assessment(id) ON DELETE CASCADE,
          word_index    INTEGER NOT NULL,
          word          TEXT    NOT NULL,
          phoneme       TEXT    NOT NULL,
          accuracy      REAL    NOT NULL
        ) STRICT;

        CREATE TABLE operations (
          id         INTEGER PRIMARY KEY,
          ts         INTEGER NOT NULL,
          trace_id   TEXT    NOT NULL,
          kind       TEXT    NOT NULL,
          provider   TEXT,
          status     INTEGER,
          latency_ms INTEGER,
          error_kind TEXT,
          meta       TEXT
        ) STRICT;

        CREATE INDEX idx_sentence_material ON sentence(material_id);
        CREATE INDEX idx_recording_sentence ON recording(sentence_id);
        CREATE INDEX idx_assessment_recording ON assessment(recording_id);
        CREATE INDEX idx_phoneme_assessment ON phoneme_score(assessment_id);
        CREATE INDEX idx_phoneme_lookup ON phoneme_score(phoneme);
        CREATE INDEX idx_operations_trace ON operations(trace_id);
        CREATE INDEX idx_operations_ts ON operations(ts);
      `);

      // 流水是 append-only：写下去的事实不允许改口。
      // 用触发器把它焊死在数据库里，而不是靠「大家都记得别 UPDATE」。
      // DELETE 不拦——保留策略要靠它裁剪老记录。
      db.exec(`
        CREATE TRIGGER operations_no_update
        BEFORE UPDATE ON operations
        BEGIN
          SELECT RAISE(ABORT, 'operations 是 append-only，不允许 UPDATE');
        END;
      `);
    },
  },
  {
    version: 2,
    name: "流水记录花费",
    up(db) {
      // 加的是**可空**列。加非空列会把老行静默填上默认值
      // （Atlas 的 MY101 / MF103 检查的就是这个），那等于篡改历史。
      db.exec("ALTER TABLE operations ADD COLUMN cost_micros INTEGER");
    },
  },
  {
    version: 3,
    name: "流水区分服务类型",
    up(db) {
      // 没有这一列就答不出「上周练了几次」——TTS 合成和发音评分
      // 会算进同一个计数。听一次范本再跟读一次记 2，但那是 1 次练习。
      //
      // 靠 provider 区分不了：两边都是 'azure'。
      //
      // 同样是**可空**列。v3 之前的老行是 NULL 而不是被猜一个值——
      // 我们确实不知道那些行属于哪一侧，猜一个就是伪造历史。
      db.exec("ALTER TABLE operations ADD COLUMN service TEXT");
      db.exec("CREATE INDEX idx_operations_service ON operations(service, ts)");
    },
  },
  {
    version: 4,
    name: "评分可靠性与流水回指",
    up(db) {
      // reliable：1 = scored，0 = unreliable，NULL = v4 之前。契约 [C34]。
      // 趋势曲线必须默认过滤 reliable = 0，否则被噪声记录污染，
      // **而且这件事发生时没有任何征兆**——纯白噪声的准确度是 71 分。
      db.exec("ALTER TABLE assessment ADD COLUMN reliable INTEGER");

      // trace_id：把业务记录和 operations 流水双向打通。契约 [C74]。
      // 没有它，排查「那次练习为什么失败」时从业务记录跳不到流水，
      // 而这两处正在记录同一次调用。
      db.exec("ALTER TABLE recording ADD COLUMN trace_id TEXT");
      db.exec("CREATE INDEX idx_recording_trace ON recording(trace_id)");
    },
  },
];

export function currentVersion(db: DatabaseSync): number {
  return readPragma(db, "user_version") as number;
}

export function latestVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}

/**
 * 把库迁到最新版本，返回迁移后的版本号。
 * 已经是最新就什么都不做——必须幂等，因为每次启动都会调它。
 *
 * `migrations` 可注入：测试要能构造「迁到一半失败」和「只迁到 v1」
 * 这两种局面，而它们用真实迁移表造不出来。
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  const from = currentVersion(db);

  for (const migration of migrations) {
    if (migration.version <= from) continue;

    db.exec("BEGIN");
    try {
      migration.up(db);
      // 版本号和表结构在同一个事务里，不可能只成功一半。
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `迁移 ${migration.version}（${migration.name}）失败，已回滚`,
        { cause: err },
      );
    }
  }

  return currentVersion(db);
}
