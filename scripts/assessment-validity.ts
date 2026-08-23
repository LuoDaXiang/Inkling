/**
 * 评分效度测量（M02）。
 *
 *   npm run validity -- --n 100 --min-age 16
 *
 * 回答一个问题：**Azure 的发音评分，和人类专家的判断有多一致？**
 *
 * 用 speechocean762 数据集。它的价值在于每一条都由 5 位语言专家独立打分、
 * 取平均作为真值，而且说话人全是母语为普通话的英语学习者——和本项目的
 * 目标用户是同一个人群。数据集的五个维度与 Azure 返回的五个一一对应。
 *
 *   数据集    accuracy  fluency  prosodic  completeness  total    0–10
 *   Azure     Accuracy  Fluency  Prosody   Completeness  Pron     0–100
 *
 * 这比「自己录五段、凭耳朵排序」强的地方：n 从 5 变成几百，主观印象变成
 * 相关系数，而且用的是这个领域的标准基准。
 *
 * 相关系数的读法（社会科学惯例，发音评测论文也用这个尺度）：
 *   > 0.7   强，可以放心拿来给用户看
 *   0.5–0.7 中等，能用，但要在界面上弱化单次分数、强调趋势
 *   < 0.5   弱，这个维度不该单独展示
 *
 * 结果落到 data/validity/ 下的 JSON，重跑分析不必重新花钱。
 *
 * 成本：约每 100 条 $0.2（Azure 发音评估按音频时长计费）。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWav } from "@/core/audio/wav";

const KEY = need("AZURE_SPEECH_KEY");
const REGION = need("AZURE_SPEECH_REGION");

const DATASET = "mispeech/speechocean762";
const ROWS_API = "https://datasets-server.huggingface.co/rows";

/** 五个维度的名字，数据集侧 → Azure 侧。 */
const DIMENSIONS = [
  { label: "准确度", expert: "accuracy", azure: "AccuracyScore" },
  { label: "流利度", expert: "fluency", azure: "FluencyScore" },
  { label: "语调", expert: "prosodic", azure: "ProsodyScore" },
  { label: "完整度", expert: "completeness", azure: "CompletenessScore" },
  { label: "总分", expert: "total", azure: "PronScore" },
] as const;

interface DatasetRow {
  text: string;
  accuracy: number;
  fluency: number;
  prosodic: number;
  completeness: number;
  total: number;
  speaker: string;
  gender: string;
  age: number;
  audio: Array<{ src: string }>;
}

interface Scored {
  text: string;
  speaker: string;
  age: number;
  seconds: number;
  expert: Record<string, number>;
  azure: Record<string, number>;
}

// ---------------------------------------------------------------- 统计

/** 皮尔逊相关：两组数值线性相关的强度。对量纲不敏感，0–10 对 0–100 无需归一化。 */
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = (xs[i] as number) - mx;
    const b = (ys[i] as number) - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? NaN : num / den;
}

/**
 * 斯皮尔曼相关：只看排序，不看数值间距。
 *
 * 对本项目比皮尔逊更贴切——用户关心的是「这次比上次好吗」，
 * 而不是「分数差了几分」。专家打的 0–10 整数分本身也是序数量表。
 */
function spearman(xs: number[], ys: number[]): number {
  return pearson(rank(xs), rank(ys));
}

/** 平均秩，并列取中间值。 */
function rank(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]!.i] = shared;
    i = j + 1;
  }
  return out;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

// ---------------------------------------------------------------- 取数

