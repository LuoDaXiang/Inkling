import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
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
 * 本地 HTTP 服务。三个路由，所以不引框架——见 docs/decisions.md 0013。
 *
 * 边界纪律：身份和额度检查将来只能加在这一层，永远不进 core/。
 * synthesize() 不知道有没有账号这回事，Stage 2 加账号时它一行不改。
 */

export interface ServerDeps {
  provider: TtsProvider;
  /** 没配置时评分路由返回 503，其余功能照常可用。 */
  scoring?: ScoringProvider;
  store: FileAudioStore;
  /** 静态文件目录。 */
  publicDir: string;
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
   * 和 TTS 缓存分开是刻意的（[C38]）：那边的键是请求派生的，去重是目的；
   * 录音同一句录十次是十份必须各自保留的音频，去重就是数据丢失。
   */
  recordings?: RecordingStore;
}

/**
 * 共享常量已经搬到 `contract.ts`——它是唯一来源，`GET /api/config` 从那里取值。
 * 这里原样再导出，让现有路由测试的 import 一行不改，也避开循环 import。
 * 搬家的理由与取值规则见 `docs/api-contract.md` §4「这些值从哪里来」。
 */
export {
  MAX_AUDIO_BYTES,
  MAX_PCM_BYTES,
  RECORDING_SAMPLE_RATE,
} from "./contract";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".mjs": "text/javascript; charset=utf-8",
};

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

