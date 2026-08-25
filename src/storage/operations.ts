import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { ServiceErrorKind } from "@/core/errors";
import { incrementalVacuum } from "./db";

/**
 * 操作流水。
 *
 * 每次调用外部服务记一行：什么时候、哪个引擎、多久、花多少、成没成。
 * 超时和限流这两类故障的共同点是**不可复现**——用户说「卡住了」，
 * 本地跑一百遍都正常。没有流水，手上就只有那一句「卡住了」。
 *
 * 三条硬约束，每条都有测试守着：
 *
 *   1. **写流水永远不抛异常。** 它是可观测性设施，不是业务主路径。
 *      流水自己挂了不能把评分请求一起带走——那是本末倒置：
 *      最需要记录的时刻，恰恰是最容易出错的时刻。
 *
 *   2. **排序靠 id，不靠 ts。** `Date.now()` 不单调——NTP 校时会让它回跳，
 *      同一毫秒内多条记录的先后也无从分辨。id 是 rowid，单调递增。
 *      ts 只用于展示和时间范围查询，这两个用途不能混。
 *
 *   3. **meta 只收白名单里的键。** 请求上下文里混着 subscription key，
 *      一个顺手的 JSON.stringify(request) 就把密钥写进了库。
 *      白名单是唯一可靠的做法——黑名单永远漏。
 */

export type OperationKind = "request" | "retry" | "result" | "error";

/**
 * 哪一侧的服务。
 *
 * 靠 `provider` 区分不了——TTS 和评分都是 `'azure'`。而「上周练了几次」
 * 问的是**评分**次数：一次练习是一次跟读，听范本不算。
 */
export type OperationService = "tts" | "scoring";

export interface OperationInput {
  /** 串起一次完整请求的所有事件。重试也用同一个。 */
  traceId: string;
  kind: OperationKind;
  service?: OperationService;
  provider?: string;
  status?: number;
  latencyMs?: number;
  errorKind?: ServiceErrorKind;
  /** 花费，单位微元。用整数避免浮点累加误差。 */
  costMicros?: number;
  meta?: Record<string, unknown>;
}

export interface OperationRow {
  id: number;
  ts: number;
  traceId: string;
  kind: string;
  /** v3 之前的老行是 null——那时候没有这个维度，不猜。 */
  service: string | null;
  provider: string | null;
  status: number | null;
  latencyMs: number | null;
  errorKind: string | null;
  costMicros: number | null;
  meta: Record<string, unknown> | null;
}

export interface Summary {
  /** 发起过多少次请求。带 service 过滤时就是那一侧的次数。 */
  requests: number;
  /** 其中失败了多少次。 */
  failures: number;
  /** 一共重试了多少次。 */
  retries: number;
  /** 总花费，微元。 */
  costMicros: number;
}

/**
 * meta 的键白名单。
 *
 * 想加字段就往这里加，并且要想清楚它会不会带进用户隐私或密钥。
 * 不在名单里的键**静默丢弃**——不报错，因为报错会违反「写流水不抛」。
 */
export const META_KEYS: readonly string[] = [
  "retryAfterSec",
  "waitedMs",
  "attempt",
  "textLength",
  "audioBytes",
  "durationMs",
  "voice",
  "model",
  "format",
  "cached",
  "reason",
  "echoCancellation",
  "noiseSuppression",
  "autoGainControl",
];

/** 单个字符串值的上限。Azure 挂掉时会返回整页 HTML，不截断就整页进库。 */
const MAX_STRING = 512;
/** 整个 meta 序列化后的上限。 */
const MAX_META_BYTES = 4096;

export interface LogOptions {
  /** 注入时钟，测试用。 */
  now?: () => number;
  /**
   * 写流水失败时的去处。默认吞掉。
   * 生产环境应该接到日志上，否则流水静默失效你不会知道。
   */
  onError?: (err: unknown) => void;
}

export class OperationLog {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;
  private insert: StatementSync | null = null;

