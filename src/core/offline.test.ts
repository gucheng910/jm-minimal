// @vitest-environment jsdom
// 离线缓存语义回归。
//
// 两层保障：
//   1) 共享逻辑层（两个后端都要满足的不变量）：只读路径绝不创建容器、失败不留空壳、
//      「有页才算已缓存」、幂等跳过、反推页列表 —— 用真实的 Cache 后端跑（jsdom 下即 web 路径）。
//   2) 后端契约：native 后端（Android/iOS 的 Filesystem）不引真插件（在 jsdom 里加载会卡死
//      vitest fork worker，见 offline.ts 的 FS() 注释），改为钉住它与 Cache 后端共享的那部分
//      逻辑契约：listPages 的页码语义 + manifest 的来源（pagesFromCache 的还原分支）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cacheCover, cachePage, cachedCoverUrl, deleteAlbumCache, invalidateCacheScan,
  offlineBackendKind, pagesFromCache, pruneEmptyCaches, scanCachedChapters, toOfflinePageUrls
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

describe("后端选择", () => {
  it("jsdom / Web 走 Cache 后端（原生壳才用 Filesystem）", () => {
    expect(offlineBackendKind()).toBe("cache");
  });
});

describe("scanCachedChapters", () => {
  it("空 cache 不算已缓存（历史 caches.open 副作用留下的垃圾）", async () => {
    await fake.api.open("jm-offline-900001"); // 模拟只读操作创建的空 cache
    expect(fake.store.has("jm-offline-900001")).toBe(true);
    const map = await scanCachedChapters();
    expect(map.size).toBe(0);
  });

  it("有页条目才算，页数与封面单独统计（只有封面的话不计入）", async () => {
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

  it("只查指定几话时先看存在性，不创建任何东西", async () => {
    fake.seed("jm-offline-has", ["https://x/1.webp"]);
    const map = await scanCachedChapters(["has", "missing"]);
    expect([...map.keys()]).toEqual(["has"]);
    expect(fake.store.has("jm-offline-missing")).toBe(false);
  });
});

describe("cachePage / cacheCover 不产生空壳", () => {
  it("下载失败时不会创建 cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const ok = await cachePage("777", "https://x/fail.webp");
    expect(ok).toBe(false);
    // 判据用与生产代码同源的那一条：**有页才算落盘**（不能用 `fake.store.has()` ——
    // 本文件既有的假 Cache API 里 `open()` 会先把名字塞进 store，与浏览器一致，
    // 因此只要中间任何一次探测走 open()，store.has 就恒为 true，断言不出任何东西）
    expect((await scanCachedChapters()).has("777")).toBe(false);
  });

  it("下载成功才创建并写入", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("img", { status: 200 })));
    expect(await cachePage("777", "https://x/ok.webp")).toBe(true);
    expect(fake.store.get("jm-offline-777")?.has("https://x/ok.webp")).toBe(true);
  });

  it("同一张图重复缓存不重复下载（幂等）", async () => {
    const f = vi.fn(async () => new Response("img", { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect(await cachePage("777", "https://x/same.webp")).toBe(true);
    expect(await cachePage("777", "https://x/same.webp")).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("封面失败同样不创建 cache", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));
    await cacheCover("778", "https://x/cover.jpg");
    expect(await fake.api.has("jm-offline-778")).toBe(false);
  });
});

describe("只读路径不创建 cache", () => {
  it("cachedCoverUrl / toOfflinePageUrls 对不存在的 cache 直接返回", async () => {
    expect(await cachedCoverUrl("779", "https://x/cover.jpg")).toBe("");
    const pages = [{ page: 1, image: "https://x/1.webp" }];
    expect(await toOfflinePageUrls("779", pages)).toEqual(pages);
    expect(fake.store.has("jm-offline-779")).toBe(false);
  });

  it("缓存过的页会被换成 blob URL，并保留原文件名（scramble 要用）", async () => {
    fake.seed("jm-offline-880", ["https://x/00001.webp"]);
    const out = await toOfflinePageUrls("880", [{ page: 1, image: "https://x/00001.webp" }]);
    expect(out[0].image).toBe("blob:fake");
    expect(out[0].name).toBe("00001");
  });
});

describe("pagesFromCache（IDB 记录丢失时的补救）", () => {
  it("从落盘内容反推页列表：按 URL 排序、排除封面、带原地址与文件名", async () => {
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
