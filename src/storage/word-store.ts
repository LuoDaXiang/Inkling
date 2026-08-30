import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write";

/**
 * 生词本 —— **本地存储，离线可用**（迁移计划 M4.3）。
 *
 * 参考实现的 `pages/vocabulary.tsx` 走 `webApi.mineMeanings()`，
 * `components/meanings/` 也一样——**数据源是它自己的服务器，本地没有
 * Meaning 模型**。搬过来是个空壳：界面在，点开永远是空的。
 * 所以这一层自己写，一个 JSON 文件，不联网。
 *
 * ## 为什么是 JSON 不是 SQLite
 *
 * 生词本是**一个用户手工攒出来的小表**：一天加几个词，几年也就几千行，
 * 没有关联查询、没有并发写入、没有事务边界。业务库那边用 SQLite 是因为
 * 练习记录要按句子关联、按时间聚合、还要和录音文件保持引用完整；
 * 这里一条都不成立。
 *
 * 反过来，JSON 有一个 SQLite 没有的好处：**用户能自己打开看、自己改、
 * 自己拷走**。生词本是用户攒的资产，不该锁在一个要工具才打得开的文件里。
 *
 * ## 坏文件挪走，不覆盖
 *
 * 和 `dict-store` 同一条：词典清单坏了重新导入就有了，
 * **生词本坏了是用户几年的东西没了**。所以一律挪到
 * `<name>.corrupt.<时间戳>`，然后从空开始——绝不静默覆盖。
 */

export interface SavedWord {
  /** 原样保存用户看到的形态。不做小写化——`March` 和 `march` 不是一个词。 */
  word: string;
  addedAt: number;
  /** 用户自己写的一句话。词典释义不存这里：词典会换，笔记不该跟着丢。 */
  note?: string;
}

const SCHEMA_VERSION = 1;

interface WordFile {
  schema_version: number;
  words: SavedWord[];
}

export class WordStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  /** 全部生词，最近加的排前面。 */
  async list(): Promise<SavedWord[]> {
    const found = await this.read();
    return [...found.words].sort((a, b) => b.addedAt - a.addedAt);
  }

  /**
   * 加一个词。
   *
   * **同一个词再加一次是更新时间，不是加第二条**——用户在两篇材料里
   * 碰到同一个生词是常事，攒出两条重复只会让列表越来越难看。
   * 但**笔记不覆盖**：已经写过的笔记，再次加词时留着。
   */
  async add(word: string, now = Date.now(), note?: string): Promise<SavedWord> {
    const trimmed = word.trim();
    if (trimmed === "") throw new Error("空字符串不是一个词");

    const found = await this.read();
    const existing = found.words.find((w) => w.word === trimmed);

    const entry: SavedWord = {
      word: trimmed,
      addedAt: now,
      ...(note !== undefined ? { note } : existing?.note !== undefined ? { note: existing.note } : {}),
    };

    await this.write({
      schema_version: SCHEMA_VERSION,
      words: [...found.words.filter((w) => w.word !== trimmed), entry],
    });
    return entry;
  }

  /** 改笔记。词不存在时当成新加一条——用户的意图很清楚，不必先加再改。 */
  async annotate(word: string, note: string, now = Date.now()): Promise<SavedWord> {
    return this.add(word, now, note);
  }

  /** 删一个词。不存在也不抛——幂等。 */
  async remove(word: string): Promise<void> {
    const found = await this.read();
    await this.write({
      schema_version: SCHEMA_VERSION,
      words: found.words.filter((w) => w.word !== word),
    });
  }

  async has(word: string): Promise<boolean> {
    return (await this.read()).words.some((w) => w.word === word.trim());
  }

  private async read(): Promise<WordFile> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return { schema_version: SCHEMA_VERSION, words: [] };
    }

    try {
      return parseWords(JSON.parse(raw) as unknown);
    } catch {
      // 挪走，不覆盖。见文件头——这是用户攒了几年的东西。
      await rename(this.path, `${this.path}.corrupt.${Date.now()}`).catch(() => {});
      return { schema_version: SCHEMA_VERSION, words: [] };
    }
  }

  private async write(file: WordFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFileAtomic(this.path, new TextEncoder().encode(JSON.stringify(file, null, 2)));
  }

  /** 测试用：直接落一份内容，制造坏文件之类的情形。 */
  async writeRaw(text: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, text, "utf8");
  }
}

/**
 * 读回来的东西要验形状。
 *
 * 一条缺 `word` 的记录会在界面上渲染成一行空白，点它没有反应——
 * 而没有任何东西会报错。宁可整份当成坏文件挪走，也不要半份。
 */
function parseWords(value: unknown): WordFile {
  if (typeof value !== "object" || value === null) throw new Error("不是对象");
  const raw = value as { words?: unknown };
  if (!Array.isArray(raw.words)) throw new Error("words 不是数组");

  const words = raw.words.map((entry): SavedWord => {
    if (typeof entry !== "object" || entry === null) throw new Error("条目不是对象");
    const w = entry as Record<string, unknown>;
    if (typeof w["word"] !== "string" || w["word"] === "") throw new Error("缺 word");
    if (typeof w["addedAt"] !== "number" || !Number.isFinite(w["addedAt"])) {
      throw new Error("缺 addedAt");
    }
    return {
      word: w["word"],
      addedAt: w["addedAt"],
      ...(typeof w["note"] === "string" ? { note: w["note"] } : {}),
    };
  });

  return { schema_version: SCHEMA_VERSION, words };
}
