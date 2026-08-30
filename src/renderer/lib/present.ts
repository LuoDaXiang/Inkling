/**
 * 「该展示什么」的决定层。
 *
 * 输入是主进程的响应，输出是一个**描述对象**——界面照着它画。
 * 这里同样没有任何 DOM 操作。
 *
 * ## M3：从 `public/present.js` 搬过来，加了类型
 *
 * **逻辑一行没改，用例一条没退役。** 迁移计划把这个文件划进「M3 退役 71 条」
 * 那一格，但那一格的前提是「这些代码随 `public/*.js` 一起消失」——
 * 而它没有消失，它就是 React 界面照着画的那份决定。
 * 退役一批仍然守着活代码的用例，是把覆盖率换成一个更好看的迁移故事。
 *
 * 文件头原本那句「界面是草稿，这个文件不是」正是这一步的依据。
 *
 * ## 为什么把决定和绘制分开
 *
 * 契约里有几条是**产品正确性**，不能留给界面自己发挥：
 *
 *   [C30] `unreliable` 必须降级呈现。照 `scored` 渲染会把噪声当成
 *         「读得还行」端给用户——纯白噪声的准确度是 71 分，而准确度是主打维度。
 *   [C44] 缺席不能渲染成 0。语调没测出来就不显示语调那一行，
 *         显示「语调 0 分」是在撒谎。
 *   [C32] `persisted:false` 的两种含义必须分得开，否则用户不知道
 *         这次到底有没有记上。
 *
 * 把这些做成可测的纯函数，界面重画多少次都不会把它们画丢。
 */

export interface Presentation {
  kind: "scored" | "unreliable" | "no_speech" | "unknown";
  showScores: boolean;
  showWords: boolean;
  recognized: string | null;
  scores: Record<string, unknown> | null;
  words: unknown[];
  notices: string[];
  meta: { assessedMs: number | null; trimmedMs: number | null; snr: number | null };
  playbackUrl: string | null;
  traceId: string | null;
}

export type ErrorAction =
  | "fix_input"
  | "refresh_list"
  | "report_bug"
  | "retry_manually"
  | "check_server_config"
  | "disable_feature";

export interface ErrorView {
  code: string;
  known: boolean;
  message: string;
  action: ErrorAction;
  blameUser: boolean;
  canRetry: boolean;
}

export interface PitchContour {
  hz: (number | null)[];
  hopMs: number;
}

export interface PitchPlotInput {
  reference?: unknown;
  recording?: unknown;
  width?: number;
  height?: number;
  padding?: number;
}

export interface PitchPoint {
  x: number;
  y: number;
}

export interface PitchSegment {
  series: "reference" | "recording";
  points: PitchPoint[];
}

export interface PitchPlot {
  segments: PitchSegment[];
  minHz: number | null;
  maxHz: number | null;
  durationMs: number;
}

export interface WordMarks {
  word: string;
  accuracy: number | null;
  base: "ok" | "mispronounced" | "omission" | "insertion";
  monotone: { level: 0 | 1 | 2 | 3; intensity: number | null };
  breakMark: "unexpected" | "missing" | null;
}

export interface PhonemeRow {
  phoneme: string;
  accuracy: number | null;
  band: string | null;
  weak: boolean;
}

/**
 * 分数只展示分档，不展示原始百分数。
 *
 * 实测准确度和流利度系统性偏高约 20 分（专家均分 65.8，服务端给 85.7）——
 * 直接展示会让用户以为自己比实际水平好得多。
 *
 * **这一条对准确度尤其要紧**，因为它是主打维度：主打维度报一个虚高的数字，
 * 整个产品的可信度就没了。分档切点用效度测量的数据反推，不是拍脑袋定的。
 * 见 decisions 0019 与 0035。
 */
export function band(score: unknown): string | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score >= 85) return "很好";
  if (score >= 70) return "不错";
  if (score >= 50) return "可懂";
  return "要重练";
}

