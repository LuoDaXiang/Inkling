/**
 * `contract.js` 的类型声明。
 *
 * `public/` 不在 tsconfig 的 include 里（它是浏览器代码，不参与服务端构建），
 * 所以 `tests/client/` 里 import 它时拿不到类型。沿用 `recorder.d.ts` 的做法。
 */

export declare const CONTRACT_VERSION: string;

export declare class ContractError extends Error {}

export interface ClientConfig {
  contractVersion: string;
  recordingSampleRate: number;
  maxRecordingSeconds: number;
  maxUploadBytes: number;
  maxReferenceChars: number;
  maxTitleChars: number;
  maxSentencesPerMaterial: number;
  scoringAvailable: boolean;
}

export declare function loadConfig(deps?: {
  fetch?: (input: string) => Promise<Response>;
}): Promise<ClientConfig>;

export declare function canRecord(config: unknown): boolean;

export interface CaptureFlags {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export declare function buildAssessQuery(input: {
  sentenceId?: unknown;
  reference?: unknown;
  clientRequestId?: unknown;
  capture?: CaptureFlags;
}): URLSearchParams;

export declare function newClientRequestId(random?: { randomUUID(): string }): string;

export declare function captureFlagsFrom(track: unknown): CaptureFlags;
