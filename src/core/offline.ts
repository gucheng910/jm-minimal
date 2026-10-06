// 离线图片缓存：**按平台双后端**
//
//   · 原生壳（Android / iOS）→ Capacitor Filesystem（图片落在 App 沙盒里，给 WKWebView 一个 file:// URL）
//   · Web / PWA / 单测      → Cache API + blob URL（原实现）
//
// 为什么 iOS 必须走 Filesystem，而不能继续用 Cache API：
//   Capacitor 的 iOS 默认 scheme 是 `capacitor://localhost`（见 capacitor.config.ts 的 ios 段），
//   它不是 http/https —— 苹果 WKWebView 下 Service Worker 无法在该 scheme 注册（官方 issue #7069），
//   CacheStorage 的可用性与配额在同一 scheme 下也没有任何保证。原来那套 `if (!("caches" in window)) return`
//   的兜底会让 iOS 上**整个离线库静默不落盘**（不报错、界面照常，只是重启后全没了）。
//   Filesystem 走的是原生沙盒，与 Web 存储配额/清理策略无关。
//
// 历史坑（在 Cache 后端里依然保留，见 webBackend）：
//   ⚠ 1.7.2 事故根因 = `caches.open()` 会「创建」不存在的 cache。因此：
//     - 所有只读路径必须先 `has()`，否则读一次就凭空造一个空 cache；
//     - 写入路径必须「先 fetch 成功再落盘」，否则下载失败就留下空目录/空 cache；
//     - 判断「某话是否已缓存」不能只看名字，必须确认里面有「页」条目。
//   双后端共用同一条纪律：native 侧 `putPage` 里「写页文件 → 再写 manifest」，且只读一律先 readdir。
//   详见 docs/30-1.7.2回归问题定位与修复.md
import { Capacitor } from "@capacitor/core";
import { Directory } from "@capacitor/filesystem/dist/esm/definitions";
import { getPlatform } from "./platform";
import type { ReadPage } from "./types";

export const OFFLINE_PREFIX = "jm-offline-";
const COVER_NAME = "cover";
const MANIFEST_NAME = "meta.json";

export function cacheName(id: number | string): string {
  return OFFLINE_PREFIX + String(id);
}

/** 已缓存话的实况：真正落盘的页数（不含封面） */
export interface CachedChapterInfo {
  pages: number;
  cover: boolean;
}

/** 后端入口需要的元数据：manifest 里存原始页地址，用于 IDB 记录丢失时反推 */
export interface PageEntry {
  page: number;
  url: string;
  name?: string;
}

function pageKeyName(url: string): string {
  const clean = url.split("?")[0].split("/").pop() || "";
  return clean.replace(/\.(webp|jpg|jpeg|png|gif)$/i, "");
}

// ---------------------------------------------------------------- 后端接口

/**
 * 一个「目录名 → 文件」的存储后端。目录名由 cacheName(id) 给出。
 * 语义要求（两个实现都必须满足）：
 *   · 只读操作绝不创建目录；
 *   · putPage / putCover 先拿到字节再落盘，不要"先建目录再下载"；
 *   · listPages 返回的页码必须与原始页序一致。
 */
interface OfflineBackend {
  readonly kind: "native" | "cache";
  has(id: string): Promise<boolean>;
  /** 该 URL 对应的页是否**已经落盘**（幂等判据；只读，不得创建任何东西） */
  hasPage(id: string, url: string): Promise<boolean>;
  download(url: string, hints?: string): Promise<Blob | null>;
  /** 先下载、成功才写页；返回 false 表示失败且**不留下任何痕迹** */
  putPage(id: string, page: number, url: string, blob: Blob): Promise<boolean>;
  putCover(id: string, coverUrl: string, blob: Blob): Promise<void>;
  listPages(id: string): Promise<Array<{ page: number; ext: string; key?: string }>>;
  manifest(id: string): Promise<{ pages?: PageEntry[]; coverUrl?: string; coverExt?: string } | null>;
  /** 该话是否已存封面（Cache 后端靠 `_cover_` 键名，native 靠 manifest） */
  hasCover(id: string): Promise<boolean>;
  /** 把某页变成可直接放进 <img src> 的地址 */
  pageUrl(id: string, page: number, ext: string): Promise<string>;
  coverUrl(id: string, coverUrl: string): Promise<string>;
  removeDir(id: string): Promise<void>;
  allIds(): Promise<string[]>;
}