  constructor(db: DatabaseSync, options: LogOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * 追加一行。**永不抛异常。**
   *
   * 返回值只是给测试和诊断用的，业务代码不该依赖它——
   * 依赖它就意味着业务在关心流水成没成，那就又把它变成主路径了。
   */
  append(input: OperationInput): boolean {
    try {
      this.insert ??= this.db.prepare(`
        INSERT INTO operations
          (ts, trace_id, kind, service, provider, status, latency_ms, error_kind, cost_micros, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // 每个可选字段都要显式 ?? null。
      // undefined 绑定会抛 ERR_INVALID_ARG_TYPE，而 undefined 恰恰在
      // 失败路径上最常见（请求没发出去就没有 latency，非 429 就没有 retryAfter）。
      this.insert.run(
        this.now(),
        input.traceId,
        input.kind,
        input.service ?? null,
        input.provider ?? null,
        toInt(input.status),
        toInt(input.latencyMs),
        input.errorKind ?? null,
        toInt(input.costMicros),
        serializeMeta(input.meta),
      );
      return true;
    } catch (err) {
      this.onError(err);
      return false;
    }
  }

  /** 回放一次完整请求。按 id 排序——见文件头第 2 条。 */
  byTrace(traceId: string): OperationRow[] {
    const rows = this.db
      .prepare("SELECT * FROM operations WHERE trace_id = ? ORDER BY id")
      .all(traceId);
    return rows.map(toRow);
  }

  /** 时间范围查询，左闭右开。 */
  between(fromTs: number, toTs: number): OperationRow[] {
    const rows = this.db
      .prepare("SELECT * FROM operations WHERE ts >= ? AND ts < ? ORDER BY id")
      .all(fromTs, toTs);
    return rows.map(toRow);
  }

  /**
   * roadmap 的验收标准：上周练了几次、失败几次、花了多少。
   *
   * **「练了几次」要传 `'scoring'`。** 不传 service 得到的是两侧之和，
   * 那个数字回答的是「调了几次外部服务」，不是「练了几次」。
   *
   * v3 之前的老行 service 为 null，带过滤时它们**不会**被算进任何一侧——
   * 这是对的：我们确实不知道它们属于哪边。不带过滤时它们仍然计入总数。
   */
  summary(fromTs: number, toTs: number, service?: OperationService): Summary {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) FILTER (WHERE kind = 'request')       AS requests,
          COUNT(*) FILTER (WHERE kind = 'error')         AS failures,
          COUNT(*) FILTER (WHERE kind = 'retry')         AS retries,
          COALESCE(SUM(cost_micros), 0)                  AS cost_micros
        FROM operations
        WHERE ts >= ?1 AND ts < ?2 AND (?3 IS NULL OR service = ?3)
      `)
      .get(fromTs, toTs, service ?? null) as Record<string, unknown>;

    return {
      requests: Number(row["requests"] ?? 0),
      failures: Number(row["failures"] ?? 0),
      retries: Number(row["retries"] ?? 0),
      costMicros: Number(row["cost_micros"] ?? 0),
    };
  }

  /**
   * 保留策略：删掉 ts 早于某个时刻的记录，返回删了几行。
   *
   * 流水只增不减会一直涨。DELETE 本身不会把空间还给操作系统，
   * 所以删完顺手跑一次 incremental_vacuum——这是 auto_vacuum = INCREMENTAL
   * 换来的能力，否则只能停服跑全库 VACUUM。
   */
  prune(beforeTs: number): number {
    const result = this.db.prepare("DELETE FROM operations WHERE ts < ?").run(beforeTs);
    const removed = Number(result.changes);
    // DELETE 只是把页挂到 freelist 上，文件不会变小。
    // auto_vacuum = INCREMENTAL 让我们可以在这里在线回收，不必停服跑 VACUUM。
    if (removed > 0) incrementalVacuum(this.db);
    return removed;
  }
}

/** 数值字段统一走这里：undefined/null → null，其余取整。 */
function toInt(value: number | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value)) return null; // NaN / Infinity 不能进 INTEGER 列
  return Math.trunc(value);
}

/**
 * meta 序列化。白名单过滤 + 截断 + 类型收敛。
 * 任何一步出问题都返回 null 而不是抛——见文件头第 1 条。
 */
export function serializeMeta(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;

  const clean: Record<string, string | number | boolean> = Object.create(null) as Record<
    string,
    string | number | boolean
  >;
  let kept = 0;

  for (const key of META_KEYS) {
    if (!Object.hasOwn(meta, key)) continue;
    const value = meta[key];
    const coerced = coerce(value);
    if (coerced === null) continue;
    clean[key] = coerced;
    kept++;
  }

  if (kept === 0) return null;

  try {
    const json = JSON.stringify(clean);
    if (json === undefined) return null;
    return json.length > MAX_META_BYTES ? json.slice(0, MAX_META_BYTES) : json;
  } catch {
    // 循环引用之类。宁可丢掉 meta，也不能让写流水失败。
    return null;
  }
}

/** 只收标量。对象和数组一律丢弃——它们是尺寸失控和隐私泄漏的入口。 */
function coerce(value: unknown): string | number | boolean | null {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  // JSON.stringify 遇到 BigInt 会抛，转成字符串。
  if (typeof value === "bigint") return value.toString();
  return null;
}

function toRow(raw: unknown): OperationRow {
  const r = raw as Record<string, unknown>;
  return {
    id: Number(r["id"]),
    ts: Number(r["ts"]),
    traceId: String(r["trace_id"]),
    kind: String(r["kind"]),
    service: (r["service"] as string | null) ?? null,
    provider: (r["provider"] as string | null) ?? null,
    status: r["status"] === null ? null : Number(r["status"]),
    latencyMs: r["latency_ms"] === null ? null : Number(r["latency_ms"]),
    errorKind: (r["error_kind"] as string | null) ?? null,
    costMicros: r["cost_micros"] === null ? null : Number(r["cost_micros"]),
    meta: parseMeta(r["meta"]),
  };
}

/**
 * 读回 meta。
 *
 * 用 null 原型接住解析结果——库里的 JSON 来自外部服务的响应，
 * 里面出现 `__proto__` 键时,普通对象展开就是原型污染入口。
 */
function parseMeta(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.assign(Object.create(null) as Record<string, unknown>, parsed);
  } catch {
    return null; // 被截断的 JSON 解不出来是正常的
  }
}
