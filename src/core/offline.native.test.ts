// @vitest-environment jsdom
// 原生（Android / iOS）Filesystem 后端的运行时覆盖 —— 这是上一版最大的测试缺口。
//
// 为什么要单独一个文件：offline.ts 用**动态** import 加载 @capacitor/filesystem（顶层静态 import
// 会在 jsdom 下把 vitest 的 fork worker 卡死，见 offline.ts 的 FS() 注释）。所以这里必须
// `vi.mock` 把那个模块换成内存实现，并把 Capacitor.getPlatform() 伪装成 android，
// 让 offline.ts 真的走 NativeBackend —— 而不是只做类型检查。
//
// 同一套行为在 Cache 后端上也跑一遍（「对照」）：两个后端**对外的行为必须一致**，
// Android 用户与 Web 用户读同一本书不该有差别。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Capacitor } from "@capacitor/core";

// ---------------------------------------------------------------- 内存 Filesystem

type Blob_ = { data: string };
const memFs = new Map<string, Blob_>();
const memDirs = new Set<string>();

const norm = (p: string) => p.replace(/\/+/g, "/").replace(/\/$/, "");

vi.mock("@capacitor/filesystem", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@capacitor/filesystem")>();
  const dirOf = (p: string) => {
    const n = norm(p);
    const i = n.lastIndexOf("/");
    return i > 0 ? n.slice(0, i) : "";
  };
  return {
    ...orig,
    Filesystem: {
      async readdir({ path }: { path: string }) {
        const n = norm(path);
        const prefix = n ? n + "/" : "";
        const entries = new Map<string, "file" | "directory">();
        // ⚠ 必须结合 memDirs 判断类型：目录里可能只有子目录、还没有任何文件（比如空话题目录
        // 或 pruneEmptyCaches 要清的那种"空壳"）。只按"下面有没有文件"判断的话，
        // 这些条目会被误报成 file，allIds() 的 type==="directory" 过滤会把它们全丢掉。
        for (const d of memDirs) {
          if (!d.startsWith(prefix)) continue;
          const seg = d.slice(prefix.length).split("/")[0];
          if (seg && !seg.includes("/")) entries.set(seg, "directory");
        }
        for (const [p] of memFs) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          const seg = rest.split("/")[0];
          if (!seg) continue;
          if (rest.includes("/")) entries.set(seg, "directory");
          else if (!entries.has(seg)) entries.set(seg, "file");
        }
        const files = [...entries].map(([name, type]) => ({ name, type }));
        if (files.length === 0) throw new Error("Directory does not exist: " + n);
        return { files };
      },
      async readFile({ path }: { path: string }) {
        const v = memFs.get(norm(path));
        if (!v) throw new Error("File does not exist: " + norm(path));
        return { data: v.data } as unknown as { data: string };
      },
      async writeFile({ path, data }: { path: string; data: string }) {
        const n = norm(path);
        const d = dirOf(n);
        if (d && !memDirs.has(d)) {
          // 模拟 recursive:true 的目录创建
          const parts = d.split("/");
          for (let i = 1; i <= parts.length; i++) memDirs.add(parts.slice(0, i).join("/"));
        }
        memFs.set(n, { data: String(data) });
        return { uri: "file:///data/" + n };
      },
      async getUri({ path }: { path: string }) {
        const n = norm(path);
        if (!memFs.has(n)) throw new Error("File does not exist: " + n);
        return { uri: "file:///data/" + n };
      },
      async rmdir({ path }: { path: string }) {
        const n = norm(path);
        if (!memDirs.has(n)) throw new Error("Directory does not exist: " + n);
        for (const p of [...memFs.keys()]) if (p === n || p.startsWith(n + "/")) memFs.delete(p);
        for (const d of [...memDirs]) if (d === n || d.startsWith(n + "/")) memDirs.delete(d);
      }
    }
  };
});