/** 只读路径共用的存在性判断（两个实现都不允许在这里创建任何东西） */
async function tryFetch(url: string, attempt = 0): Promise<Blob | null> {
  try {
    const resp = await fetch(url, { mode: "cors", cache: "no-store" });
    if (resp.ok) return await resp.blob();
  } catch { /* 下一次尝试 */ }
  if (attempt === 0) {
    await new Promise((r) => setTimeout(r, 400));
    return tryFetch(url, 1);
  }
  return null;
}

function extOf(url: string): string {
  const m = url.split("?")[0].match(/\.(webp|jpg|jpeg|png|gif)$/i);
  return m ? m[1].toLowerCase() : "bin";
}

const pageFile = (page: number, ext: string) => "p" + String(page).padStart(4, "0") + "." + ext;

// ---------------------------------------------------------------- Cache 后端（Web / PWA）

/**
 * 原实现，一字未改语义 —— Web/PWA 上它工作良好（SW 能注册、CacheStorage 有硬件保障），
 * 没有理由把 Web 也换成 Filesystem 的 web 实现：那条路是 base64 存 IndexedDB，
 * 漫画页动辄几百 KB，体积 +33% 且全量过 JSON 序列化，老机型会卡。
 */
class CacheBackend implements OfflineBackend {
  readonly kind = "cache" as const;
  private covers = new Map<string, string>();

  private available(): boolean {
    return typeof window !== "undefined" && "caches" in window;
  }

  async has(id: string): Promise<boolean> {
    if (!this.available()) return false;
    try { return await caches.has(cacheName(id)); } catch { return false; }
  }

  async hasPage(id: string, url: string): Promise<boolean> {
    if (!this.available()) return false;
    try {
      const cache = await caches.open(cacheName(id));
      const hit = await cache.match(url);
      return Boolean(hit && hit.ok);
    } catch {
      return false;
    }
  }

  download(url: string): Promise<Blob | null> { return tryFetch(url); }

  async putPage(id: string, _page: number, url: string, blob: Blob): Promise<boolean> {
    if (!this.available()) return false;
    try {
      const cache = await caches.open(cacheName(id));
      await cache.put(url, new Response(blob, { status: 200 }));
      return true;
    } catch {
      return false;
    }
  }

  async putCover(id: string, coverUrl: string, blob: Blob): Promise<void> {
    if (!this.available()) return;
    try {
      const cache = await caches.open(cacheName(id));
      await cache.put(coverUrl + "_cover_", new Response(blob, { status: 200 }));
    } catch { /* 封面缓存失败不阻塞 */ }
  }

  async listPages(id: string): Promise<Array<{ page: number; ext: string; key?: string }>> {
    if (!this.available()) return [];
    try {
      const cache = await caches.open(cacheName(id));
      const keys = (await cache.keys()).map((k) => String(k.url)).filter((u) => !u.includes("_cover_"));
      keys.sort();
      // Cache 后端的"页码"来自 URL 字典序；key 即原始图片地址（重建页列表要用它）
      return keys.map((u, i) => ({ page: i + 1, ext: extOf(u), key: u }));
    } catch {
      return [];
    }
  }

  async manifest(): Promise<null> { return null; }

  async hasCover(id: string): Promise<boolean> {
    if (!this.available()) return false;
    try {
      const cache = await caches.open(cacheName(id));
      const keys = await cache.keys();
      return keys.some((k) => String(k.url).includes("_cover_"));
    } catch {
      return false;
    }
  }