/** 数值字段：缺席一律给 `null`，**绝不给 0**（[C44]）。 */
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 把一次评分响应翻译成「该展示什么」。
 *
 * 对未知的 `outcome` 取值**降级而不是崩溃**（§5：封闭枚举收窄是破坏性变更，
 * 而客户端遇到未知取值必须降级显示）。将来服务端加一种走向时，
 * 老客户端会显示「这次的结果看不懂」，而不是白屏。
 */
export function presentResult(data: unknown): Presentation {
  const body = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const outcome = body["outcome"];

  const view: Presentation = {
    kind: "unknown",
    showScores: false,
    showWords: false,
    recognized: null,
    scores: null,
    words: [],
    notices: [],
    meta: { assessedMs: null, trimmedMs: null, snr: null },
    playbackUrl: null,
    traceId: typeof body["traceId"] === "string" ? body["traceId"] : null,
  };

  // 时间与信噪比对三种走向都可能有，先统一处理。
  view.meta.assessedMs = numberOrNull(body["assessedMs"]);
  view.meta.snr = numberOrNull(body["snr"]);
  const start = numberOrNull(body["trimmedStartMs"]);
  const end = numberOrNull(body["trimmedEndMs"]);
  view.meta.trimmedMs = start === null && end === null ? null : (start ?? 0) + (end ?? 0);

  if (outcome === "scored" || outcome === "unreliable") {
    view.kind = outcome;
    view.recognized = typeof body["recognized"] === "string" ? body["recognized"] : null;
    view.words = Array.isArray(body["words"]) ? (body["words"] as unknown[]) : [];

    if (outcome === "scored") {
      view.showScores = true;
      view.showWords = true;
      view.scores =
        body["scores"] && typeof body["scores"] === "object"
          ? (body["scores"] as Record<string, unknown>)
          : null;
    } else {
      // [C30] 降级呈现的具体内容：不展示 scores（任何一项）、不展示逐词标红，
      // 只展示 recognized 并提示重录。
      //
      // recognized 保留是因为它在 unreliable 时**恰恰是最有用的信息**：
      // 用户看到系统听成了什么，就理解了为什么不可信。
      view.notices.push("这次的录音不太可靠，下面是系统听到的内容，请重录一次。");
    }
  } else if (outcome === "no_speech") {
    // [C31] 两条来源（修剪后为空 / 服务识别不到）合并成同一个 outcome，
    // 因为对客户端是同一件事：「这次没录到声音，重录」。
    view.kind = "no_speech";
    view.notices.push("这次没有录到语音，请重录一次。");
  } else {
    view.notices.push("这次的结果看不懂——客户端可能比服务端旧了。");
  }

  // [C32] persisted 的三态。两种 false 必须分得开，否则客户端不知道该不该提示。
  if (body["persisted"] === true) {
    view.playbackUrl = typeof body["audioUrl"] === "string" ? body["audioUrl"] : null;
  } else if (typeof body["persistError"] === "string") {
    // 「要求记录但写失败了」——练习记录丢一行是用户的数据没了，而且不会
    // 重新产生。结果照给，失败照说。
    view.notices.push("这次的练习记录没保存上。");
  }
  // persisted:false 且没有 persistError = 本来就没要求记录（匿名试用，
  // 或无成本的 no_speech）。**不提示**——那不是失败。

  return view;
}

/**
 * 错误取值 → 客户端该做什么（契约 §7.4）。
 *
 * **只基于 `error` 分支，绝不解析 `message`**（[C46] [C53]）。
 * message 的措辞随时可能改，而且改它不算破坏性变更。
 *
 * `auth` / `quota` 是 5xx 而不是 4xx，因为密钥是本机配的——
 * **浏览器端的用户没做错任何事**（[C45]）。所以这两种的 `blameUser` 是 false：
 * 界面不该向用户追责。
 */
interface ActionSpec {
  action: ErrorAction;
  blameUser: boolean;
  canRetry: boolean;
}

