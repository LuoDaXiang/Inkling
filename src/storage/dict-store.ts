import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write";
import {
  classifyImport,
  titleFromPath,
  type InstalledDict,
} from "@/core/dict/mdict";

/**
 * 已安装词典的清单与文件。
 *
 * 目录结构：
 *
 * ```
 * <data>/dictionaries/
 *   index.json              ← 清单
 *   <md5>/Collins.mdx       ← 用户导入的原文件，按内容哈希分目录
 *   <md5>/Collins.mdd
 * ```
 *
 * **按哈希分目录**是照参考实现做的，那一条它做对了：同一本词典导入两次
 * 落在同一个目录，天然幂等；两本同名的不同词典也不会互相覆盖。
 *
 * **复制文件而不是记路径**。参考实现两件事都做了却记错了——它把文件复制
 * 进词典目录，返回的 `mdx` 却是用户导入时那个源路径。用户导入完把 U 盘拔了，
 * 查词就失败，而清单里那条词典看起来一切正常。这里返回的一律是目标路径。
 */

/** 清单文件名。和词典目录放一起，删掉整个目录就是彻底卸载。 */
const INDEX_FILE = "index.json";

const SCHEMA_VERSION = 1;

interface IndexFile {
  schema_version: number;
  dicts: InstalledDict[];
}

export class DictStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  /** 已安装的词典，按安装时间倒序——刚装的排前面。 */
  async list(): Promise<InstalledDict[]> {
    const found = await this.readIndex();
    return [...found.dicts].sort((a, b) => b.installedAt - a.installedAt);
  }

  /**
   * 导入一本词典。
   *
   * 同一本导入两次是**覆盖**，不是报错：用户重新导入通常就是想修一个坏文件。
   */
  async install(paths: readonly string[], now = Date.now()): Promise<InstalledDict> {
    const { mdx, mdds } = classifyImport(paths);

    const bytes = await readFile(mdx);
    const hash = createHash("md5").update(bytes).digest("hex");

    const target = join(this.dir, hash);
    await mkdir(target, { recursive: true });

    const mdxTarget = join(target, basename(mdx));
    await writeFileAtomic(mdxTarget, bytes);

    const mddTargets: string[] = [];
    for (const mdd of mdds) {
      const to = join(target, basename(mdd));
      await writeFileAtomic(to, await readFile(mdd));
      mddTargets.push(to);
    }

    const dict: InstalledDict = {
      hash,
      title: titleFromPath(mdx),
      // 目标路径，不是源路径。见文件头。
      mdx: mdxTarget,
      mdds: mddTargets,
      installedAt: now,
    };

    const index = await this.readIndex();
    await this.writeIndex({
      schema_version: SCHEMA_VERSION,
      dicts: [...index.dicts.filter((d) => d.hash !== hash), dict],
    });

    return dict;
  }

  /** 卸载。文件和清单一起删——留下孤儿目录只会让下次导入看起来「已经装过」。 */
  async remove(hash: string): Promise<void> {
    const index = await this.readIndex();
    await this.writeIndex({
      schema_version: SCHEMA_VERSION,
      dicts: index.dicts.filter((d) => d.hash !== hash),
    });
    await rm(join(this.dir, hash), { recursive: true, force: true });
  }

  /**
   * 清单读不出来时**返回空**，不抛。
   *
   * 和 `json_store` 那批一个道理：词典清单坏了，用户重新导入一次就有了；
   * 而开机时因为一个坏 JSON 整个应用起不来，是不成比例的后果。
   *
   * 但坏文件要**挪走**而不是覆盖——里面记着用户导入过哪些词典，
   * 静默删掉就再也查不回来了。
   */
  private async readIndex(): Promise<IndexFile> {
    const path = join(this.dir, INDEX_FILE);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return { schema_version: SCHEMA_VERSION, dicts: [] };
    }

    try {
      return parseIndex(JSON.parse(raw) as unknown);
    } catch {
      // **挪走，不是留一份副本。** 早先这里写成「删一个带时间戳的名字，
      // 再写一份带时间戳的副本」——两次 `Date.now()` 是两个不同的路径名，
      // 那个删除什么也没删；更糟的是**原件还在**，下次 list() 又会检测到它，
      // 再写一个新的 .corrupt.<ts>，文件数无上限增长。
      // `word-store` 那边一开始就是 rename，两处现在一致。
      await rename(path, `${path}.corrupt.${Date.now()}`).catch(() => {});
      return { schema_version: SCHEMA_VERSION, dicts: [] };
    }
  }

  private async writeIndex(index: IndexFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFileAtomic(
      join(this.dir, INDEX_FILE),
      new TextEncoder().encode(JSON.stringify(index, null, 2)),
    );
  }

  /** 测试与排障用：词典目录里实际有哪些子目录。 */
  async directories(): Promise<string[]> {
    try {
      const found = await readdir(this.dir, { withFileTypes: true });
      return found.filter((f) => f.isDirectory()).map((f) => f.name);
    } catch {
      return [];
    }
  }
}

/**
 * 清单要验形状。
 *
 * 磁盘上的东西不是我们刚写的那一份。不验就把一条 `{}` 当词典发给界面，
 * 用户点开看到一本没有名字、查不出词的词典，而没有任何东西报错。
 */
function parseIndex(value: unknown): IndexFile {
  if (typeof value !== "object" || value === null) throw new Error("不是对象");
  const raw = value as { dicts?: unknown };
  if (!Array.isArray(raw.dicts)) throw new Error("dicts 不是数组");

  const dicts = raw.dicts.map((entry): InstalledDict => {
    if (typeof entry !== "object" || entry === null) throw new Error("词典条目不是对象");
    const d = entry as Record<string, unknown>;
    if (typeof d["hash"] !== "string" || d["hash"] === "") throw new Error("缺 hash");
    if (typeof d["title"] !== "string") throw new Error("缺 title");
    if (typeof d["mdx"] !== "string" || d["mdx"] === "") throw new Error("缺 mdx");
    if (!Array.isArray(d["mdds"])) throw new Error("mdds 不是数组");
    if (typeof d["installedAt"] !== "number") throw new Error("缺 installedAt");

    return {
      hash: d["hash"],
      title: d["title"],
      mdx: d["mdx"],
      mdds: (d["mdds"] as unknown[]).map((m) => String(m)),
      installedAt: d["installedAt"],
    };
  });

  return { schema_version: SCHEMA_VERSION, dicts };
}
