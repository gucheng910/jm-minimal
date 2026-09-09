// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { sanitizeCommentHtml } from "./commentRich";

describe("sanitizeCommentHtml", () => {
  it("空输入返回空串", () => {
    expect(sanitizeCommentHtml("")).toBe("");
  });

  it("保留白名单标签与安全属性", () => {
    const out = sanitizeCommentHtml('<p>你好 <b>粗体</b> <a href="https://a.com" title="t">链接</a></p>');
    expect(out).toContain("<p>");
    expect(out).toContain("<b>粗体</b>");
    expect(out).toContain('href="https://a.com"');
    expect(out).toContain('title="t"');
  });

  it("删除 script/iframe/style 等高危节点，但保留正常文本", () => {
    const out = sanitizeCommentHtml('<p>ok</p><script>alert(1)</script><iframe src="https://x"></iframe><style>body{display:none}</style>');
    expect(out).not.toMatch(/<script|<iframe|<style/i);
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("ok");
  });

  it("剥离 on* 事件属性", () => {
    const out = sanitizeCommentHtml('<img src="https://a/x.png" onerror="alert(1)" onclick="alert(2)">');
    expect(out).not.toMatch(/onerror|onclick/i);
    expect(out).toContain('src="https://a/x.png"');
  });

  it("只允许 http(s)/mailto/相对路径的 href 与 src", () => {
    expect(sanitizeCommentHtml('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
    expect(sanitizeCommentHtml('<img src="data:text/html;base64,xxx">')).not.toContain("data:");
    expect(sanitizeCommentHtml('<a href="/relative">x</a>')).toContain('href="/relative"');
    expect(sanitizeCommentHtml('<a href="mailto:a@b.c">x</a>')).toContain("mailto:a@b.c");
  });

  it("style 里出现 url()/expression/@import/javascript: 时整条属性删除", () => {
    const out = sanitizeCommentHtml('<span style="background:url(javascript:alert(1))">x</span>');
    expect(out).not.toContain("url(");
    expect(sanitizeCommentHtml('<span style="color:red">x</span>')).toContain("color:red");
  });

  it("非白名单标签去壳但保留内部文本与合法子标签", () => {
    const out = sanitizeCommentHtml("<custom-tag>保留我<em>内部</em></custom-tag>");
    expect(out).not.toContain("custom-tag");
    expect(out).toContain("保留我");
    expect(out).toContain("<em>内部</em>");
  });

  it("emoji span 还原为 unicode 字符", () => {
    expect(sanitizeCommentHtml('<span class="emoji emoji1f600"></span>')).toBe("😀");
  });

  it("非法码点的 emoji class 保持原样且不抛错", () => {
    const out = sanitizeCommentHtml('<span class="emoji emoji110000"></span>');
    expect(out).toContain("span");
  });
});
