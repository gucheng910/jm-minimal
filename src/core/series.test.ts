// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { bookIdOf, isSeriesWork, knownBookId, mergeBookMeta, rememberSeries, clearSeriesMap, seriesMapSize, SERIES_MAP_KEY, visibleChapters } from "./series";
import type { AlbumDetail } from "./types";

const d = (patch: Partial<AlbumDetail>): AlbumDetail => ({ id: 1, name: "x", ...patch });

beforeEach(() => { clearSeriesMap(); localStorage.clear(); });

describe("bookIdOf", () => {
  it("连载：series_id 有效时用它当书 id", () => {
    expect(bookIdOf(d({ id: "413446", series_id: "400222" }))).toBe("400222");
    expect(bookIdOf(d({ id: 413446, series_id: 400222 }))).toBe("400222");
  });
  it("单本：series_id 为 0 / \"0\" / 空 / 缺失 → 书 id = 自身", () => {
    expect(bookIdOf(d({ id: "1470832", series_id: "0" }))).toBe("1470832");
    expect(bookIdOf(d({ id: "1470832", series_id: 0 }))).toBe("1470832");
    expect(bookIdOf(d({ id: "1470832", series_id: "" }))).toBe("1470832");
    expect(bookIdOf(d({ id: "1470832" }))).toBe("1470832");
  });
  it("空值安全", () => {
    expect(bookIdOf(null)).toBe("");
    expect(bookIdOf(undefined)).toBe("");
  });
});

describe("isSeriesWork", () => {
  it("多话为真，空/单元素为假", () => {
    expect(isSeriesWork(d({ series: [{ id: 1 }, { id: 2 }] }))).toBe(true);
    expect(isSeriesWork(d({ series: [{ id: 1 }] }))).toBe(false);
    expect(isSeriesWork(d({ series: [] }))).toBe(false);
    expect(isSeriesWork(d({}))).toBe(false);
  });
});

describe("rememberSeries / knownBookId", () => {
  it("一次回包种入整本书的映射", () => {
    rememberSeries(d({
      id: "413446",
      series_id: "400222",
      series: [{ id: "400222" }, { id: "413446" }, { id: "413447" }]
    }));
    expect(knownBookId("400222")).toBe("400222");
    expect(knownBookId("413446")).toBe("400222");
    expect(knownBookId("413447")).toBe("400222");
    expect(knownBookId(413447)).toBe("400222");
    expect(seriesMapSize()).toBe(3);
  });
  it("单本也记录（书 id = 自身），未收录回落到自身", () => {
    rememberSeries(d({ id: "1470832", series_id: "0" }));
    expect(knownBookId("1470832")).toBe("1470832");
    expect(knownBookId("999999")).toBe("999999");
  });
  it("脏数据不抛错", () => {
    rememberSeries(null);
    rememberSeries(undefined);
    rememberSeries(d({ id: "1", series: [{ id: undefined } as unknown as { id: string }] }));
    expect(knownBookId("1")).toBe("1");
  });
  it("清空后回到回落语义", () => {
    rememberSeries(d({ id: "413446", series_id: "400222", series: [{ id: "413446" }] }));
    clearSeriesMap();
    expect(knownBookId("413446")).toBe("413446");
    expect(localStorage.getItem(SERIES_MAP_KEY)).toBeNull();
  });
});

