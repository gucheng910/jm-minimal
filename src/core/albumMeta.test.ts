import { describe, it, expect } from "vitest";
import { authorNames, albumTags, isPurchased, parsePaid, priceOf } from "./albumMeta";
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

describe("parsePaid / isPurchased（判据必须与官方 Detail.tsx:200 一致）", () => {
  it("无价格 / 价格非法 → 非付费内容，谈不上购买", () => {
    expect(parsePaid(d({ price: "" }))).toBe(false);
    expect(parsePaid(d({ price: "0" }))).toBe(false);
    expect(parsePaid(d({ price: "abc" }))).toBe(false);
  });

  it("官方真值表：非空字符串（含 \"0\"/\"false\"）与空串都算已购", () => {
    // 官方 isPurchased = purchased || purchased === ""，以下全部为真值 → 不应再要钱
    expect(parsePaid(d({ price: "5", purchased: "" }))).toBe(false);
    expect(parsePaid(d({ price: "5", purchased: "0" }))).toBe(false);
    expect(parsePaid(d({ price: "5", purchased: "false" }))).toBe(false);
    expect(parsePaid(d({ price: "5", purchased: "1" }))).toBe(false);
    expect(parsePaid(d({ price: "5", purchased: "true" }))).toBe(false);
    expect(parsePaid(d({ price: "5", purchased: "xxx" }))).toBe(false);
    expect(parsePaid(d({ price: "5", purchased: 1 }))).toBe(false);
    expect(parsePaid(d({ price: "5", purchased: true }))).toBe(false);
  });

  it("只有「假值且非空串」才算未购", () => {
    expect(parsePaid(d({ price: "5" }))).toBe(true);
    expect(parsePaid(d({ price: "5", purchased: undefined }))).toBe(true);
    expect(parsePaid(d({ price: "5", purchased: null }))).toBe(true);
    expect(parsePaid(d({ price: "5", purchased: 0 }))).toBe(true);
    expect(parsePaid(d({ price: "5", purchased: false }))).toBe(true);
  });

  it("isPurchased 对空串与缺失的区分（官方特判分支）", () => {
    expect(isPurchased(d({ purchased: "" }))).toBe(true);
    expect(isPurchased(d({ purchased: "0" }))).toBe(true);
    expect(isPurchased(d({ purchased: undefined }))).toBe(false);
    expect(isPurchased(null)).toBe(false);
  });
});

describe("priceOf（只用于展示应付金额）", () => {
  it("有效金额返回数值", () => {
    expect(priceOf(d({ price: "5" }))).toBe(5);
    expect(priceOf(d({ price: 30 as unknown as string }))).toBe(30);
  });
  it("缺失 / 非法 / 非正数一律 0", () => {
    expect(priceOf(d({ price: "" }))).toBe(0);
    expect(priceOf(d({ price: "0" }))).toBe(0);
    expect(priceOf(d({ price: "-3" }))).toBe(0);
    expect(priceOf(d({ price: "abc" }))).toBe(0);
    expect(priceOf(null)).toBe(0);
  });
});
