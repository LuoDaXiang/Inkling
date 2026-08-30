import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMaterialDetail,
  getMaterials,
  postMaterials,
  type JsonResult,
  type ServerDeps,
} from "@/http/server";
import { split } from "@/core/text/split";
import { FileAudioStore } from "@/storage/file-audio-store";
import { FakeTtsProvider } from "./helpers/fake-provider";
import { memoryDb } from "./helpers/db";

/**
 * `POST /api/materials` 与列表 / 详情 —— 契约 §6.2–6.4，测试清单 #12–#17。
 *
 * 这一步的作用是**分配 `sentenceId`，打通身份**。F12 断的就是这一节：
 * `POST /api/assess` 现在只拿到一段字面文本，而文本反查不出 id——
 * `sentence` 表没有 text 上的唯一约束，同一句话出现在两个材料里是合法状态。
 *
 * ## M2.5：驱动方式换了，断言一条没换
 *
 * 此前靠 `createApp(deps)` 起一个真端口加真实 `fetch`；现在直接调
 * `postMaterials` / `getMaterials` / `getMaterialDetail`。
 * 下面那个 `asRes()` 把 `HandlerResult` 包成和 `Response` 同形的东西
 * （`status` / `json()` / `text()`），所以**每条用例的正文一个字没改**。
 *
 * 这层薄包装是刻意的：它让「换传输」这件事在 diff 里只有几行，
 * 而不是散在 30 条用例里——散开的话，改错一条也看不出来。
 */

let dir: string;
let db: ReturnType<typeof memoryDb>;
let deps: ServerDeps;
/** 没接数据库的那一套，用来测「功能未配置」。 */
let bareDeps: ServerDeps;

/** `HandlerResult` → 和 `Response` 同形的东西，好让用例正文一个字不用改。 */
interface FakeResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

const asRes = (result: JsonResult): FakeResponse => ({
  status: result.status,
  json: async () => result.body,
  text: async () => JSON.stringify(result.body),
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "inkling-materials-"));
  db = memoryDb();
  const common: ServerDeps = {
    provider: new FakeTtsProvider({}),
    store: new FileAudioStore(join(dir, "audio")),
    defaultVoice: "en-US-AvaNeural",
  };
  deps = Object.assign({}, common, { db });
  bareDeps = common;
});

afterAll(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM material");
});

interface Created {
  materialId: number;
  sentences: Array<{ id: number; ord: number; text: string; assessable: boolean }>;
}

const post = async (payload: unknown, at?: ServerDeps): Promise<FakeResponse> =>
  asRes(
    (await postMaterials(
      { raw: typeof payload === "string" ? payload : JSON.stringify(payload) },
      at ?? deps,
    )) as JsonResult,
  );

const create = async (text: string, title = "第一课"): Promise<Created> => {
  const res = await post({ title, source: "paste", text });
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
};

/**
 * 列表。仍然收一个 query string，因为用例表达的就是「客户端发了 ?limit=0」——
 * 把它换成 `listRaw(0)` 会把「越界的 limit 从线上来」这个前提抹掉。
 * 这里做的解析和适配器里那一行是同一件事。
 */
const listRaw = async (query = "", at?: ServerDeps): Promise<FakeResponse> => {
  const limit = new URLSearchParams(query.replace(/^\?/, "")).get("limit");
  return asRes((await getMaterials({ limit }, at ?? deps)) as JsonResult);
};

/** 详情。id 保持字符串，因为「id 不是整数 → 400」那一组测的正是字符串形态。 */
const detail = async (id: string | number, at?: ServerDeps): Promise<FakeResponse> =>
  asRes((await getMaterialDetail({ id: String(id) }, at ?? deps)) as JsonResult);

