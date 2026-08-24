import { describe, test, expect } from "vitest";
import {
  transition,
  initialContext,
  maxSamples,
  canStart,
  elapsedSeconds,
  AUDIO_CONSTRAINTS,
  type RecorderState,
  type RecorderEvent,
  type RecorderContext,
} from "@/core/recording/state";
import { MAX_ASSESSABLE_SECONDS } from "@/core/audio/wav";

/**
 * 输入空间分类（判据一，见 docs/decisions.md 0006）
 *
 *   A. 完整矩阵 —— 6 个状态 × 7 种事件 = 42 格，每一格都有定义
 *   B. 正常路径 —— idle → requesting → recording → done
 *   C. 失败分支 —— 权限被拒、设备出错
 *   D. 上限 —— 按采样数到点自动停
 *   E. 取消与重录
 *   F. 派生量 —— canStart、elapsedSeconds、配置常量
 *
 * **A 组是这个文件的核心。** 状态机的穷尽性没法靠「我想了想觉得够了」
 * 来论证——只有把矩阵的每一格都写出来，才能说清楚「为什么这些类是穷尽的」。
 * 42 格全部覆盖，就没有任何组合是没想过的。
 *
 * 写成纯函数的回报也在这里：不需要 jsdom、不需要 testing-library、
 * 不引任何依赖，就能把状态机测透。参考实现的录音逻辑散在三个文件里、
 * 混着 IPC 和文件系统，所以它一个测试都写不了。
 */

const CONFIG = { sampleRate: 16000 };
const LIMIT = maxSamples(CONFIG);

const at = (state: RecorderState, samples = 0): RecorderContext => ({
  state,
  samples,
  reachedLimit: false,
});

const step = (ctx: RecorderContext, event: RecorderEvent): RecorderContext =>
  transition(ctx, event, CONFIG);

describe("A. 状态 × 事件完整矩阵", () => {
  const STATES: RecorderState[] = ["idle", "requesting", "recording", "done", "denied", "error"];
  const EVENTS: RecorderEvent[] = [
    { type: "start" },
    { type: "granted" },
    { type: "denied" },
    { type: "chunk", samples: 128 },
    { type: "stop" },
    { type: "cancel" },
    { type: "error" },
  ];

  test("矩阵是 6 × 7 = 42 格", () => {
    expect(STATES.length * EVENTS.length).toBe(42);
  });

  test.each(
    STATES.flatMap((state) => EVENTS.map((event) => [state, event.type, state, event] as const)),
  )("在 %s 收到 %s 不会崩溃，且结果是合法状态", (_s, _e, state, event) => {
    // 这一条把 42 格全走一遍。不求断言具体结果（那由下面的分组负责），
    // 只求证明「没有任何一个组合会让状态机进入未定义的状态」。
    const result = step(at(state, 1000), event);
    expect(STATES).toContain(result.state);
    expect(result.samples).toBeGreaterThanOrEqual(0);
  });

  test.each([
    ["idle", { type: "stop" } as const],
    ["idle", { type: "granted" } as const],
    ["idle", { type: "chunk", samples: 128 } as const],
    ["requesting", { type: "start" } as const],
    ["requesting", { type: "chunk", samples: 128 } as const],
    ["requesting", { type: "stop" } as const],
    ["recording", { type: "start" } as const],
    ["recording", { type: "granted" } as const],
    ["recording", { type: "denied" } as const],
    ["done", { type: "chunk", samples: 128 } as const],
    ["done", { type: "stop" } as const],
    ["denied", { type: "granted" } as const],
    ["error", { type: "chunk", samples: 128 } as const],
  ])("在 %s 收到非法事件 %o 时原样返回，不抛错也不进 error", (state, event) => {
    // 现实中双击一次按钮就会产生一个非法事件（recording 收到 start）。
    // 那不是故障，是用户手快。当成故障处理会让界面莫名其妙地红一下。
    const before = at(state as RecorderState, 500);
    expect(step(before, event)).toBe(before);
  });

  test("done 状态收到 chunk 绝不能计入 —— 管线里的残留采样", () => {
    // 停止之后，AudioWorklet 管线里可能还有一两块采样在路上。
    // 让它们计入的话，最后的采样数会和实际编码出的音频对不上。
    const done: RecorderContext = { state: "done", samples: 1000, reachedLimit: false };
    expect(step(done, { type: "chunk", samples: 128 }).samples).toBe(1000);
  });
});