// ---------------------------------------------------------------- 假 Cache API（对照用）

function makeFakeCaches() {
  // ⚠ 存的是「响应工厂」而不是 Response 本身：Response 的 body 只能读一次，而应用真的会读它
  // （toOfflinePageUrls 把命中项读成 blob）。浏览器里 cache.match() 每次都给你一个**新的**
  // Response，所以这里也必须每次现造一个 —— 否则断言阶段读到的是已被消费的 body。
  const store = new Map<string, Map<string, () => Response>>();
  return {
    store,
    api: {
      open: async (name: string) => {
        if (!store.has(name)) store.set(name, new Map());
        const m = store.get(name)!;
        return {
          match: async (url: string) => m.get(url)?.(),
          put: async (url: string, r: Response) => {
            const bytes = new Uint8Array(await r.arrayBuffer()); // 落盘一次，之后随时重建
            m.set(url, () => new Response(bytes.slice(), { status: 200 }));
          },
          keys: async () => [...m.keys()].map((u) => ({ url: u }))
        };
      },
      has: async (name: string) => store.has(name),
      delete: async (name: string) => store.delete(name),
      keys: async () => [...store.keys()]
    },
    seed(name: string, urls: string[]) {
      const m = new Map<string, () => Response>();
      for (const u of urls) m.set(u, () => new Response("x", { status: 200 }));
      store.set(name, m);
    }
  };
}



let fake: ReturnType<typeof makeFakeCaches>;

function resetFs() {
  memFs.clear();
  memDirs.clear();
}

/** 一个"图"的内容：把 URL 编进去，便于断言"写进去的确实是这一页的字节" */
function imgBody(url: string): string {
  return "IMG:" + url;
}

function stubImgFetch() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(String(url));
    if (String(url).includes("/broken/")) return new Response("no", { status: 500 });
    // ⚠ 刻意用**字符串**而不是 Blob：jsdom 里 `new Response(new Blob(["x"])).text()`
    // 会得到 "[object Blob]"（Blob 是 jsdom 的实现，undici 的 Response 不认）。
    // 生产代码的 base64 编码路径正好依赖 `blob.arrayBuffer()`，用字符串能避开这个
    // 环境差异，让异步路径跑在真实语义上而不是被 jsdom 的假 Blob 骗过去。
    return new Response(imgBody(String(url)), { status: 200 });
  }));
  return calls;
}

const PAGE_URLS = ["https://img.test/00001.webp", "https://img.test/00002.webp", "https://img.test/00003.webp"];

