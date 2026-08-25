/**
 * `recorder.js` 的类型声明。
 *
 * `public/` 不在 tsconfig 的 include 里（它是浏览器代码，不参与服务端构建），
 * 所以 `tests/contract-consistency.test.ts` import 它时拿不到类型。
 *
 * 这个文件只为那一条跨层一致性测试存在——它必须能读到客户端**真实的**
 * 那份常量，而不是服务端常量的副本。见 docs/api-contract.md 测试清单 #27。
 */

export declare const TARGET_SAMPLE_RATE: number;

export declare class Recorder {
  constructor(onEvent: (event: { type: string }) => void);
  start(constraints: Record<string, boolean>): Promise<void>;
  cancel(): Promise<void>;
}
