/** `present.js` 的类型声明。理由同 `contract.d.ts`。 */

export declare function band(score: unknown): string | null;

export interface Presentation {
  kind: "scored" | "unreliable" | "no_speech" | "unknown";
  showScores: boolean;
  showWords: boolean;
  recognized: string | null;
  scores: Record<string, unknown> | null;
  words: unknown[];
  notices: string[];
  meta: {
    assessedMs: number | null;
    trimmedMs: number | null;
    snr: number | null;
  };
  playbackUrl: string | null;
  traceId: string | null;
}

export declare function presentResult(data: unknown): Presentation;

export interface ErrorView {
  code: string;
  known: boolean;
  message: string;
  action:
    | "fix_input"
    | "refresh_list"
    | "report_bug"
    | "retry_manually"
    | "check_server_config"
    | "disable_feature";
  blameUser: boolean;
  canRetry: boolean;
}

export declare function interpretError(body: unknown): ErrorView;

export declare const AUTO_RETRY_POST: false;
