import * as React from "react";
import { toast } from "sonner";
import { Toaster } from "@renderer/components/ui/sonner";
import { Label } from "@renderer/components/ui/label";
import { Textarea } from "@renderer/components/ui/textarea";
import { Progress } from "@renderer/components/ui/progress";
import { ResultPanel } from "@renderer/components/ResultPanel";
import { DictSettings } from "@renderer/components/DictSettings";
import { WordBook } from "@renderer/components/WordBook";
import { bridge, isBytes, type InstalledDict } from "@renderer/lib/ipc";
import {
  buildAssessQuery,
  canRecord,
  captureFlagsFrom,
  loadConfig,
  newClientRequestId,
  queryObject,
  type ContractConfig,
} from "@renderer/lib/contract";
import { interpretError, type PitchContour } from "@renderer/lib/present";
import { Recorder, TARGET_SAMPLE_RATE, type RecorderEvent } from "@renderer/lib/recorder";
import { usePersistentState } from "@renderer/lib/uiState";

/**
 * 主界面。
 *
 * **和 M2 长得一模一样**（对照物：`docs/m2-baseline/`）——M3 的铁律是
 * 不顺带做任何功能改动。所以这里的每一块都能在那三张截图里找到：
 * 输入 + 合成范本 → 跟读 → 结果区（曲线 / 分数 / 逐词 / 元信息）。
 *
 * 三件事没变，只是换了位置：
 *   - 「该展示什么」仍在 `lib/present.ts`（原 `public/present.js`）
 *   - 「该发什么请求」仍在 `lib/contract.ts`（原 `public/contract.js`）
 *   - 录音仍在 `lib/recorder.ts`（原 `public/recorder.js`）
 *
 * 变的只有传输：`fetch("/api/…")` 变成 `window.inkling.*`。
 */

/** 界面上能选的音色。列表短是刻意的——选择多不会让人读得更好。 */
const VOICES = [
  { value: "", label: "默认（Ava）" },
  { value: "en-US-AndrewNeural", label: "Andrew（男）" },
  { value: "en-GB-SoniaNeural", label: "Sonia（英）" },
];

const SPEEDS = [
  { value: "", label: "1.0×" },
  { value: "0.9", label: "0.9×" },
  { value: "0.8", label: "0.8×" },
];

/**
 * 一个会自己回收的 blob URL。
 *
 * `URL.createObjectURL` 造出来的 URL **会一直占着那段内存，直到显式
 * revoke**。这里每次合成范本、每次录音都会造一个音频 blob（几百 KB 到 2 MB），
 * 不回收的话练一小时就漏几十兆。
 *
 * 旧的 vanilla 版本是回收的（`if (myUrl) URL.revokeObjectURL(myUrl)`），
 * M3 搬进 React 时丢了——这是一处回归，审计时抓回来的。
 * 做成 hook 而不是在两个地方各写一遍 revoke：漏掉一处不会报错，
 * 只是慢慢变慢。
 */
function useObjectUrl(): [string | null, (next: string | null) => void] {
  const [url, setUrl] = React.useState<string | null>(null);
  const current = React.useRef<string | null>(null);

  const replace = React.useCallback((next: string | null) => {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = next;
    setUrl(next);
  }, []);

  // 卸载时把最后一个也回收掉。
  React.useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );

  return [url, replace];
}

