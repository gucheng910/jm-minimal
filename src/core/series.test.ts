// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { bookIdOf, isSeriesWork, knownBookId, mergeBookMeta, rememberSeries, clearSeriesMap, seriesMapSize, SERIES_MAP_KEY } from "./series";
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
