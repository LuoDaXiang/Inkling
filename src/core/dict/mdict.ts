/**
 * mdict 词典的加载与查词。
 *
 * 用户自带 `.mdx` / `.mdd`，按内容哈希存到 `<data>/dictionaries/<hash>/`，
 * 由 `@divisey/js-mdict` 解析。**没有任何内容被分发**——这是词典三层里
 * 唯一法律上干净的一层（迁移计划 M4 的那张表）。预置词典（8 本，约 2.3 GB，
 * 全在版权期内）和 camdict（67 MB 来源不明的剑桥词典 sqlite）都不碰。
 *
 * ## reader 是参数传进来的
 *
 * 和 `TtsProvider` / `ScoringProvider` 同构：这一层不 import
 * `@divisey/js-mdict`，只依赖一个 `MdictReader` 接口。于是导入校验、
 * `@@@LINK=` 转跳、定义清洗这些**真正会出错的逻辑**可以不碰文件系统就测完，
 * 而「那个库能不能读真文件」由一条用真夹具的用例单独守着
 * （`tests/fixtures/test-dict.mdx`，4 个词的合成词典，无版权内容）。
 *
 * ## 参考实现那版的四个问题，这里都不重犯
 *
 * 参考实现的 `src/main/mdict.ts`（144 行）：
 *
 * 1. **`currentDictHash` 从来没有被赋值过。** 于是
 *    `mdict.hash !== this.currentDictHash` 恒为真，每查一个词都重新
 *    `new MdictReader(...)` 把整本词典重新解析一遍。它有一个 LRU(20)，
 *    但只缓存资源文件，不缓存 reader。**不报错，只是慢得莫名其妙。**
 * 2. **`@@@LINK=` 递归没有深度上限。** 两个词互相指向就是死循环。
 * 3. **`getResource` 遍历 mdd 时第一个没命中就 `return ""`**，
 *    后面的 mdd 根本轮不到——多文件词典的资源一半读不出来。
 * 4. **`import()` 复制了文件，返回的却是源路径。** 用户导入完把 U 盘拔了，
 *    查词就失败，而记录里那条词典看起来一切正常。
 */

/** `@divisey/js-mdict` 的最小接口。这一层只用到 `lookup`。 */
export interface MdictReader {
  lookup(word: string): { keyText?: string; definition?: string | null } | null;
}

/** 打开一个 `.mdx` 得到 reader。注入点。 */
export type ReaderFactory = (mdxPath: string) => MdictReader;

/** 一本已安装的词典。 */
export interface InstalledDict {
  /** `.mdx` 的内容哈希，同时也是存放目录名。 */
  hash: string;
  /** 展示用的名字，取自 `.mdx` 的文件名。 */
  title: string;
  /** `.mdx` 在词典目录里的**绝对路径**，不是用户导入时那个源路径。 */
  mdx: string;
  /**
   * 同一本词典的资源文件（图片、发音），可能有多个，也可能没有。
   *
   * **这一版只存不读。** 参考实现的 `getResource`（从 `.mdd` 里取图片和音频）
   * 没有搬——M4.1 的验收是「导入一个 .mdx，查一个词」，正文在 `.mdx` 里。
   * 存下来是因为卸载时要一并删掉，界面上也要显示「含 N 个资源文件」；
   * 写在这里是因为一个存了不用的字段，下一个人会以为资源已经读得出来。
   */
  mdds: string[];
  installedAt: number;
}

export class DictError extends Error {
  override readonly name = "DictError";
}

/**
 * `@@@LINK=` 的转跳上限。
 *
 * 参考实现没有上限，两个词互相指向就把主进程转死。真实词典里
 * 一跳（`quick` → `fast`）是常态，两跳偶见，超过三跳的没见过——
 * 与其猜一个大数字，不如定一个说得清的小数字，超了就当查不到。
 */
export const MAX_LINK_HOPS = 5;

/**
 * 挑出一次导入里的 mdx 与 mdd。
 *
 * **只允许一个 `.mdx`**：两个 mdx 是两本词典，合成一条记录之后，
 * 用户看到的是一本、查到的是另一本，而这件事没有任何东西会报错。
 */
