// 离线图片缓存（Cache API）：每话一个 cache，键名 jm-offline-<话id>
//
// ⚠ 关键坑（1.7.2 事故根因）：caches.open() 会「创建」不存在的 cache（实测：open 之后
// caches.keys() 就多出一个空 cache，条目数 0）。因此：
//   - 所有只读路径必须先 caches.has()，否则读一次就凭空造一个空 cache；
//   - 写入路径必须「先 fetch 成功再 open + put」，否则下载失败就留下空 cache；
//   - 判断「某话是否已缓存」不能只看 cache 名，必须确认里面有「页」条目。
// 详见 docs/30-1.7.2回归问题定位与修复.md
import type { ReadPage } from "./types";

export const OFFLINE_PREFIX = "jm-offline-";
const COVER_SUFFIX = "_cover_";

export function cacheName(id: number | string): string {
  return OFFLINE_PREFIX + String(id);
}

/** 已缓存话的实况：真正落盘的页数（不含封面） */
export interface CachedChapterInfo {
  pages: number;
  cover: boolean;
}

let scanCache: { at: number; value: Map<string, CachedChapterInfo> } | null = null;
const SCAN_TTL_MS = 1500;

/** 缓存被写入/删除后调用，让下一次扫描重新计算（避免高频扫描同时保证及时性） */
export function invalidateCacheScan(): void {
  scanCache = null;
}

/**
 * 扫描「已缓存的话」：cache 名只是候选，必须确认里面有非封面条目。
 *
 * ids 省略 = 全库扫描（caches.keys() 之后逐个 open 取条目），结果带 1.5s 记忆。
 * ids 传入 = **只查这几话**（先 caches.has() 再 open）：进某本书的缓存详情、阅读器切话
 * 只需要自己那几十话，没必要把整机所有 cache 都开一遍 —— 老机型上这是"进详情页要等半天"的主因。
 */
export async function scanCachedChapters(ids?: Iterable<string>): Promise<Map<string, CachedChapterInfo>> {
  const filtered = ids !== undefined;
  if (!filtered && scanCache && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.value;
  const value = new Map<string, CachedChapterInfo>();
  if (!("caches" in window)) return value;
  try {
    const names = filtered
      ? Array.from(new Set(Array.from(ids!, (x) => String(x)).filter(Boolean))).map((id) => cacheName(id))
      : (await caches.keys()).filter((n) => n.startsWith(OFFLINE_PREFIX));
    await Promise.all(names.map(async (name) => {
      const id = name.slice(OFFLINE_PREFIX.length);
      try {
        if (filtered && !(await caches.has(name))) return; // 不存在直接跳过，别白开一次
        const cache = await caches.open(name); // 名字来自 keys()，不会新建
        const keys = await cache.keys();
        let pages = 0;
        let cover = false;
        for (const k of keys) {
          if (String(k.url).includes(COVER_SUFFIX)) cover = true;
          else pages += 1;
        }
        if (pages > 0) value.set(id, { pages, cover });
      } catch { /* 单个 cache 读失败不影响其它 */ }
    }));
  } catch { /* ignore */ }
  if (!filtered) scanCache = { at: Date.now(), value };
  return value;
}

function pageFileName(url: string): string {
  const clean = url.split("?")[0].split("/").pop() || "";
  return clean.replace(/\.(webp|jpg|jpeg|png|gif)$/i, "");
}

const activeBlobURLs = new Set<string>();

/** 离线读页的并发度：老机型上 8 已经能把"等它一张张转 blob"的时间压掉大半 */
const OFFLINE_READ_CONCURRENCY = 8;

/**
 * blob 游标：换话/换源前调用，返回当前已创建的 blob 数量。
 * 配合 releaseOfflinePageUrlsBefore()，只释放"上一话"的 blob —— 若换话时立刻全放，
 * 屏上还没被替换掉的旧页图片会瞬间裂开（blob URL 已失效）。
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

/** 把已缓存页替换成 blob URL；cache 不存在时原样返回（不创建 cache） */
export async function toOfflinePageUrls(id: number | string, pages: ReadPage[]): Promise<ReadPage[]> {
  if (!("caches" in window)) return pages;
  const name = cacheName(id);
  try {
    if (!(await caches.has(name))) return pages;
  } catch {
    return pages;
  }
  const cache = await caches.open(name);
  // 逐页串行会退化成 N 次往返（40 页 = 40 次 match+blob+createObjectURL，老机型上体感很明显）。
  // 改成有界并发：保序写回数组，内存峰值最多 8 个 blob 同时在处理。
  const out: ReadPage[] = new Array(pages.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= pages.length) return;
      const p = pages[i];
      const hit = await cache.match(p.image);
      if (hit && hit.ok) {
        const blob = await hit.blob();
        const url = URL.createObjectURL(blob);
        activeBlobURLs.add(url);
        // blob URL 会丢失文件名；scramble 重排需要原名，因此随页携带
        out[i] = { page: p.page, image: url, name: p.name || pageFileName(p.image) };
      } else {
        out[i] = p;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(OFFLINE_READ_CONCURRENCY, pages.length) }, worker));
  return out;
}

