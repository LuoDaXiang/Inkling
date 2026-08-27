/**
 * 客户端这一侧的契约层。
 *
 * 见 `docs/api-contract.md`。这个文件里**没有任何 DOM 操作**——它只负责
 * 「按契约该发什么请求」和「拿到的东西合不合契约」，界面怎么画是别人的事。
 *
 * ## 为什么这样切
 *
 * 契约 §14 的十条客户端测试守的是 §8 那七条承诺，而**服务端一条都验不了**：
 * 它拿到的只是一串浮点数，无从判断采样率对不对。所以这些只能在客户端测。
 *
 * 而客户端唯一测不了的部分是 DOM 和浏览器 API。把逻辑抽出来之后，
 * 测不了的那一层就只剩「把决定画到屏幕上」这一步——
 * 和录音层用的是同一个策略（浏览器只负责拿到采样，转换/修剪/编码全在 core/）。
 *
 * ## 界面是草稿，这个文件不是
 *
 * 这里的东西由契约决定，不由布局决定。界面重画多少次，这些函数都不用改。
 */

/**
 * 客户端内置的契约版本。
 *
 * **和服务端那份重复是刻意的**——它们正是要比对的两端（[C1] [C4]）。
 * 适用条件是「客户端与服务端同仓库、同版本发布」，这个字段让那个假设
 * 可被检测。声明一个假设而不给检测手段，等于没有假设。
 */
export const CONTRACT_VERSION = "v0";

/** 契约被违反时抛这个。和网络错误分开，因为处置完全不同。 */
export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

/** `GET /api/config` 必须给的数值字段。少一个就没法工作。 */
const REQUIRED_NUMBERS = [
  "recordingSampleRate",
  "maxRecordingSeconds",
  "maxUploadBytes",
  "maxReferenceChars",
  "maxTitleChars",
  "maxSentencesPerMaterial",
];

/**
 * 启动时取一次共享常量（[C3]）。
 *
 * **版本不匹配必须明确报错并停止**（[C4]），不能继续以诡异的方式工作——
 * 那正是这个字段存在的全部理由。
 *
 * 对**多出来的字段宽容**：契约 §15 明写「新增响应字段」不算破坏性变更，
 * 所以见到不认识的字段要当没看见，而不是报错。严格校验会让服务端
 * 加一个字段就打死所有老客户端。
 *
 * @param {{ fetch?: typeof globalThis.fetch }} [deps] 注入点，测试用。
 */
export async function loadConfig(deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  let res;
  try {
    res = await fetchImpl("/api/config");
  } catch (err) {
    // 网络错误不是契约违反，分开报——用户能做的事不同。
    throw new Error(`取不到服务端配置：${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    throw new Error(`取服务端配置失败，HTTP ${res.status}`);
  }

  let config;
  try {
    config = await res.json();
  } catch {
    throw new ContractError("服务端配置不是合法 JSON");
  }

  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new ContractError("服务端配置不是一个对象");
  }

  if (config.contractVersion !== CONTRACT_VERSION) {
    throw new ContractError(
      `契约版本不匹配：客户端是 ${CONTRACT_VERSION}，服务端是 ${String(config.contractVersion)}。` +
        `客户端与服务端必须同版本发布，请刷新页面或重新部署。`,
    );
  }

  for (const name of REQUIRED_NUMBERS) {
    const value = config[name];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new ContractError(`服务端配置的 ${name} 不是正整数：${String(value)}`);
    }
  }

  if (typeof config.scoringAvailable !== "boolean") {
    throw new ContractError("服务端配置的 scoringAvailable 不是布尔");
  }

  return config;
}

/**
 * 能不能录音（[C5]）。
 *
 * 评分没配的时候要**在界面上直接禁用录音入口**，而不是让用户录完 30 秒
 * 再吃一个 503。这个函数只做判断，禁用长什么样是界面的事。
 */
export function canRecord(config) {
  return config?.scoringAvailable === true;
}

/**
 * 拼 `POST /api/assess` 的查询串。
 *
 * 几条容易写错的规矩都在这里钉死：
 *
 * - **`sentenceId` 与 `reference` 只能给一个**（[C24]）。服务端会拒，
 *   但客户端也不该发出去——那是一个本可以在本地发现的错误。
 * - **capture 参数缺席就不传**，不要传 `"false"`（[C27]）。
 *   `NULL`（不知道）和 `false`（确定没开）在库里是两个不同的事实，
 *   把「读不到」写成「没开」是在记录一个假的事实。
 * - **`sentenceId` 原样透传，不做形状校验**（[C7] [C55]）。
 *   它是不透明标识符，当前实现是自增整数但形状将来可能变。
 *   在这里写一个 `/^\d+$/` 就是把「现在是整数」变成了一条约束。
 */
export function buildAssessQuery(input) {
  const { sentenceId, reference, clientRequestId, capture } = input ?? {};

  const hasSentence = sentenceId !== undefined && sentenceId !== null;
  const hasReference = reference !== undefined && reference !== null;

  if (hasSentence && hasReference) {
    throw new ContractError("sentenceId 与 reference 只能给一个");
  }
  if (!hasSentence && !hasReference) {
    throw new ContractError("必须给 sentenceId 或 reference 其中之一");
  }

  const q = new URLSearchParams();
  if (hasSentence) q.set("sentenceId", String(sentenceId));
  else q.set("reference", String(reference));

  if (clientRequestId !== undefined && clientRequestId !== null) {
    q.set("clientRequestId", String(clientRequestId));
  }

  for (const name of ["echoCancellation", "noiseSuppression", "autoGainControl"]) {
    const value = capture?.[name];
    // 只有真的读到布尔才发。undefined 表示浏览器没告诉我们，那就别猜。
    if (typeof value === "boolean") q.set(name, value ? "true" : "false");
  }

  return q;
}

/**
 * 生成 `clientRequestId`（[C48]）。
 *
 * v0 服务端只把它记进流水，不做去重——它是给 F4（in-flight 去重）
 * **预留的位置**。预留一个字段比将来加一个字段便宜一个数量级：
 * 加字段要两端同时改并兼容旧客户端，预留只要现在多写一行。
 */
export function newClientRequestId(random = globalThis.crypto) {
  return random.randomUUID();
}

/**
 * 从 `MediaStreamTrack` 回读三个音频开关（[C27] [C51]）。
 *
 * **必须是 `getSettings()` 的回读值，不是我们请求的值**——浏览器可以无视
 * constraint。读不到就不填，落库为 `NULL`（不知道），而不是 `false`（确定没开）。
 *
 * 这三个开关对发音评分是有害的：AGC 抹平重音和语调动态，降噪削掉
 * /s/ /f/ /θ/ 的高频能量，而准确度是主打维度。所以真实生效值必须记下来——
 * 否则同一个人同一句话换个浏览器分数不一样，而差异不在我们的代码里。
 */
export function captureFlagsFrom(track) {
  const out = {};
  if (!track || typeof track.getSettings !== "function") return out;

  let settings;
  try {
    settings = track.getSettings();
  } catch {
    // 某些浏览器在轨道已结束时会抛。读不到就是不知道，不是失败。
    return out;
  }
  if (settings === null || typeof settings !== "object") return out;

  for (const name of ["echoCancellation", "noiseSuppression", "autoGainControl"]) {
    const value = settings[name];
    // 不做类型强转：拿到 1 / "true" / undefined 一律当成「没读到」。
    // 强转会把一个猜测记录成事实。
    if (typeof value === "boolean") out[name] = value;
  }
  return out;
}