export function classifyImport(paths: readonly string[]): { mdx: string; mdds: string[] } {
  const mdxs = paths.filter((p) => /\.mdx$/i.test(p));
  const mdds = paths.filter((p) => /\.mdd$/i.test(p));

  if (mdxs.length === 0) {
    throw new DictError("这一组文件里没有 .mdx —— 词典正文在 .mdx 里，.mdd 只是图片和音频。");
  }
  if (mdxs.length > 1) {
    throw new DictError(
      `选中了 ${mdxs.length} 个 .mdx，一次只能导入一本词典。请分开导入。`,
    );
  }
  return { mdx: mdxs[0] as string, mdds };
}

/** 从 `.mdx` 的文件名取展示用的名字。 */
export function titleFromPath(mdxPath: string): string {
  const base = mdxPath.split(/[/\\]/).pop() ?? mdxPath;
  return base.replace(/\.mdx$/i, "");
}

/**
 * 查词。
 *
 * reader 由 `factory` 按 hash 缓存——参考实现在这里每次都重新解析整本词典，
 * 因为它的 `currentDictHash` 从来没被赋值过。
 */
export class DictLookup {
  private readonly factory: ReaderFactory;
  private readonly readers = new Map<string, MdictReader>();
  private readonly maxReaders: number;

  /**
   * @param maxReaders 同时留在内存里的 reader 数。词典是大文件，
   *   一本几百兆很常见，所以默认只留 2 本——用户不会同时查五本词典。
   */
  constructor(factory: ReaderFactory, maxReaders = 2) {
    this.factory = factory;
    this.maxReaders = Math.max(1, maxReaders);
  }

  /** 查不到返回 `null`，**不返回空字符串**——「没这个词」和「有但释义是空的」是两件事。 */
  lookup(word: string, dict: InstalledDict): string | null {
    return this.resolve(word, dict, 0);
  }

  private resolve(word: string, dict: InstalledDict, hops: number): string | null {
    if (hops > MAX_LINK_HOPS) return null;

    const reader = this.readerFor(dict);
    let found: { definition?: string | null } | null;
    try {
      found = reader.lookup(word);
    } catch {
      // 词典文件坏了、格式不认识——查不到，不是崩溃。
      return null;
    }

    const definition = clean(found?.definition ?? null);
    if (definition === null) return null;

    // `@@@LINK=other` 是词典里的转跳（`quick` → `fast`）。
    if (definition.startsWith("@@@LINK=")) {
      return this.resolve(definition.slice("@@@LINK=".length).trim(), dict, hops + 1);
    }
    return definition;
  }

  private readerFor(dict: InstalledDict): MdictReader {
    const cached = this.readers.get(dict.hash);
    if (cached) {
      // 命中即刷新：Map 保持插入顺序，删掉再塞回去就是最近使用。
      this.readers.delete(dict.hash);
      this.readers.set(dict.hash, cached);
      return cached;
    }

    const reader = this.factory(dict.mdx);
    this.readers.set(dict.hash, reader);
    if (this.readers.size > this.maxReaders) {
      const oldest = this.readers.keys().next().value;
      if (oldest !== undefined) this.readers.delete(oldest);
    }
    return reader;
  }

  /** 测试与「删掉一本词典之后」用：把缓存的 reader 丢掉。 */
  forget(hash: string): void {
    this.readers.delete(hash);
  }

  /** 测试用：当前缓存了几个 reader。 */
  get cachedCount(): number {
    return this.readers.size;
  }
}

/**
 * 清洗一条释义。
 *
 * 两件事：
 *
 * - **去掉尾部的 NUL。** mdict 的记录块以 `\0` 分隔，而
 *   `@divisey/js-mdict` 不替你去掉。原样塞进 DOM 的话，
 *   末尾会多一个不可见字符——它不显示、不报错，但会跟着复制粘贴走。
 * - 全空白当成没有。空字符串和 `null` 在这一层必须合并成 `null`，
 *   否则界面要在两个地方各判断一次「有没有释义」。
 */
function clean(definition: string | null): string | null {
  if (definition === null) return null;
  const trimmed = definition.replace(/\0+$/, "").trim();
  return trimmed === "" ? null : trimmed;
}