export function createApp(deps: ServerDeps) {
  return createServer((req, res) => {
    handle(req, res, deps).catch((err: unknown) => {
      // 兜底：任何没被下面接住的错误都不该让进程崩掉。
      sendJson(res, 500, { error: "internal", message: describe(err) });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/config") {
    return getConfig(res, deps);
  }

  if (req.method === "POST" && path === "/api/materials") {
    return postMaterials(req, res, deps);
  }

  if (req.method === "GET" && path === "/api/materials") {
    return getMaterials(url, res, deps);
  }

  if (req.method === "GET" && path.startsWith("/api/materials/")) {
    return getMaterialDetail(res, path.slice("/api/materials/".length), deps);
  }

  if (req.method === "POST" && path === "/api/tts") {
    return postTts(req, res, deps);
  }

  if (req.method === "POST" && path === "/api/assess") {
    return postAssess(req, res, deps);
  }

  if (req.method === "GET" && /^\/api\/recordings\/[^/]+\/audio$/.test(path)) {
    return getRecordingAudio(res, path.split("/")[3] as string, deps);
  }

  if (req.method === "GET" && path.startsWith("/api/audio/")) {
    return getAudio(res, path.slice("/api/audio/".length), deps);
  }

  if (req.method === "GET") {
    return getStatic(res, path, deps.publicDir);
  }

  sendJson(res, 405, { error: "method_not_allowed", message: `不支持 ${req.method}` });
}

/**
 * GET /api/config —— 契约 §4。
 *
 * 下发共享常量与契约版本，消灭「客户端和服务端各硬编码一份」这一整类问题。
 * 无错误分支、无副作用、不花钱、幂等。
 *
 * `no-store` 是 [C6]：这份 config 的全部目的就是消灭两边不一致，
 * 让它自己被缓存住是自相矛盾——客户端会拿着上一版的常量跑。
 */
function getConfig(res: ServerResponse, deps: ServerDeps): void {
  sendJson(res, 200, buildConfig({ scoringAvailable: Boolean(deps.scoring) }), {
    "Cache-Control": "no-store",
  });
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

/** 没接数据库时的统一回应。功能未配置，让客户端禁用相关入口。 */
function requireDb(res: ServerResponse, deps: ServerDeps): DatabaseSync | null {
  if (deps.db) return deps.db;
  sendJson(res, 503, { error: "unavailable", message: "材料功能未配置（服务端没有接数据库）。" });
  return null;
}

/** POST /api/materials  { title?, source, text } → 201 { materialId, sentences } */
async function postMaterials(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const db = requireDb(res, deps);
  if (!db) return;

  let body: string;
  try {
    body = await readBody(req, MAX_JSON_BYTES);
  } catch (err) {
    return sendJson(res, 413, { error: "too_long", message: describe(err) });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return sendJson(res, 400, { error: "rejected", message: "请求体不是合法 JSON" });
  }

  const input = parsed as { title?: unknown; source?: unknown; text?: unknown };

  // 写路径严格：任何可疑输入都拒绝，因为它会落进改不动的库里。
  if (typeof input.text !== "string" || input.text.trim() === "") {
    return sendJson(res, 400, { error: "rejected", message: "缺少 text 字段，或它是空的" });
  }
  if (input.source !== "paste") {
    // v0 只接受 "paste"，"ai" 由 M06 打开（[C9]）。
    return sendJson(res, 400, {
      error: "rejected",
      message: `source 只接受 "paste"，收到的是 ${JSON.stringify(input.source)}`,
    });
  }
  if (input.title !== undefined && typeof input.title !== "string") {
    return sendJson(res, 400, { error: "rejected", message: "title 必须是字符串" });
  }

  // title 缺省时从正文取一小段。缺省不是错误，不该逼用户先想标题。
  const title = (input.title ?? input.text.trim().slice(0, 40)).trim();
  if (title === "") {
    return sendJson(res, 400, { error: "rejected", message: "title 不能是空的" });
  }
  if (title.length > MAX_TITLE_CHARS) {
    return sendJson(res, 400, {
      error: "rejected",
      message: `title ${title.length} 字符，超过 ${MAX_TITLE_CHARS} 上限`,
    });
  }

  // 分句在服务端做，客户端不参与——split() 有 73 个用例，
  // 而 F3 要给它加的「每句必须是可评分单元」这条约束也只能加在这里。
  const texts = split(input.text);
  if (texts.length === 0) {
    return sendJson(res, 400, { error: "rejected", message: "这段文本分不出任何句子" });
  }
  if (texts.length > MAX_SENTENCES_PER_MATERIAL) {
    return sendJson(res, 400, {
      error: "rejected",
      message: `分出了 ${texts.length} 句，超过 ${MAX_SENTENCES_PER_MATERIAL} 上限。请把材料拆成几份。`,
    });
  }

  const made = createMaterial(db, { title, source: "paste", texts, createdAt: Date.now() });
  sendJson(res, 201, {
    materialId: made.materialId,
    sentences: withAssessable(made.sentences),
  });
}

/** GET /api/materials?limit= → { materials: [...] } */
function getMaterials(url: URL, res: ServerResponse, deps: ServerDeps): void {
  const db = requireDb(res, deps);
  if (!db) return;
  sendJson(res, 200, { materials: listMaterials(db, clampLimit(url.searchParams.get("limit"))) });
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
function getMaterialDetail(res: ServerResponse, raw: string, deps: ServerDeps): void {
  const db = requireDb(res, deps);
  if (!db) return;

  if (!POSITIVE_INT.test(raw)) {
    return sendJson(res, 400, { error: "rejected", message: `材料 id 必须是正整数，收到 ${raw}` });
  }

  const detail = getMaterial(db, Number(raw));
  if (!detail) {
    return sendJson(res, 404, { error: "not_found", message: `材料 ${raw} 不存在` });
  }

  sendJson(res, 200, { ...detail, sentences: withAssessable(detail.sentences) });
}

/** POST /api/tts  { text, voice?, speed? } → { key, format, bytes, cached, url } */
async function postTts(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req, MAX_JSON_BYTES);
  } catch (err) {
    return sendJson(res, 413, { error: "too_long", message: describe(err) });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return sendJson(res, 400, { error: "rejected", message: "请求体不是合法 JSON" });
  }

  // 手写路由没有 schema 校验，所以字段要一个个查。
  const input = parsed as { text?: unknown; voice?: unknown; speed?: unknown };
  if (typeof input.text !== "string") {
    return sendJson(res, 400, { error: "rejected", message: "缺少 text 字段" });
  }
  if (input.voice !== undefined && typeof input.voice !== "string") {
    return sendJson(res, 400, { error: "rejected", message: "voice 必须是字符串" });
  }
  if (input.speed !== undefined && typeof input.speed !== "number") {
    return sendJson(res, 400, { error: "rejected", message: "speed 必须是数字" });
  }

  const trace = beginTrace(deps);
  const voice = input.voice ?? deps.defaultVoice;
  trace.emit({
    kind: "request",
    service: "tts",
    provider: deps.provider.engine,
    meta: { textLength: input.text.length, voice },
  });

  try {
    const result = await synthesize(
      {
        text: input.text,
        voice,
        ...(input.speed === undefined ? {} : { speed: input.speed }),
      },
      { provider: deps.provider, store: deps.store },
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
        ? { costMicros: ttsCostMicros(input.text.length, deps.rates) }
        : {}),
      meta: { cached: result.cached, format: result.format, audioBytes: result.bytes },
    });

    sendJson(res, 200, {
      key: result.key,
      format: result.format,
      bytes: result.bytes,
      cached: result.cached,
      url: `/api/audio/${result.key}.${result.format}`,
    });
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
      return sendJson(res, STATUS[err.kind], { error: err.kind, message: err.message });
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
 * 请求体是原始 Float32 采样（小端），其余参数全在 query string。
 * 用二进制而不是 JSON：base64 会让体积再涨三分之一，
 * 而 30 秒的采样已经接近 2MB（[C23]）。
 *
 * 这一层只做编排，每一步的逻辑都在 core/ 里且有用例覆盖。
 *
 * **已知代价**（契约记录在案，v0 接受）：`reference` 走 query 意味着用户的
 * 练习文本会进 URL，反向代理的 access log 和浏览器历史都会留下。
 * Stage 0 本机单用户可接受，一旦部署到公网必须改成 header 或 body 内嵌。
 */
async function postAssess(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  if (!deps.scoring) {
    return sendJson(res, 503, {
      error: "unavailable",
      message: "评分未配置。检查 .env.local 里的 Azure 密钥。",
    });
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const q = url.searchParams;

  // ---- 参数校验（写路径严格，§9）----

  const rawSentenceId = q.get("sentenceId");
  const rawReference = q.get("reference");

  // [C24] 两个都给 → 400。不是「以某个为准」：同一个事实存两份且可能不一致，
  // 是契约必须在边界上杀死的东西。规定优先级只是把歧义推迟到实现里。
  if (rawSentenceId !== null && rawReference !== null) {
    return sendJson(res, 400, {
      error: "rejected",
      message: "sentenceId 与 reference 只能给一个",
    });
  }
  if (rawSentenceId === null && rawReference === null) {
    return sendJson(res, 400, { error: "rejected", message: "缺少 sentenceId 或 reference" });
  }

  const clientRequestId = q.get("clientRequestId");
  if (clientRequestId !== null && !UUID_V4.test(clientRequestId)) {
    // [C64] 不静默丢弃：META_KEYS 的单值上限是 512 字符且超限是静默截断，
    // 一个残缺的 id 进流水比没有更糟。
    return sendJson(res, 400, {
      error: "rejected",
      message: "clientRequestId 必须是 UUID v4",
    });
  }

  let capture: CaptureFlags;
  try {
    capture = readCaptureFlags(q);
  } catch (err) {
    return sendJson(res, 400, { error: "rejected", message: describe(err) });
  }

  // ---- 解析参考文本 ----

  let reference: string;
  let sentenceId: number | undefined;

  if (rawSentenceId !== null) {
    if (!POSITIVE_INT.test(rawSentenceId)) {
      return sendJson(res, 400, {
        error: "rejected",
        message: `sentenceId 必须是正整数，收到 ${rawSentenceId}`,
      });
    }
    const db = requireDb(res, deps);
    if (!db) return;

    const sentence = getSentence(db, Number(rawSentenceId));
    if (!sentence) {
      return sendJson(res, 404, { error: "not_found", message: `句子 ${rawSentenceId} 不存在` });
    }
    // [C25] 参考文本由服务端从 sentence.text 读，客户端不传。
    // 客户端传的话，用户在界面上改了文本而 id 没变，评分就会挂到错误的句子上。
    reference = sentence.text;
    sentenceId = sentence.id;
  } else {
    reference = rawReference ?? "";
  }

  // ---- 读请求体 ----

  let raw: Buffer;
  try {
    raw = await readBinaryBody(req, MAX_PCM_BYTES);
  } catch (err) {
    return sendJson(res, 413, { error: "too_long", message: describe(err) });
  }

  // Float32 每采样 4 字节。长度不是 4 的倍数说明上传被截断了，
  // 直接按 4 取整会让最后一个采样是垃圾数据（[C65]）。
  if (raw.byteLength === 0 || raw.byteLength % 4 !== 0) {
    return sendJson(res, 400, {
      error: "rejected",
      message: `采样数据长度 ${raw.byteLength} 不是 4 的倍数，上传可能被截断了`,
    });
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
      return sendJson(res, 200, {
        outcome: "no_speech",
        trimmedStartMs,
        persisted: false,
        traceId: trace.id,
      });
    }

    // 计费与落库都按**实际送给服务的**时长，不是用户按住录音键的时长。
    const assessedMs = msOf(trimmed.samples.length);
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
      return sendJson(res, 200, {
        outcome: "no_speech",
        trimmedStartMs,
        traceId: trace.id,
        ...persistence,
      });
    }

    sendJson(res, 200, {
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
      ...persistence,
    });
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
      return sendJson(res, 400, { error: "rejected", message: err.message });
    }
    if (err instanceof MalformedResponseError) {
      trace.emit({
        kind: "error", service: "scoring", provider: engine, status: 502,
        latencyMs: trace.elapsed(), errorKind: "unknown", meta: { reason: err.message },
      });
      console.error(`[assess] malformed: ${err.message}`);
      return sendJson(res, 502, { error: "unknown", message: "评分服务返回了无法解析的结果" });
    }
    if (err instanceof ServiceError) {
      trace.emit({
        kind: "error", service: "scoring", provider: engine, status: STATUS[err.kind],
        latencyMs: trace.elapsed(), errorKind: err.kind, meta: { reason: err.message },
      });
      console.error(`[assess] ${err.kind}: ${err.message}`);
      return sendJson(res, STATUS[err.kind], { error: err.kind, message: err.message });
    }
    trace.emit({
      kind: "error", service: "scoring", provider: engine,
      latencyMs: trace.elapsed(), errorKind: "unknown", meta: { reason: describe(err) },
    });
    throw err;
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
 */
function readCaptureFlags(q: URLSearchParams): CaptureFlags {
  const out: CaptureFlags = {};
  for (const name of ["echoCancellation", "noiseSuppression", "autoGainControl"] as const) {
    const raw = q.get(name);
    if (raw === null) continue;
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
async function getRecordingAudio(res: ServerResponse, raw: string, deps: ServerDeps): Promise<void> {
  const db = requireDb(res, deps);
  if (!db) return;
  if (!deps.recordings) {
    return sendJson(res, 503, { error: "unavailable", message: "录音存储未配置" });
  }

  if (!POSITIVE_INT.test(raw)) {
    return sendJson(res, 400, { error: "rejected", message: `录音 id 必须是正整数，收到 ${raw}` });
  }

  const key = getRecordingAudioKey(db, Number(raw));
  if (key === null) {
    return sendJson(res, 404, { error: "not_found", message: `录音 ${raw} 不存在` });
  }

  let audio: Uint8Array;
  try {
    audio = await deps.recordings.read(key);
  } catch {
    // 悬空引用：库里有记录但文件没了。[C67] 的顺序保证它不该发生，
    // 但磁盘被手工清理过之类的情况仍然可能，如实报 404 而不是 500。
    return sendJson(res, 404, { error: "not_found", message: `录音 ${raw} 的音频文件不存在` });
  }

  res.writeHead(200, {
    "Content-Type": "audio/wav",
    "Content-Length": String(audio.byteLength),
    // 内容寻址：同一个键的内容永远不变。
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(audio);
}

/** GET /api/audio/{64位哈希}.wav */
async function getAudio(res: ServerResponse, name: string, deps: ServerDeps): Promise<void> {
  const match = /^([0-9a-f]{64})\.(wav|mp3)$/.exec(name);
  if (!match) {
    return sendJson(res, 400, { error: "rejected", message: "音频地址格式不对" });
  }
  const key = match[1] as string;
  const format = match[2] as "wav" | "mp3";

  let audio: Uint8Array;
  try {
    audio = await deps.store.read(key, format);
  } catch {
    return sendJson(res, 404, { error: "not_found", message: "音频不存在" });
  }

  res.writeHead(200, {
    "Content-Type": format === "wav" ? "audio/wav" : "audio/mpeg",
    "Content-Length": String(audio.byteLength),
    // 内容寻址：同一个键的内容永远不变，可以放心长期缓存。
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(audio);
}

async function getStatic(res: ServerResponse, path: string, publicDir: string): Promise<void> {
  const rel = path === "/" ? "/index.html" : path;
  const root = resolve(publicDir);
  const file = resolve(join(root, normalize(rel)));

  // 手写静态服务必须自己防路径穿越。normalize 之后仍要确认没跑出根目录。
  if (file !== root && !file.startsWith(root + "/")) {
    return sendJson(res, 403, { error: "forbidden", message: "越界的路径" });
  }

  try {
    const content = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "not_found", message: `没有 ${rel}` });
  }
}

/**
 * 边收边数字节，超限立刻停止累积——不能等收完再判断，那时内存已经吃进去了。
 *
 * **超限时不能 destroy 请求。** 那样会在响应发出之前掐断连接，
 * 客户端拿到的是连接重置而不是 413，看到的错误是「fetch failed」，
 * 完全不知道是自己传太大了。正确做法是停止累积、拒绝 Promise，
 * 让上层把 413 正常发出去，剩余的字节自然丢弃。
 *
 * 这个 bug 在 JSON 那条路上一直存在，从来没被测到——
 * 因为没有人真的用一个超大请求体打过它。
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return collect(req, limit).then((buffer) => buffer.toString("utf8"));
}

/** 二进制版。文本版会破坏字节。 */
function readBinaryBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return collect(req, limit);
}

function collect(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;

    req.on("data", (chunk: Buffer) => {
      if (overflowed) return; // 已经超限，继续丢弃直到流结束
      size += chunk.byteLength;
      if (size > limit) {
        overflowed = true;
        chunks.length = 0; // 立刻释放已经吃进去的内存
        rejectPromise(new Error(`请求体超过 ${Math.round(limit / 1024)} KB`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!overflowed) resolvePromise(Buffer.concat(chunks));
    });
    req.on("error", rejectPromise);
  });
}

/**
 * `headers` 是后加的可选参数，默认不传、行为与之前完全一致。
 * 目前唯一的用途是给 `/api/config` 发 `Cache-Control: no-store`（[C6]）。
 */
function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
