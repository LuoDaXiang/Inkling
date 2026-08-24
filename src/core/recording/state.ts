import { MAX_ASSESSABLE_SECONDS } from "@/core/audio/wav";

/**
 * 录音状态机。
 *
 * 写成不依赖 DOM 的纯函数，所以不需要 jsdom、不引任何测试依赖，
 * 而且能把状态 × 事件的**完整矩阵**测一遍——这是状态机唯一诚实的
 * 穷尽性证明。参考实现的录音逻辑散在三个文件里、混着 IPC 和文件系统，
 * 所以它一个测试都写不了。
 *
 * 浏览器那层只做两件事：把真实事件翻译成 Event，把 State 映射成界面。
 * 别的什么都不做。
 */

export type RecorderState =
  | "idle"
  /** 已请求麦克风权限，等用户点允许。 */
  | "requesting"
  | "recording"
  /** 录完了，采样在手上。 */
  | "done"
  /** 用户拒绝了权限，或浏览器不支持。 */
  | "denied"
  /** 设备被占用、拔掉麦克风等。 */
  | "error";

export type RecorderEvent =
  | { type: "start" }
  | { type: "granted" }
  | { type: "denied" }
  /** 收到一块采样。n 是这块的采样数。 */
  | { type: "chunk"; samples: number }
  | { type: "stop" }
  | { type: "cancel" }
  | { type: "error" };

export interface RecorderContext {
  state: RecorderState;
  /**
   * 已收到的采样数。
   *
   * **上限按采样数算，不按墙上时钟。** 两者会分叉：浏览器会挂起后台
   * 标签页的 AudioContext，采样停止流入而计时器还在走。用户切回来
   * 看到「已录 25 秒」，实际只有 8 秒音频。而评分接口在意的是音频有多长，
   * 不是用户等了多久——所以采样数才是权威。
   */
  samples: number;
  /** 到达上限自动停止时为 true，用于区分「用户停的」和「到点停的」。 */
  reachedLimit: boolean;
}

export interface RecorderConfig {
  sampleRate: number;
  /** 上限秒数。默认取评分接口能吃下的最大值。 */
  maxSeconds?: number;
}

/**
 * 音频处理开关。
 *
 * 三个全开。代价是浏览器会对信号做处理，可能削掉一些辅音细节；
 * 收益是不把环境噪声带进评分——而实测纯噪声的准确度能拿 71 分，
 * 噪声对分数的污染比处理带来的损失大得多。
 *
 * 这三个值直接送进 getUserMedia 的 audio 约束。
 */
export const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;

export function initialContext(): RecorderContext {
  return { state: "idle", samples: 0, reachedLimit: false };
}

export function maxSamples(config: RecorderConfig): number {
  return Math.floor((config.maxSeconds ?? MAX_ASSESSABLE_SECONDS) * config.sampleRate);
}

/**
 * 状态迁移。
 *
 * **非法事件一律忽略，返回原对象。** 不抛错也不进 error 状态——
 * 现实中双击一次按钮就会产生一个非法事件（recording 状态收到 start），
 * 那不是故障，是用户手快。把它当故障处理会让界面莫名其妙地红一下。
 *
 * 返回原对象（而不是等值的新对象）让调用方可以用引用比较来判断
 * 「这个事件有没有引起变化」，省掉一次无谓的重渲染。
 */
export function transition(
  context: RecorderContext,
  event: RecorderEvent,
  config: RecorderConfig,
): RecorderContext {
  switch (context.state) {
    case "idle":
      // 只有 start 有意义。stop / chunk 在这里都是迟到的残留事件——
      // 上一次录音停止后，管线里可能还有一两块采样在路上。
      return event.type === "start"
        ? { state: "requesting", samples: 0, reachedLimit: false }
        : context;

    case "requesting":
      switch (event.type) {
        case "granted":
          return { ...context, state: "recording" };
        case "denied":
          return { ...context, state: "denied" };
        case "error":
          return { ...context, state: "error" };
        // 权限对话框弹出时用户又点了取消。
        case "cancel":
          return initialContext();
        default:
          return context;
      }

    case "recording":
      switch (event.type) {
        case "chunk": {
          const samples = context.samples + event.samples;
          const limit = maxSamples(config);
          // 到点直接停，不提示。提示会打断朗读——用户一分神，
          // 这一遍的流利度就毁了，而那正是我们要测的东西。
          return samples >= limit
            ? { state: "done", samples: limit, reachedLimit: true }
            : { ...context, samples };
        }
        case "stop":
          // 一个采样都没收到就停 = 什么也没录到，回到起点而不是 done。
          // 让上层去处理一个空录音，只会多一处要防的空值。
          return context.samples === 0 ? initialContext() : { ...context, state: "done" };
        case "cancel":
          return initialContext();
        case "error":
          return { ...context, state: "error" };
        default:
          return context;
      }

    // 终态。只接受 start（重录）和 cancel（清理），其余一律忽略——
    // 尤其是 chunk：停止之后管线里的残留采样绝不能再计入。
    case "done":
    case "denied":
    case "error":
      if (event.type === "start") return { state: "requesting", samples: 0, reachedLimit: false };
      if (event.type === "cancel") return initialContext();
      return context;
  }
}

/** 界面用：现在能不能开始录。 */
export function canStart(context: RecorderContext): boolean {
  return context.state !== "requesting" && context.state !== "recording";
}

/** 界面用：已录时长，由采样数换算而来。 */
export function elapsedSeconds(context: RecorderContext, config: RecorderConfig): number {
  return context.samples / config.sampleRate;
}
