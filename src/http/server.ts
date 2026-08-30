import { randomUUID } from "node:crypto";
import type { TtsProvider } from "@/providers/tts/types";
import type { ScoringProvider } from "@/providers/scoring/types";
import type { FileAudioStore } from "@/storage/file-audio-store";
import { synthesize } from "@/core/tts/synthesize";
import { assess } from "@/core/scoring/assess";
import { ServiceError, type ServiceErrorKind } from "@/core/errors";
import { floatToInt16 } from "@/core/audio/pcm";
import { trimSilence } from "@/core/audio/trim-silence";
import { encodeWav } from "@/core/audio/encode-wav";
import { InvalidWavError } from "@/core/audio/wav";
import { contourOf, type PitchContour } from "@/core/audio/pitch";
import { InvalidReferenceError } from "@/providers/scoring/config";
import { MalformedResponseError } from "@/providers/scoring/parse";
import type { DatabaseSync } from "node:sqlite";
import type { OperationInput, OperationLog } from "@/storage/operations";
import { split } from "@/core/text/split";
import { MAX_REFERENCE_CHARS } from "@/providers/scoring/config";
import {
  createMaterial,
  getMaterial,
  getRecordingAudioKey,
  getSentence,
  listMaterials,
  persistPractice,
  type SentenceRow,
} from "@/storage/records";
import type { RecordingStore } from "@/storage/recording-store";
import type { PitchStore } from "@/storage/pitch-store";
import type { AssessmentResult } from "@/providers/scoring/types";
import { scoringCostMicros, ttsCostMicros, type Rates } from "@/core/cost";
import {
  buildConfig,
  MAX_JSON_BYTES,
  MAX_PCM_BYTES,
  MAX_SENTENCES_PER_MATERIAL,
  MAX_TITLE_CHARS,
  RECORDING_SAMPLE_RATE,
} from "./contract";

/**
 * 八个业务 handler —— **传输中立**。
 *
 * 边界纪律：身份和额度检查将来只能加在这一层，永远不进 core/。
 * synthesize() 不知道有没有账号这回事，Stage 2 加账号时它一行不改。
 *
 * ## 这个文件为什么还叫 `http/server.ts`
 *
 * M2.5 把这八个函数从 `(res: ServerResponse, deps)` 改成
 * `(input, deps) => Promise<HandlerResult>`；M3 把接在它们外面的 HTTP
 * 适配器整个删了（`createApp` / `dispatch` / `send` / `getStatic` /
 * 请求体读取），换成 `src/electron/ipc.ts`。**这八个函数一行没动**，
 * 那 129 条路由用例一条没改——那正是 M2.5 存在的全部理由。
 *
 * 路径没改名是刻意的：改名会让 129 条用例的 import 全部变动，
 * 而这一步的价值恰恰在于「换传输时它们不用动」。一次为了名字好听的
 * 大范围改动，会把这个证据抹掉。
 *
 * ## 为什么 HTTP 不留着
 *
 * 禁区 #3 / #4：桌面应用开一个无鉴权的本机端口，同机任何进程都能调
 * TTS 花掉 Azure 额度，而那些路由无一条检查来源；而 HTTP 与 IPC 并存
 * 意味着两套入口、两套错误处理、两份契约——`contract.ts` 存在的全部
 * 意义就是消灭这种分叉。
 *
 * 第 9 条路由 `getStatic` 随 HTTP 一起消失：Electron 下静态资源由
 * Vite / `file://` 接管。所以当初是 9 条路由、8 个 handler。
 */

export interface ServerDeps {
  provider: TtsProvider;
  /** 没配置时评分路由返回 503，其余功能照常可用。 */
  scoring?: ScoringProvider;
  store: FileAudioStore;
  /** 未指定音色时用它。 */
  defaultVoice: string;
  /**
   * 操作流水。**可选**——没接的时候整条链路照常工作，只是不留记录。
   *
   * 做成可选不是偷懒：流水是可观测性设施，路由不该因为它缺席就走不通。
   * 这个类型签名本身就是那条契约的第一道保证——`deps.log?.append()`
   * 在没有 log 时是空操作，在有 log 时也永不抛（见 operations.ts）。
   */
  log?: OperationLog;
  /**
   * 计费费率。**可选**——没配置就不记花费，而不是记 0。
   *
   * 这两件事必须分得开：`null` 是「没配费率，不知道」，`0` 是「确实免费」。
   * 把没配置记成 0，成本报表会看起来一切正常，直到收到账单。
   */
  rates?: Rates;
  /**
   * 业务库。**可选**——没接的时候材料相关的路由返回 503 `unavailable`，
   * 其余功能照常，和 `scoring` 缺席时的处置一致（契约 §7.4）。
   *
   * 做成可选的直接理由是现有一百多个路由用例不传它；
   * 更根本的理由是这一层的边界纪律：路由不该因为某个可选设施缺席就整体走不通。
   */
  db?: DatabaseSync;
  /**
   * 用户录音的存储。**可选**，缺席时 assess 仍然评分，只是不落库。
   *
   * 和 TTS 缓存分开是刻意的（[C38]）：那边的键是请求参数派生的，去重是目的；
   * 录音同一句录十次是十份必须各自保留的音频，去重就是数据丢失。
   */
  recordings?: RecordingStore;
  /**
   * 参考音高曲线的缓存。**可选**——缺席时 TTS 与评分都照常，只是响应里
   * 没有 `pitch` 字段，前端画不出曲线。
   *
   * 注意两条路的不对称：**TTS 那条要 store，评分这条不要。**
   * 范本音频会被缓存，所以它的曲线也该缓存，否则每次重放都要重算；
   * 用户录音是一次性的，算完就随响应发走，没有第二次读取，落盘只是浪费磁盘。
   */
  pitch?: PitchStore;
}