const ERROR_ACTIONS: Record<string, ActionSpec> = {
  rejected: { action: "fix_input", blameUser: true, canRetry: false },
  not_found: { action: "refresh_list", blameUser: false, canRetry: false },
  forbidden: { action: "report_bug", blameUser: false, canRetry: false },
  method_not_allowed: { action: "report_bug", blameUser: false, canRetry: false },
  too_long: { action: "fix_input", blameUser: true, canRetry: false },
  network: { action: "retry_manually", blameUser: false, canRetry: true },
  empty: { action: "retry_manually", blameUser: false, canRetry: true },
  unknown: { action: "retry_manually", blameUser: false, canRetry: true },
  auth: { action: "check_server_config", blameUser: false, canRetry: false },
  quota: { action: "check_server_config", blameUser: false, canRetry: false },
  unavailable: { action: "disable_feature", blameUser: false, canRetry: false },
  internal: { action: "report_bug", blameUser: false, canRetry: false },
};

export function interpretError(body: unknown): ErrorView {
  const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const code = typeof payload["error"] === "string" ? (payload["error"] as string) : null;
  const known = code !== null && Object.hasOwn(ERROR_ACTIONS, code);

  return {
    code: code ?? "internal",
    known,
    // message 直接拿来显示是允许的，拿来做分支不行。
    message: typeof payload["message"] === "string" ? (payload["message"] as string) : "",
    // 未知取值降级成「报 bug」，不崩溃（§5：封闭枚举）。
    ...(known ? (ERROR_ACTIONS[code as string] as ActionSpec) : ERROR_ACTIONS["internal"]!),
  };
}

/**
 * **`canRetry` 说的是「可以提示用户手动重试」，不是「可以自动重试」。**
 *
 * [C36] [C47] [C52]：客户端一律不自动重试任何 POST。每次 `POST /api/assess`
 * 都真实付费，而且超时之后请求可能已经在服务端执行并计费了。
 *
 * 这个常量存在的唯一目的是让那条规矩在代码里有个可以被引用、被测试的位置——
 * 一条只写在文档里的禁令，迟早有人不知道。
 */
export const AUTO_RETRY_POST = false;

/* ================================================================== *
 * 音高曲线（M1.5 契约扩展 / M1.6 展示）
 * ================================================================== */

/**
 * 把一条或两条音高曲线折算成画布坐标。
 *
 * **这里仍然不碰 DOM**，理由和这个文件里其余部分一样：
 * 「该画成什么样」是可测的决定，「怎么画」是十几行 canvas 调用。
 * 把两者混在一起，下面这三条就再也测不到了：
 *
 *   1. **`null` 处必须断开**，不能把断点两侧连成一条直线。
 *      连起来的那条线是编出来的——用户会看到一段根本没测出音高的地方
 *      有一条平滑的曲线，而没有任何东西会报错。这是这个函数存在的首要理由。
 *   2. **两条曲线共用同一个纵轴**。各自归一化的话，一个念得又低又平的人
 *      和范本会画出一模一样的两条线，跟读练习的全部意义就没了。
 *   3. **横轴按时间对齐**，不是按帧号。两条曲线的 `hopMs` 可以不同
 *      （范本 24 kHz 合成、录音 16 kHz，将来采样率还可能再变），
 *      按帧号对齐会让长度不同的两条曲线错位。
 *
 * 返回的是一组**折线段**：每段是连续有值的一串点。`null` 把一条曲线
 * 切成多段，画的时候一段一条 path，段与段之间自然断开。
 *
 * @param {{reference?: unknown, recording?: unknown, width?: number, height?: number, padding?: number}} input
 */