describe("B. 正常路径", () => {
  test("idle → requesting → recording → done", () => {
    let ctx = initialContext();
    expect(ctx.state).toBe("idle");

    ctx = step(ctx, { type: "start" });
    expect(ctx.state).toBe("requesting");

    ctx = step(ctx, { type: "granted" });
    expect(ctx.state).toBe("recording");

    ctx = step(ctx, { type: "chunk", samples: 16000 });
    expect(ctx.state).toBe("recording");
    expect(ctx.samples).toBe(16000);

    ctx = step(ctx, { type: "stop" });
    expect(ctx.state).toBe("done");
    expect(ctx.samples).toBe(16000);
    expect(ctx.reachedLimit).toBe(false);
  });

  test("采样数逐块累加", () => {
    let ctx = at("recording");
    for (let i = 0; i < 10; i++) ctx = step(ctx, { type: "chunk", samples: 128 });
    expect(ctx.samples).toBe(1280);
  });

  test("块大小不一致也能累加 —— 渲染块大小不保证是 128", () => {
    let ctx = at("recording");
    for (const n of [128, 64, 256, 128]) ctx = step(ctx, { type: "chunk", samples: n });
    expect(ctx.samples).toBe(576);
  });

  test("一个采样都没收到就停 → 回到 idle，不进 done", () => {
    // 让上层去处理一个空录音，只会多一处要防的空值。
    expect(step(at("recording", 0), { type: "stop" }).state).toBe("idle");
  });
});

describe("C. 失败分支", () => {
  test("权限被拒 → denied", () => {
    expect(step(at("requesting"), { type: "denied" }).state).toBe("denied");
  });

  test("请求权限时出错 → error", () => {
    expect(step(at("requesting"), { type: "error" }).state).toBe("error");
  });

  test("录音中设备出错 → error，已收到的采样保留", () => {
    // 拔掉麦克风、设备被别的程序抢走。已录的部分仍然有价值，
    // 界面可以问用户「要不要就用这一段」。
    const ctx = step(at("recording", 5000), { type: "error" });
    expect(ctx.state).toBe("error");
    expect(ctx.samples).toBe(5000);
  });

  test("从失败状态可以直接重录", () => {
    for (const state of ["denied", "error"] as const) {
      const ctx = step(at(state, 999), { type: "start" });
      expect(ctx.state).toBe("requesting");
      expect(ctx.samples).toBe(0);
    }
  });
});

