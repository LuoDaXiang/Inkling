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
}

export interface NewAssessment {
  recordingId: number;
  engine: string;
  result: AssessmentResult;
  createdAt: number;
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
         echo_cancellation, noise_suppression, auto_gain_control, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
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
    );
  return Number(result.lastInsertRowid);
}

/** 总分 + 完整 JSON + 扁平音素明细，一个事务写完。 */
export function insertAssessment(db: DatabaseSync, input: NewAssessment): number {
  return withTransaction(db, () => {
    const { result } = input;
    const inserted = db
      .prepare(`
        INSERT INTO assessment
          (recording_id, engine, accuracy, fluency, completeness, prosody,
           overall, recognized, snr, words_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  });
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