describe("mergeBookMeta", () => {
  it("用书级字段补全话级空字段，书名保留话级", () => {
    const chapter = d({ id: "413446", name: "痴汉成瘾-第2话", series_id: "400222", author: [], tags: ["慾望"], description: "" });
    const book = d({
      id: "400222", name: "痴汉成瘾", series_id: "400222",
      author: ["小胖手", "红色都市"], tags: ["韩漫", "完结", "慾望"], description: "简介正文",
      series: [{ id: "400222" }, { id: "413446" }]
    });
    const merged = mergeBookMeta(chapter, book);
    expect(merged.name).toBe("痴汉成瘾-第2话");
    expect(merged.author).toEqual(["小胖手", "红色都市"]);
    expect(merged.tags).toEqual(["韩漫", "完结", "慾望"]);
    expect(merged.description).toBe("简介正文");
    expect(merged.series).toHaveLength(2);
    expect(String(merged.id)).toBe("413446");
  });
  it("书级缺失或字段为空时不覆盖话级已有值", () => {
    const chapter = d({ id: "1", author: ["甲"], tags: ["t"], description: "话级简介", series: [{ id: "1" }, { id: "2" }] });
    expect(mergeBookMeta(chapter, null)).toBe(chapter);
    const merged = mergeBookMeta(chapter, d({ id: "1", author: [], tags: [], description: "", series: [] }));
    expect(merged.author).toEqual(["甲"]);
    expect(merged.tags).toEqual(["t"]);
    expect(merged.description).toBe("话级简介");
    expect(merged.series).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────
// v3.9 目录两轴（调研 TOP8 第 4 条）：顺序 + 筛选
// ────────────────────────────────────────────────
describe("visibleChapters：目录的顺序与筛选（纯函数）", () => {
  const chap = (id: number | string, sort?: number | string) => ({ id, sort });
  /** 服务端给的顺序**故意不是**按 sort 排好的（实测真的有这种回包） */
  const MESSY = [chap(3, 3), chap(1, 1), chap(2, 2)];
  const ASC = [chap(10, 10), chap(11, 11), chap(12, 12)];
  const none = new Map<string, { pages: number }>();

  it("【红线】默认档（正序 + 全部）**原样返回服务端给的顺序**（不排序、不动身份）", () => {
    const out = visibleChapters(MESSY, "asc", "all", none);
    expect(out.map((c) => c.id)).toEqual([3, 1, 2]);          // 乱序也照原样
    expect(out[0]).toBe(MESSY[0]);                            // 同一个对象引用
    expect(visibleChapters([], "asc", "all", none)).toEqual([]);
  });

  it("★ 倒序按 **sort** 排，不是 reverse()（服务端顺序不可信时这一点才是对的）", () => {
    // reverse 会给 [2,1,3]；按 sort 倒序应当是 [3,2,1]
    expect(visibleChapters(MESSY, "desc", "all", none).map((c) => c.id)).toEqual([3, 2, 1]);
    expect(visibleChapters(ASC, "desc", "all", none).map((c) => c.id)).toEqual([12, 11, 10]);
  });

  it("倒序：sort 无效（缺失 / 0 / 非数字）的项排到最后，且它们之间保持原相对顺序", () => {
    const s = [chap("a"), chap("b", 2), chap("c", 0), chap("d", 1), chap("e", "x")];
    expect(visibleChapters(s, "desc", "all", none).map((c) => c.id)).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("倒序：sort 相同时保持服务端给的相对顺序（稳定）", () => {
    const s = [chap("p", 5), chap("q", 5), chap("r", 5)];
    expect(visibleChapters(s, "desc", "all", none).map((c) => c.id)).toEqual(["p", "q", "r"]);
  });

  it("★ 筛选只看**有页**的缓存（只有封面的目录读不了，必须被筛掉）", () => {
    const cached = new Map<string, { pages: number }>([
      ["1", { pages: 20 }],      // 有页 → 算
      ["2", { pages: 0 }],       // 只有封面 → 不算（点开会是空阅读器）
      ["99", { pages: 5 }]       // 不在本书里 → 不影响
    ]);
    expect(visibleChapters(MESSY, "asc", "cached", cached).map((c) => c.id)).toEqual([1]);
  });

  it("筛选 + 倒序可以叠加（先筛后排）", () => {
    const cached = new Map<string, { pages: number }>([["1", { pages: 3 }], ["3", { pages: 3 }]]);
    expect(visibleChapters(MESSY, "desc", "cached", cached).map((c) => c.id)).toEqual([3, 1]);
  });

  it("一话都没缓存 → 空数组（调用方据此显示「本地没有缓存的话」空态，不是只留一个空盒子）", () => {
    expect(visibleChapters(ASC, "asc", "cached", none)).toEqual([]);
    expect(visibleChapters(ASC, "desc", "cached", none)).toEqual([]);
  });
});