/** 对每个后端跑同一套断言 —— 这就是"逻辑与 Android/Web 一致"的可执行定义 */
describe.each(["native", "cache"] as const)("离线后端行为一致性（%s）", (backend) => {  beforeEach(() => {
    vi.resetModules();
    fake = makeFakeCaches();
    resetFs();
    Object.defineProperty(window, "caches", { value: fake.api, configurable: true, writable: true });
    (URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL = () => "blob:fake";
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => { /* noop */ };
    if (backend === "native") {
      vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
    } else {
      vi.spyOn(Capacitor, "getPlatform").mockReturnValue("web");
    }
  });

  afterEach(() => { vi.restoreAllMocks(); });

  async function mod() {
    const m = await import("./offline");
    m.invalidateCacheScan();
    return m;
  }

  it("后端选择正确", async () => {
    const m = await mod();
    expect(m.offlineBackendKind()).toBe(backend);
  });

  it("iOS 与 Android 选到**同一个**后端（原生壳共用 Filesystem，不是各写一套）", async () => {
    // 这是"不要在两端搞出不同逻辑"的可执行约束：只有 web 与原生不同，iOS/Android 必须一致
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("ios");
    const ios = await (async () => { vi.resetModules(); return await import("./offline"); })();
    const iosKind = ios.offlineBackendKind();
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
    const and = await (async () => { vi.resetModules(); return await import("./offline"); })();
    expect(iosKind).toBe(and.offlineBackendKind());
  });

  it("大图不乱码（base64 分块编码在 256KB 以上不出错）", async () => {
    // 真实漫画页常见 100–500 KB，base64 要分块；旧式 String.fromCharCode.apply 大数组会爆栈
    const big = new Uint8Array(300 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i % 251); // 含 0x00 与 >0x7F 的字节，专门坑 utf8 路径
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(big, { status: 200 });
    }));
    const m = await mod();
    expect(await m.cachePage("900020", "https://img.test/big.webp")).toBe(true);
    const pages = await m.pagesFromCache("900020");
    expect(pages).toHaveLength(1);
    if (backend === "native") {
      const f = [...memFs.entries()].find(([k]) => k.includes("p0001"));
      expect(f).toBeTruthy();
      const decoded = atob(f![1].data);
      expect(decoded.length).toBe(big.length);
      // 抽样比对几个字节（含首尾）——逐字节比也行但没必要
      for (const i of [0, 1, 127, 128, 255, 65535, big.length - 1]) {
        expect(decoded.charCodeAt(i) & 0xff).toBe(big[i]);
      }
    }
    expect(calls).toHaveLength(1);
  });

  it("缓存一话：页按顺序落盘、可扫描到、页数正确", async () => {
    stubImgFetch();
    const m = await mod();
    for (const u of PAGE_URLS) {
      expect(await m.cachePage("900001", u)).toBe(true);
    }
    const scan = await m.scanCachedChapters();
    expect(scan.get("900001")?.pages).toBe(3);
    // 反推的页列表必须与原始顺序一致（Cache 靠 URL 字典序，native 靠 manifest 的 page 字段）
    const pages = await m.pagesFromCache("900001");
    expect(pages.map((p) => p.image)).toEqual(PAGE_URLS);
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(pages.map((p) => p.name)).toEqual(["00001", "00002", "00003"]);
  });

  it("相同的页列表重复缓存：幂等，不重复下载", async () => {
    const calls = stubImgFetch();
    const m = await mod();
    for (const u of PAGE_URLS) await m.cachePage("900002", u);
    const after1 = calls.length;
    for (const u of PAGE_URLS) expect(await m.cachePage("900002", u)).toBe(true);
    expect(calls.length).toBe(after1); // 没有多发一次请求
    expect((await m.pagesFromCache("900002")).map((p) => p.image)).toEqual(PAGE_URLS);
  });

  it("下载失败：整话不算已缓存，且下次重试能补上（失败页不占页号）", async () => {
    const calls = stubImgFetch();
    const m = await mod();
    expect(await m.cachePage("900003", PAGE_URLS[0])).toBe(true);
    expect(await m.cachePage("900003", "https://img.test/broken/9.webp")).toBe(false);
    expect(await m.cachePage("900003", PAGE_URLS[1])).toBe(true);
    const pages = await m.pagesFromCache("900003");
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.image)).toEqual([PAGE_URLS[0], PAGE_URLS[1]]); // 失败页没占号
    expect(calls.filter((u) => u.includes("broken")).length).toBeGreaterThanOrEqual(1);
  });

  it("写进去的确实是这一页的字节（不是张冠李戴）", async () => {
    stubImgFetch();
    const m = await mod();
    for (const u of PAGE_URLS) await m.cachePage("900004", u);
    const pages = await m.toOfflinePageUrls("900004", PAGE_URLS.map((u, i) => ({ page: i + 1, image: u })));
    expect(pages).toHaveLength(3);
    for (const p of pages) {
      expect(p.image).not.toBe(PAGE_URLS[0]); // 已经换成后端地址
      expect(p.name).toMatch(/^0000[123]$/);
    }
    if (backend === "native") {
      // native：manifest 里存的原始 URL 必须与页文件一一对应
      const n = await m.pagesFromCache("900004");
      expect(n.map((p) => p.image)).toEqual(PAGE_URLS);
      // ★ 字节级验证：第 1 页的**文件内容**必须真的属于第 1 页的 URL
      // （base64 解码后逐字节比对 —— 这条能抓住"页号错位/张冠李戴"这类最危险的 bug）
      const firstFile = [...memFs.entries()].find(([k]) => k.includes("p0001"));
      expect(firstFile).toBeTruthy();
      expect(atob(firstFile![1].data)).toBe(imgBody(PAGE_URLS[0]));
    } else {
      // cache：只验"存下来了且可用"。
      // ⚠ 不在 jsdom 里断言字节：jsdom 的 Blob 与 undici 的 Response 在这个组合下不可靠
      // （`new Response(jsdomBlob).blob()/text()` 拿到的是 "[object Blob]"），
      // 字节保真的验证放在 native 分支做（那条走 base64，能真正逐字节比对）。
      const hit = fake.store.get("jm-offline-900004")?.get("https://img.test/00002.webp");
      expect(hit).toBeTruthy();
      expect(hit!().ok).toBe(true);
    }
  });

  it("封面：写入后能读回，且不与正文页混淆", async () => {
    stubImgFetch();
    const m = await mod();
    await m.cachePage("900005", PAGE_URLS[0]);
    await m.cacheCover("900005", "https://img.test/cover.jpg");
    const cover = await m.cachedCoverUrl("900005", "https://img.test/cover.jpg");
    expect(cover).not.toBe("");
    const scan = await m.scanCachedChapters();
    expect(scan.get("900005")).toEqual({ pages: 1, cover: true }); // 封面不算页
  });

  it("只读路径不创建容器：不存在的话查了也不会凭空出现", async () => {
    const m = await mod();
    expect(await m.cachedCoverUrl("900006", "https://img.test/cover.jpg")).toBe("");
    expect(await m.pagesFromCache("900006")).toEqual([]);
    const untouched = [{ page: 1, image: PAGE_URLS[0] }];
    expect(await m.toOfflinePageUrls("900006", untouched)).toEqual(untouched);
    expect((await m.scanCachedChapters()).has("900006")).toBe(false);
    expect(memFs.size).toBe(0);
  });

  it("删除一话：页与封面一起消失", async () => {
    stubImgFetch();
    const m = await mod();
    await m.cachePage("900007", PAGE_URLS[0]);
    await m.cacheCover("900007", "https://img.test/cover.jpg");
    expect((await m.scanCachedChapters()).has("900007")).toBe(true);
    await m.deleteAlbumCache("900007");
    expect((await m.scanCachedChapters()).has("900007")).toBe(false);
    expect(await m.pagesFromCache("900007")).toEqual([]);
    expect(await m.cachedCoverUrl("900007", "https://img.test/cover.jpg")).toBe("");
  });

  it("清空全部：返回清理的话数", async () => {
    stubImgFetch();
    const m = await mod();
    await m.cachePage("900008", PAGE_URLS[0]);
    await m.cachePage("900009", PAGE_URLS[1]);
    expect((await m.scanCachedChapters()).size).toBe(2);
    const n = await m.clearAllAlbumCaches();
    expect(n).toBe(2);
    expect((await m.scanCachedChapters()).size).toBe(0);
  });

  it("pruneEmptyCaches：清空壳、保留有页的、跳过正在下载的", async () => {
    stubImgFetch();
    const m = await mod();
    await m.cachePage("900010", PAGE_URLS[0]);
    if (backend === "native") {
      // 造一个真正的空目录（写一个文件再删掉，目录会留下）
      memDirs.add("jm-offline/chapters/900011");
      memFs.set("jm-offline/chapters/900011/tmp", { data: "" });
      memFs.delete("jm-offline/chapters/900011/tmp");
      memDirs.add("jm-offline/chapters/900012");
    } else {
      await fake.api.open("jm-offline-900011");
      await fake.api.open("jm-offline-900012");
    }
    const n = await m.pruneEmptyCaches(new Set(["900012"]));
    expect(n).toBe(1);
    expect((await m.scanCachedChapters()).has("900010")).toBe(true);
    if (backend === "native") {
      expect(memDirs.has("jm-offline/chapters/900011")).toBe(false);
      expect(memDirs.has("jm-offline/chapters/900012")).toBe(true); // 跳过
    } else {
      expect(fake.store.has("jm-offline-900011")).toBe(false);
      expect(fake.store.has("jm-offline-900012")).toBe(true);
    }
  });

  it("scanCachedChapters(ids) 只查指定几话，且不创建东西", async () => {
    stubImgFetch();
    const m = await mod();
    await m.cachePage("900013", PAGE_URLS[0]);
    const map = await m.scanCachedChapters(["900013", "900014"]);
    expect([...map.keys()]).toEqual(["900013"]);
    expect(memDirs.has("jm-offline/chapters/900014")).toBe(false);
    expect(fake.store.has("jm-offline-900014")).toBe(false);
  });

  it("换图源重下：先清空再下，页序从 1 重新开始（对齐 cacheTasks.reDownloadCache 的真实路径）", async () => {
    stubImgFetch();
    const m = await mod();
    for (const u of PAGE_URLS) await m.cachePage("900016", u);
    expect((await m.pagesFromCache("900016")).map((p) => p.page)).toEqual([1, 2, 3]);

    // 生产代码的换源/重下是「先删旧缓存，再重新入队」，不是往旧缓存上追加
    await m.deleteAlbumCache("900016");
    expect(await m.pagesFromCache("900016")).toEqual([]);

    const ALT = ["https://img2.test/00001.webp", "https://img2.test/00002.webp", "https://img2.test/00003.webp"];
    for (const u of ALT) expect(await m.cachePage("900016", u)).toBe(true);

    const pages = await m.pagesFromCache("900016");
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]); // 页序从头开始，没有错位/翻倍
    expect(pages.map((p) => p.name)).toEqual(["00001", "00002", "00003"]);
    expect(pages.map((p) => p.image)).toEqual(ALT); // 旧图床的地址已经不在了
    expect((await m.scanCachedChapters()).get("900016")?.pages).toBe(3);
  });

  it("未清空就换源：新地址按 4/5/6 追加（与原 Cache 实现一致，不丢也不覆盖）", async () => {
    stubImgFetch();
    const m = await mod();
    for (const u of PAGE_URLS) await m.cachePage("900017", u);
    const ALT = ["https://img2.test/00001.webp", "https://img2.test/00002.webp", "https://img2.test/00003.webp"];
    for (const u of ALT) await m.cachePage("900017", u);
    // 注意：真实的换源路径会先 deleteAlbumCache（见上一条），这里固定的是"没清空"时两个后端
    // 都不丢数据的既有语义 —— 原 Cache 实现同样是两条 URL 并存（cache 里按 URL 建键）
    const pages = await m.pagesFromCache("900017");
    expect(pages).toHaveLength(6);
    expect([...new Set(pages.map((p) => p.image))].sort()).toEqual([...PAGE_URLS, ...ALT].sort());
  });

  it("blob 游标的释放语义（native 下也不能把已用的地址放掉）", async () => {
    stubImgFetch();
    const m = await mod();
    await m.cachePage("900015", PAGE_URLS[0]);
    const cursor = m.blobCheckpoint();
    await m.toOfflinePageUrls("900015", [{ page: 1, image: PAGE_URLS[0] }]);
    // 释放游标之前的（本次新增的保留）—— 不该抛错
    expect(() => m.releaseOfflinePageUrlsBefore(cursor)).not.toThrow();
    expect(() => m.releaseOfflinePageUrls()).not.toThrow();
  });
});