/**
 * 从 cache 反推页列表：IndexedDB 记录丢失（老版本配额溢出/迁移中断）时，
 * 只要图片还在就能继续离线阅读。scramble 需要的 scrambleId 由调用方另行补。
 */
export async function pagesFromCache(id: number | string): Promise<ReadPage[]> {
  if (!("caches" in window)) return [];
  const name = cacheName(id);
  try {
    if (!(await caches.has(name))) return [];
    const cache = await caches.open(name);
    const keys = await cache.keys();
    const urls = keys.map((k) => String(k.url)).filter((u) => !u.includes(COVER_SUFFIX)).sort();
    return urls.map((u, i) => ({ page: i + 1, image: u, name: pageFileName(u) }));
  } catch {
    return [];
  }
}

/** 缓存单页图片（已存在则跳过）；先下载成功再 open+put，避免失败留下空 cache */
export async function cachePage(id: number | string, url: string): Promise<boolean> {
  if (!("caches" in window)) return false;
  const name = cacheName(id);
  try {
    if (await caches.has(name)) {
      const cache = await caches.open(name);
      const hit = await cache.match(url);
      if (hit && hit.ok) return true;
    }
  } catch { /* 继续走下载 */ }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, { mode: "cors", cache: "no-store" });
      if (resp.ok) {
        const cache = await caches.open(name);
        await cache.put(url, resp.clone());
        return true;
      }
    } catch { /* 下一次尝试 */ }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 400));
  }
  return false;
}

/** 封面按 URL 缓存在专辑同名 cache（key 与页面图区分）；同样先下载成功再建 cache */
export async function cacheCover(id: number | string, coverUrl: string): Promise<void> {
  if (!("caches" in window) || !coverUrl) return;
  const name = cacheName(id);
  try {
    if (await caches.has(name)) {
      const cache = await caches.open(name);
      if (await cache.match(coverUrl + COVER_SUFFIX)) return;
    }
    // 必须 cors + ok：opaque(no-cors) 响应无法存入 Cache API，会导致离线封面永远缺失
    const resp = await fetch(coverUrl, { mode: "cors", cache: "no-store" });
    if (!resp.ok) return;
    const cache = await caches.open(name);
    await cache.put(coverUrl + COVER_SUFFIX, resp);
  } catch { /* 封面缓存失败不阻塞 */ }
}

/** 读取已缓存封面为 blob URL（cache 不存在时直接返回空，不创建 cache） */
export async function cachedCoverUrl(id: number | string, coverUrl: string): Promise<string> {
  if (!("caches" in window) || !coverUrl) return "";
  const name = cacheName(id);
  try {
    if (!(await caches.has(name))) return "";
    const cache = await caches.open(name);
    const hit = await cache.match(coverUrl + COVER_SUFFIX);
    if (hit && hit.ok) {
      const blob = await hit.blob();
      return URL.createObjectURL(blob);
    }
  } catch { /* ignore */ }
  return "";
}

export async function deleteAlbumCache(id: number | string): Promise<void> {
  if (!("caches" in window)) return;
  try {
    await caches.delete(cacheName(id));
    invalidateCacheScan();
  } catch { /* ignore */ }
}

/** 清理全部离线专辑缓存（含封面），返回删除的专辑缓存数量 */
export async function clearAllAlbumCaches(): Promise<number> {
  if (!("caches" in window)) return 0;
  let n = 0;
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(OFFLINE_PREFIX)).map(async (name) => {
      try { await caches.delete(name); n += 1; } catch { /* ignore */ }
    }));
  } catch { /* ignore */ }
  invalidateCacheScan();
  return n;
}

/**
 * 清理零条目的空 cache（历史版本 caches.open 副作用留下的垃圾）。
 * exclude 传「正在下载中的话 id」，避免打断进行中的任务。
 */
export async function pruneEmptyCaches(exclude: Set<string> = new Set()): Promise<number> {
  if (!("caches" in window)) return 0;
  let n = 0;
  try {
    const names = (await caches.keys()).filter((name) => name.startsWith(OFFLINE_PREFIX));
    await Promise.all(names.map(async (name) => {
      const id = name.slice(OFFLINE_PREFIX.length);
      if (exclude.has(id)) return;
      try {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        if (keys.length === 0) { await caches.delete(name); n += 1; }
      } catch { /* ignore */ }
    }));
  } catch { /* ignore */ }
  if (n > 0) invalidateCacheScan();
  return n;
}
