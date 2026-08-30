/**
 * Tailwind v3。
 *
 * 语义色走 CSS 变量（见 `src/renderer/styles.css`），不写死十六进制——
 * 组件里散着的字面色值一改就得全局搜索，而搜索漏掉的那一处不会报错，
 * 只是颜色不对。
 */
export default {
  content: ["./index.html", "./src/renderer/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "var(--line)",
        input: "var(--line)",
        ring: "var(--accent)",
        background: "var(--ground)",
        foreground: "var(--ink)",
        primary: { DEFAULT: "var(--accent)", foreground: "var(--ground)" },
        secondary: { DEFAULT: "var(--surface-2)", foreground: "var(--ink)" },
        muted: { DEFAULT: "var(--surface-2)", foreground: "var(--muted-ink)" },
        card: { DEFAULT: "var(--surface)", foreground: "var(--ink)" },
        popover: { DEFAULT: "var(--surface-2)", foreground: "var(--ink)" },
        destructive: { DEFAULT: "var(--bad)", foreground: "#fff" },
      },
    },
  },
  plugins: [],
};