/* ================================================================== *
 * 传输中立的输入与结果
 * ================================================================== */

/**
 * 查询参数。**不是 `URLSearchParams`**——那是 HTTP 特有的类型，
 * handler 认识它就等于认识 HTTP。IPC 那边传过来的是一个普通对象。
 */
export type Query = Record<string, string | undefined>;

/** JSON 响应。绝大多数结果是这一种。 */
export interface JsonResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** 二进制响应。只有两条音频路由和静态文件用，`headers` 必须带 Content-Type。 */
export interface BytesResult {
  status: number;
  bytes: Uint8Array;
  headers: Record<string, string>;
}

export type HandlerResult = JsonResult | BytesResult;

function isBytes(result: HandlerResult): result is BytesResult {
  return "bytes" in result;
}

/**
 * 错误分类到 HTTP 状态码。
 *
 * 分两类看：auth 和 quota 是**服务端配置**的问题（Stage 0 的 key 是本机填的），
 * 所以是 5xx 不是 4xx——浏览器端的用户没做错任何事。
 * rejected 和 too_long 才是请求本身的问题。
 */
const STATUS: Record<ServiceErrorKind, number> = {
  auth: 500,
  quota: 503,
  network: 502,
  rejected: 400,
  too_long: 413,
  empty: 502,
  unknown: 500,
};

/**
 * 一次请求的流水上下文。
 *
 * traceId 把 request / error / retry / result 串成一条链，
 * 排查「那次卡住了」时靠它把整个过程捞出来。
 */
function beginTrace(deps: ServerDeps): {
  /** 回给客户端，让它能把一次失败的练习和服务端流水对上（[C29]）。 */
  id: string;
  emit(input: Omit<OperationInput, "traceId">): void;
  elapsed(): number;
} {
  const traceId = randomUUID();
  const started = Date.now();
  return {
    id: traceId,
    emit(input) {
      deps.log?.append({ traceId, ...input });
    },
    elapsed: () => Date.now() - started,
  };
}

/* ================================================================== *
 * 八个传输中立的 handler
 * ================================================================== */

/**
 * GET /api/config —— 契约 §4。
 *
 * 下发共享常量与契约版本，消灭「客户端和服务端各硬编码一份」这一整类问题。
 * 无错误分支、无副作用、不花钱、幂等。
 *
 * `no-store` 是 [C6]：这份 config 的全部目的就是消灭两边不一致，
 * 让它自己被缓存住是自相矛盾——客户端会拿着上一版的常量跑。
 */
export async function getConfig(deps: ServerDeps): Promise<HandlerResult> {
  return {
    status: 200,
    body: buildConfig({ scoringAvailable: Boolean(deps.scoring) }),
    headers: { "Cache-Control": "no-store" },
  };
}

/* ================================================================== *
 * 材料 —— 契约 §6.2–6.4
 * ================================================================== */

/**
 * `assessable`：这一句能不能送去评分。
 *
 * 判据是 `text.length <= maxReferenceChars`，**这是保守代理，不是真实时长**——
 * 真实时长要合成完才知道，而 F3（分句不知道 30 秒约束）还没解决。
 * 字符长度会误伤极慢语速的短句，但方向是安全的：宁可标成不可评分，
 * 也不要让用户录完才吃 400。见 [C16]。
 *
 * 它的**取值**将来会变（F3 修好后换成真实判据），所以客户端不得缓存（[C17]）。
 * 因此它是每次读的时候算出来的，不入库。
 */
function withAssessable(sentences: readonly SentenceRow[]): Array<
  SentenceRow & { assessable: boolean }