export default function App() {
  const [config, setConfig] = React.useState<ContractConfig | null>(null);
  const [bootError, setBootError] = React.useState<string | null>(null);

  // UI 状态一律 localStorage，不走 IPC（M3.4）。
  const [text, setText] = usePersistentState("text", "The quick brown fox jumps over the lazy dog.");
  const [voice, setVoice] = usePersistentState("voice", "");
  const [speed, setSpeed] = usePersistentState("speed", "");

  const [synthesizing, setSynthesizing] = React.useState(false);
  const [modelUrl, setModelUrl] = useObjectUrl();
  const [referencePitch, setReferencePitch] = React.useState<PitchContour | null>(null);

  const [recording, setRecording] = React.useState(false);
  const [samples, setSamples] = React.useState(0);
  const [assessing, setAssessing] = React.useState(false);
  const [myUrl, setMyUrl] = useObjectUrl();
  const [result, setResult] = React.useState<Record<string, unknown> | null>(null);
  const [support] = React.useState(() => Recorder.checkSupport());

  /**
   * 已装的词典。**练习页也要知道**——生词本查词用它，没装时那里显示的
   * 是「去导入一本」而不是「查不到」。两种说法对用户的意义完全不同。
   */
  const [dicts, setDicts] = React.useState<InstalledDict[]>([]);
  const [showDict, setShowDict] = usePersistentState("showDict", false);

  React.useEffect(() => {
    bridge()
      .dict.list()
      .then(setDicts)
      .catch(() => setDicts([]));
  }, [showDict]);

  const maxSamples = (config?.maxRecordingSeconds ?? 30) * TARGET_SAMPLE_RATE;

  /** 启动时取一次共享常量。版本不匹配必须停（[C4]）。 */
  React.useEffect(() => {
    loadConfig({ call: async () => (await bridge().getConfig()) as { status: number; body: unknown } })
      .then(setConfig)
      .catch((err: unknown) => setBootError(err instanceof Error ? err.message : String(err)));
  }, []);

  /* ---- 合成范本 ---- */

  async function synthesize(): Promise<void> {
    setSynthesizing(true);
    try {
      const payload: Record<string, unknown> = { text };
      if (voice) payload["voice"] = voice;
      if (speed) payload["speed"] = Number(speed);

      const res = await bridge().postTts(JSON.stringify(payload));
      if (isBytes(res)) throw new Error("合成返回了字节，这不对");

      if (res.status !== 200) {
        const view = interpretError(res.body);
        toast.error(`${view.code}：${view.message}`);
        return;
      }

      const body = res.body as Record<string, unknown>;
      const url = await audioUrl(String(body["url"]));
      setModelUrl(url);
      // 缺席就是缺席：老的缓存条目没有曲线，那时只画录音那一条。
      setReferencePitch((body["pitch"] as PitchContour | undefined) ?? null);
      toast.success(body["cached"] === true ? "命中缓存" : "合成完成");
    } catch (err) {
      toast.error(`合成失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSynthesizing(false);
    }
  }

  /**
   * 把 `/api/audio/{key}.wav` 变成一个能播的 blob URL。
   *
   * HTTP 那条路上 `<audio src>` 直接指得过去；IPC 这边字节要自己接回来。
   * 这是换传输后**唯一**多出来的一步，也是为什么 `getAudio` 那个频道
   * 必须存在——不是为了兼容，是渲染层确实拿不到文件系统。
   */
  async function audioUrl(url: string): Promise<string | null> {
    const name = url.split("/").pop();
    if (!name) return null;
    const res = await bridge().getAudio(name);
    if (!isBytes(res)) return null;
    return URL.createObjectURL(new Blob([res.bytes], { type: "audio/wav" }));
  }

  /* ---- 录音 ---- */

  const recorderRef = React.useRef<Recorder | null>(null);

  function handleEvent(event: RecorderEvent): void {
    // 这一层不做业务判断，只把事件翻译成界面。真正的状态迁移由
    // core/ 那份状态机定义，这里只映射三个可见状态。
    switch (event.type) {
      case "granted":
        setRecording(true);
        setSamples(0);
        break;
      case "chunk":
        setSamples((n) => n + event.samples);
        break;
      case "denied":
        setRecording(false);
        toast.error("麦克风权限被拒绝。到系统设置里重新允许。");
        break;
      case "error":
        setRecording(false);
        toast.error("打不开麦克风。检查一下是不是被别的程序占用了。");
        break;
      default:
        break;
    }
  }

  // 到点直接停，不提示——提示会打断朗读，用户一分神这遍的流利度就毁了。
  React.useEffect(() => {
    if (recording && samples >= maxSamples) void finish();
  }, [recording, samples, maxSamples]);

  async function startRecording(): Promise<void> {
    setResult(null);
    setMyUrl(null);
    const recorder = new Recorder({ onEvent: handleEvent });
    recorderRef.current = recorder;
    await recorder.start({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  }

  async function finish(): Promise<void> {
    const recorder = recorderRef.current;
    if (!recorder || !recording) return;
    setRecording(false);

    // [C27] 必须在停之前回读——轨道停掉之后 getSettings() 就读不到了。
    const capture = captureFlagsFrom(recorder.track);
    const chunks = await recorder.stop();
    recorderRef.current = null;
    setSamples(0);

    if (chunks.length === 0) {
      toast.error("没有录到声音");
      return;
    }

    let total = 0;
    for (const c of chunks) total += c.length;
    const pcm = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      pcm.set(c, offset);
      offset += c.length;
    }

    // 本地回放用。主进程不回传音频——它拿到的是原始采样，
    // 转换和编码都在那边做，那些逻辑有 171 个用例覆盖。
    setMyUrl(URL.createObjectURL(new Blob([wavOf(pcm)], { type: "audio/wav" })));

    setAssessing(true);
    try {
      const query = buildAssessQuery({
        reference: text,
        clientRequestId: newClientRequestId(),
        capture,
      });
      const res = await bridge().postAssess(queryObject(query), pcm.buffer as ArrayBuffer);
      if (isBytes(res)) throw new Error("评分返回了字节，这不对");

      if (res.status !== 200) {
        const view = interpretError(res.body);
        toast.error(`${view.code}：${view.message}`);
        return;
      }
      setResult(res.body as Record<string, unknown>);
    } catch (err) {
      toast.error(`评分失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAssessing(false);
    }
  }

  /* ---- 渲染 ---- */

  if (bootError) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="mb-3 text-xl font-semibold">Inkling 起不来</h1>
        <p className="whitespace-pre-wrap text-sm text-[var(--bad)]">{bootError}</p>
      </main>
    );
  }

  const recordable = config !== null && canRecord(config) && support.ok;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-5 p-8">
      <h1 className="text-xl font-semibold">Inkling</h1>

      <section className="flex flex-col gap-3.5 rounded border border-border bg-card p-5">
        <Label htmlFor="text">要练的句子</Label>
        <Textarea
          id="text"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="粘一段英文进来"
        />

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => void synthesize()}
            disabled={synthesizing || text.trim() === ""}
            className="rounded bg-[var(--accent)] px-5 py-2.5 font-semibold text-[var(--ground)] disabled:opacity-45"
          >
            {synthesizing ? "合成中…" : "听范本"}
          </button>

          <Label className="flex items-center gap-1.5">
            音色
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              className="rounded border border-border bg-background px-2.5 py-2 text-sm"
            >
              {VOICES.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          </Label>

          <Label className="flex items-center gap-1.5">
            语速
            <select
              value={speed}
              onChange={(e) => setSpeed(e.target.value)}
              className="rounded border border-border bg-background px-2.5 py-2 text-sm"
            >
              {SPEEDS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Label>
        </div>

        {modelUrl ? <audio controls src={modelUrl} className="w-full" /> : null}
      </section>

      <section className="flex flex-col gap-3.5 rounded border border-border bg-card p-5">
        <h2 className="text-base font-semibold">跟读</h2>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void (recording ? finish() : startRecording())}
            disabled={!recordable || assessing}
            className="rounded bg-[var(--bad)] px-5 py-2.5 font-semibold text-white disabled:opacity-45"
          >
            {recording ? "停止" : "开始录音"}
          </button>

          {recording ? (
            <>
              <button
                type="button"
                onClick={() => {
                  void recorderRef.current?.cancel();
                  recorderRef.current = null;
                  setRecording(false);
                  setSamples(0);
                }}
                className="rounded bg-secondary px-5 py-2.5 font-semibold"
              >
                取消
              </button>
              <span className="font-mono text-sm tabular-nums">
                {(samples / TARGET_SAMPLE_RATE).toFixed(1)}s
              </span>
            </>
          ) : null}
        </div>

        {recording ? <Progress value={Math.min(100, (samples / maxSamples) * 100)} /> : null}

        {/*
          禁用的按钮要在旁边说明原因，不要只靠 disabled 的灰色。
          评分没配时**直接禁用录音入口**，而不是让用户录完 30 秒再吃一个 503（[C5]）。
        */}
        {!support.ok ? (
          <p className="text-sm text-[var(--bad)]">{support.reason}</p>
        ) : config && !canRecord(config) ? (
          <p className="text-sm text-[var(--bad)]">评分未配置，录音入口已禁用。</p>
        ) : null}

        {assessing ? <p className="text-sm text-muted-foreground">评分中…</p> : null}
        {myUrl ? <audio controls src={myUrl} className="w-full" /> : null}
      </section>

      <ResultPanel data={result} referencePitch={referencePitch} />

      <WordBook words={bridge().words} dict={bridge().dict} dicts={dicts} />

      {/*
        词典设置默认收起来：没装词典的用户不需要每次都看见它，
        而装过一次之后也很少再动。收起状态走 localStorage，不走 IPC（M3.4）。
      */}
      <button
        type="button"
        onClick={() => setShowDict((v) => !v)}
        className="self-start text-sm text-muted-foreground underline"
        aria-expanded={showDict}
      >
        {showDict ? "收起词典设置" : "词典设置"}
      </button>
      {showDict ? <DictSettings bridge={bridge().dict} /> : null}

      <Toaster />
    </main>
  );
}

/**
 * 本地回放用的 WAV。
 *
 * **只为播放，不参与评分。** 送去评分的字节由主进程从原始采样编码，
 * 那条路上有 171 个用例覆盖；这里编错了顶多是回放不对，不影响分数。
 */
function wavOf(pcm: Float32Array): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(bytes);
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.length * 2, true);

  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i] as number));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}