async function fetchRows(offset: number, length: number): Promise<DatasetRow[]> {
  const url =
    `${ROWS_API}?dataset=${encodeURIComponent(DATASET)}` +
    `&config=default&split=test&offset=${offset}&length=${length}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`数据集接口返回 ${res.status}`);
  const json = (await res.json()) as { rows: Array<{ row: DatasetRow }> };
  return json.rows.map((r) => r.row);
}

/** test 切分一共这么多条。元数据全拉一遍不花钱，只有音频和 Azure 才花钱。 */
const TEST_SIZE = 2500;

async function fetchAllRows(): Promise<DatasetRow[]> {
  const all: DatasetRow[] = [];
  for (let offset = 0; offset < TEST_SIZE; offset += 100) {
    all.push(...(await fetchRows(offset, 100)));
    process.stdout.write(`  拉取元数据 ${all.length}/${TEST_SIZE}\r`);
  }
  process.stdout.write(" ".repeat(40) + "\r");
  return all;
}

/**
 * 按专家总分分层抽样。
 *
 * 第一次跑的时候按顺序取前 20 个成人，结果专家分只有 7/8/9/10 四个取值，
 * completeness 更是全部 10 分——方差为零，相关系数无定义。
 *
 * 这是取值范围压扁（range restriction）：样本在真值上没有差异时，
 * 相关系数会被系统性地压向 0，此时算出来的低相关**不能**解读成
 * 「评分不准」，它只说明这批样本选坏了。
 *
 * 分层抽样按总分把候选分组，每组取同样多条，保证覆盖整个分数段。
 */
function stratify(rows: DatasetRow[], n: number): DatasetRow[] {
  const byScore = new Map<number, DatasetRow[]>();
  for (const row of rows) {
    const bucket = byScore.get(row.total) ?? [];
    bucket.push(row);
    byScore.set(row.total, bucket);
  }

  const scores = [...byScore.keys()].sort((a, b) => a - b);
  const perBucket = Math.ceil(n / scores.length);
  const picked: DatasetRow[] = [];

  for (const score of scores) {
    const bucket = byScore.get(score) as DatasetRow[];
    // 每档内部按说话人打散，避免同一个人贡献一整档
    shuffle(bucket);
    picked.push(...bucket.slice(0, perBucket));
  }

  console.log(
    `  分层：${scores.map((s) => `${s}分 ${Math.min(perBucket, byScore.get(s)!.length)}条`).join(" · ")}`,
  );
  shuffle(picked);
  return picked.slice(0, n);
}

/** 固定种子的洗牌，保证同样参数跑两次抽到同一批，结果可复现。 */
function shuffle<T>(items: T[]): void {
  let seed = 42;
  for (let i = items.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
}

const ENDPOINT =
  `https://${REGION}.stt.speech.microsoft.com` +
  `/speech/recognition/conversation/cognitiveservices/v1?language=en-US`;

async function assess(audio: Uint8Array, reference: string) {
  const config = {
    ReferenceText: reference,
    GradingSystem: "HundredMark",
    Granularity: "Phoneme",
    Dimension: "Comprehensive",
    EnableProsodyAssessment: "True",
  };

  // 429 要退避重试。批量跑几百条一定会撞上限流。
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": KEY,
        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
        "Pronunciation-Assessment": Buffer.from(JSON.stringify(config)).toString("base64"),
        Accept: "application/json",
      },
      body: Buffer.from(audio),
    });

    if (res.status === 429) {
      const wait = 2 ** attempt * 1000;
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Azure ${res.status}: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text) as {
      RecognitionStatus: string;
      NBest?: Array<Record<string, number>>;
    };
    // 识别失败（比如整句听不清）不是错误，是一条要如实计入的结果。
    if (parsed.RecognitionStatus !== "Success" || !parsed.NBest?.[0]) return null;
    return parsed.NBest[0];
  }
  throw new Error("限流退避四次仍未成功");
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(
    `\n评分效度测量  数据集 ${DATASET} · test 切分\n` +
      `目标 ${args.n} 条` +
      (args.minAge > 0 ? ` · 只取 ${args.minAge} 岁以上（数据集一半是儿童）` : "") +
      `\n`,
  );

  const scored: Scored[] = [];
  const skipped = { tooYoung: 0, notRecognized: 0, badAudio: 0 };

  const all = await fetchAllRows();
  const eligible = all.filter((r) => {
    if (r.age < args.minAge) {
      skipped.tooYoung++;
      return false;
    }
    return true;
  });
  console.log(`  候选 ${eligible.length} 条（共 ${all.length}）`);
  const sample = stratify(eligible, args.n);
  console.log("");

  {
    for (const row of sample) {
      const src = row.audio[0]?.src;
      if (!src) continue;
      const audio = new Uint8Array(await (await fetch(src)).arrayBuffer());

      let seconds: number;
      try {
        const info = parseWav(audio);
        // 数据集音频本身就是 16k/mono/16bit，这里是防御性校验：
        // 万一将来换数据源，格式不对必须当场发现，而不是让分数悄悄偏低。
        if (info.sampleRate !== 16000 || info.channels !== 1) {
          skipped.badAudio++;
          continue;
        }
        seconds = info.duration;
      } catch {
        skipped.badAudio++;
        continue;
      }

      const result = await assess(audio, row.text);
      if (!result) {
        skipped.notRecognized++;
        continue;
      }

      scored.push({
        text: row.text,
        speaker: row.speaker,
        age: row.age,
        seconds,
        expert: {
          accuracy: row.accuracy,
          fluency: row.fluency,
          prosodic: row.prosodic,
          completeness: row.completeness,
          total: row.total,
        },
        azure: Object.fromEntries(
          DIMENSIONS.map((d) => [d.azure, result[d.azure] ?? NaN]),
        ),
      });

      if (scored.length % 10 === 0) {
        process.stdout.write(`  已评 ${scored.length}/${sample.length}\r`);
      }
    }
  }

  report(scored, skipped);

  const dir = join(process.cwd(), "data", "validity");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`);
  await writeFile(file, JSON.stringify({ dataset: DATASET, args, skipped, scored }, null, 2));
  console.log(`\n明细已存 ${file}\n`);
}

function report(scored: Scored[], skipped: Record<string, number>): void {
  const totalSeconds = scored.reduce((a, s) => a + s.seconds, 0);
  console.log(
    `\n有效样本 ${scored.length} 条 · 音频 ${(totalSeconds / 60).toFixed(1)} 分钟 · ` +
      `约 $${((totalSeconds / 3600) * 1.32).toFixed(2)}`,
  );
  console.log(
    `跳过：未达年龄 ${skipped.tooYoung ?? 0} · 识别失败 ${skipped.notRecognized ?? 0} · ` +
      `格式不符 ${skipped.badAudio ?? 0}\n`,
  );

  const w = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - width(s)));
  console.log(
    w("维度", 10) + w("皮尔逊", 10) + w("斯皮尔曼", 12) + w("专家均分", 11) + w("Azure均分", 11) + "判读",
  );
  console.log("─".repeat(66));

  for (const d of DIMENSIONS) {
    const pairs = scored
      .map((s) => [s.expert[d.expert] as number, s.azure[d.azure] as number] as const)
      .filter(([e, a]) => Number.isFinite(e) && Number.isFinite(a));
    const xs = pairs.map((p) => p[0]);
    const ys = pairs.map((p) => p[1]);

    const p = pearson(xs, ys);
    const sp = spearman(xs, ys);
    console.log(
      w(d.label, 10) +
        w(fmt(p), 10) +
        w(fmt(sp), 12) +
        // 专家分乘 10 拉到同一量纲，方便看系统性偏高还是偏低
        w((mean(xs) * 10).toFixed(1), 11) +
        w(mean(ys).toFixed(1), 11) +
        verdict(sp),
    );
  }

  console.log(
    "\n判读尺度：>0.7 强 · 0.5–0.7 中等 · <0.5 弱。\n" +
      "斯皮尔曼比皮尔逊更贴合本项目——用户关心「这次比上次好吗」，不是「差几分」。\n" +
      "专家均分已乘 10 拉到 Azure 的量纲，两列差得多说明存在系统性偏高或偏低。",
  );
}

const fmt = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "—");

function verdict(r: number): string {
  if (!Number.isFinite(r)) return "无数据";
  if (r > 0.7) return "强";
  if (r >= 0.5) return "中等";
  return "弱 ⚠️";
}

/** 中日韩字符占两格，表格对齐要按显示宽度算。 */
function width(s: string): number {
  let n = 0;
  for (const ch of s) n += /[一-鿿　-〿＀-￯]/.test(ch) ? 2 : 1;
  return n;
}

function parseArgs(): { n: number; minAge: number } {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: number): number => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return fallback;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) ? v : fallback;
  };
  return { n: get("n", 50), minAge: get("min-age", 0) };
}

function need(name: string): string {
  const v = process.env[name];
  if (!v?.trim()) {
    console.error(`\n缺少 ${name}。先 cp .env.example .env.local 并填写。\n`);
    process.exit(1);
  }
  return v.trim();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

await main();
