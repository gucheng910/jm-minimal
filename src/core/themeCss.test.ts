// @vitest-environment node
/**
 * CSS 主题规则的结构约束（防止 2026-09-13 那个「暗色下蓝字看不见」的 bug 复发）。
 *
 * 事故回顾：暗色块里有一句
 *     [data-theme="dark"] button { background: #F2F0E5; color: #1C1B1A; }
 * 它的选择器权重是 (0,1,1) —— 一个属性选择器 + 一个类型选择器，
 * **高于** .link / .backtxt / .d-more 这类 (0,1,0) 的类规则。
 * 结果详情页的作者/标签蓝字被染成 #1C1B1A，在 #100F0F 底上对比度只有 1.04:1（等于看不见）。
 * 浅色模式没暴露，是因为基类只有 `button { color: #fff }`（0,0,1），输给类规则。
 *
 * 约束：**主题规则不许把裸标签当主体**（`button`、`input, select` 这种）。
 * 要改裸标签的颜色/底色，就加令牌（--btn-ink / --field-bg）让基类引用 ——
 * 基类是 (0,0,1)，永远输给类规则，组件各写各的颜色就不会被抢。
 * `.foo button`、`button.ghost` 这类带限定的是允许的：它们只命中特定组件。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 统一成 LF：仓库在 Windows 上是 CRLF 检出，按 "\n}" 找块尾会落空。
// 同时剥掉注释：本文件的说明文字里就写着那句出事的规则，不剥会把注释也当成一条规则。
const css = readFileSync(new URL("../index.css", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** 抽出所有 `[data-theme="dark"] ...` 规则的完整选择器与声明体 */
function darkRules(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /(\[data-theme="dark"\][^{}]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

/**
 * 该规则里有没有「裸标签主体」。
 * 把选择器按逗号拆开，每段去掉开头的 [data-theme="dark"] 前缀后，
 * 若整段就是一个元素名（button / input …），就是危险写法。
 */
function bareTagSubjects(selector: string): string[] {
  return selector
    .split(",")
    .map((s) => s.trim().replace(/^\[data-theme="dark"\]\s*/, "").trim())
    .filter((s) => /^[a-z][a-z0-9]*$/i.test(s));
}

/** 取某个块（`:root {` 或 `[data-theme="dark"] {`）的文本 */
function block(startMarker: string): string {
  const start = css.indexOf(startMarker);
  expect(start, "找不到块 " + startMarker).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start));
}

const HEX = "#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})\\b";

describe("index.css 主题规则约束", () => {
  it("暗色规则不得把裸标签当主体（权重 (0,1,1) 会压过 (0,1,0) 的类规则）", () => {
    const offenders = darkRules()
      .filter((r) => bareTagSubjects(r.selector).length > 0)
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it("裸标签主题规则一条都没有（含只有背景的）", () => {
    const offenders = darkRules()
      .filter((r) => /(^|[\s;{])(color|background|background-color)\s*:/.test(r.body))
      .filter((r) => bareTagSubjects(r.selector).length > 0)
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });

  it("反色按钮的前景色必须是令牌，且两套主题都定义", () => {
    expect(block(":root {")).toMatch(new RegExp("--btn-ink:\\s*" + HEX));
    expect(block('[data-theme="dark"] {')).toMatch(new RegExp("--btn-ink:\\s*" + HEX));
    expect(css).toMatch(/button \{[^}]*color:\s*var\(--btn-ink\)/);
  });

  it("输入控件填充色必须是令牌，且两套主题都定义", () => {
    expect(block(":root {")).toMatch(/--field-bg:\s*var\(--surface\)/);
    expect(block('[data-theme="dark"] {')).toMatch(/--field-bg:\s*var\(--surface-2\)/);
    expect(css).toMatch(/select, input, textarea \{[^}]*background:\s*var\(--field-bg\)/);
  });

  it("--link 在两套主题下都有值（详情页作者/标签靠它上色）", () => {
    expect(block(":root {")).toMatch(new RegExp("--link:\\s*" + HEX));
    expect(block('[data-theme="dark"] {')).toMatch(new RegExp("--link:\\s*" + HEX));
    expect(css).toMatch(/\.link \{[^}]*color:\s*var\(--link\)/);
  });
});
