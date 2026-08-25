import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { IN_MEMORY, openDatabase } from "@/storage/db";
import { migrate } from "@/storage/migrations";

/**
 * 测试用的库。
 *
 * 大部分测试用内存库——快，而且每个 DatabaseSync(':memory:') 天然隔离，
 * 不需要清理。但**并发和 WAL 相关的测试必须用真实文件**：
 * 内存库没有文件锁、WAL 设了不生效、永远不会有 SQLITE_BUSY。
 * 拿内存库测并发是测了个寂寞。
 */

/** 已迁移到最新版本的内存库。 */
export function memoryDb(): DatabaseSync {
  const db = openDatabase(IN_MEMORY);
  migrate(db);
  return db;
}

/** 没跑迁移的空内存库，给迁移测试自己用。 */
export function emptyMemoryDb(): DatabaseSync {
  return openDatabase(IN_MEMORY);
}

export interface TempDb {
  db: DatabaseSync;
  path: string;
  dir: string;
  /** 再开一个连到同一个文件的连接，用来制造并发。 */
  connect(busyTimeoutMs?: number): DatabaseSync;
  cleanup(): Promise<void>;
}

/** 落在临时目录里的真实文件库。 */
export async function fileDb(busyTimeoutMs?: number): Promise<TempDb> {
  const dir = await mkdtemp(join(tmpdir(), "inkling-test-"));
  const path = join(dir, "test.db");
  const opened: DatabaseSync[] = [];

  const connect = (timeout?: number): DatabaseSync => {
    const db = openDatabase(path, timeout === undefined ? {} : { busyTimeoutMs: timeout });
    opened.push(db);
    return db;
  };

  const db = connect(busyTimeoutMs);
  migrate(db);

  return {
    db,
    path,
    dir,
    connect,
    async cleanup() {
      for (const each of opened) {
        try {
          each.close();
        } catch {
          // 已经关了
        }
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 一个可控的时钟，用来测「时间戳回跳」这类事。 */
export function fakeClock(start = 1_700_000_000_000): { now: () => number; set(t: number): void; tick(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    set(next: number) {
      t = next;
    },
    tick(ms: number) {
      t += ms;
    },
  };
}