> {
  return sentences.map((s) => ({ ...s, assessable: s.text.length <= MAX_REFERENCE_CHARS }));
}

/** 路径参数必须是十进制正整数。不是 → 400 而**不是** 404：格式错和不存在是两件事（[C57]）。 */
const POSITIVE_INT = /^[1-9][0-9]*$/;

/**
 * 没接数据库时的统一回应。功能未配置，让客户端禁用相关入口。
 *
 * M2.5 之前它叫 `requireDb(res, deps)` 并且**自己发响应**——那是这次
 * 重构里两个真正的设计改动之一（另一个是 `readCaptureFlags` 不再吃
 * `URLSearchParams`）。它被 5 个 handler 共用，只要它还认识 `res`，
 * 那 5 个 handler 里的 `res` 就拔不干净。
 */
function resolveDb(deps: ServerDeps): DatabaseSync | null {
  return deps.db ?? null;
}

const DB_UNAVAILABLE: JsonResult = {
  status: 503,
  body: { error: "unavailable", message: "材料功能未配置（服务端没有接数据库）。" },
};

/**
 * 请求体超限。文案只写一处，HTTP 的流式截断和 handler 的自查共用。
 */
function tooLong(limit: number): JsonResult {
  return {
    status: 413,
    body: { error: "too_long", message: `请求体超过 ${Math.round(limit / 1024)} KB` },
  };
}

export interface JsonBodyInput {
  /**
   * 未解析的请求体文本。
   *
   * **不是解析好的对象**，因为「这段文本不是合法 JSON」这条分支
   * （契约里的 400 `rejected`）必须留在 handler 里被测到。
   * 交给适配器去解析的话，那条分支就只有走完整 HTTP 才测得到，
   * 而 M2.5 的全部目的就是让这些用例不依赖传输。
   */
  raw: string;
}

/** POST /api/materials  { title?, source, text } → 201 { materialId, sentences } */
export async function postMaterials(
  input: JsonBodyInput,
  deps: ServerDeps,
): Promise<HandlerResult> {
  const db = resolveDb(deps);
  if (!db) return DB_UNAVAILABLE;

  if (Buffer.byteLength(input.raw) > MAX_JSON_BYTES) return tooLong(MAX_JSON_BYTES);

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw) as unknown;
  } catch {
    return { status: 400, body: { error: "rejected", message: "请求体不是合法 JSON" } };
  }

  const body = parsed as { title?: unknown; source?: unknown; text?: unknown };

  // 写路径严格：任何可疑输入都拒绝，因为它会落进改不动的库里。
  if (typeof body.text !== "string" || body.text.trim() === "") {
    return { status: 400, body: { error: "rejected", message: "缺少 text 字段，或它是空的" } };
  }
  if (body.source !== "paste") {
    // v0 只接受 "paste"，"ai" 由 M06 打开（[C9]）。
    return {
      status: 400,
      body: {
        error: "rejected",
        message: `source 只接受 "paste"，收到的是 ${JSON.stringify(body.source)}`,
      },
    };
  }
  if (body.title !== undefined && typeof body.title !== "string") {
    return { status: 400, body: { error: "rejected", message: "title 必须是字符串" } };
  }

  // title 缺省时从正文取一小段。缺省不是错误，不该逼用户先想标题。
  const title = (body.title ?? body.text.trim().slice(0, 40)).trim();
  if (title === "") {
    return { status: 400, body: { error: "rejected", message: "title 不能是空的" } };
  }
  if (title.length > MAX_TITLE_CHARS) {
    return {
      status: 400,
      body: {
        error: "rejected",
        message: `title ${title.length} 字符，超过 ${MAX_TITLE_CHARS} 上限`,
      },
    };
  }

  // 分句在服务端做，客户端不参与——split() 有 73 个用例，
  // 而 F3 要给它加的「每句必须是可评分单元」这条约束也只能加在这里。
  const texts = split(body.text);
  if (texts.length === 0) {
    return { status: 400, body: { error: "rejected", message: "这段文本分不出任何句子" } };
  }
  if (texts.length > MAX_SENTENCES_PER_MATERIAL) {
    return {
      status: 400,
      body: {
        error: "rejected",
        message: `分出了 ${texts.length} 句，超过 ${MAX_SENTENCES_PER_MATERIAL} 上限。请把材料拆成几份。`,
      },
    };
  }

  const made = createMaterial(db, { title, source: "paste", texts, createdAt: Date.now() });
  return {
    status: 201,
    body: { materialId: made.materialId, sentences: withAssessable(made.sentences) },
  };
}

