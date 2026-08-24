import type {
  AssessmentRequest,
  AssessmentResult,
  ScoringProvider,
} from "@/providers/scoring/types";
import { ServiceError } from "@/core/errors";

/**
 * 假的评分 provider。
 *
 * 编排层的每一条决策路径都能靠它在不联网的前提下走到：
 * 正常评分、没识别到语音、各类失败、失败后重试成功。
 */
export interface FakeScoringOptions {
  /** 按顺序返回。用完之后重复最后一项。 */
  results?: Array<AssessmentResult | null | Error>;
  maxSeconds?: number;
  maxReferenceChars?: number;
}

export class FakeScoringProvider implements ScoringProvider {
  readonly engine = "fake";
  readonly maxSeconds: number;
  readonly maxReferenceChars: number;

  /** 测试用：记录每次调用，断言重试次数与传入内容。 */
  readonly calls: AssessmentRequest[] = [];

  private readonly queue: Array<AssessmentResult | null | Error>;

  constructor(options: FakeScoringOptions = {}) {
    this.queue = options.results ?? [scores()];
    this.maxSeconds = options.maxSeconds ?? 30;
    this.maxReferenceChars = options.maxReferenceChars ?? 900;
  }

  async assess(request: AssessmentRequest): Promise<AssessmentResult | null> {
    this.calls.push(request);
    const item =
      this.queue.length > 1 ? this.queue.shift()! : (this.queue[0] ?? null);
    if (item instanceof Error) throw item;
    return item;
  }
}

/** 造一份评分结果。默认是「读得不错」，传参覆盖单项。 */
export function scores(
  overrides: Partial<AssessmentResult["scores"]> = {},
): AssessmentResult {
  return {
    scores: {
      accuracy: 96,
      fluency: 100,
      completeness: 100,
      prosody: 91,
      overall: 95.6,
      ...overrides,
    },
    words: [
      {
        word: "The",
        accuracy: 80,
        errorType: "None",
        phonemes: [{ phoneme: "dh", accuracy: 67 }],
        monotone: 0.31,
      },
    ],
    recognized: "The quick brown fox.",
    snr: 38.7,
  };
}

/**
 * 纯白噪声的真实分数形态。
 *
 * 实测：3 秒白噪声拿到准确度 71、流利度 13、语调 5.2、总分 32.7。
 * 准确度比及格线还高——这就是「单个维度不能单独信」的来源。
 */
export function noiseScores(): AssessmentResult {
  return scores({ accuracy: 71, fluency: 13, prosody: 5.2, completeness: 69, overall: 32.7 });
}

export const err = (kind: ConstructorParameters<typeof ServiceError>[0], message = kind) =>
  new ServiceError(kind, message);