describe("D. 上限 —— 按采样数，不按墙上时钟", () => {
  test("上限是 30 秒对应的采样数", () => {
    expect(LIMIT).toBe(MAX_ASSESSABLE_SECONDS * 16000);
    expect(LIMIT).toBe(480_000);
  });

  test("到点自动停，并标记 reachedLimit", () => {
    const ctx = step(at("recording", LIMIT - 128), { type: "chunk", samples: 128 });
    expect(ctx.state).toBe("done");
    expect(ctx.reachedLimit).toBe(true);
  });

  test("超出上限时采样数被夹到上限，不会多出来", () => {
    // 最后一块可能跨过边界。多算的话，编码出的音频会超过 30 秒，
    // 送进评分接口会被静默截断——那正是我们要避免的。
    const ctx = step(at("recording", LIMIT - 10), { type: "chunk", samples: 1000 });
    expect(ctx.samples).toBe(LIMIT);
  });

  test("差一个采样时不停", () => {
    const ctx = step(at("recording", LIMIT - 200), { type: "chunk", samples: 199 });
    expect(ctx.state).toBe("recording");
    expect(ctx.reachedLimit).toBe(false);
  });

  test("恰好等于上限时停", () => {
    const ctx = step(at("recording", LIMIT - 128), { type: "chunk", samples: 128 });
    expect(ctx.state).toBe("done");
  });

  test("用户主动停时 reachedLimit 为 false —— 两种停止要能区分", () => {
    expect(step(at("recording", 1000), { type: "stop" }).reachedLimit).toBe(false);
  });

  test("按采样数而不是墙上时钟 —— 切后台时两者会分叉", () => {
    // 浏览器会挂起后台标签页的 AudioContext：采样停止流入，
    // 而计时器还在走。用户切回来看到「已录 25 秒」，实际只有 8 秒音频。
    // 评分接口在意的是音频有多长，不是用户等了多久。
    //
    // 这条用例的形态：时间过去很久（很多次 transition 调用），
    // 但没有 chunk 事件，状态就该原地不动。
    let ctx = at("recording", 8 * 16000);
    for (let i = 0; i < 1000; i++) ctx = step(ctx, { type: "granted" }); // 非 chunk 事件
    expect(ctx.state).toBe("recording");
    expect(elapsedSeconds(ctx, CONFIG)).toBe(8);
  });

  test("上限可配置", () => {
    expect(maxSamples({ sampleRate: 16000, maxSeconds: 10 })).toBe(160_000);
    expect(maxSamples({ sampleRate: 48000, maxSeconds: 5 })).toBe(240_000);
  });
});

describe("E. 取消与重录", () => {
  test.each([["requesting"], ["recording"], ["done"], ["denied"], ["error"]] as const)(
    "在 %s 取消 → 回到 idle 且采样清零",
    (state) => {
      const ctx = step(at(state, 9999), { type: "cancel" });
      expect(ctx.state).toBe("idle");
      expect(ctx.samples).toBe(0);
    },
  );

  test("取消和停止的区别：取消丢弃，停止保留", () => {
    const recording = at("recording", 5000);
    expect(step(recording, { type: "cancel" }).samples).toBe(0);
    expect(step(recording, { type: "stop" }).samples).toBe(5000);
  });

  test("从 done 重录会清零采样数", () => {
    const ctx = step(at("done", 480_000), { type: "start" });
    expect(ctx.samples).toBe(0);
    expect(ctx.reachedLimit).toBe(false);
  });

  test("重录时上一次的 reachedLimit 不会带过来", () => {
    const finished: RecorderContext = { state: "done", samples: LIMIT, reachedLimit: true };
    expect(step(finished, { type: "start" }).reachedLimit).toBe(false);
  });
});

describe("F. 派生量与配置", () => {
  test("canStart 在忙碌时为 false", () => {
    expect(canStart(at("idle"))).toBe(true);
    expect(canStart(at("done"))).toBe(true);
    expect(canStart(at("denied"))).toBe(true);
    expect(canStart(at("error"))).toBe(true);
    expect(canStart(at("requesting"))).toBe(false);
    expect(canStart(at("recording"))).toBe(false);
  });

  test("elapsedSeconds 由采样数换算", () => {
    expect(elapsedSeconds(at("recording", 16000), CONFIG)).toBe(1);
    expect(elapsedSeconds(at("recording", 8000), CONFIG)).toBe(0.5);
    expect(elapsedSeconds(at("idle", 0), CONFIG)).toBe(0);
  });

  test("三个音频处理开关全开 —— 不把环境噪声带进评分", () => {
    // 代价是浏览器会对信号做处理，可能削掉一些辅音细节；
    // 收益是不带进环境噪声——实测纯噪声的准确度能拿 71 分，
    // 噪声对分数的污染比处理带来的损失大得多。
    expect(AUDIO_CONSTRAINTS).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  test("初始状态", () => {
    expect(initialContext()).toEqual({ state: "idle", samples: 0, reachedLimit: false });
  });
});
