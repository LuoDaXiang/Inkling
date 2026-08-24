import type { AssessmentResult, ScoringProvider } from "@/providers/scoring/types";
import { ServiceError, toServiceError } from "@/core/errors";
import { looksLikeSpeech } from "@/providers/scoring/parse";

/**
 * 评分编排层：校验 → 调 provider → 判断结果可不可信 → 带重试。
 *
 * 和 synthesize() 同构：不知道用的是哪家服务，provider 是参数传进来的，
 * 所以能在不联网的情况下被完整测试。
 *
 * 两处刻意与 TTS 不同：
 *
 *   1. **没有缓存**。评分的输入是每次都不同的录音，缓存永远不会命中。
 *      见 docs/decisions.md 0015。
 *
 *   2. **有重试**。TTS 失败了用户可以再点一次按钮，代价只是等待；
 *      评分失败意味着**那一遍朗读白读了**，用户得重新录。所以这里
 *      值得自动重试可重试的失败，而 synthesize() 不需要。
 */

/** 评分结果的三种走向。调用方必须处理全部三种。 */
export type AssessOutcome =
  | { kind: "scored"; result: AssessmentResult }
  /**
   * 服务端识别到了语音，但各项指标显示这段录音不像是在读参考文本——
   * 典型情况是背景噪声。实测纯白噪声的准确度是 71 分，光看那一项
   * 会当成「读得还行」呈现给用户。
   */
  | { kind: "unreliable"; result: AssessmentResult }
  /** 完全没识别到语音：静音、太短、非语音。 */
  | { kind: "no_speech" };

export interface AssessRequest {
  audio: Uint8Array;
  reference: string;
}

export interface AssessDeps {
  provider: ScoringProvider;
  /** 重试次数，不含首次。默认 2，即最多请求 3 次。 */
  maxRetries?: number;
  /** 注入点：测试用它跳过真实等待。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 退避基数。第 n 次重试等 BACKOFF_MS × 2^(n-1)。 */
const BACKOFF_MS = 500;
const DEFAULT_MAX_RETRIES = 2;

export async function assess(
  request: AssessRequest,
  deps: AssessDeps,
): Promise<AssessOutcome> {
  const { provider } = deps;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = deps.sleep ?? defaultSleep;

  // 循环没有终止条件，退出只靠内部的 return 和 throw。
  //
  // 那种写法会留下一行永远走不到的代码——判据二要求「未覆盖的分支
  // 要么补测试，要么说明为什么不该存在」，而最好的处置是**让它不存在**：
  // 不可达代码写不出测试，也就没有东西能保证它是对的。
  // 这样写之后，每条路径都以 return 或 throw 结束，类型自然收敛。
  for (let attempt = 0; ; attempt++) {
    try {
      // provider 负责校验音频与参考文本，并在不合格时抛错。
      // 这些错误不该重试——输入不会因为再试一次就变合格。
      const result = await provider.assess(request);

      if (result === null) return { kind: "no_speech" };

      // 识别成功不等于结果可信。单个维度不能单独信：
      // 纯白噪声的准确度 71 分，靠流利度 13 和总分 32.7 才看得出不对。
      return looksLikeSpeech(result)
        ? { kind: "scored", result }
        : { kind: "unreliable", result };
    } catch (err) {
      const error = toServiceError(err, `${provider.engine} 评分失败`);

      // 不可重试的失败立刻抛出。重试一个 auth 错误只会更快耗尽额度。
      // 最后一次尝试失败后也不再等待——用户已经在等了，而我们已经放弃。
      if (!error.retryable || attempt >= maxRetries) throw error;

      await sleep(BACKOFF_MS * 2 ** attempt);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 重试语义的说明，供调用方与测试共享，避免两边各写各的。 */
export const RETRY = { baseMs: BACKOFF_MS, defaultMaxRetries: DEFAULT_MAX_RETRIES } as const;

export { ServiceError };