  /** 把已存的响应重新包成 blob URL（与旧实现一致：每次调用一个新的 blob URL） */
  private async blobUrlOf(id: string, key: string): Promise<string> {
    try {
      const cache = await caches.open(cacheName(id));
      const hit = await cache.match(key);
      if (hit && hit.ok) return URL.createObjectURL(await hit.blob());
    } catch { /* ignore */ }
    return "";
  }

  async pageUrl(id: string, page: number, _ext: string): Promise<string> {
    if (!this.available()) return "";
    const cache = await caches.open(cacheName(id)).catch(() => null);
    if (!cache) return "";
    const keys = (await cache.keys()).map((k) => String(k.url)).filter((u) => !u.includes("_cover_")).sort();
    const key = keys[page - 1];
    return key ? this.blobUrlOf(id, key) : "";
  }

  async coverUrl(id: string, coverUrl: string): Promise<string> {
    if (!this.available() || !coverUrl) return "";
    const key = coverUrl + "_cover_";
    const cached = this.covers.get(key);
    if (cached) return cached;
    const url = await this.blobUrlOf(id, key);
    if (url) this.covers.set(key, url);
    return url;
  }

  async removeDir(id: string): Promise<void> {
    if (!this.available()) return;
    try { await caches.delete(cacheName(id)); } catch { /* ignore */ }
  }

