import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
}

/**
 * 请求体上限。框架会替你做这件事，手写就得自己做。
 *
 * 按路由分开，因为两类请求的量级差三个数量级：
 *
 *   JSON  一段待合成的文本，几 KB 顶天
 *   音频  16kHz 单声道 16bit = 32,000 字节/秒，30 秒就是 960KB
 *
 * 之前只有一个 64KB 的常量，当时脑子里想的是 JSON。等 M03 上传录音时，
 * **任何超过 2 秒的录音都会被自己的服务器拒掉**——而错误信息会说
 * 「请求体过大」，看不出真正的原因。趁还没写录音路由先分开。
 */
const MAX_JSON_BYTES = 64 * 1024;

/** 30 秒 16kHz 单声道音频约 960KB，留一点余量。 */
export const MAX_AUDIO_BYTES = 1024 * 1024;

/**
 * 录音上传的上限。
 *
 * 浏览器发的是**原始 Float32 采样**，不是编码好的 WAV——因为转换、
 * 修剪、编码这三步都在服务端做，那里有 171 个用例覆盖。浏览器层
 * 因此可以做到零业务逻辑，而它恰恰是唯一测不了的一层。
 *
 * 代价是上传体积翻倍：Float32 每采样 4 字节，30 秒 16kHz 是
 * 30 × 16000 × 4 = 1,920,000 字节。所以这个上限必须比 MAX_AUDIO_BYTES
 * 大一倍多。两个数字的关系有对账测试守着。
 */
export const MAX_PCM_BYTES = 2 * 1024 * 1024;

/** 录音的采样率。浏览器端和服务端必须一致，否则时长会算错。 */
export const RECORDING_SAMPLE_RATE = 16000;

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

  try {
    const result = await synthesize(
      {
        text: input.text,
        voice: input.voice ?? deps.defaultVoice,
        ...(input.speed === undefined ? {} : { speed: input.speed }),
      },
      { provider: deps.provider, store: deps.store },
    );

    sendJson(res, 200, {
      key: result.key,
      format: result.format,
      bytes: result.bytes,
      cached: result.cached,
      url: `/api/audio/${result.key}.${result.format}`,
    });
  } catch (err) {
    if (err instanceof ServiceError) {
      // 服务端日志留全文，返回给前端的也是同一句话——Stage 0 只有自己在用，
      // 没必要藏。等有了别的用户再决定哪些细节不该外泄。
      console.error(`[tts] ${err.kind}: ${err.message}`);
      return sendJson(res, STATUS[err.kind], { error: err.kind, message: err.message });
    }
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

  try {
    // 三步全是纯函数，全部有用例覆盖：
    // 转格式 → 掐掉首尾静音 → 编码成 WAV。
    const pcm = floatToInt16(floats);
    const trimmed = trimSilence(pcm, { sampleRate: RECORDING_SAMPLE_RATE });

    // 修剪后可能什么都不剩——整段都是静音。这不是错误，
    // 是要如实告诉用户的结果，走和「没识别到语音」同一条路。
    if (trimmed.samples.length === 0) {
      return sendJson(res, 200, { outcome: "no_speech", trimmed: { start: trimmed.trimmedStart } });
    }

    const wav = encodeWav(trimmed.samples, { sampleRate: RECORDING_SAMPLE_RATE });
    const outcome = await assess({ audio: wav, reference }, { provider: deps.scoring });

    if (outcome.kind === "no_speech") {
      return sendJson(res, 200, { outcome: "no_speech" });
    }

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
    if (err instanceof InvalidWavError || err instanceof InvalidReferenceError) {
      console.error(`[assess] rejected: ${err.message}`);
      return sendJson(res, 400, { error: "rejected", message: err.message });
    }
    if (err instanceof MalformedResponseError) {
      console.error(`[assess] malformed: ${err.message}`);
      return sendJson(res, 502, { error: "unknown", message: "评分服务返回了无法解析的结果" });
    }
    if (err instanceof ServiceError) {
      console.error(`[assess] ${err.kind}: ${err.message}`);
      return sendJson(res, STATUS[err.kind], { error: err.kind, message: err.message });
    }
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
