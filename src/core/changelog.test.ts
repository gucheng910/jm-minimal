// @vitest-environment jsdom
/** 内置更新日志（v3.16）：格式与"找不到就不弹"这两条是界面依赖的契约。 */
import { describe, expect, it } from "vitest";
import { CHANGELOG, changelogFor, changelogText, currentChangelog } from "./changelog";
import { LOCAL_VERSION } from "./constants";

describe("内置更新日志表", () => {
  it("★ 当前版本必须有条目 —— 否则用户装完新版什么也看不到", () => {
    const e = currentChangelog();
    expect(e, "CHANGELOG 里没有 " + LOCAL_VERSION + " 的条目").not.toBeNull();
    expect(e && e.items.length).toBeGreaterThan(0);
  });

  it("格式：版本号不带 v、日期是 YYYY-MM-DD、每条都不为空", () => {
    for (const e of CHANGELOG) {
      expect(e.version).toMatch(/^\d+(\.\d+)*$/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.title.trim().length).toBeGreaterThan(0);
      // 只要求"非空"（trim 后 > 0）：这条断言的本意是拦住空串/纯空白条目。
      // 原来写的是 > 4，但补丁版可以只有一条**字面的**「无」（2.3.2 就是按用户要求这么写的），
      // 中文一个字就够表达"没更新内容"，阈值卡长度会把它误判成坏条目。
      for (const item of e.items) expect(item.trim().length).toBeGreaterThan(0);
    }
  });

  it("版本号唯一（重复条目会让 changelogFor 只认第一条、另一条永远看不到）", () => {
    const vs = CHANGELOG.map((e) => e.version);
    expect(new Set(vs).size).toBe(vs.length);
  });

  it("找不到的版本 → null（界面据此不弹，而不是弹一个空壳）", () => {
    expect(changelogFor("0.0.1")).toBeNull();
    expect(changelogFor("")).toBeNull();
    expect(changelogFor(" v2.2.7 ")).toBeNull();   // 不做 trim / 去 v 的宽容匹配：格式必须严
  });

  it("正文格式：一行一条、带「· 」前缀；没有条目就是空串", () => {
    const txt = changelogText(currentChangelog());
    expect(txt.split("\n").length).toBe((currentChangelog() as { items: string[] }).items.length);
    expect(txt.startsWith("· ")).toBe(true);
    expect(changelogText(null)).toBe("");
    expect(changelogText({ version: "9", date: "2026-01-01", title: "t", items: [] })).toBe("");
  });
});
