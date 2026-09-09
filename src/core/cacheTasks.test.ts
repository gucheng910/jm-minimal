// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearAllMeta, getChapter } from "./offlineMeta";

const V1 = "jmclient.cacheTasks.v1";
const V2 = "jmclient.cacheTasks.v2";

beforeEach(async () => {
  await clearAllMeta();
  localStorage.clear();
  vi.resetModules();
});

describe("cacheTasks v1 → v2 迁移", () => {
  it("旧条目（pages 内联）搬进 IndexedDB，localStorage 只留轻量队列", async () => {
    localStorage.setItem(V1, JSON.stringify([
      { id: "111", title: "旧任务", author: "甲", total: 2, done: 2, status: "done", pages: [{ page: 1, image: "https://x/1.webp" }, { page: 2, image: "https://x/2.webp" }] }
    ]));
    const mod = await import("./cacheTasks");
    await new Promise((r) => setTimeout(r, 60)); // 等 migrateLegacy 异步完成

    const list = mod.cacheList();
    expect(list).toHaveLength(1);
    expect(list[0].bookId).toBe("111"); // 旧数据没有 bookId：回落到自身
    expect(list[0].total).toBe(2);

    const rec = await getChapter("111");
    expect(rec?.pages).toHaveLength(2);
    expect(rec?.bookId).toBe("111");

    // v1 键已清理，v2 里不再内联 pages
    expect(localStorage.getItem(V1)).toBeNull();
    const v2 = JSON.parse(localStorage.getItem(V2) || "[]");
    expect(v2).toHaveLength(1);
    expect(v2[0].pages).toBeUndefined();
  });

  it("v2 已存在时仍会把残留的 v1 pages 补齐到 IDB", async () => {
    localStorage.setItem(V2, JSON.stringify([{ id: "222", bookId: "B2", title: "新队列", total: 1, done: 0, status: "paused", updatedAt: 1 }]));
    localStorage.setItem(V1, JSON.stringify([{ id: "222", title: "旧", total: 1, done: 0, status: "paused", pages: [{ page: 1, image: "https://x/a.webp" }] }]));
    const mod = await import("./cacheTasks");
    await new Promise((r) => setTimeout(r, 60));
    expect(mod.cacheList()[0].bookId).toBe("B2"); // 以 v2 为准
    expect((await getChapter("222"))?.pages).toHaveLength(1);
    expect(localStorage.getItem(V1)).toBeNull();
  });

  it("chapterPages 能读回迁移后的页列表", async () => {
    localStorage.setItem(V1, JSON.stringify([{ id: "333", title: "旧", total: 1, done: 0, status: "paused", pages: [{ page: 1, image: "https://x/b.webp" }] }]));
    const mod = await import("./cacheTasks");
    await new Promise((r) => setTimeout(r, 60));
    expect(await mod.chapterPages("333")).toHaveLength(1);
    expect(await mod.chapterPages("999")).toEqual([]);
  });
});
