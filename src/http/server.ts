import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import type { TtsProvider } from "@/providers/tts/types";
import type { FileAudioStore } from "@/storage/file-audio-store";
import { synthesize } from "@/core/tts/synthesize";
import { TtsError, type TtsErrorKind } from "@/core/tts/errors";

/**
 * 本地 HTTP 服务。三个路由，所以不引框架——见 docs/decisions.md 0013。
 *
 * 边界纪律：身份和额度检查将来只能加在这一层，永远不进 core/。
 * synthesize() 不知道有没有账号这回事，Stage 2 加账号时它一行不改。
 */

export interface ServerDeps {
  provider: TtsProvider;
  store: FileAudioStore;
  /** 静态文件目录。 */
  publicDir: string;
  /** 未指定音色时用它。 */
  defaultVoice: string;
}

/** 请求体上限。框架会替你做这件事，手写就得自己做。 */
const MAX_BODY_BYTES = 64 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

/**
 * 错误分类到 HTTP 状态码。
 *
 * 分两类看：auth 和 quota 是**服务端配置**的问题（Stage 0 的 key 是本机填的），
 * 所以是 5xx 不是 4xx——浏览器端的用户没做错任何事。
 * rejected 和 too_long 才是请求本身的问题。
 */
const STATUS: Record<TtsErrorKind, number> = {
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
    body = await readBody(req);
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
    if (err instanceof TtsError) {
      // 服务端日志留全文，返回给前端的也是同一句话——Stage 0 只有自己在用，
      // 没必要藏。等有了别的用户再决定哪些细节不该外泄。
      console.error(`[tts] ${err.kind}: ${err.message}`);
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

/** 边收边数字节，超限立刻断开——不能等收完再判断，那时内存已经吃进去了。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        rejectPromise(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
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
