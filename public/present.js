/**
 * 「该展示什么」的决定层。
 *
 * 输入是服务端的响应，输出是一个**描述对象**——界面照着它画。
 * 这里同样没有任何 DOM 操作。
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
export function band(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score >= 85) return "很好";
  if (score >= 70) return "不错";
  if (score >= 50) return "可懂";
  return "要重练";
}

/** 数值字段：缺席一律给 `null`，**绝不给 0**（[C44]）。 */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 把一次评分响应翻译成「该展示什么」。
 *
 * 对未知的 `outcome` 取值**降级而不是崩溃**（§5：封闭枚举收窄是破坏性变更，
 * 而客户端遇到未知取值必须降级显示）。将来服务端加一种走向时，
 * 老客户端会显示「这次的结果看不懂」，而不是白屏。
 */
export function presentResult(data) {
  const body = data && typeof data === "object" ? data : {};
  const outcome = body.outcome;

  const view = {
    kind: "unknown",
    showScores: false,
    showWords: false,
    recognized: null,
    scores: null,
    words: [],
    notices: [],
    meta: { assessedMs: null, trimmedMs: null, snr: null },
    playbackUrl: null,
    traceId: typeof body.traceId === "string" ? body.traceId : null,
  };

  // 时间与信噪比对三种走向都可能有，先统一处理。
  view.meta.assessedMs = numberOrNull(body.assessedMs);
  view.meta.snr = numberOrNull(body.snr);
  const start = numberOrNull(body.trimmedStartMs);
  const end = numberOrNull(body.trimmedEndMs);
  view.meta.trimmedMs = start === null && end === null ? null : (start ?? 0) + (end ?? 0);

  if (outcome === "scored" || outcome === "unreliable") {
    view.kind = outcome;
    view.recognized = typeof body.recognized === "string" ? body.recognized : null;
    view.words = Array.isArray(body.words) ? body.words : [];

    if (outcome === "scored") {
      view.showScores = true;
      view.showWords = true;
      view.scores = body.scores && typeof body.scores === "object" ? body.scores : null;
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
  if (body.persisted === true) {
    view.playbackUrl = typeof body.audioUrl === "string" ? body.audioUrl : null;
  } else if (typeof body.persistError === "string") {
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
const ERROR_ACTIONS = {
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

export function interpretError(body) {
  const payload = body && typeof body === "object" ? body : {};
  const code = typeof payload.error === "string" ? payload.error : null;
  const known = code !== null && Object.hasOwn(ERROR_ACTIONS, code);

  return {
    code: code ?? "internal",
    known,
    // message 直接拿来显示是允许的，拿来做分支不行。
    message: typeof payload.message === "string" ? payload.message : "",
    // 未知取值降级成「报 bug」，不崩溃（§5：封闭枚举）。
    ...(known ? ERROR_ACTIONS[code] : ERROR_ACTIONS.internal),
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
