import { describe, it, expect } from "vitest";
import { authorNames, albumTags, parsePaid } from "./albumMeta";
import type { AlbumDetail } from "./types";

const d = (patch: Partial<AlbumDetail>): AlbumDetail => ({ id: 1, name: "x", ...patch });

describe("authorNames", () => {
  it("数组形式逐项 trim 并过滤空值", () => {
    expect(authorNames(d({ author: [" 甲 ", "", "乙"] }))).toEqual(["甲", "乙"]);
  });
  it("字符串形式（列表乐观快照）按 / 拆分", () => {
    expect(authorNames(d({ author: "甲/乙" as unknown as string[] }))).toEqual(["甲", "乙"]);
  });
  it("缺失或类型异常返回空数组", () => {
    expect(authorNames(null)).toEqual([]);
    expect(authorNames(d({ author: undefined }))).toEqual([]);
    expect(authorNames(d({ author: 123 as unknown as string[] }))).toEqual([]);
  });
});

describe("albumTags", () => {
  it("一律转字符串（防止非字符串被当 React 子节点渲染而白屏）", () => {
    expect(albumTags(d({ tags: ["巨乳", "", 42 as unknown as string] }))).toEqual(["巨乳", "42"]);
  });
  it("非数组返回空数组", () => {
    expect(albumTags(d({ tags: "巨乳" as unknown as string[] }))).toEqual([]);
    expect(albumTags(null)).toEqual([]);
  });
});

describe("parsePaid", () => {
  it("无价格 / 价格非法 → 未付费限制", () => {
    expect(parsePaid(d({ price: "" }))).toBe(false);
    expect(parsePaid(d({ price: "0" }))).toBe(false);
    expect(parsePaid(d({ price: "abc" }))).toBe(false);
  });
  it("有价格且未购买 → 需要购买", () => {
    expect(parsePaid(d({ price: "5" }))).toBe(true);
    expect(parsePaid(d({ price: "5", purchased: "0" }))).toBe(true);
    expect(parsePaid(d({ price: "5", purchased: false }))).toBe(true);
  });
  it("已购买（各种真值形态）→ 不再限制", () => {
    expect(parsePaid(d({ price: "5", purchased: true }))).toBe(false);
    expect(parsePaid(d({ price: "5", purchased: "1" }))).toBe(false);
    expect(parsePaid(d({ price: "5", purchased: "true" }))).toBe(false);
  });
});