export function pitchPlot(input: PitchPlotInput): PitchPlot {
  const opts = (input && typeof input === "object" ? input : {}) as PitchPlotInput;
  const width = positiveOr(opts.width, 600);
  const height = positiveOr(opts.height, 120);
  const padding = typeof opts.padding === "number" && opts.padding >= 0 ? opts.padding : 4;

  const series = (
    [
      { name: "reference" as const, contour: readContour(opts.reference) },
      { name: "recording" as const, contour: readContour(opts.recording) },
    ] as const
  ).filter((s): s is { name: "reference" | "recording"; contour: PitchContour } =>
    s.contour !== null,
  );

  const empty: PitchPlot = { segments: [], minHz: null, maxHz: null, durationMs: 0 };
  if (series.length === 0) return empty;

  // 纵轴：两条曲线一起定范围。分别归一化会抹掉「谁高谁低」这个信息，
  // 而那正是跟读要看的东西。
  let minHz = Infinity;
  let maxHz = -Infinity;
  let durationMs = 0;
  for (const s of series) {
    const { hz, hopMs } = s.contour;
    durationMs = Math.max(durationMs, hz.length * hopMs);
    for (const v of hz) {
      if (v === null) continue;
      if (v < minHz) minHz = v;
      if (v > maxHz) maxHz = v;
    }
  }

  // 一个有值的点都没有：两条曲线全是 null。不画，也不假装画了。
  if (minHz === Infinity) return { ...empty, durationMs };

  // 上下各留一点余量，免得曲线贴着边框。范围退化成一个点时给一个固定余量，
  // 否则 (v - min) / (max - min) 会除以 0。
  const spanHz = maxHz - minHz;
  const padHz = spanHz === 0 ? 10 : spanHz * 0.1;
  const lowHz = minHz - padHz;
  const highHz = maxHz + padHz;

  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);
  const spanMs = durationMs === 0 ? 1 : durationMs;

  const segments: PitchSegment[] = [];
  for (const s of series) {
    const { hz, hopMs } = s.contour;
    let current: PitchSegment | null = null;

    hz.forEach((value, index) => {
      if (value === null) {
        // 断点。把攒着的这一段收掉，下一个有值的点从头开一段。
        if (current) segments.push(current);
        current = null;
        return;
      }
      const point = {
        x: padding + (((index * hopMs) / spanMs) * usableWidth),
        // canvas 的 y 向下增长，所以高频在上要减。
        y: padding + usableHeight - (((value - lowHz) / (highHz - lowHz)) * usableHeight),
      };
      if (!current) current = { series: s.name, points: [] };
      current.points.push(point);
    });

    if (current) segments.push(current);
  }

  // 只有一个点的段画不出线。留着——绘制层画一个圆点，
  // 丢掉的话「这里测出了一个孤立的音高」这个事实就没了。
  return { segments, minHz, maxHz, durationMs };
}

/** 响应里的 `pitch` 字段。形状不对就当没有——半条曲线比没有曲线更糟。 */
function readContour(value: unknown): { hz: (number | null)[]; hopMs: number } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { hz?: unknown; hopMs?: unknown };
  const hopMs = raw.hopMs;
  if (typeof hopMs !== "number" || !Number.isFinite(hopMs) || hopMs <= 0) return null;
  if (!Array.isArray(raw.hz)) return null;

  const hz = raw.hz.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  return { hz, hopMs };
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/* ================================================================== *
 * 逐词三层标记（decisions 0045）
 * ================================================================== */

/**
 * 准确度低于这个分数，即使 `errorType` 是 `None` 也按念错标。
 *
 * 从 `index.html` 挪进来的，值没变。挪的理由是它是一条**产品判断**
 * （多低算念错），而不是一句绘制代码。
 */
export const LOW_ACCURACY = 60;

/** `monotone` 的分档切点。三档，不是连续色阶——见 0045 最后一节。 */
export const MONOTONE_LIGHT = 1 / 3;
export const MONOTONE_HEAVY = 2 / 3;

/**
 * 一个词该怎么标。**三层各自独立，不是查表。**
 *
 * 参考实现那份是 `{None: …, Mispronunciation: …, Monotone: …}[errorType]`，
 * 一个词只能显示一种错误——因为 Azure 的 `errorType` 是单值枚举。
 * Inkling 的 `WordScore` 是三个正交字段，一个词可以同时「念错了」和「读得平」。
 *
 * 返回三个互不覆盖的通道：
 *
 *   `base`     底色。`"ok" | "mispronounced" | "omission" | "insertion"`
 *   `monotone` 次级标记。`{ level: 0|1|2|3, intensity: number|null }`
 *   `breakMark` 第三层。`"unexpected" | "missing" | null`
 *
 * **同时念错且读平时，底色是念错，而下划线照画**（0045）。
 * 优先级说的是「底色归谁」，不是「其余的层不显示」——
 * 那正是查表结构做不到的一点。
 */