  async allIds(): Promise<string[]> {
    if (!this.available()) return [];
    try {
      const names = await caches.keys();
      const out: string[] = [];
      for (const name of names.filter((n) => n.startsWith(OFFLINE_PREFIX))) {
        const id = name.slice(OFFLINE_PREFIX.length);
        const cache = await caches.open(name);
        const keys = await cache.keys();
        // 只有封面不算已缓存：空 cache 与"仅封面"都不进结果（1.7.2 的判据）
        if (keys.some((k) => !String(k.url).includes("_cover_"))) out.push(id);
      }
      return out;
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------- Filesystem 后端（Android / iOS）

/** 每个话题一个目录：<Data>/jm-offline/chapters/<话id>/，内含 p0001.webp… 与 meta.json */
const FS_ROOT = "jm-offline/chapters";

/**
 * Filesystem 必须**动态加载**，不能顶层 import：
 * `@capacitor/filesystem` 的入口会把 web 实现一起 re-export，在 jsdom 下加载它会
 * 直接把 vitest 的 fork worker 卡死（实测：worker 启动超时 60s，整个用例文件跑不起来）。
 * 只有原生后端会用到它，所以推迟到真正写文件的那一刻再 import，Web/PWA/单测完全不加载。
 */
let fsModule: Promise<typeof import("@capacitor/filesystem")> | null = null;
function FS(): Promise<typeof import("@capacitor/filesystem")> {
  if (!fsModule) fsModule = import("@capacitor/filesystem");
  return fsModule;
}

function base64FromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000; // 分块，避免 apply 参数过多爆栈
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(bin);
}

class NativeBackend implements OfflineBackend {
  readonly kind = "native" as const;
  private pageUrls = new Map<string, string>();

  private dir(id: string): string { return FS_ROOT + "/" + id; }
  private path(id: string, file: string): string { return this.dir(id) + "/" + file; }

  async has(id: string): Promise<boolean> {
    try {
      await (await FS()).Filesystem.readdir({ path: this.dir(id), directory: Directory.Data });
      return true;
    } catch {
      // 目录不存在 —— readdir 会抛，这正是我们想要的"不创建"语义
      return false;
    }
  }

  async hasPage(id: string, url: string): Promise<boolean> {
    const meta = await this.manifest(id);
    return Boolean((meta?.pages || []).some((p) => p.url === url));
  }

  async download(url: string): Promise<Blob | null> {
    // 原生壳里 fetch 由 Capacitor 补丁后的实现提供（无浏览器 CORS 限制），
    // 图床不发 CORS 头也能取到 —— 这条比 Web 端更宽松，是有意的。
    return tryFetch(url);
  }

  async putPage(id: string, page: number, url: string, blob: Blob): Promise<boolean> {
    try {
      const name = pageFile(page, extOf(url));
      const data = base64FromBuffer(await blob.arrayBuffer());
      // 先写页文件（失败就直接返回，不会留下只有 manifest 的空目录）
      await (await FS()).Filesystem.writeFile({
        path: this.path(id, name),
        data,
        directory: Directory.Data,
        recursive: true
      });
      // 再更新 manifest：原始页地址（Cache 后端靠 URL 找图，这里必须显式存一份）
      const meta = (await this.manifest(id)) || {};
      const pages = (meta.pages || []).filter((p) => p.page !== page);
      pages.push({ page, url, name: pageNameOf(url) });
      pages.sort((a, b) => a.page - b.page);
      await this.writeManifest(id, { ...meta, pages });
      return true;
    } catch {
      return false;
    }
  }

  async putCover(id: string, coverUrl: string, blob: Blob): Promise<void> {
    try {
      const ext = extOf(coverUrl);
      const data = base64FromBuffer(await blob.arrayBuffer());
      await (await FS()).Filesystem.writeFile({
        path: this.path(id, COVER_NAME + "." + ext),
        data,
        directory: Directory.Data,
        recursive: true
      });
      const meta = (await this.manifest(id)) || {};
      await this.writeManifest(id, { ...meta, coverUrl, coverExt: ext });
    } catch { /* 封面缓存失败不阻塞 */ }
  }

  private async writeManifest(id: string, meta: { pages?: PageEntry[]; coverUrl?: string; coverExt?: string }): Promise<void> {
    await (await FS()).Filesystem.writeFile({
      path: this.path(id, MANIFEST_NAME),
      data: JSON.stringify(meta),
      directory: Directory.Data,
      recursive: true
    });
  }

  async manifest(id: string): Promise<{ pages?: PageEntry[]; coverUrl?: string; coverExt?: string } | null> {
    try {
      const r = await (await FS()).Filesystem.readFile({ path: this.path(id, MANIFEST_NAME), directory: Directory.Data });
      const text = typeof r.data === "string" ? r.data : "";
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  async hasCover(id: string): Promise<boolean> {
    const meta = await this.manifest(id);
    return Boolean(meta?.coverUrl);
  }

  async listPages(id: string): Promise<Array<{ page: number; ext: string; key?: string }>> {
    try {
      const r = await (await FS()).Filesystem.readdir({ path: this.dir(id), directory: Directory.Data });
      const pages: Array<{ page: number; ext: string }> = [];
      for (const f of r.files) {
        const m = f.name.match(/^p(\d+)\.([a-z0-9]+)$/i);
        if (m) pages.push({ page: Number(m[1]), ext: m[2].toLowerCase() });
      }
      pages.sort((a, b) => a.page - b.page);
      return pages;
    } catch {
      return [];
    }
  }

  async pageUrl(id: string, page: number, ext: string): Promise<string> {
    const file = pageFile(page, ext);
    const key = this.path(id, file);
    const cached = this.pageUrls.get(key);
    if (cached) return cached;
    try {
      // Directory.Data 的 getUri 返回 file://…；convertFileSrc 再转成 WKWebView 能加载的地址
      // （iOS 上是 capacitor://localhost/_capacitor_file_…，Android 上是 http://localhost/_capacitor_file_…）
      const uri = await (await FS()).Filesystem.getUri({ path: key, directory: Directory.Data });
      const url = Capacitor.convertFileSrc(uri.uri);
      this.pageUrls.set(key, url);
      return url;
    } catch {
      return "";
    }
  }

  async coverUrl(id: string, _coverUrl: string): Promise<string> {
    const meta = await this.manifest(id);
    const ext = meta?.coverExt || "bin";
    try {
      const uri = await (await FS()).Filesystem.getUri({ path: this.path(id, COVER_NAME + "." + ext), directory: Directory.Data });
      return Capacitor.convertFileSrc(uri.uri);
    } catch {
      return "";
    }
  }

  async removeDir(id: string): Promise<void> {
    try {
      await (await FS()).Filesystem.rmdir({ path: this.dir(id), directory: Directory.Data, recursive: true });
    } catch { /* 目录不存在：正常 */ }
  }

  async allIds(): Promise<string[]> {
    try {
      const r = await (await FS()).Filesystem.readdir({ path: FS_ROOT, directory: Directory.Data });
      return r.files.filter((f) => f.type === "directory").map((f) => f.name);
    } catch {
      return [];
    }
  }
}

function pageNameOf(url: string): string {
  return pageKeyName(url);
}

// ---------------------------------------------------------------- 后端选择

const cacheBackend = new CacheBackend();
const nativeBackend = new NativeBackend();

/**
 * 后端选择：原生壳（android/ios）用沙盒文件，其余（web / PWA / jsdom 单测）用 Cache API。
 *
 * 🚨 必须**惰性**解析，不能在模块求值时定死：`Capacitor.getPlatform()` 读的是
 * `window.webkit.messageHandlers.bridge` / `window.androidBridge`，而本模块是在应用入口
 * 的依赖图里被求值的 —— 万一那一刻原生桥还没注入完，就会把 Android 也判成 web，
 * 于是整个离线库继续走 Cache API（在原生壳里可能静默不落盘），而且**永远纠不回来**。
 * 缓存一次结果即可：平台在一个进程生命周期内不会变。
 */
let backendCache: OfflineBackend | null = null;
let backendOverride: OfflineBackend | null = null;

function backend(): OfflineBackend {
  if (backendOverride) return backendOverride;
  if (!backendCache) {
    const p = getPlatform();
    backendCache = p === "android" || p === "ios" ? nativeBackend : cacheBackend;
  }
  return backendCache;
}

/** 单测用：钉住某一个后端（不需要伪造整个 Capacitor 桥） */
export function __setBackendForTests(b: "native" | "cache"): void {
  backendOverride = b === "native" ? nativeBackend : cacheBackend;
}

/** 当前后端类型（诊断用：排查"离线到底存哪了"） */
export function offlineBackendKind(): "native" | "cache" {
  return backend().kind;
}

// ---------------------------------------------------------------- 扫描（带记忆）

let scanCache: { at: number; value: Map<string, CachedChapterInfo> } | null = null;
const SCAN_TTL_MS = 1500;

/** 缓存被写入/删除后调用，让下一次扫描重新计算（避免高频扫描同时保证及时性） */
export function invalidateCacheScan(): void {
  scanCache = null;
}

function blank(): Map<string, CachedChapterInfo> {
  return new Map<string, CachedChapterInfo>();
}

/**
 * 扫描「已缓存的话」：目录/cache 名只是候选，必须确认里面有非封面条目。
 *
 * ids 省略 = 全库扫描（后端 keys 之后逐个 open 取条目），结果带 1.5s 记忆。
 * ids 传入 = **只查这几话**（先 has() 再 open）：进某本书的缓存详情、阅读器切话
 * 只需要自己那几十话，没必要把整机所有目录都读一遍 —— 老机型上这是"进详情页要等半天"的主因。
 */
export async function scanCachedChapters(ids?: Iterable<string>): Promise<Map<string, CachedChapterInfo>> {
  const filtered = ids !== undefined;
  if (!filtered && scanCache && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.value;
  const value = blank();
  try {
    const names = filtered
      ? Array.from(new Set(Array.from(ids!, (x) => String(x)).filter(Boolean)))
      : await backend().allIds();
    await Promise.all(names.map(async (id) => {
      try {
        if (filtered && !(await backend().has(id))) return; // 不存在直接跳过
        const pages = await backend().listPages(id);
        const cover = await backend().hasCover(id);
        // 判据与 1.7.2 修复一致：**有页才算已缓存**；只有封面 / 空目录不算（但封面单独记下来）
        if (pages.length > 0) value.set(id, { pages: pages.length, cover });
        else if (cover) value.set(id, { pages: 0, cover: true });
      } catch { /* 单个目录读失败不影响其它 */ }
    }));
  } catch { /* ignore */ }
  if (!filtered) scanCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- blob 游标（阅读器内存管理）

const activeBlobURLs = new Set<string>();

/** 离线读页的并发度：老机型上 8 已经能把"等它一张张转 blob"的时间压掉大半 */
const OFFLINE_READ_CONCURRENCY = 8;

/**
 * blob 游标：换话/换源前调用，返回当前已创建的 blob 数量。
 * 配合 releaseOfflinePageUrlsBefore()，只释放"上一话"的 blob —— 若换话时立刻全放，
 * 屏上还没被替换掉的旧页图片会瞬间裂开（blob URL 已失效）。
 * native 后端给的是 file:// 地址，不需要 revoke，但游标本身仍然要维护（语义一致）。
 */
export function blobCheckpoint(): number {
  return activeBlobURLs.size;
}

/** 释放游标之前的 blob（本次新加的保留）；返回释放数量 */
export function releaseOfflinePageUrlsBefore(cursor: number): number {
  let i = 0;
  let n = 0;
  for (const url of activeBlobURLs) {
    if (i++ >= cursor) break;
    try { URL.revokeObjectURL(url); n += 1; } catch { /* ignore */ }
    activeBlobURLs.delete(url);
  }
  return n;
}

/** 释放全部离线阅读 blob URL（阅读器卸载时调用，防止内存泄漏） */
export function releaseOfflinePageUrls(): number {
  let n = 0;
  for (const url of activeBlobURLs) {
    try { URL.revokeObjectURL(url); n += 1; } catch { /* ignore */ }
  }
  activeBlobURLs.clear();
  return n;
}

function trackBlob(url: string): string {
  if (url.startsWith("blob:")) activeBlobURLs.add(url);
  return url;
}

// ---------------------------------------------------------------- 对外 API

/** 把已缓存页替换成本地地址；该话没有缓存时原样返回（不创建任何东西） */
export async function toOfflinePageUrls(id: number | string, pages: ReadPage[]): Promise<ReadPage[]> {
  const sid = String(id);
  try {
    if (!(await backend().has(sid))) return pages;
  } catch {
    return pages;
  }
  // 逐页串行会退化成 N 次往返（40 页 = 40 次 readdir+blob），改成有界并发：保序写回数组
  const out: ReadPage[] = new Array(pages.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= pages.length) return;
      const p = pages[i];
      try {
        const url = await backend().pageUrl(sid, i + 1, extOf(p.image));
        if (!url) { out[i] = p; continue; }
        // blob URL 会丢失文件名；scramble 重排需要原名，因此随页携带
        out[i] = { page: p.page, image: trackBlob(url), name: p.name || pageFileName(p.image) };
      } catch {
        out[i] = p;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(OFFLINE_READ_CONCURRENCY, Math.max(pages.length, 1)) }, worker));
  return out;
}

function pageFileName(url: string): string {
  return pageKeyName(url);
}

/**
 * 从落盘内容反推页列表：IndexedDB 记录丢失（老版本配额溢出/迁移中断）时，
 * 只要图片还在就能继续离线阅读。scramble 需要的 scrambleId 由调用方另行补。
 */
export async function pagesFromCache(id: number | string): Promise<ReadPage[]> {
  const sid = String(id);
  try {
    if (!(await backend().has(sid))) return [];
    const list = await backend().listPages(sid);
    if (list.length === 0) return [];
    const meta = await backend().manifest(sid);
    const byPage = new Map<number, PageEntry>();
    for (const p of meta?.pages || []) byPage.set(p.page, p);
    return list.map((item, i) => {
      const entry = byPage.get(item.page);
      // 原始地址来源按后端分：Cache 后端就是 cache 里的 URL（item.key）；
      // native 后端靠 manifest 里存的 url（页文件名 p0001.webp 无法还原原地址）
      const url = entry?.url || item.key || "";
      return {
        page: entry?.page ?? i + 1,
        image: url,
        name: entry?.name || (url ? pageFileName(url) : "p" + String(item.page).padStart(4, "0"))
      };
    });
  } catch {
    return [];
  }
}

/** 缓存单页图片（已存在则跳过）；先下载成功再落盘，避免失败留下空目录 */
export async function cachePage(id: number | string, url: string): Promise<boolean> {
  const sid = String(id);
  try {
    if (await backend().hasPage(sid, url)) return true; // 幂等：同一张图不重复下载
  } catch { /* 继续走下载 */ }
  const blob = await backend().download(url);
  if (!blob) return false;
  const page = await nextPageIndex(sid, url);
  return backend().putPage(sid, page, url, blob);
}

/**
 * 该 URL 应该落在第几页。
 * native 后端从 manifest 里查（见过就复用原页码，保证重下/续下不重排）；
 * Cache 后端没有 manifest（靠 URL 本身索引），按"已有页数 + 1"递增 —— 它只影响顺序。
 */
async function nextPageIndex(id: string, url: string): Promise<number> {
  const meta = await backend().manifest(id);
  const known = (meta?.pages || []).find((p) => p.url === url);
  if (known) return known.page;
  const list = await backend().listPages(id);
  return list.length + 1;
}

/** 封面按 URL 缓存在专辑同目录（key 与页面图区分）；同样先下载成功再写 */
export async function cacheCover(id: number | string, coverUrl: string): Promise<void> {
  const sid = String(id);
  if (!coverUrl) return;
  try {
    const meta = await backend().manifest(sid);
    if (meta?.coverUrl === coverUrl) return; // 已缓存同一张封面
  } catch { /* 继续 */ }
  const blob = await backend().download(coverUrl);
  if (!blob) return;
  await backend().putCover(sid, coverUrl, blob);
}

/** 读取已缓存封面（cache 不存在时直接返回空，不创建任何东西） */
export async function cachedCoverUrl(id: number | string, coverUrl: string): Promise<string> {
  const sid = String(id);
  if (!coverUrl) return "";
  try {
    if (!(await backend().has(sid))) return "";
    const url = await backend().coverUrl(sid, coverUrl);
    return url ? trackBlob(url) : "";
  } catch {
    return "";
  }
}

export async function deleteAlbumCache(id: number | string): Promise<void> {
  try {
    await backend().removeDir(String(id));
    invalidateCacheScan();
  } catch { /* ignore */ }
}

/** 清理全部离线专辑缓存（含封面），返回删除的专辑缓存数量 */
export async function clearAllAlbumCaches(): Promise<number> {
  let n = 0;
  try {
    const ids = await backend().allIds();
    await Promise.all(ids.map(async (id) => {
      try { await backend().removeDir(id); n += 1; } catch { /* ignore */ }
    }));
  } catch { /* ignore */ }
  invalidateCacheScan();
  return n;
}

/**
 * 清理零条目的空目录/cache（历史版本 caches.open 副作用留下的垃圾）。
 * exclude 传「正在下载中的话 id」，避免打断进行中的任务。
 */
export async function pruneEmptyCaches(exclude: Set<string> = new Set()): Promise<number> {
  let n = 0;
  try {
    const all = backend().kind === "cache" ? (await rawCacheNames()) : await backend().allIds();
    await Promise.all(all.map(async (id) => {
      if (exclude.has(id)) return;
      try {
        const pages = await backend().listPages(id);
        const meta = await backend().manifest(id);
        if (pages.length === 0 && !meta?.coverUrl) {
          await backend().removeDir(id);
          n += 1;
        }
      } catch { /* ignore */ }
    }));
  } catch { /* ignore */ }
  if (n > 0) invalidateCacheScan();
  return n;
}

/** Cache 后端下"所有离线 cache 名"（含空 cache —— allIds 会把空的过滤掉，这里需要全量） */
async function rawCacheNames(): Promise<string[]> {
  if (typeof window === "undefined" || !("caches" in window)) return [];
  try {
    const names = await caches.keys();
    return names.filter((n) => n.startsWith(OFFLINE_PREFIX)).map((n) => n.slice(OFFLINE_PREFIX.length));
  } catch {
    return [];
  }
}