/** GET /api/materials?limit= → { materials: [...] } */
export async function getMaterials(
  input: { limit?: string | null },
  deps: ServerDeps,
): Promise<HandlerResult> {
  const db = resolveDb(deps);
  if (!db) return DB_UNAVAILABLE;
  return { status: 200, body: { materials: listMaterials(db, clampLimit(input.limit ?? null)) } };
}

/**
 * `limit` 越界一律 clamp，不报错（[C62]）。
 *
 * **读路径宽容、写路径严格**：limit 不改变任何状态，为它返回 400
 * 只是在给客户端制造麻烦；而写路径的可疑输入会落进改不动的库里。
 */
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

function clampLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return LIMIT_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value)) return LIMIT_DEFAULT;
  return Math.min(LIMIT_MAX, Math.max(1, Math.trunc(value)));
}

/** GET /api/materials/{id} → 一份材料的全部句子 */
export async function getMaterialDetail(
  input: { id: string },
  deps: ServerDeps,
): Promise<HandlerResult> {
  const db = resolveDb(deps);
  if (!db) return DB_UNAVAILABLE;

  if (!POSITIVE_INT.test(input.id)) {
    return {
      status: 400,
      body: { error: "rejected", message: `材料 id 必须是正整数，收到 ${input.id}` },
    };
  }

  const detail = getMaterial(db, Number(input.id));
  if (!detail) {
    return { status: 404, body: { error: "not_found", message: `材料 ${input.id} 不存在` } };
  }

  return { status: 200, body: { ...detail, sentences: withAssessable(detail.sentences) } };
}

/** POST /api/tts  { text, voice?, speed? } → { key, format, bytes, cached, url } */
export async function postTts(input: JsonBodyInput, deps: ServerDeps): Promise<HandlerResult> {
  if (Buffer.byteLength(input.raw) > MAX_JSON_BYTES) return tooLong(MAX_JSON_BYTES);

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw) as unknown;
  } catch {
    return { status: 400, body: { error: "rejected", message: "请求体不是合法 JSON" } };
  }

  // 手写路由没有 schema 校验，所以字段要一个个查。
  const body = parsed as { text?: unknown; voice?: unknown; speed?: unknown };
  if (typeof body.text !== "string") {
    return { status: 400, body: { error: "rejected", message: "缺少 text 字段" } };
  }
  if (body.voice !== undefined && typeof body.voice !== "string") {
    return { status: 400, body: { error: "rejected", message: "voice 必须是字符串" } };
  }
  if (body.speed !== undefined && typeof body.speed !== "number") {
    return { status: 400, body: { error: "rejected", message: "speed 必须是数字" } };
  }

  const trace = beginTrace(deps);
  const voice = body.voice ?? deps.defaultVoice;
  trace.emit({
    kind: "request",
    service: "tts",
    provider: deps.provider.engine,
    meta: { textLength: body.text.length, voice },
  });

  try {
    const result = await synthesize(
      {
        text: body.text,
        voice,
        ...(body.speed === undefined ? {} : { speed: body.speed }),
      },
      {
        provider: deps.provider,
        store: deps.store,
        ...(deps.pitch ? { pitch: deps.pitch } : {}),
      },
    );

    trace.emit({
      kind: "result",
      service: "tts",
      provider: deps.provider.engine,
      status: 200,
      latencyMs: trace.elapsed(),
      // 命中缓存就没调外部服务，花费为零——这是缓存存在的全部理由，
      // 必须能在流水里看出来。没配费率时不记，而不是记 0。
      ...(deps.rates && !result.cached
        ? { costMicros: ttsCostMicros(body.text.length, deps.rates) }
        : {}),
      meta: { cached: result.cached, format: result.format, audioBytes: result.bytes },
    });

    return {
      status: 200,
      body: {
        key: result.key,
        format: result.format,
        bytes: result.bytes,
        cached: result.cached,
        url: `/api/audio/${result.key}.${result.format}`,
        // [C43] 缺席一律用「字段不出现」表达，绝不发 null。
        ...(result.pitch ? { pitch: result.pitch } : {}),
      },
    };
  } catch (err) {
    if (err instanceof ServiceError) {
      // 失败不计费：401 / 429 / 网络断都没有产生可计费用量。
      trace.emit({
        kind: "error",
        service: "tts",
        provider: deps.provider.engine,
        status: STATUS[err.kind],
        latencyMs: trace.elapsed(),
        errorKind: err.kind,
        meta: { reason: err.message },
      });
      // 服务端日志留全文，返回给前端的也是同一句话——Stage 0 只有自己在用，
      // 没必要藏。等有了别的用户再决定哪些细节不该外泄。
      console.error(`[tts] ${err.kind}: ${err.message}`);
      return { status: STATUS[err.kind], body: { error: err.kind, message: err.message } };
    }
    trace.emit({
      kind: "error",
      service: "tts",
      provider: deps.provider.engine,
      latencyMs: trace.elapsed(),
      errorKind: "unknown",
      meta: { reason: describe(err) },
    });
    throw err;
  }
}

