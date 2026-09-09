// @vitest-environment jsdom
// 离线缓存语义回归：1.7.2 事故根因是「caches.open 会创建空 cache」+「只按 cache 名判定已缓存」，
// 这里用一个与浏览器语义一致的极简假实现把这些行为钉住。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cacheCover, cachePage, cachedCoverUrl, deleteAlbumCache, invalidateCacheScan,
  pagesFromCache, pruneEmptyCaches, scanCachedChapters, toOfflinePageUrls
} from "./offline";

/** 假 Cache API：open 会创建空 cache（与浏览器一致） */
function makeFakeCaches() {
  const store = new Map<string, Map<string, Response>>();
  const resp = (body = "x") => new Response(body, { status: 200 });
  return {
    store,
    api: {
      open: async (name: string) => {
        if (!store.has(name)) store.set(name, new Map());
        const m = store.get(name)!;
        return {
          match: async (url: string) => m.get(url),
          put: async (url: string, r: Response) => { m.set(url, r); },
          keys: async () => [...m.keys()].map((u) => ({ url: u }))
        };
      },
      has: async (name: string) => store.has(name),
      delete: async (name: string) => store.delete(name),
      keys: async () => [...store.keys()]
    },
    seed(name: string, urls: string[]) {
      const m = new Map<string, Response>();
      for (const u of urls) m.set(u, resp());
      store.set(name, m);
    }
  };
}

let fake: ReturnType<typeof makeFakeCaches>;

beforeEach(() => {
  fake = makeFakeCaches();
  Object.defineProperty(window, "caches", { value: fake.api, configurable: true, writable: true });
  invalidateCacheScan();
  // jsdom 没有 createObjectURL
  (URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL = () => "blob:fake";
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => { /* noop */ };
});

afterEach(() => { vi.restoreAllMocks(); });

describe("scanCachedChapters", () => {
  it("空 cache 不算已缓存（历史 caches.open 副作用留下的垃圾）", async () => {
    await fake.api.open("jm-offline-900001"); // 模拟只读操作创建的空 cache
    expect(fake.store.has("jm-offline-900001")).toBe(true);
    const map = await scanCachedChapters();
    expect(map.size).toBe(0);
  });

  it("有页条目才算，页数与封面单独统计", async () => {
    fake.seed("jm-offline-900001", ["https://x/1.webp", "https://x/2.webp", "https://x/cover.jpg_cover_"]);
    fake.seed("jm-offline-900002", ["https://x/cover2.jpg_cover_"]); // 只有封面
    const map = await scanCachedChapters();
    expect([...map.keys()]).toEqual(["900001"]);
    expect(map.get("900001")).toEqual({ pages: 2, cover: true });
  });

  it("结果有 1.5s 记忆，invalidate 后重新计算", async () => {
    fake.seed("jm-offline-1", ["https://x/1.webp"]);
    expect((await scanCachedChapters()).size).toBe(1);
    fake.seed("jm-offline-2", ["https://x/2.webp"]);
    expect((await scanCachedChapters()).size).toBe(1); // 命中缓存
    invalidateCacheScan();
    expect((await scanCachedChapters()).size).toBe(2);
  });
});

describe("cachePage / cacheCover 不产生空 cache", () => {
  it("下载失败时不会创建 cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const ok = await cachePage("777", "https://x/fail.webp");
    expect(ok).toBe(false);
    expect(fake.store.has("jm-offline-777")).toBe(false);
  });

  it("下载成功才创建并写入", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("img", { status: 200 })));
    expect(await cachePage("777", "https://x/ok.webp")).toBe(true);
    expect(fake.store.get("jm-offline-777")?.has("https://x/ok.webp")).toBe(true);
  });

  it("封面失败同样不创建 cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));
    await cacheCover("778", "https://x/cover.jpg");
    expect(fake.store.has("jm-offline-778")).toBe(false);
  });
});

describe("只读路径不创建 cache", () => {
  it("cachedCoverUrl / toOfflinePageUrls 对不存在的 cache 直接返回", async () => {
    expect(await cachedCoverUrl("779", "https://x/cover.jpg")).toBe("");
    const pages = [{ page: 1, image: "https://x/1.webp" }];
    expect(await toOfflinePageUrls("779", pages)).toEqual(pages);
    expect(fake.store.has("jm-offline-779")).toBe(false);
  });
});

describe("pagesFromCache（IDB 记录丢失时的补救）", () => {
  it("从 cache 反推页列表：按 URL 排序、排除封面、带文件名", async () => {
    fake.seed("jm-offline-900003", ["https://x/00003.webp", "https://x/00001.webp", "https://x/c.jpg_cover_"]);
    const pages = await pagesFromCache("900003");
    expect(pages.map((p) => p.image)).toEqual(["https://x/00001.webp", "https://x/00003.webp"]);
    expect(pages[0]).toMatchObject({ page: 1, name: "00001" });
  });

  it("cache 不存在返回空数组且不创建", async () => {
    expect(await pagesFromCache("900004")).toEqual([]);
    expect(fake.store.has("jm-offline-900004")).toBe(false);
  });
});

describe("pruneEmptyCaches", () => {
  it("清掉零条目 cache，保留有页的，跳过正在下载的", async () => {
    await fake.api.open("jm-offline-empty1");
    await fake.api.open("jm-offline-active");
    fake.seed("jm-offline-has", ["https://x/1.webp"]);
    const n = await pruneEmptyCaches(new Set(["active"]));
    expect(n).toBe(1);
    expect(fake.store.has("jm-offline-empty1")).toBe(false);
    expect(fake.store.has("jm-offline-active")).toBe(true);
    expect(fake.store.has("jm-offline-has")).toBe(true);
  });
});

describe("deleteAlbumCache", () => {
  it("删除后扫描结果随之更新", async () => {
    fake.seed("jm-offline-1", ["https://x/1.webp"]);
    expect((await scanCachedChapters()).size).toBe(1);
    await deleteAlbumCache("1");
    expect((await scanCachedChapters()).size).toBe(0);
  });
});
