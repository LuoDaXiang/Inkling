/**
 * 组件测试的公共准备。
 *
 * 两件事，都不做别的：
 *
 * 1. 装 `@testing-library/jest-dom` 的匹配器。
 * 2. **每条用例之后卸载**。vitest 默认 `globals: false`，
 *    而 RTL 的自动清理是挂在全局 `afterEach` 上的——不显式接上的话，
 *    上一条用例渲染的 DOM 会留在文档里，`getAllByTestId` 一路累加。
 *    表现是「单跑一条绿，连起来跑红」，而且看起来像组件坏了。
 *
 * **不在这里造任何全局桩**——一个在 setup 里被静默 mock 掉的浏览器 API，
 * 会让用例在「它其实不工作」的情况下变绿。要桩就在用到它的那个文件里
 * 显式桩，读得到。
 */
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
});
