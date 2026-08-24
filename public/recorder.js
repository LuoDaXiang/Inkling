/**
 * 浏览器录音层。
 *
 * **这一层刻意做得很薄，因为它测不了。** 它只做三件事：
 *   1. 开麦克风，把 Float32 采样一块块收下来（每块必须复制）
 *   2. 把真实事件翻译成状态机的 Event
 *   3. 把状态映射成界面
 *
 * 采样格式转换、静音修剪、WAV 编码、状态迁移，全部在 core/ 里，
 * 那些有 171 个用例覆盖。这里没有一行业务判断。
 *
 * 为什么绕开 MediaRecorder：Chrome 的 MediaRecorder 只产出
 * WebM 容器 + Opus 编码，而评分接口只收 WAV 或 OGG。编码对得上
 * 但容器不对，直接上传必然被拒。参考实现因此必须再引一个几十兆的
 * 转码库；用 AudioWorklet 直接取 PCM，源头就是对的格式。
 */

const TARGET_SAMPLE_RATE = 16000;

/** AudioWorklet 处理器。它跑在音频线程里，只负责把采样搬到主线程。 */
const WORKLET_SOURCE = `
class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // 没有输入时返回 true 保活。返回 false 会永久停掉这个节点。
    if (!channel || channel.length === 0) return true;
    // 必须复制：这块内存下次调用就会被覆盖。
    this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("tap", TapProcessor);
`;

export class Recorder {
  constructor({ onEvent }) {
    this.onEvent = onEvent;
    this.chunks = [];
    this.context = null;
    this.stream = null;
    this.node = null;
  }

  /**
   * 浏览器支持检查。
   *
   * Firefox 会在连接不同采样率的节点时报错，且忽略 getUserMedia 的
   * sampleRate 约束——所以 Stage 0 明确不支持它。与其让用户录完
   * 才发现分数不对，不如一开始就说清楚。见 docs/decisions.md 0031。
   */
  static checkSupport() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { ok: false, reason: "这个浏览器不支持录音。" };
    }
    if (typeof AudioWorkletNode === "undefined") {
      return { ok: false, reason: "这个浏览器不支持 AudioWorklet，无法录音。" };
    }
    if (navigator.userAgent.includes("Firefox")) {
      return {
        ok: false,
        reason: "Firefox 暂不支持——它无法把录音固定在 16kHz，会影响评分。请用 Chrome 或 Safari。",
      };
    }
    return { ok: true };
  }

  async start(constraints) {
    this.chunks = [];
    this.onEvent({ type: "start" });

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...constraints, sampleRate: TARGET_SAMPLE_RATE },
      });
    } catch (err) {
      // NotAllowedError 是用户点了拒绝；其余（设备被占用、没有麦克风）算错误。
      this.onEvent({ type: err?.name === "NotAllowedError" ? "denied" : "error" });
      return;
    }

    try {
      this.context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });

      // 拿到的采样率必须真的是 16000。浏览器可能不理会这个请求，
      // 而不一致会让编出来的 WAV 时长和实际对不上，评分随之出错。
      if (this.context.sampleRate !== TARGET_SAMPLE_RATE) {
        await this.cleanup();
        this.onEvent({ type: "error" });
        return;
      }

      const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await this.context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      this.node = new AudioWorkletNode(this.context, "tap");
      this.node.port.onmessage = (event) => {
        this.chunks.push(event.data);
        this.onEvent({ type: "chunk", samples: event.data.length });
      };

      this.context.createMediaStreamSource(this.stream).connect(this.node);
      // 不连到 destination —— 连上会把麦克风的声音外放，形成啸叫。
      this.onEvent({ type: "granted" });
    } catch {
      await this.cleanup();
      this.onEvent({ type: "error" });
    }
  }

  /** 停止并释放麦克风。返回收集到的采样块。 */
  async stop() {
    const chunks = this.chunks;
    await this.cleanup();
    return chunks;
  }

  async cancel() {
    this.chunks = [];
    await this.cleanup();
  }

  /**
   * 释放麦克风。
   *
   * 必须逐条 stop 每个 track——只关 AudioContext 的话，
   * 浏览器地址栏的录音红点会一直亮着，用户会以为在被偷听。
   */
  async cleanup() {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
  }
}

export { TARGET_SAMPLE_RATE };
