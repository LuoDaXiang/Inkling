import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 造一个**合成的** MDX v2 词典，给 mdict 加载器的用例当夹具。
 *
 *   npx tsx scripts/make-test-mdx.ts
 *
 * ## 为什么要自己造
 *
 * `@divisey/js-mdict` 的测试词典要从百度网盘下载，仓库里没有；
 * 而现成的 `.mdx` 词典（Collins、Longman、Oxford）**全在版权期内**——
 * 往仓库里塞一本就是 M4.4 明说不做的那件事。
 *
 * 没有夹具的话，M4.1 的验收「导入一个 `.mdx`，查一个词」就只能靠一个
 * 假的 reader 走过场：那验的是我们自己的代码，验不了「这个库真的能读文件」。
 * 造一本 4 个词的合成词典，两件事就都验得到，而且**可复现、无版权**。
 *
 * ## 格式
 *
 * MDX v2.0，UTF-8，不加密，zlib 压缩。字节布局照着
 * `node_modules/@divisey/js-mdict/src/mdictbase.js` 的读取顺序写：
 *
 * ```
 * uint32BE  header 长度
 * bytes     header（UTF-16LE 的 XML，以 \x00\x00 结尾）
 * uint32    header 的 adler32（读取方跳过，但位置要占住）
 * 5×uint64BE  keyBlocksNum / entriesNum / kbInfo 解压后大小 / kbInfo 压缩后大小 / keyBlocks 总大小
 * uint32    校验和（读取方跳过）
 * bytes     key block info：0x02000000 + adler32 + zlib(...)
 * bytes     key blocks：每块 0x02000000 + adler32 + zlib(...)
 * 4×uint64BE  recordBlocksNum / entriesNum / recordInfo 大小 / recordBlocks 总大小
 * bytes     record info：每块 [uint64 压缩后][uint64 解压后]
 * bytes     record blocks：每块 0x02000000 + adler32 + zlib(...)
 * ```
 *
 * **词条必须按 key 排序**：读取方靠 `firstKey` / `lastKey` 做二分定位，
 * 乱序的话查不到，而且不报错——它只会告诉你「没这个词」。
 */

/** 四个词条。定义里刻意放了一条 `@@@LINK=`，用来测转跳。 */
const ENTRIES: Array<[string, string]> = [
  ["ask", "<div>ask — to say something in order to get an answer</div>"],
  ["fast", "<div>fast — moving or able to move quickly</div>"],
  ["quick", "@@@LINK=fast"],
  ["think", "<div>think — to have a particular idea or opinion</div>"],
];

const HEADER_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  "<Dictionary " +
  'GeneratedByEngineVersion="2.0" ' +
  'RequiredEngineVersion="2.0" ' +
  'Encrypted="No" ' +
  'Encoding="UTF-8" ' +
  'Format="Html" ' +
  'CreationDate="2026-08-30" ' +
  'Compact="No" ' +
  'Compat="No" ' +
  'KeyCaseSensitive="No" ' +
  'StripKey="Yes" ' +
  'Description="Inkling 合成测试词典 —— 4 个词，无版权内容" ' +
  'Title="Inkling Test Dict" ' +
  'DataSourceFormat="106" ' +
  'StyleSheet=""/>\n';

/** adler32。读取方目前跳过校验，但字节位置必须占住。 */
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32be(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

function u16be(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value, 0);
  return out;
}

function u64be(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value), 0);
  return out;
}

/** 一个压缩块：4 字节压缩类型 + 4 字节 adler32 + zlib 数据。 */
function block(raw: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x00]),
    u32be(adler32(raw)),
    deflateSync(raw),
  ]);
}

function build(): Buffer {
  // 排序：读取方靠 firstKey / lastKey 二分，乱序查不到且不报错。
  const entries = [...ENTRIES].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // ---- record block（全部塞进一块，够用了）----
  const records: Buffer[] = [];
  const offsets: number[] = [];
  let recordOffset = 0;
  for (const [, definition] of entries) {
    offsets.push(recordOffset);
    const bytes = Buffer.concat([Buffer.from(definition, "utf8"), Buffer.from([0])]);
    records.push(bytes);
    recordOffset += bytes.length;
  }
  const recordRaw = Buffer.concat(records);
  const recordBlock = block(recordRaw);

  // ---- key block（同样一块）----
  const keyParts: Buffer[] = [];
  entries.forEach(([key], i) => {
    keyParts.push(u64be(offsets[i] as number));
    keyParts.push(Buffer.from(key, "utf8"));
    keyParts.push(Buffer.from([0]));
  });
  const keyRaw = Buffer.concat(keyParts);
  const keyBlock = block(keyRaw);

  // ---- key block info ----
  const firstKey = Buffer.from(entries[0]![0], "utf8");
  const lastKey = Buffer.from(entries[entries.length - 1]![0], "utf8");
  const kbInfoRaw = Buffer.concat([
    u64be(entries.length),
    u16be(firstKey.length),
    firstKey,
    Buffer.from([0]),
    u16be(lastKey.length),
    lastKey,
    Buffer.from([0]),
    u64be(keyBlock.length),
    u64be(keyRaw.length),
  ]);
  const kbInfo = block(kbInfoRaw);

  // ---- header ----
  const headerBytes = Buffer.concat([
    Buffer.from(HEADER_XML, "utf16le"),
    Buffer.from([0, 0]),
  ]);

  // ---- record header + info ----
  const recordInfo = Buffer.concat([u64be(recordBlock.length), u64be(recordRaw.length)]);

  return Buffer.concat([
    u32be(headerBytes.length),
    headerBytes,
    u32be(adler32(headerBytes)),

    u64be(1), // key blocks
    u64be(entries.length), // entries
    u64be(kbInfoRaw.length), // kbInfo 解压后
    u64be(kbInfo.length), // kbInfo 压缩后（含 8 字节前缀）
    u64be(keyBlock.length), // key blocks 总大小
    u32be(0), // 校验和，读取方跳过

    kbInfo,
    keyBlock,

    u64be(1), // record blocks
    u64be(entries.length),
    u64be(recordInfo.length),
    u64be(recordBlock.length),

    recordInfo,
    recordBlock,
  ]);
}

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "fixtures",
  "test-dict.mdx",
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, build());
console.log(`写好了 ${out}（${build().length} 字节，${ENTRIES.length} 个词条）`);