export function wordMarks(word: unknown): WordMarks {
  const w = (word && typeof word === "object" ? word : {}) as Record<string, unknown>;
  const errorType = typeof w["errorType"] === "string" ? (w["errorType"] as string) : "None";
  const accuracy =
    typeof w["accuracy"] === "number" && Number.isFinite(w["accuracy"])
      ? (w["accuracy"] as number)
      : null;

  return {
    word: typeof w["word"] === "string" ? (w["word"] as string) : "",
    accuracy,
    base: baseOf(errorType, accuracy),
    monotone: monotoneOf(errorType, w["monotone"]),
    breakMark: breakOf(errorType, w["breakError"]),
  };
}

/**
 * 底色只回答「这个音念得对不对」。
 *
 * `Monotone` / `UnexpectedBreak` / `MissingBreak` 三个取值虽然长在
 * `errorType` 上，但它们描述的是韵律。涂成「念错了」的底色，
 * 用户会去改一个根本没念错的音——所以它们**不设底色**，
 * 各自折进另外两层（见 `monotoneOf` / `breakOf`）。
 */
function baseOf(errorType: string, accuracy: number | null): WordMarks["base"] {
  if (errorType === "Omission") return "omission";
  if (errorType === "Insertion") return "insertion";
  if (errorType === "Mispronunciation") return "mispronounced";
  // 分数够低就是念错了，哪怕服务端说 None。
  if (accuracy !== null && accuracy < LOW_ACCURACY) return "mispronounced";
  return "ok";
}

/**
 * 连续量 → 三档。
 *
 * `errorType === "Monotone"` 而 `monotone` 字段缺席 = 「知道读平了，
 * 不知道多平」。这时给最轻的一档，`intensity` 记 `null`——
 * **不编一个中间值**。编出来的那个数字是用户没测过的信息。
 */
function monotoneOf(errorType: string, raw: unknown): WordMarks["monotone"] {
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;

  if (value === null) {
    return errorType === "Monotone"
      ? { level: 1, intensity: null }
      : { level: 0, intensity: null };
  }
  if (value <= 0) return { level: 0, intensity: value };
  if (value <= MONOTONE_LIGHT) return { level: 1, intensity: value };
  if (value <= MONOTONE_HEAVY) return { level: 2, intensity: value };
  return { level: 3, intensity: value };
}

/** 独立字段优先；只给单值枚举的 provider 从 `errorType` 折过来。 */
function breakOf(errorType: string, raw: unknown): WordMarks["breakMark"] {
  if (raw === "unexpected" || raw === "missing") return raw;
  if (errorType === "UnexpectedBreak") return "unexpected";
  if (errorType === "MissingBreak") return "missing";
  return null;
}

/**
 * 音素级明细，供悬停弹出层用（0035 第 4 条）。
 *
 * 「第 3 个词念错了」不够，「第 3 个词的 /θ/ 念成了 /s/」才是能拿去改的东西。
 *
 * 每个音素带一个 `band`，复用上面那套分档——**不展示原始百分数**（0019）。
 * 音素级的绝对值比词级更不可信，展示数字只会制造精度的错觉。
 */
export function phonemeRows(word: unknown): PhonemeRow[] {
  const w = (word && typeof word === "object" ? word : {}) as { phonemes?: unknown };
  if (!Array.isArray(w.phonemes)) return [];

  return (w.phonemes as unknown[])
    .filter(
      (p): p is { phoneme: string; accuracy?: unknown } =>
        Boolean(p) &&
        typeof p === "object" &&
        typeof (p as { phoneme?: unknown }).phoneme === "string",
    )
    .map((p) => {
      const accuracy =
        typeof p.accuracy === "number" && Number.isFinite(p.accuracy) ? p.accuracy : null;
      return {
        phoneme: p.phoneme,
        accuracy,
        band: band(accuracy),
        // 低于这条线的音素是「该练的那几个」，弹出层里要能一眼挑出来。
        weak: accuracy !== null && accuracy < LOW_ACCURACY,
      };
    });
}