describe("#15 建材料", () => {
  test("201，返回 materialId 与分好的句子", async () => {
    const made = await create("One. Two! Three?");
    expect(made.materialId).toBeGreaterThan(0);
    expect(made.sentences).toHaveLength(3);
  });

  test("同一段文本 POST 两次 → 两个不同的 materialId [C19]", async () => {
    // 刻意不幂等：同一篇文章练两遍是合法需求。
    const a = await create("Same text here.");
    const b = await create("Same text here.");
    expect(a.materialId).not.toBe(b.materialId);
    expect(a.sentences[0]?.id).not.toBe(b.sentences[0]?.id);
  });

  test("material 与 sentence 在同一个事务里——不会只留下半截", async () => {
    await create("One. Two.");
    const m = db.prepare("SELECT COUNT(*) c FROM material").get() as Record<string, unknown>;
    const s = db.prepare("SELECT COUNT(*) c FROM sentence").get() as Record<string, unknown>;
    expect(Number(m["c"])).toBe(1);
    expect(Number(s["c"])).toBe(2);
  });

  test("title 缺省时自动取一个，不报错", async () => {
    const res = await post({ source: "paste", text: "No title given here." });
    expect(res.status).toBe(201);
  });
});

describe("#16 枚举与序号", () => {
  test('source: "ai" → 400 [C9]', async () => {
    const res = await post({ title: "t", source: "ai", text: "Hi." });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe("rejected");
  });

  test("未知 source → 400 [C63]", async () => {
    const res = await post({ title: "t", source: "telepathy", text: "Hi." });
    expect(res.status).toBe(400);
  });

  test("ord 从 0 开始且连续 [C10]", async () => {
    const made = await create("One. Two. Three. Four.");
    expect(made.sentences.map((s) => s.ord)).toEqual([0, 1, 2, 3]);
  });
});

describe("#12 分句与 assessable", () => {
  test("分句结果与直接调 split() 一致 [C15]", async () => {
    const text = "First one. Second one! Third one?\nFourth on a new line.";
    const made = await create(text);
    expect(made.sentences.map((s) => s.text)).toEqual(split(text));
  });

  test("assessable 的边界就是 maxReferenceChars（900 / 901）[C16]", async () => {
    // 保守代理，不是真实时长——真实时长要合成完才知道，而 F3 还没解决。
    // 字符长度会误伤极慢语速的短句，但方向是安全的。
    const ok = `${"x".repeat(899)}.`;
    const tooLong = `${"y".repeat(900)}.`;
    const made = await create(`${ok} ${tooLong}`);

    expect(made.sentences[0]?.text.length).toBe(900);
    expect(made.sentences[1]?.text.length).toBe(901);
    expect(made.sentences[0]?.assessable).toBe(true);
    expect(made.sentences[1]?.assessable).toBe(false);
  });
});

describe("#13 assessable:false 的句子仍然是一等公民", () => {
  test("仍然入库，仍然出现在详情里 [C18]", async () => {
    const made = await create(`Short one. ${"y".repeat(900)}.`);
    const found = (await (await detail(made.materialId)).json()) as {
      sentences: Array<{ assessable: boolean }>;
    };
    expect(found.sentences).toHaveLength(2);
    expect(found.sentences[1]?.assessable).toBe(false);

    const row = db.prepare("SELECT COUNT(*) c FROM sentence").get() as Record<string, unknown>;
    expect(Number(row["c"])).toBe(2);
  });

  test("也计入列表的 sentenceCount", async () => {
    await create(`Short one. ${"y".repeat(900)}.`);
    const body = (await (await listRaw()).json()) as {
      materials: Array<{ sentenceCount: number }>;
    };
    expect(body.materials[0]?.sentenceCount).toBe(2);
  });
});

describe("#17 列表", () => {
  test("按 id 降序 [C8][C20]", async () => {
    const first = await create("Alpha.");
    const second = await create("Beta.");
    const body = (await (await listRaw()).json()) as { materials: Array<{ id: number }> };
    expect(body.materials.map((m) => m.id)).toEqual([second.materialId, first.materialId]);
  });

  test("字段齐全", async () => {
    await create("Alpha.");
    const body = (await (await listRaw()).json()) as { materials: Array<Record<string, unknown>> };
    expect(Object.keys(body.materials[0] ?? {}).sort()).toEqual(
      ["createdAtMs", "id", "sentenceCount", "source", "title"].sort(),
    );
  });

  test("limit 越界一律 clamp，不报错 [C62]", async () => {
    // 读路径宽容、写路径严格：limit 不改变任何状态。
    for (const query of ["?limit=0", "?limit=-5", "?limit=99999", "?limit=abc", "?limit="]) {
      expect((await listRaw(query)).status, query).toBe(200);
    }
  });

  test("limit 生效", async () => {
    await create("Alpha.");
    await create("Beta.");
    await create("Gamma.");
    const body = (await (await listRaw("?limit=2")).json()) as { materials: unknown[] };
    expect(body.materials).toHaveLength(2);
  });

  test("空库返回空数组，不是 null", async () => {
    const body = (await (await listRaw()).json()) as { materials: unknown[] };
    expect(body.materials).toEqual([]);
  });
});

