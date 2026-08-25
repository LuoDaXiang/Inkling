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
import type { OperationInput, OperationLog } from "@/storage/operations";
import { scoringCostMicros, ttsCostMicros, type Rates } from "@/core/cost";
import {
  buildConfig,
  MAX_JSON_BYTES,
  MAX_PCM_BYTES,
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
  emit(input: Omit<OperationInput, "traceId">): void;
  elapsed(): number;
} {
  const traceId = randomUUID();
  const started = Date.now();
  return {
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

  if (req.method === "POST" && path === "/api/tts") {
    return postTts(req, res, deps);
  }

  if (req.method === "POST" && path === "/api/assess") {
    return postAssess(req, res, deps);
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
 * POST /api/assess
 *
 * 请求体是原始 Float32 采样（小端），参考文本放在查询串里。
 * 用二进制而不是 JSON：base64 会让体积再涨三分之一，
 * 而 30 秒的采样已经接近 2MB。
 *
 * 这一层只做编排，每一步的逻辑都在 core/ 里且有用例覆盖。
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
  const reference = url.searchParams.get("reference") ?? "";

  let raw: Buffer;
  try {
    raw = await readBinaryBody(req, MAX_PCM_BYTES);
  } catch (err) {
    return sendJson(res, 413, { error: "too_long", message: describe(err) });
  }

  // Float32 每采样 4 字节。长度不是 4 的倍数说明上传被截断了，
  // 直接按 4 取整会让最后一个采样是垃圾数据。
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
      durationMs: Math.round((floats.length / RECORDING_SAMPLE_RATE) * 1000),
      textLength: reference.length,
    },
  });

  try {
    // 三步全是纯函数，全部有用例覆盖：
    // 转格式 → 掐掉首尾静音 → 编码成 WAV。
    const pcm = floatToInt16(floats);
    const trimmed = trimSilence(pcm, { sampleRate: RECORDING_SAMPLE_RATE });

    // 修剪后可能什么都不剩——整段都是静音。这不是错误，
    // 是要如实告诉用户的结果，走和「没识别到语音」同一条路。
    if (trimmed.samples.length === 0) {
      // 整段静音，根本没调外部服务。记成 result 而不是 error——
      // 用户确实录了一段没有语音的东西，这是结果不是故障。
      // 分错了会让「失败率」这个指标失真。
      // 修剪后什么都不剩，**根本没调外部服务**——所以不计费。
      trace.emit({
        kind: "result",
        service: "scoring",
        provider: deps.scoring.engine,
        status: 200,
        latencyMs: trace.elapsed(),
        meta: { reason: "no_speech_after_trim" },
      });
      return sendJson(res, 200, { outcome: "no_speech", trimmed: { start: trimmed.trimmedStart } });
    }

    // 计费按**实际送给服务的**音频时长，不是用户按住录音键的时长——
    // 首尾静音被掐掉了，那部分没有送出去，不该计费。
    const assessedMs = Math.round((trimmed.samples.length / RECORDING_SAMPLE_RATE) * 1000);
    const wav = encodeWav(trimmed.samples, { sampleRate: RECORDING_SAMPLE_RATE });
    const outcome = await assess({ audio: wav, reference }, { provider: deps.scoring });

    if (outcome.kind === "no_speech") {
      // 这一条相反：音频确实送出去了，服务只是没识别到语音。调了就要计费。
      trace.emit({
        kind: "result",
        service: "scoring",
        provider: deps.scoring.engine,
        status: 200,
        latencyMs: trace.elapsed(),
        ...(deps.rates ? { costMicros: scoringCostMicros(assessedMs, deps.rates) } : {}),
        meta: { reason: "no_speech" },
      });
      return sendJson(res, 200, { outcome: "no_speech" });
    }

    trace.emit({
      kind: "result",
      service: "scoring",
      provider: deps.scoring.engine,
      status: 200,
      latencyMs: trace.elapsed(),
      ...(deps.rates ? { costMicros: scoringCostMicros(assessedMs, deps.rates) } : {}),
      meta: {
        reason: outcome.kind,
        durationMs: assessedMs,
        audioBytes: wav.byteLength,
      },
    });

    sendJson(res, 200, {
      outcome: outcome.kind,
      scores: outcome.result.scores,
      words: outcome.result.words,
      recognized: outcome.result.recognized,
      snr: outcome.result.snr,
      trimmed: { start: trimmed.trimmedStart, end: trimmed.trimmedEnd },
      seconds: trimmed.samples.length / RECORDING_SAMPLE_RATE,
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