/**
 * POST /api/assess —— 契约 §6.6
 *
 * 请求体是原始 Float32 采样（小端），其余参数全在 query。
 * 用二进制而不是 JSON：base64 会让体积再涨三分之一，
 * 而 30 秒的采样已经接近 2MB（[C23]）。
 *
 * 这一层只做编排，每一步的逻辑都在 core/ 里且有用例覆盖。
 *
 * **已知代价**（契约记录在案，v0 接受）：HTTP 那条路上 `reference` 走
 * query string，意味着用户的练习文本会进 URL，反向代理的 access log 和
 * 浏览器历史都会留下。Stage 0 本机单用户可接受，一旦部署到公网必须改成
 * header 或 body 内嵌。M3 换 IPC 之后这条代价自然消失——**但它消失是
 * 因为换了传输，不是因为这个 handler 改了**，所以这段话留着。
 */
export interface AssessInput {
  query: Query;
  /** 原始 Float32 采样（小端）。 */
  body: Uint8Array;
}

export async function postAssess(input: AssessInput, deps: ServerDeps): Promise<HandlerResult> {
  if (!deps.scoring) {
    return {
      status: 503,
      body: { error: "unavailable", message: "评分未配置。检查 .env.local 里的 Azure 密钥。" },
    };
  }

  const q = input.query;

  // ---- 参数校验（写路径严格，§9）----

  const rawSentenceId = q["sentenceId"] ?? null;
  const rawReference = q["reference"] ?? null;

  // [C24] 两个都给 → 400。不是「以某个为准」：同一个事实存两份且可能不一致，
  // 是契约必须在边界上杀死的东西。规定优先级只是把歧义推迟到实现里。
  if (rawSentenceId !== null && rawReference !== null) {
    return {
      status: 400,
      body: { error: "rejected", message: "sentenceId 与 reference 只能给一个" },
    };
  }
  if (rawSentenceId === null && rawReference === null) {
    return { status: 400, body: { error: "rejected", message: "缺少 sentenceId 或 reference" } };
  }

  const clientRequestId = q["clientRequestId"] ?? null;
  if (clientRequestId !== null && !UUID_V4.test(clientRequestId)) {
    // [C64] 不静默丢弃：META_KEYS 的单值上限是 512 字符且超限是静默截断，
    // 一个残缺的 id 进流水比没有更糟。
    return {
      status: 400,
      body: { error: "rejected", message: "clientRequestId 必须是 UUID v4" },
    };
  }

  let capture: CaptureFlags;
  try {
    capture = readCaptureFlags(q);
  } catch (err) {
    return { status: 400, body: { error: "rejected", message: describe(err) } };
  }

  // ---- 解析参考文本 ----

  let reference: string;
  let sentenceId: number | undefined;

  if (rawSentenceId !== null) {
    if (!POSITIVE_INT.test(rawSentenceId)) {
      return {
        status: 400,
        body: { error: "rejected", message: `sentenceId 必须是正整数，收到 ${rawSentenceId}` },
      };
    }
    const db = resolveDb(deps);
    if (!db) return DB_UNAVAILABLE;

    const sentence = getSentence(db, Number(rawSentenceId));
    if (!sentence) {
      return { status: 404, body: { error: "not_found", message: `句子 ${rawSentenceId} 不存在` } };
    }
    // [C25] 参考文本由服务端从 sentence.text 读，客户端不传。
    // 客户端传的话，用户在界面上改了文本而 id 没变，评分就会挂到错误的句子上。
    reference = sentence.text;
    sentenceId = sentence.id;
  } else {
    reference = rawReference ?? "";
  }

  // ---- 请求体 ----

  const raw = input.body;
  if (raw.byteLength > MAX_PCM_BYTES) return tooLong(MAX_PCM_BYTES);

  // Float32 每采样 4 字节。长度不是 4 的倍数说明上传被截断了，
  // 直接按 4 取整会让最后一个采样是垃圾数据（[C65]）。
  if (raw.byteLength === 0 || raw.byteLength % 4 !== 0) {
    return {
      status: 400,
      body: {
        error: "rejected",
        message: `采样数据长度 ${raw.byteLength} 不是 4 的倍数，上传可能被截断了`,
      },
    };
  }

  const floats = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const trace = beginTrace(deps);
  trace.emit({
    kind: "request",
    service: "scoring",
    provider: deps.scoring.engine,
    meta: {
      audioBytes: raw.byteLength,
      durationMs: msOf(floats.length),
      textLength: reference.length,
      ...(sentenceId === undefined ? {} : { sentenceId }),
      ...(clientRequestId === null ? {} : { clientRequestId }),
    },
  });

  try {
    // 三步全是纯函数，全部有用例覆盖：
    // 转格式 → 掐掉首尾静音 → 编码成 WAV。
    const pcm = floatToInt16(floats);
    const trimmed = trimSilence(pcm, { sampleRate: RECORDING_SAMPLE_RATE });
    const trimmedStartMs = msOf(trimmed.trimmedStart);
    const trimmedEndMs = msOf(trimmed.trimmedEnd);

    // 修剪后可能什么都不剩——整段都是静音。这不是错误，
    // 是要如实告诉用户的结果，走和「没识别到语音」同一条路（[C31]）。
    //
    // **根本没调外部服务**，所以不计费、也不落库（[C33] 第四行）。
    if (trimmed.samples.length === 0) {
      trace.emit({
        kind: "result",
        service: "scoring",
        provider: deps.scoring.engine,
        status: 200,
        latencyMs: trace.elapsed(),
        meta: { reason: "no_speech_after_trim" },
      });
      return {
        status: 200,
        body: { outcome: "no_speech", trimmedStartMs, persisted: false, traceId: trace.id },
      };
    }

    // 计费与落库都按**实际送给服务的**时长，不是用户按住录音键的时长。
    const assessedMs = msOf(trimmed.samples.length);

    // 音高曲线算在**修剪后**的那一段上，和送去评分的是同一段音频。
    // 算在原始采样上的话，曲线的第 0 帧对应用户按下录音键的那一刻，
    // 而波形图画的是修剪后的音频——两条时间轴差一个 trimmedStartMs，
    // 曲线会整体偏移，且没有任何东西会报错。
    //
    // 直接切原始的 Float32（而不是把 Int16 转回来）：`floatToInt16` 是
    // 逐采样映射，下标一一对应，所以这个切片就是修剪后那一段的原始精度。
    const contour = contourFor(
      floats.subarray(trimmed.trimmedStart, trimmed.trimmedStart + trimmed.samples.length),
    );

    const wav = encodeWav(trimmed.samples, { sampleRate: RECORDING_SAMPLE_RATE });
    const outcome = await assess({ audio: wav, reference }, { provider: deps.scoring });

    const costed = deps.rates ? { costMicros: scoringCostMicros(assessedMs, deps.rates) } : {};

    // [C33] 落库的判据是「这次调用有没有产生成本」，不是「有没有分数」。
    // 走到这里说明音频确实送出去了，三种 outcome 都要留痕。
    const persistence = await persistPracticeBundle(deps, {
      sentenceId,
      wav,
      assessedMs,
      capture,
      traceId: trace.id,
      engine: deps.scoring.engine,
      // no_speech 时没有分数，只落 recording。
      result: outcome.kind === "no_speech" ? undefined : outcome.result,
      reliable: outcome.kind === "scored",
    });

    trace.emit({
      kind: "result",
      service: "scoring",
      provider: deps.scoring.engine,
      status: 200,
      latencyMs: trace.elapsed(),
      ...costed,
      meta: { reason: outcome.kind, durationMs: assessedMs, audioBytes: wav.byteLength },
    });

    if (outcome.kind === "no_speech") {
      return {
        status: 200,
        body: {
          outcome: "no_speech",
          trimmedStartMs,
          traceId: trace.id,
          // 没识别出词，但音频是真的送出去了，曲线照给——用户能看到自己
          // 确实发了声，只是没被认出来。
          ...(contour ? { pitch: contour } : {}),
          ...persistence,
        },
      };
    }

    return {
      status: 200,
      body: {
        outcome: outcome.kind,
        scores: outcome.result.scores,
        words: outcome.result.words,
        recognized: outcome.result.recognized,
        // [C43] 缺席一律用「字段不出现」表达，绝不发 null。
        ...(outcome.result.snr === undefined ? {} : { snr: outcome.result.snr }),
        trimmedStartMs,
        trimmedEndMs,
        assessedMs,
        traceId: trace.id,
        ...(contour ? { pitch: contour } : {}),
        ...persistence,
      },
    };
  } catch (err) {
    // 三类错误分开报，因为用户能做的事不同：
    // 音频有问题 → 重录；参考文本有问题 → 是我们的 bug；
    // 响应结构坏掉 → 服务端变了，重录也没用。
    const engine = deps.scoring.engine;
    if (err instanceof InvalidWavError || err instanceof InvalidReferenceError) {
      trace.emit({
        kind: "error", service: "scoring", provider: engine, status: 400,
        latencyMs: trace.elapsed(), errorKind: "rejected", meta: { reason: err.message },
      });
      console.error(`[assess] rejected: ${err.message}`);
      return { status: 400, body: { error: "rejected", message: err.message } };
    }
    if (err instanceof MalformedResponseError) {
      trace.emit({
        kind: "error", service: "scoring", provider: engine, status: 502,
        latencyMs: trace.elapsed(), errorKind: "unknown", meta: { reason: err.message },
      });
      console.error(`[assess] malformed: ${err.message}`);
      return { status: 502, body: { error: "unknown", message: "评分服务返回了无法解析的结果" } };
    }
    if (err instanceof ServiceError) {
      trace.emit({
        kind: "error", service: "scoring", provider: engine, status: STATUS[err.kind],
        latencyMs: trace.elapsed(), errorKind: err.kind, meta: { reason: err.message },
      });
      console.error(`[assess] ${err.kind}: ${err.message}`);
      return { status: STATUS[err.kind], body: { error: err.kind, message: err.message } };
    }
    trace.emit({
      kind: "error", service: "scoring", provider: engine,
      latencyMs: trace.elapsed(), errorKind: "unknown", meta: { reason: describe(err) },
    });
    throw err;
  }
}

