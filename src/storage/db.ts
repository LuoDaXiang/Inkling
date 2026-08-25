import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

/**
 * `node:sqlite` 必须这样加载，不能直接 import。
 *
 * Node 出于「实验性」把 sqlite 排除在 `module.builtinModules` 之外
 * （`isBuiltin('node:sqlite')` 是 true，但 `builtinModules` 里没有它）。
 * Vite 判定内置模块用的正是 `builtinModules`，于是 `import "node:sqlite"`
 * 会被当成第三方包去 node_modules 里找，然后报「Failed to load url sqlite」。
 *
 * `createRequire` 走 Node 自己的解析，绕开打包器的静态分析。
 * 代价是这一处丑，收益是不必为一个测试工具的短板去改构建配置。
 * 等 node:sqlite 转正进入 builtinModules，这里可以换回普通 import。
 *
 * 其余文件一律 `import type`，会被 TypeScript 擦除，不会走到解析器。
 */
const load = createRequire(import.meta.url);
const runtime = load("node:sqlite") as typeof import("node:sqlite");

/** 运行时构造器。需要裸连接的地方从这里拿，不要自己 import node:sqlite。 */
export const SqliteDatabase = runtime.DatabaseSync;

/**
 * 数据库连接。
 *
 * SQLite 有三个反直觉的默认值，而且失败方式都是静默的，所以每个连接
 * 都必须显式设一遍。见 docs/decisions.md 0037。
 *
 *   1. **弹性类型**：INTEGER 列能存 'wxyz' 而不报错。解药是建表加 STRICT，
 *      在 schema 那边处理（见 migrations.ts）。
 *   2. **外键默认不强制**（原生 SQLite 如此）。`node:sqlite` 帮我们默认打开了，
 *      但这是它的选择不是 SQLite 的，所以仍然显式设一遍，并有测试守住。
 *   3. **撞写锁立刻抛错**而不是等待。busy_timeout 是**每连接**属性，
 *      不写在数据库文件里，新开一个连接就得重设。
 *
 * WAL 只对文件库有意义，内存库设了也不生效——所以并发相关的测试
 * 必须用真实临时文件，用 :memory: 测并发是测了个寂寞。
 */

/** 内存库的位置常量。每个 DatabaseSync(':memory:') 都是**互相隔离**的独立库。 */
export const IN_MEMORY = ":memory:";

export interface OpenOptions {
  /**
   * 撞写锁时最多等多久（毫秒）。
   * SQLite 同时只允许一个写者，两个请求并发写就会撞。
   */
  busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export function openDatabase(location: string, options: OpenOptions = {}): DatabaseSync {
  const db = new SqliteDatabase(location);
  configure(db, location, options);
  return db;
}

/**
 * 把一个已有连接配好。抽出来是为了让测试能对着任意连接断言 pragma。
 */
export function configure(
  db: DatabaseSync,
  location: string,
  options: OpenOptions = {},
): void {
  // ⚠️ 这三行的**顺序不能动**。
  //
  // auto_vacuum 必须排在 journal_mode 前面。切换到 WAL 会写数据库头，
  // 而 auto_vacuum 就存在头里——头一旦写下，auto_vacuum 就被焊成 0，
  // 之后再设**不报错、读回来还是 0**。实测：
  //
  //   PRAGMA journal_mode=WAL; PRAGMA auto_vacuum=INCREMENTAL;  -> 0  ✗
  //   PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;  -> 2  ✓
  //
  // 而且它只在**建任何表之前**有机会生效。错过了要补救，就得停服跑一次
  // 全库 VACUUM（独占锁 + 额外的等大磁盘空间）。老库上这行是空操作，无害。
  //
  // 选 INCREMENTAL 不选 FULL：FULL 在每次提交都回收，给写入路径加税；
  // INCREMENTAL 把空闲页挂在 freelist 上，由 prune() 之后主动回收。
  // 见 docs/decisions.md 0037，以及 tests/db.test.ts 里盯着这个顺序的用例。
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");

  // 文件库才开 WAL。内存库设了不生效，白跑一次 pragma。
  if (location !== IN_MEMORY) {
    db.exec("PRAGMA journal_mode = WAL");
  }

  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
}

/**
 * 回收空闲页，把空间真正还给操作系统。
 *
 * 不跑这个的话，DELETE 掉的空间只是挂在 freelist 上留给 SQLite 自己复用——
 * 实测删掉 90% 的行，文件大小一个字节都不变。
 *
 * 和 VACUUM 的区别：VACUUM 要整库独占锁、要额外的等大磁盘空间，
 * 是停服操作；incremental_vacuum 只处理 freelist，可以在线跑。
 *
 * @param pages 一次最多回收多少页。省略表示全部。
 */
export function incrementalVacuum(db: DatabaseSync, pages?: number): void {
  db.exec(pages === undefined ? "PRAGMA incremental_vacuum" : `PRAGMA incremental_vacuum(${pages})`);
}

/** 读回一个整数型 pragma。测试和迁移都要用。 */
export function readPragma(db: DatabaseSync, name: string): number | string {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  if (!row) throw new Error(`pragma ${name} 没有返回值`);
  const value = Object.values(row)[0];
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`pragma ${name} 返回了意外的类型：${typeof value}`);
}

/**
 * 备份。
 *
 * **不能直接拷 .db 文件**——开了 WAL 之后最近的事务还在 .db-wal 里，
 * 只拷主文件会得到一个丢了最近记录的库。VACUUM INTO 产出的是一个
 * 完整、紧凑、一致的副本。
 */
export function backupTo(db: DatabaseSync, destination: string): void {
  db.prepare("VACUUM INTO ?").run(destination);
}
