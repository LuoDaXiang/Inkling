# M3 结果区 —— 对照 M2 的比对结果

迁移计划 M3.8 的验收：**「对照物是 M2.5-pre 存的截图，肉眼比对一致才算过」**。
这里存的是 React 版的同一组截图，和 `docs/m2-baseline/` 逐张对照。

| 这里 | 对照 | 结论 |
| --- | --- | --- |
| `01-word-marks-8-combos.png` | `../m2-baseline/01-word-marks-8-combos.jpg` | 一致 |
| `02-phoneme-popover.png` | `../m2-baseline/02-phoneme-popover.png` | 一致 |
| `03-pitch-and-scores.png` | `../m2-baseline/03-pitch-and-scores.png` | 一致，一处**数据**差异见下 |

## 怎么重新生成

```bash
npm run dev            # Electron 起来，同时起 Vite dev server
# 浏览器打开 http://localhost:5173/preview.html
```

`preview.html` + `src/renderer/preview.tsx` 是**开发用的对照页，不进打包产物**
（Forge 的渲染层只有 `index.html` 一个入口）。它存在的唯一理由就是这次比对：
真实界面要录音才出得来结果区，而一次真实录音不可复现，当不了对照物。
fixture 和 `docs/m2-baseline/index.html` 里那份**逐字相同**——换了数据再比，
比的就是数据不是界面。

## 逐块比对

**逐词三层标记**：八种组合的底色、下划线粗细、右上角标全部一致；
漏读的删除线、多读的斜体灰、「Monotone 折进第二层不进底色」也一致。
顺序、间距、圆角、配色都对得上——配色能对上是因为
`src/renderer/styles.css` 里那组变量是从 `public/app.css` **原样搬**的，
不是重新配的。

**音素弹出层**：横向一列一个音素、`th` 标成 weak、只显示分档不显示原始分数。
一致。

**音高曲线 / 分数 / 文案 / 元信息**：曲线形状、两条线的颜色、`null` 处的断口、
图例、`126–236 Hz` 的范围标注全部一致；分数是「不错 / 不错 / 可懂」，
准确度高亮排第一；元信息三行的对齐和内容一致。

## 一处差异，是数据不是界面

M2 存档里那句文案写的是「**5** 个词念得不准」，这里是「**6** 个词」。

原因：M2 的存档页那句是**写死的字符串**（那一页只渲染结果区，没有走
`presentResult` 的计数逻辑）；React 版是从 `words` 真算出来的。
两边的 `words` 是同一份 fixture——11 个词里底色不是 `ok` 的确实有 6 个
（8 种组合里 4 个念错，加上漏读、多读）。

也就是说：**M2 那张图上的 5 是当时手写错的，M3 这张图上的 6 是算出来的。**
界面没有变，变的是那个数字第一次由代码负责。
