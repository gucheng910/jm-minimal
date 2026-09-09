// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  putBook, getBook, putChapter, getChapter, listChapters, deleteBook, listBooks, clearAllMeta,
  bookMetaFromDetail, chapterLabel, type BookMeta, type ChapterMeta
} from "./offlineMeta";
import type { AlbumDetail, ReadPage } from "./types";

const pages = (n: number): ReadPage[] => Array.from({ length: n }, (_, i) => ({ page: i + 1, image: "https://cdn.example.com/p" + i + ".webp", name: String(i) }));

const book = (patch: Partial<BookMeta>): BookMeta => ({
  bookId: "400222", name: "痴汉成瘾", author: ["小胖手"], tags: ["韩漫"], description: "简介",
  chapters: [{ id: "400222", name: "", sort: 1 }, { id: "413446", name: "第2话", sort: 2 }],
  updatedAt: 1, ...patch
});

const chapter = (patch: Partial<ChapterMeta>): ChapterMeta => ({
  chapterId: "413446", bookId: "400222", name: "第2话", sort: 2, scrambleId: 220980,
  total: 47, pages: pages(47), cachedAt: 1, ...patch
});

const album = (patch: Partial<AlbumDetail>): AlbumDetail => ({ id: 1, name: "x", ...patch });

beforeEach(async () => { await clearAllMeta(); });

describe("IndexedDB 读写", () => {
  it("书级元数据可写入读回", async () => {
    await putBook(book({}));
    const got = await getBook("400222");
    expect(got?.name).toBe("痴汉成瘾");
    expect(got?.chapters).toHaveLength(2);
    expect(await getBook("不存在")).toBeNull();
  });

  it("每话 pages 可写入读回（含 scrambleId）", async () => {
    await putChapter(chapter({}));
    const got = await getChapter("413446");
    expect(got?.total).toBe(47);
    expect(got?.pages).toHaveLength(47);
    expect(got?.pages[0].image).toContain(".webp");
    expect(String(got?.scrambleId)).toBe("220980");
  });

  it("listChapters 按书过滤，listBooks 全量", async () => {
    await putChapter(chapter({ chapterId: "400222", sort: 1 }));
    await putChapter(chapter({ chapterId: "413446" }));
    await putChapter(chapter({ chapterId: "999", bookId: "888" }));
    await putBook(book({}));
    await putBook(book({ bookId: "888", name: "别的书" }));
    expect((await listChapters("400222")).map((c) => c.chapterId).sort()).toEqual(["400222", "413446"]);
    expect((await listBooks()).map((b) => b.bookId).sort()).toEqual(["400222", "888"]);
  });

  it("deleteBook 连带删除其全部话记录，不碰其他书", async () => {
    await putBook(book({}));
    await putChapter(chapter({}));
    await putChapter(chapter({ chapterId: "999", bookId: "888" }));
    await deleteBook("400222");
    expect(await getBook("400222")).toBeNull();
    expect(await getChapter("413446")).toBeNull();
    expect(await getChapter("999")).not.toBeNull();
  });

  it("clearAllMeta 清空两个 store", async () => {
    await putBook(book({}));
    await putChapter(chapter({}));
    await clearAllMeta();
    expect(await listBooks()).toEqual([]);
    expect(await listChapters("400222")).toEqual([]);
  });
});

describe("bookMetaFromDetail", () => {
  it("连载：目录快照 + 书级书名优先 + 作者/标签归一", () => {
    const meta = bookMetaFromDetail(album({
      id: "413446", name: "痴汉成瘾-第2话", book_name: "痴汉成瘾", series_id: "400222",
      author: ["小胖手", "红色都市"], tags: ["韩漫", "完结"], description: "简介正文",
      series: [{ id: "400222", name: "", sort: "1" }, { id: "413446", name: "第2话", sort: "2" }]
    }), "https://img/400222.jpg");
    expect(meta.bookId).toBe("400222");
    expect(meta.name).toBe("痴汉成瘾");
    expect(meta.author).toEqual(["小胖手", "红色都市"]);
    expect(meta.chapters).toEqual([{ id: "400222", name: "", sort: 1 }, { id: "413446", name: "第2话", sort: 2 }]);
    expect(meta.cover).toBe("https://img/400222.jpg");
  });

  it("单本：bookId = 自身，目录为空，sort 非法值兜底为 0", () => {
    const meta = bookMetaFromDetail(album({ id: "1470832", name: "单本", series_id: "0", series: [{ id: "1", name: "x", sort: "abc" }] }));
    expect(meta.bookId).toBe("1470832");
    expect(meta.name).toBe("单本");
    expect(meta.chapters).toEqual([{ id: "1", name: "x", sort: 0 }]);
  });
});

describe("chapterLabel", () => {
  it("优先用接口名称，缺失时用 sort 兜底", () => {
    expect(chapterLabel({ name: "第2话", sort: 2 })).toBe("第2话");
    expect(chapterLabel({ name: "", sort: 1 })).toBe("第1话");
    expect(chapterLabel({ sort: "3" })).toBe("第3话");
    expect(chapterLabel(undefined)).toBe("");
  });
});
