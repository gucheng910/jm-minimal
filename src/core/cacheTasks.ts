// 缓存任务中心：队列化下载（暂停/继续/删除/失败提示），退出 App 即自动停止（无需额外处理）。
import { cacheCover, cacheName, cachePage, clearAllAlbumCaches, deleteAlbumCache } from "./offline";
import { emit } from "./bus";
import type { ReadPage } from "./types";

export type CacheStatus = "queued" | "running" | "paused" | "failed" | "done";

export interface CacheTaskMeta {
  id: string;
  title: string;
  author?: string;
  category?: string;
  cover?: string;
  scrambleId?: number | string;
  total: number;
  done: number;
  status: CacheStatus;
  error?: string;
  pages: ReadPage[];
  updatedAt: number;
}

const LS_KEY = "jmclient.cacheTasks.v1";
const BATCH = 4;

let tasks: CacheTaskMeta[] = load();
let active = false;
let loopGen = 0;

function load(): CacheTaskMeta[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as CacheTaskMeta[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(tasks)); } catch { /* ignore */ }
}

function notify(progress = false) {
  emit("jm:caches", { progress });
}

export function cacheList(): CacheTaskMeta[] {
  return tasks.map((t) => ({ ...t }));
}

export function isTaskDone(id: number | string): boolean {
  const t = tasks.find((x) => x.id === String(id));
  return Boolean(t && t.status === "done");
}

export async function enqueueCache(meta: {
  id: number | string;
  title: string;
  author?: string;
  category?: string;
  cover?: string;
  scrambleId?: number | string;
  pages: ReadPage[];
}): Promise<void> {
  const id = String(meta.id);
  const existing = tasks.find((t) => t.id === id);
  if (existing && (existing.status === "queued" || existing.status === "running")) {
    notify();
    return;
  }
  // 已完成的旧任务若再次缓存（可能换了图源 URL），先清空旧缓存再排队
  if (existing && existing.status === "done") {
    await deleteAlbumCache(id);
  }
  const entry: CacheTaskMeta = {
    id,
    title: meta.title || String(meta.id),
    author: meta.author || "",
    category: meta.category || "",
    cover: meta.cover || "",
    scrambleId: meta.scrambleId,
    total: meta.pages.length,
    done: 0,
    status: "queued",
    pages: meta.pages,
    updatedAt: Date.now()
  };
  tasks = tasks.filter((t) => t.id !== id);
  tasks.unshift(entry);
  save();
  notify();
  ensureLoop();
}

export function pauseCache(id: number | string): void {
  const t = tasks.find((x) => x.id === String(id));
  if (t && (t.status === "queued" || t.status === "running")) {
    t.status = "paused";
    t.updatedAt = Date.now();
    save();
    notify();
  }
}

export function resumeCache(id: number | string): void {
  const t = tasks.find((x) => x.id === String(id));
  if (t && (t.status === "paused" || t.status === "failed")) {
    t.status = "queued";
    t.error = "";
    t.updatedAt = Date.now();
    save();
    notify();
    ensureLoop();
  }
}

/** 删除任务与全部缓存文件 */
export async function removeCache(id: number | string): Promise<void> {
  const sid = String(id);
  tasks = tasks.filter((t) => t.id !== sid);
  save();
  notify();
  loopGen += 1; // 打断进行中的任务
  await deleteAlbumCache(sid);
}

/** 重下：清空该专辑缓存后重新排队（保留元数据） */
export async function reDownloadCache(id: number | string): Promise<void> {
  const t = tasks.find((x) => x.id === String(id));
  if (!t) return;
  loopGen += 1;
  await deleteAlbumCache(String(id));
  t.done = 0;
  t.status = "queued";
  t.error = "";
  t.updatedAt = Date.now();
  save();
  notify();
  ensureLoop();
}

/** 清空全部任务与缓存（缓存中心“清理全部”入口） */
export async function clearAllCacheTasks(): Promise<number> {
  loopGen += 1; // 打断进行中任务
  tasks = [];
  save();
  notify();
  return clearAllAlbumCaches();
}

export function ensureLoop(): void {
  if (active) return;
  void runLoop().finally(() => { active = false; });
}

async function runLoop(): Promise<void> {
  active = true;
  const gen = loopGen;
  while (loopGen === gen) {
    const t = tasks.find((x) => x.status === "queued");
    if (!t) break;
    t.status = "running";
    t.error = "";
    save();
    notify();
    let ok = 0;
    let fail = 0;
    const sid = t.id;
    for (let i = 0; i < t.pages.length; i += BATCH) {
      if (loopGen !== gen) break; // 任务被删除/重下
      if ((t.status as string) === "paused") break;
      const batch = t.pages.slice(i, i + BATCH);
      const results = await Promise.all(batch.map((p) => cachePage(sid, p.image).then((r) => r)));
      ok += results.filter(Boolean).length;
      fail += results.length - results.filter(Boolean).length;
      t.done = ok;
      t.updatedAt = Date.now();
      // 进度持久化节流：每满 16 页落盘一次（中断恢复以重新扫描为准，无需逐页写）
      if (ok % 16 < BATCH || fail > 0) save();
      notify(true);
    }
    if (loopGen !== gen) break;
    if ((t.status as string) === "paused") {
      save();
      notify();
      break;
    }
    if ((t.status as string) !== "paused") {
      t.done = ok;
      t.updatedAt = Date.now();
      if (fail === 0 && ok >= t.pages.length) {
        t.status = "done";
        t.error = "";
        if (t.cover) { await cacheCover(sid, t.cover).catch(() => { /* ignore */ }); }
      } else {
        t.status = "failed";
        t.error = fail > 0 ? "有 " + fail + " 页缓存失败，可重试" : "缓存未完成";
      }
      save();
      notify();
    }
  }
}

// 恢复中断状态：上次退出时 running/queued 保持 queued，允许手动继续
for (const t of tasks) {
  if (t.status === "running") t.status = "queued";
}
save();
