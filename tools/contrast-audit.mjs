// 设计令牌对比度审计（读 src/index.css 的真实取值，不再硬编码 —— 硬编码会随改版一起过期）
//   node scripts/contrast-warm.mjs
// 任何一条不达 WCAG AA 就 exit 1，改色时会被拦住（可挂进 CI）。
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

/** 取某个选择器块里的令牌值（接受 #RGB 与 #RRGGBB，统一展开成 6 位） */
function token(name, scope = ":root") {
  const start = css.indexOf(scope + " {");
  if (start < 0) throw new Error("找不到作用域 " + scope);
  const block = css.slice(start, css.indexOf("\n}", start));
  const m = block.match(new RegExp("--" + name + ":\\s*#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})\\b"));
  if (!m) throw new Error("找不到令牌 --" + name + "（作用域 " + scope + "）");
  const hex = m[1];
  return "#" + (hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex);
}

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h) => {
  const [r, g, b] = hex2rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

const DARK = '[data-theme="dark"]';
let failed = 0;
function check(label, fg, bg, min) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) failed += 1;
  console.log("  " + (ok ? "✓" : "✗") + " " + label.padEnd(36) + fg + " on " + bg + " = " + r.toFixed(2) + "  (需 ≥ " + min + ")");
}

const paper = token("bg");
const surface = token("surface");
console.log("=== 浅色（纸 " + paper + " / 卡 " + surface + "）===");
check("正文 --ink", token("ink"), paper, 7);
check("正文 --ink（卡片上）", token("ink"), surface, 7);
check("次级 --ink-2", token("ink-2"), paper, 4.5);
check("三级 --ink-3（.muted / 13px 元信息）", token("ink-3"), paper, 4.5);
check("三级 --ink-3（卡片上）", token("ink-3"), surface, 4.5);
check("链接 --link", token("link"), paper, 4.5);
check("成功 --ok on --ok-soft", token("ok"), token("ok-soft"), 4.5);
check("错误 --err on --err-soft", token("err"), token("err-soft"), 4.5);

const dpaper = token("bg", DARK);
const dsurf = token("surface", DARK);
console.log("=== 深色（底 " + dpaper + " / 卡 " + dsurf + "）===");
check("正文 --ink", token("ink", DARK), dpaper, 7);
check("次级 --ink-2", token("ink-2", DARK), dpaper, 4.5);
check("三级 --ink-3", token("ink-3", DARK), dpaper, 4.5);
check("链接 --link", token("link", DARK), dpaper, 4.5);

const rbg = token("reader-bg");
console.log("=== 阅读器（恒定深色 " + rbg + "）===");
check("次级文字 --reader-ink-2", token("reader-ink-2"), rbg, 4.5);
check("三级文字 --reader-ink-3", token("reader-ink-3"), rbg, 4.5);

console.log("=== 行宽参考（不参与判定）===");
console.log("  14px 正文，34 汉字 = " + Math.round(14 * 34) + "px；36 汉字 = " + Math.round(14 * 36) + "px；65ch(西文) ≈ " + Math.round(14 * 0.5 * 65) + "px");

console.log("");
if (failed > 0) {
  console.log("对比度审计未通过：" + failed + " 项低于阈值");
  process.exit(1);
}
console.log("对比度审计通过：全部达到 WCAG AA");