/**
 * 录音的音高曲线。算不出来就不给，**绝不给一条错的**。
 *
 * `extractPitch` 在窗口装不下 3 个基频周期时会抛（见 `core/audio/pitch.ts` 里
 * 那段关于参考实现的注释）。那种处境下参考实现返回的是一串数字——
 * 曲线画得出来，形状是噪声。这里把它变成「没有曲线」。
 *
 * 抛错不能让整次评分失败：分数已经算出来了、钱已经花了，为一条画图用的
 * 曲线把结果扔掉是第二次伤害。和 [C35] 是同一条判断。
 */
function contourFor(samples: Float32Array): PitchContour | null {
  try {
    return contourOf({ samples, sampleRate: RECORDING_SAMPLE_RATE });
  } catch {
    return null;
  }
}

/** 采样数 → 毫秒。响应里所有时间都带 `Ms` 后缀（[C28] [C41]）。 */
function msOf(samples: number): number {
  return Math.round((samples / RECORDING_SAMPLE_RATE) * 1000);
}

/** UUID v4，36 字符。[C64] */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CaptureFlags {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

/**
 * 三个音频采集开关。
 *
 * [C66] 严格 `"true"` / `"false"`，其他值一律 400——**不把 `"1"` 当真**。
 * 缺席则不出现在结果里，落库为 `NULL`（不知道），不是 `false`（确定没开）。
 *
 * [C27] 客户端送来的必须是 `MediaStreamTrack.getSettings()` 的**回读值**，
 * 不是它请求的值——浏览器可以无视 constraint。服务端无从校验这一点，
 * 所以它是客户端的承诺（§8），不是服务端的检查。
 *
 * M2.5：入参从 `URLSearchParams` 换成普通对象。语义一个字没改——
 * IPC 那边送过来的同样是字符串，所以严格 `"true"` / `"false"` 照旧成立。
 */
function readCaptureFlags(q: Query): CaptureFlags {
  const out: CaptureFlags = {};
  for (const name of ["echoCancellation", "noiseSuppression", "autoGainControl"] as const) {
    const raw = q[name];
    if (raw === undefined) continue;
    if (raw !== "true" && raw !== "false") {
      throw new Error(`${name} 只接受 "true" 或 "false"，收到 ${JSON.stringify(raw)}`);
    }
    out[name] = raw === "true";
  }
  return out;
}

/** 落库的结果。字段形状直接就是响应里 `persisted` 那一组（[C32]）。 */
type Persistence =
  | { persisted: false }
  | { persisted: false; persistError: string }
  | { persisted: true; recordingId: number; assessmentId?: number; audioUrl: string };

/**
 * 落盘 + 落库。**顺序写死**，见 [C67]：
 *
 *   1. 算内容哈希
 *   2. 写音频文件（原子写）
 *   3. 开事务 → 写 recording / assessment / phoneme_score → 提交
 *
 * **只能是这个顺序。** 文件系统不参与 SQLite 事务，所以两种失败的后果不对称：
 *
 *   第 2 步失败 → 什么都没写，persisted:false + persistError。可容忍
 *   第 3 步失败 → 孤儿音频文件：占磁盘，没人引用。可容忍
 *   反过来先写库 → **悬空引用**：记录看起来完全正常，读音频 404。不可容忍
 *
 * 孤儿文件是浪费磁盘，悬空引用是用户看到坏记录。**宁可浪费磁盘。**
 * 孤儿文件的回收和 F8 是同一件事，一起做；在那之前只增不减，v0 接受。
 *
 * [C35] 写库失败返 200 而不是 500：评分已经成功、钱已经花了，把结果扔掉是
 * 第二次伤害。但静默吞掉也不行——练习记录丢一行是用户的数据没了，
 * 而且不会重新产生。所以：**结果照给，失败照说。**
 *
 * 这条**不能照抄 operations 的「写流水永不抛」**。流水丢一行只是少个运维记录，
 * 业务表丢一行是丢用户资产。同一个仓库里两处采取相反策略是对的。
 */
async function persistPracticeBundle(
  deps: ServerDeps,
  input: {
    sentenceId: number | undefined;
    wav: Uint8Array;
    assessedMs: number;
    capture: CaptureFlags;
    traceId: string;
    engine: string;
    result: AssessmentResult | undefined;
    reliable: boolean;
  },
): Promise<Persistence> {
  // [C32] 没给 sentenceId = 匿名试用，**本来就没要求记录**，不是失败。
  if (input.sentenceId === undefined) return { persisted: false };
  if (!deps.db || !deps.recordings) {
    return { persisted: false, persistError: "服务端没有接数据库或录音存储" };
  }

  const db = deps.db;
  const now = Date.now();

  let audioKey: string;
  try {
    audioKey = (await deps.recordings.put(input.wav)).key;
  } catch (err) {
    return { persisted: false, persistError: `录音落盘失败：${describe(err)}` };
  }

  try {
    const ids = persistPractice(db, {
      recording: {
        sentenceId: input.sentenceId,
        audioKey,
        durationMs: input.assessedMs,
        createdAt: now,
        traceId: input.traceId,
        ...input.capture,
      },
      ...(input.result === undefined
        ? {}
        : {
            assessment: {
              engine: input.engine,
              result: input.result,
              createdAt: now,
              reliable: input.reliable,
            },
          }),
    });

    return {
      persisted: true,
      recordingId: ids.recordingId,
      ...(ids.assessmentId === undefined ? {} : { assessmentId: ids.assessmentId }),
      audioUrl: `/api/recordings/${ids.recordingId}/audio`,
    };
  } catch (err) {
    // 孤儿文件留在盘上，这是 [C67] 选定的失败方向。
    return { persisted: false, persistError: `练习记录写入失败：${describe(err)}` };
  }
}

/**
 * GET /api/recordings/{id}/audio —— 契约 §6.7
 *
 * [C37] 为什么必须有这条：`recording.audio_key` 是 NOT NULL，我们被表结构
 * 逼着存音频。不给读的入口，等于把 F12 在小一号的尺度上重犯一遍——
 * 存了但没人能用。
 */
export async function getRecordingAudio(
  input: { id: string },
  deps: ServerDeps,
): Promise<HandlerResult> {
  const db = resolveDb(deps);
  if (!db) return DB_UNAVAILABLE;
  if (!deps.recordings) {
    return { status: 503, body: { error: "unavailable", message: "录音存储未配置" } };
  }

  if (!POSITIVE_INT.test(input.id)) {
    return {
      status: 400,
      body: { error: "rejected", message: `录音 id 必须是正整数，收到 ${input.id}` },
    };
  }

  const key = getRecordingAudioKey(db, Number(input.id));
  if (key === null) {
    return { status: 404, body: { error: "not_found", message: `录音 ${input.id} 不存在` } };
  }

  let audio: Uint8Array;
  try {
    audio = await deps.recordings.read(key);
  } catch {
    // 悬空引用：库里有记录但文件没了。[C67] 的顺序保证它不该发生，
    // 但磁盘被手工清理过之类的情况仍然可能，如实报 404 而不是 500。
    return {
      status: 404,
      body: { error: "not_found", message: `录音 ${input.id} 的音频文件不存在` },
    };
  }

  return {
    status: 200,
    bytes: audio,
    headers: {
      "Content-Type": "audio/wav",
      // 内容寻址：同一个键的内容永远不变。
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  };
}

/** GET /api/audio/{64位哈希}.wav */
export async function getAudio(input: { name: string }, deps: ServerDeps): Promise<HandlerResult> {
  const match = /^([0-9a-f]{64})\.(wav|mp3)$/.exec(input.name);
  if (!match) {
    return { status: 400, body: { error: "rejected", message: "音频地址格式不对" } };
  }
  const key = match[1] as string;
  const format = match[2] as "wav" | "mp3";

  let audio: Uint8Array;
  try {
    audio = await deps.store.read(key, format);
  } catch {
    return { status: 404, body: { error: "not_found", message: "音频不存在" } };
  }

  return {
    status: 200,
    bytes: audio,
    headers: {
      "Content-Type": format === "wav" ? "audio/wav" : "audio/mpeg",
      // 内容寻址：同一个键的内容永远不变，可以放心长期缓存。
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
