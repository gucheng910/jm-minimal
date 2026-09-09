// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { loadHistory, saveHistory, HISTORY_MAX, type HistoryEntry } from "./history";
import { flushPendingWrites } from "./debounceStorage";
import { rememberSeries, clearSeriesMap } from "./series";
import { UI_KEYS } from "./constants";
import type { AlbumDetail } from "./types";

const entry = (patch: Partial<HistoryEntry>): HistoryEntry => ({
  id: "413446", bookId: "400222", name: "痴汉成瘾", lastReadAt: 1000, ...patch
});

const album = (patch: Partial<AlbumDetail>): AlbumDetail => ({ id: 1, name: "x", ...patch });

beforeEach(() => {
  // 防抖写入是模块级状态：先落盘再清空，避免测试间互相污染
  flushPendingWrites();
  localStorage.clear();
  clearSeriesMap();
});

describe("loadHistory 迁移", () => {
  it("旧格式（AlbumSummary[]）自动升级：补 bookId 与时间戳，顺序保持", () => {
    localStorage.setItem(UI_KEYS.history, JSON.stringify([
      { id: "111", name: "甲", author: "A", adddate: "2026-01-01", description: "d1" },
      { id: "222", name: "乙" }
    ]));
    const list = loadHistory();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("111");
    expect(list[0].bookId).toBe("111");
    expect(list[0].author).toBe("A");
    expect(list[0].lastReadAt).toBeGreaterThan(list[1].lastReadAt);
  });

  it("旧条目按 seriesMap 归到同一本书并合并", () => {
    rememberSeries(album({ id: "400222", series_id: "400222", series: [{ id: "400222" }, { id: "413446" }] }));
    localStorage.setItem(UI_KEYS.history, JSON.stringify([
      { id: "413446", name: "痴汉成瘾-第2话" },
      { id: "400222", name: "痴汉成瘾" }
    ]));
    const list = loadHistory();
    expect(list).toHaveLength(1);
    expect(list[0].bookId).toBe("400222");
    expect(list[0].id).toBe("413446"); // 最近在前的那条
  });

  it("脏数据不抛错", () => {
    localStorage.setItem(UI_KEYS.history, "{not json");
    expect(loadHistory()).toEqual([]);
    localStorage.setItem(UI_KEYS.history, JSON.stringify([null, 3, { name: "无 id" }]));
    expect(loadHistory()).toEqual([]);
  });
});

describe("saveHistory", () => {
  it("同书覆盖：连载多话只占一条", () => {
    saveHistory(entry({ id: "400222", chapterName: "第1话", lastReadAt: 1000 }));
    saveHistory(entry({ id: "413446", chapterName: "第2话", lastReadAt: 2000 }));
    const list = loadHistory();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("413446");
    expect(list[0].chapterName).toBe("第2话");
  });

  it("不同书各自一条，最近读的排最前", () => {
    saveHistory(entry({ id: "1", bookId: "1", name: "甲", lastReadAt: 1000 }));
    saveHistory(entry({ id: "2", bookId: "2", name: "乙", lastReadAt: 2000 }));
    expect(loadHistory().map((x) => x.name)).toEqual(["乙", "甲"]);
  });

  it("超过上限截断到 HISTORY_MAX", () => {
    for (let i = 0; i < HISTORY_MAX + 5; i++) {
      saveHistory(entry({ id: String(i), bookId: String(i), name: "n" + i, lastReadAt: 1000 + i }));
    }
    const list = loadHistory();
    expect(list).toHaveLength(HISTORY_MAX);
    expect(list[0].name).toBe("n" + (HISTORY_MAX + 4));
  });

  it("保留话号与总话数", () => {
    saveHistory(entry({ chapterName: "第12话", sort: 12, chapters: 146 }));
    const e = loadHistory()[0];
    expect(e.chapterName).toBe("第12话");
    expect(e.chapters).toBe(146);
  });
});
