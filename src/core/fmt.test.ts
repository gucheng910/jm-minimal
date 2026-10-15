import { describe, it, expect } from "vitest";
import { fmtCount, fmtDate } from "./fmt";

describe("fmtCount（数据条计数）", () => {
  it("缺失 / 0 / 非法一律空串（调用方不显示该段）", () => {
    expect(fmtCount(undefined)).toBe("");
    expect(fmtCount(null)).toBe("");
    expect(fmtCount("")).toBe("");
    expect(fmtCount(0)).toBe("");
    expect(fmtCount(-5)).toBe("");
    expect(fmtCount("abc")).toBe("");
  });
  it("千以下原样千分位", () => {
    expect(fmtCount(4210)).toBe("4,210");
  });
  it("一万以上进“万”，整数万不带 .0", () => {
    expect(fmtCount(12345)).toBe("1.2 万");
    expect(fmtCount(20000)).toBe("2 万");
    expect(fmtCount("98765")).toBe("9.9 万");
  });
  it("一亿以上进“亿”", () => {
    expect(fmtCount(123000000)).toBe("1.2 亿");
  });
});

describe("fmtDate（收录日期）", () => {
  it("缺失 / 空串 → 空串", () => {
    expect(fmtDate(undefined)).toBe("");
    expect(fmtDate("")).toBe("");
  });
  it("字符串日期只留 YYYY-MM-DD", () => {
    expect(fmtDate("2024-05-11 12:33:44")).toBe("2024-05-11");
    expect(fmtDate("2024-05-11")).toBe("2024-05-11");
  });
  it("秒 / 毫秒时间戳都归一（UTC 容差：只断言格式与年份）", () => {
    const sec = fmtDate(1715400000);       // 2024-05-11 前后
    const ms = fmtDate(1715400000000);
    expect(sec).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ms).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sec.slice(0, 4)).toBe("2024");
  });
  it("认不出的值原样返回，绝不显示 Invalid Date", () => {
    expect(fmtDate("未知")).toBe("未知");
  });
});