describe("#4 详情与 id 校验", () => {
  test("取得到全部句子", async () => {
    const made = await create("One. Two.");
    const res = await detail(made.materialId);
    expect(res.status).toBe(200);
    const found = (await res.json()) as Record<string, unknown>;
    expect(found["id"]).toBe(made.materialId);
    expect((found["sentences"] as unknown[]).length).toBe(2);
  });

  test("不存在的 id → 404", async () => {
    const res = await detail(999999);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>)["error"]).toBe("not_found");
  });

  test("id 不是整数 → 400，不是 404 [C57]", async () => {
    // 格式错和不存在是两件事。
    for (const bad of ["abc", "1.5", "-3", "0x10", "%20"]) {
      const res = await detail(bad);
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as Record<string, unknown>)["error"], bad).toBe("rejected");
    }
  });
});

describe("#14 写路径的输入校验", () => {
  test("请求体不是合法 JSON → 400", async () => {
    expect((await post("{not json")).status).toBe(400);
  });

  test("title 为空或全空白 → 400 [C58]", async () => {
    expect((await post({ title: "", source: "paste", text: "Hi." })).status).toBe(400);
    expect((await post({ title: "   ", source: "paste", text: "Hi." })).status).toBe(400);
  });

  test("title 超过 maxTitleChars → 400 [C58]", async () => {
    const res = await post({ title: "t".repeat(201), source: "paste", text: "Hi." });
    expect(res.status).toBe(400);
  });

  test("title 正好 maxTitleChars → 通过", async () => {
    const res = await post({ title: "t".repeat(200), source: "paste", text: "Hi." });
    expect(res.status).toBe(201);
  });

  test("text 为空 → 400 [C59]", async () => {
    expect((await post({ title: "t", source: "paste", text: "" })).status).toBe(400);
  });

  test("text 分不出任何句子 → 400 [C60]", async () => {
    expect((await post({ title: "t", source: "paste", text: "   " })).status).toBe(400);
  });

  test("句子数超过上限 → 400，且提示拆分 [C60]", async () => {
    const many = "Hi. ".repeat(501);
    const res = await post({ title: "t", source: "paste", text: many });
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as Record<string, unknown>)["message"])).toMatch(/拆/);
  });

  test("字段类型不对 → 400", async () => {
    expect((await post({ title: 1, source: "paste", text: "Hi." })).status).toBe(400);
    expect((await post({ title: "t", source: "paste", text: 42 })).status).toBe(400);
  });

  test("被拒的请求不留下任何行", async () => {
    await post({ title: "t", source: "ai", text: "Hi." });
    const row = db.prepare("SELECT COUNT(*) c FROM material").get() as Record<string, unknown>;
    expect(Number(row["c"])).toBe(0);
  });
});

describe("C43 响应里不出现 null", () => {
  test("建材料、列表、详情三条都不发 null", async () => {
    const made = await create("One. Two.");
    for (const [name, res] of [
      ["列表", await listRaw()],
      ["详情", await detail(made.materialId)],
    ] as const) {
      expect(await res.text(), name).not.toContain("null");
    }
  });
});

describe("没接数据库时", () => {
  test("三条路由都返回 503 unavailable，而不是 500", async () => {
    expect((await post({ title: "t", source: "paste", text: "Hi." }, bareDeps)).status).toBe(503);
    expect((await listRaw("", bareDeps)).status).toBe(503);
    expect((await detail(1, bareDeps)).status).toBe(503);
  });
});
