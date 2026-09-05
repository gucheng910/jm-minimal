import type { ReadPage } from "./types";

const CONCURRENCY = 4;

export function cacheName(id: number | string): string {
  return "jm-offline-" + String(id);
}

export async function isAlbumCached(id: number | string): Promise<boolean> {
  if (!("caches" in window)) return false;
  const cache = await caches.open(cacheName(id));
  const keys = await cache.keys();
  return keys.length > 0;
}

export async function downloadAlbum(id: number | string, pages: ReadPage[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const cache = await caches.open(cacheName(id));
  let done = 0;
  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = pages.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (p) => {
      try {
        const resp = await fetch(p.image, { mode: "cors", cache: "no-store" });
        if (resp.ok) await cache.put(p.image, resp.clone());
      } catch { /* single image failure tolerated */ }
      done += 1;
      onProgress?.(done, pages.length);
    }));
  }
  return done;
}

function pageFileName(url: string): string {
  const clean = url.split("?")[0].split("/").pop() || "";
  return clean.replace(/\.(webp|jpg|jpeg|png|gif)$/i, "");
}

const activeBlobURLs = new Set<string>();

/** 释放全部离线阅读 blob URL（阅读器卸载时调用，防止内存泄漏） */
export function releaseOfflinePageUrls(): number {
  let n = 0;
  for (const url of activeBlobURLs) {
    try { URL.revokeObjectURL(url); n += 1; } catch { /* ignore */ }
  }
  activeBlobURLs.clear();
  return n;
}

export async function toOfflinePageUrls(id: number | string, pages: ReadPage[]): Promise<ReadPage[]> {
  if (!("caches" in window)) return pages;
  const cache = await caches.open(cacheName(id));
  const out: ReadPage[] = [];
  for (const p of pages) {
    const hit = await cache.match(p.image);
    if (hit && hit.ok) {
      const blob = await hit.blob();
      const url = URL.createObjectURL(blob);
      activeBlobURLs.add(url);
      // blob URL 会丢失文件名；scramble 重排需要原名，因此随页携带
      out.push({ page: p.page, image: url, name: p.name || pageFileName(p.image) });
    } else {
      out.push(p);
    }
  }
  return out;
}

// ---- 缓存中心支持（页面级原样缓存 + 封面） ----

/** 缓存单页图片（若已存在则跳过），网络抖动时即时重试 1 次 */
export async function cachePage(id: number | string, url: string): Promise<boolean> {
  if (!("caches" in window)) return false;
  const cache = await caches.open(cacheName(id));
  const hit = await cache.match(url);
  if (hit && hit.ok) return true;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, { mode: "cors", cache: "no-store" });
      if (resp.ok) {
        await cache.put(url, resp.clone());
        return true;
      }
    } catch { /* 下一次尝试 */ }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 400));
  }
  return false;
}

export async function cachedPageCount(id: number | string): Promise<number> {
  if (!("caches" in window)) return 0;
  try {
    const cache = await caches.open(cacheName(id));
    const keys = await cache.keys();
    return keys.filter((k) => !String(k.url).includes("_cover_")).length;
  } catch {
    return 0;
  }
}

/** 封面按 URL 缓存在专辑同名 cache（key 与页面图区分） */
export async function cacheCover(id: number | string, coverUrl: string): Promise<void> {
  if (!("caches" in window) || !coverUrl) return;
  try {
    const cache = await caches.open(cacheName(id));
    const key = coverUrl + "_cover_";
    const hit = await cache.match(key);
    if (hit) return;
    // 必须 cors + ok：opaque(no-cors) 响应无法存入 Cache API，会导致离线封面永远缺失
    const resp = await fetch(coverUrl, { mode: "cors", cache: "no-store" });
    if (resp.ok) await cache.put(key, resp);
  } catch { /* 封面缓存失败不阻塞 */ }
}

/** 读取已缓存封面为 blob URL（失败返回空） */
export async function cachedCoverUrl(id: number | string, coverUrl: string): Promise<string> {
  if (!("caches" in window) || !coverUrl) return "";
  try {
    const cache = await caches.open(cacheName(id));
    const hit = await cache.match(coverUrl + "_cover_");
    if (hit && hit.ok) {
      const blob = await hit.blob();
      return URL.createObjectURL(blob);
    }
  } catch { /* ignore */ }
  return "";
}

export async function deleteAlbumCache(id: number | string): Promise<void> {
  if (!("caches" in window)) return;
  try { await caches.delete(cacheName(id)); } catch { /* ignore */ }
}

/** 清理全部离线专辑缓存（含封面），返回删除的专辑缓存数量 */
export async function clearAllAlbumCaches(): Promise<number> {
  if (!("caches" in window)) return 0;
  let n = 0;
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("jm-offline-")).map(async (name) => {
      try { await caches.delete(name); n += 1; } catch { /* ignore */ }
    }));
  } catch { /* ignore */ }
  return n;
}