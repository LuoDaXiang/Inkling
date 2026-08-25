import type { DatabaseSync } from "node:sqlite";
import type { AssessmentResult } from "@/providers/scoring/types";

/**
 * 四张业务表的读写。
 *
 * 关于逐词明细的存法，这里做了一个**故意的冗余**：
 *
 *   - `assessment.words_json` 存 provider 返回的完整结构，是**事实来源**。
 *     将来改主意了，扁平表可以从它重建；反过来不行。
 *   - `phoneme_score` 是一张扁平表，只服务查询。
 *
 * 只存 JSON 的话，「这个用户历史上所有 /θ/ 的准确度趋势」查不出来——
 * 而 roadmap 说得很清楚，「第 3 个词的 /θ/ 念成了 /s/」才是主打维度的落脚点。
 * 只存扁平表的话，provider 将来加了新字段就丢了。所以两份都留。
 *
 * 两份必须在**同一个事务**里写，否则会出现「有总分没明细」的半截记录。
 */

export interface NewMaterial {
  title: string;
  source: string;
  createdAt: number;
}

export interface NewSentence {
  materialId: number;
  ord: number;
  text: string;
  createdAt: number;
}

/** 音频采集参数。浏览器可以无视你的 constraint，所以这里存的是回读值。 */
export interface CaptureSettings {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export interface NewRecording extends CaptureSettings {
  sentenceId: number;
  audioKey: string;
  durationMs: number;
  createdAt: number;
  /**
   * 回指 `operations` 流水（[C74]）。
   *
   * 没有它，排查「那次练习为什么失败」时从业务记录跳不到流水，
   * 而这两处正在记录同一次调用。
   */
  traceId?: string;
}

export interface NewAssessment {
  recordingId: number;
  engine: string;
  result: AssessmentResult;
  createdAt: number;
  /**
   * 这次评分可不可信（[C34]）。`unreliable` 落库时为 false。
   *
   * 趋势曲线必须默认过滤掉不可信的记录，否则被噪声污染——
   * 纯白噪声的准确度是 71 分，**而这件事发生时没有任何征兆**。
   */
  reliable?: boolean;
}

export interface PhonemeHistoryRow {
  assessmentId: number;
  word: string;
  wordIndex: number;
  accuracy: number;
  createdAt: number;
}

export function insertMaterial(db: DatabaseSync, input: NewMaterial): number {
  const result = db
    .prepare("INSERT INTO material (title, source, created_at) VALUES (?, ?, ?)")
    .run(input.title, input.source, input.createdAt);
  return Number(result.lastInsertRowid);
}

export function insertSentence(db: DatabaseSync, input: NewSentence): number {
  const result = db
    .prepare("INSERT INTO sentence (material_id, ord, text, created_at) VALUES (?, ?, ?, ?)")
    .run(input.materialId, input.ord, input.text, input.createdAt);
  return Number(result.lastInsertRowid);
}

export function insertRecording(db: DatabaseSync, input: NewRecording): number {
  const result = db
    .prepare(`
      INSERT INTO recording
        (sentence_id, audio_key, duration_ms,
         echo_cancellation, noise_suppression, auto_gain_control, created_at, trace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.sentenceId,
      input.audioKey,
      input.durationMs,
      // 三态：开 / 关 / 不知道。浏览器读不到就是 null，不能默认成 false。
      toFlag(input.echoCancellation),
      toFlag(input.noiseSuppression),
      toFlag(input.autoGainControl),
      input.createdAt,
      input.traceId ?? null,
    );
  return Number(result.lastInsertRowid);
}

/** 总分 + 完整 JSON + 扁平音素明细，一个事务写完。 */
export function insertAssessment(db: DatabaseSync, input: NewAssessment): number {
  return withTransaction(db, () => insertAssessmentRows(db, input));
}

/**
 * 不带事务的版本。
 *
 * `persistPractice()` 要把 recording 和它一起包进**同一个**事务，而 SQLite
 * 不支持嵌套事务——在 withTransaction 里再 BEGIN 会直接抛。所以事务边界
 * 必须由最外层决定，这里只负责写行。
 */
function insertAssessmentRows(db: DatabaseSync, input: NewAssessment): number {
  {
    const { result } = input;
    const inserted = db
      .prepare(`
        INSERT INTO assessment
          (recording_id, engine, accuracy, fluency, completeness, prosody,
           overall, recognized, snr, words_json, created_at, reliable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.recordingId,
        input.engine,
        result.scores.accuracy,
        result.scores.fluency,
        result.scores.completeness,
        // prosody 可能缺席——音频被截断、参考文本无效时它直接不出现。
        result.scores.prosody ?? null,
        result.scores.overall,
        result.recognized,
        result.snr ?? null,
        JSON.stringify(result.words),
        input.createdAt,
        // [C73]：走 toFlag() 而不是直接绑 JS boolean。F17 记录了
        // node:sqlite 的布尔绑定行为随 Node 版本变，已实测到差异。
        toFlag(input.reliable),
      );

    const assessmentId = Number(inserted.lastInsertRowid);
    const phoneme = db.prepare(`
      INSERT INTO phoneme_score (assessment_id, word_index, word, phoneme, accuracy)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const [wordIndex, word] of result.words.entries()) {
      for (const p of word.phonemes) {
        phoneme.run(assessmentId, wordIndex, word.word, p.phoneme, p.accuracy);
      }
    }

    return assessmentId;
  }
}

/**
 * 一次练习的完整落库：`recording` +（可选的）`assessment` + `phoneme_score`，
 * **一个事务**。
 *
 * `assessment` 可缺席：服务识别不到语音时这次没有分数，但**调用已经发生、
 * 钱已经花了**，所以录音仍然要留痕（[C33]）——用户可以回放确认自己到底录了什么。
 *
 * 注意这个函数**不写音频文件**。文件系统不参与 SQLite 事务，落盘必须在
 * 调用它之前完成，顺序见 [C67]：先写文件、后写库。反过来会产生悬空引用——
 * 记录看起来完全正常，读音频 404。宁可留孤儿文件。
 */
export function persistPractice(
  db: DatabaseSync,
  input: {
    recording: NewRecording;
    assessment?: Omit<NewAssessment, "recordingId">;
  },
): { recordingId: number; assessmentId?: number } {
  return withTransaction(db, () => {
    const recordingId = insertRecording(db, input.recording);
    if (!input.assessment) return { recordingId };
    const assessmentId = insertAssessmentRows(db, { recordingId, ...input.assessment });
    return { recordingId, assessmentId };
  });
}

/** 查一条录音的音频键。`GET /api/recordings/{id}/audio` 用它。 */
export function getRecordingAudioKey(db: DatabaseSync, id: number): string | null {
  const row = db
    .prepare("SELECT audio_key FROM recording WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? String(row["audio_key"]) : null;
}

/**
 * 某个音素的历史表现。
 *
 * 这个查询就是双写存在的理由——只存 JSON 的话它写不出来。
 */
export function phonemeHistory(db: DatabaseSync, phoneme: string): PhonemeHistoryRow[] {
  const rows = db
    .prepare(`
      SELECT p.assessment_id, p.word, p.word_index, p.accuracy, a.created_at
      FROM phoneme_score p
      JOIN assessment a ON a.id = p.assessment_id
      WHERE p.phoneme = ?
      ORDER BY a.created_at, p.id
    `)
    .all(phoneme);

  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      assessmentId: Number(r["assessment_id"]),
      word: String(r["word"]),
      wordIndex: Number(r["word_index"]),
      accuracy: Number(r["accuracy"]),
      createdAt: Number(r["created_at"]),
    };
  });
}

/** 从 words_json 取回完整结构。扁平表丢掉的字段（errorType、monotone）在这里。 */
export function readWords(db: DatabaseSync, assessmentId: number): AssessmentResult["words"] {
  const row = db
    .prepare("SELECT words_json FROM assessment WHERE id = ?")
    .get(assessmentId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`assessment ${assessmentId} 不存在`);
  return JSON.parse(String(row["words_json"])) as AssessmentResult["words"];
}

/**
 * 事务包装。
 *
 * SQLite 不支持真正的嵌套事务，只有 SAVEPOINT。这里不做嵌套——
 * 重入会静默产生错误的提交边界，宁可让它抛。
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function toFlag(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * 材料与句子的读取
 *
 * 注意这里**不计算 `assessable`**。那是契约层的概念（[C16]：判据是
 * `text.length <= maxReferenceChars`，而且 [C17] 说明它的取值将来会变），
 * 由 `http/` 在出口处附加。存储层只管存了什么，不管契约怎么解释它。
 * ------------------------------------------------------------------ */

/** 一条句子的原始形态。`assessable` 由 HTTP 层附加。 */
export interface SentenceRow {
  id: number;
  ord: number;
  text: string;
}

export interface MaterialSummary {
  id: number;
  title: string;
  source: string;
  createdAtMs: number;
  sentenceCount: number;
}

export interface MaterialDetail extends Omit<MaterialSummary, "sentenceCount"> {
  sentences: SentenceRow[];
}

export interface NewMaterialWithSentences {
  title: string;
  source: string;
  /** 已经分好的句子，顺序即 `ord`。 */
  texts: readonly string[];
  createdAt: number;
}

/**
 * 建材料并写入全部句子，**一个事务**。
 *
 * 不做去重：同一段文本建两次会产生两个 material，这是刻意的（[C19]）——
 * 同一篇文章练两遍是合法需求。重复的句子不会重复付 TTS 的钱，
 * 因为音频缓存按内容寻址（决策 0004）已经解决了那个问题。
 */
export function createMaterial(
  db: DatabaseSync,
  input: NewMaterialWithSentences,
): { materialId: number; sentences: SentenceRow[] } {
  return withTransaction(db, () => {
    const materialId = insertMaterial(db, {
      title: input.title,
      source: input.source,
      createdAt: input.createdAt,
    });

    const sentences: SentenceRow[] = input.texts.map((text, ord) => ({
      id: insertSentence(db, { materialId, ord, text, createdAt: input.createdAt }),
      ord,
      text,
    }));

    return { materialId, sentences };
  });
}

/** 材料列表，按 id 降序（[C8]：排序永远用 id，不用时间戳）。 */
export function listMaterials(db: DatabaseSync, limit: number): MaterialSummary[] {
  const rows = db
    .prepare(`
      SELECT m.id, m.title, m.source, m.created_at,
             (SELECT COUNT(*) FROM sentence s WHERE s.material_id = m.id) AS sentence_count
      FROM material m
      ORDER BY m.id DESC
      LIMIT ?
    `)
    .all(limit);

  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: Number(r["id"]),
      title: String(r["title"]),
      source: String(r["source"]),
      createdAtMs: Number(r["created_at"]),
      sentenceCount: Number(r["sentence_count"]),
    };
  });
}

/** 一份材料的全部句子。不存在返回 null，由调用方翻译成 404。 */
export function getMaterial(db: DatabaseSync, id: number): MaterialDetail | null {
  const head = db
    .prepare("SELECT id, title, source, created_at FROM material WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!head) return null;

  const rows = db
    .prepare("SELECT id, ord, text FROM sentence WHERE material_id = ? ORDER BY ord")
    .all(id);

  return {
    id: Number(head["id"]),
    title: String(head["title"]),
    source: String(head["source"]),
    createdAtMs: Number(head["created_at"]),
    sentences: rows.map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: Number(r["id"]), ord: Number(r["ord"]), text: String(r["text"]) };
    }),
  };
}

/** 查一条句子。`POST /api/assess` 用它把 sentenceId 换成参考文本（[C25]）。 */
export function getSentence(
  db: DatabaseSync,
  id: number,
): { id: number; materialId: number; text: string } | null {
  const row = db
    .prepare("SELECT id, material_id, text FROM sentence WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: Number(row["id"]),
    materialId: Number(row["material_id"]),
    text: String(row["text"]),
  };
}
