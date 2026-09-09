// 缓存任务中心：队列化下载（暂停/继续/删除/失败提示），退出 App 即自动停止（无需额外处理）。
// 存储分层（docs/28 §2.2 实测）：队列状态小、需同步读 → localStorage；
// 每话 pages 约 5 KB、写频繁 → IndexedDB（localStorage 全量重写会卡主线程且 9.4 MB 硬顶）。
import { cacheCover, cachePage, clearAllAlbumCaches, deleteAlbumCache } from "./offline";
import { emit } from "./bus";
import { clearAllMeta, deleteBook, deleteChapter, getChapter, listChapters, putBook, putChapter, type BookMeta } from "./offlineMeta";
import { knownBookId } from "./series";
import type { ReadPage } from "./types";

export type CacheStatus = "queued" | "running" | "paused" | "failed" | "done";

export interface CacheTaskMeta {
  /** 话 id */
  id: string;
  /** 书 id（同书多话合并展示） */
  bookId: string;
  /** 书级书名 */
  title: string;
  /** "第12话" */
  chapterName?: string;
  sort?: number;
  author?: string;
  category?: string;
  cover?: string;
  scrambleId?: number | string;
  total: number;
  done: number;
  status: CacheStatus;
  error?: string;
  updatedAt: number;
}

/** 旧版（v1）条目：pages 内联在 localStorage 里 */
interface LegacyTask extends Partial<CacheTaskMeta> {
  id?: string;
  pages?: ReadPage[];
}

const LS_KEY = "jmclient.cacheTasks.v2";
const LS_KEY_V1 = "jmclient.cacheTasks.v1";
const BATCH = 4;

let tasks: CacheTaskMeta[] = [];
/** 迁移期兜底：v1 里还没搬进 IDB 的页列表 */
const legacyPages = new Map<string, ReadPage[]>();
let active = false;
let loopGen = 0;

function parseKey(key: string): LegacyTask[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw) as LegacyTask[];
    return Array.isArray(arr) ? arr.filter((t) => t && t.id) : [];
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

function init(): void {
  const v2 = parseKey(LS_KEY);
  const v1 = parseKey(LS_KEY_V1);
  // v1 的 pages 无论任务列表取哪一份都要留着，供尚未迁移完成的下载使用
  for (const t of v1) {
    if (t.id && Array.isArray(t.pages) && t.pages.length) legacyPages.set(String(t.id), t.pages);
  }
  const list = v2.length > 0 ? v2 : v1;
  tasks = list.map((t) => {
    const id = String(t.id);
    return {
      id,
      bookId: String(t.bookId || knownBookId(id)),
      title: String(t.title || id),
      chapterName: t.chapterName,
      sort: t.sort,
      author: t.author || "",
      category: t.category || "",
      cover: t.cover || "",
      scrambleId: t.scrambleId,
      total: Number(t.total) || (Array.isArray(t.pages) ? t.pages.length : 0),
      done: Number(t.done) || 0,
      // 上次退出时 running 的任务恢复为排队，允许手动继续
      status: t.status === "running" ? "queued" : (t.status || "queued"),
      error: t.error || "",
      updatedAt: Number(t.updatedAt) || Date.now()
    };
  });
  save();
  void migrateLegacy();
}

/** v1 → IDB：把内联在 localStorage 里的 pages 搬进 chapters store，成功后删掉 v1 键 */
async function migrateLegacy(): Promise<void> {
  if (legacyPages.size === 0) {
    try { localStorage.removeItem(LS_KEY_V1); } catch { /* ignore */ }
    return;
  }
  for (const t of tasks) {
    const pages = legacyPages.get(t.id);
    if (!pages) continue;
    const ok = await putChapter({
      chapterId: t.id, bookId: t.bookId, name: t.chapterName, sort: t.sort,
      scrambleId: t.scrambleId, total: pages.length, pages, cachedAt: Date.now()
    });
    if (ok === null || ok === undefined) return; // 无 IDB：保留 v1 键，下次启动再试
    legacyPages.delete(t.id);
  }
  try { localStorage.removeItem(LS_KEY_V1); } catch { /* ignore */ }
}

init();

export function cacheList(): CacheTaskMeta[] {
  return tasks.map((t) => ({ ...t }));
}

export function taskOf(id: number | string): CacheTaskMeta | undefined {
  const t = tasks.find((x) => x.id === String(id));
  return t ? { ...t } : undefined;
}

export function isTaskDone(id: number | string): boolean {
  const t = tasks.find((x) => x.id === String(id));
  return Boolean(t && t.status === "done");
}

/** 取某话的页列表：IDB → v1 迁移兜底 */
async function pagesOf(id: string): Promise<ReadPage[] | null> {
  const rec = await getChapter(id);
  if (rec && Array.isArray(rec.pages) && rec.pages.length > 0) return rec.pages;
  const legacy = legacyPages.get(id);
  return legacy && legacy.length > 0 ? legacy : null;
}

/** 离线阅读用：读某话缓存下来的页列表（缺失返回空数组） */
export async function chapterPages(id: number | string): Promise<ReadPage[]> {
  return (await pagesOf(String(id))) || [];
}

export async function enqueueCache(meta: {
  id: number | string;
  bookId?: string;
  title: string;
  chapterName?: string;
  sort?: number;
  author?: string;
  category?: string;
  cover?: string;
  scrambleId?: number | string;
  pages: ReadPage[];
  /** 书级元数据（简介/标签/作者/目录）：离线详情页依赖它 */
  bookMeta?: BookMeta;
}): Promise<void> {
  const id = String(meta.id);
  const bookId = String(meta.bookId || knownBookId(id));
  const existing = tasks.find((t) => t.id === id);
  if (existing && (existing.status === "queued" || existing.status === "running")) {
    notify();
    return;
  }
  // 已完成的旧任务若再次缓存（可能换了图源 URL），先清空旧图片缓存再排队
  if (existing && existing.status === "done") {
    await deleteAlbumCache(id);
  }
  // 元数据先落 IDB：离线详情页/同书合并都靠它，失败也不阻塞下载
  if (meta.bookMeta) {
    await putBook({ ...meta.bookMeta, bookId, cover: meta.bookMeta.cover || meta.cover || "" }).catch(() => { /* ignore */ });
  }
  await putChapter({
    chapterId: id, bookId, name: meta.chapterName, sort: meta.sort,
    scrambleId: meta.scrambleId, total: meta.pages.length, pages: meta.pages, cachedAt: Date.now()
  }).catch(() => { /* ignore */ });

  const entry: CacheTaskMeta = {
    id,
    bookId,
    title: meta.title || String(id),
    chapterName: meta.chapterName,
    sort: meta.sort,
    author: meta.author || "",
    category: meta.category || "",
    cover: meta.cover || "",
    scrambleId: meta.scrambleId,
    total: meta.pages.length,
    done: 0,
    status: "queued",
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

/** 删除任务与全部缓存文件（图片 + 页列表 + 该书无剩余话时连书级元数据一起删） */
export async function removeCache(id: number | string): Promise<void> {
  const sid = String(id);
  const t = tasks.find((x) => x.id === sid);
  const bookId = t?.bookId || knownBookId(sid);
  tasks = tasks.filter((x) => x.id !== sid);
  save();
  notify();
  loopGen += 1; // 打断进行中的任务
  await deleteAlbumCache(sid);
  await deleteChapter(sid);
  const rest = await listChapters(bookId);
  if (rest.length === 0) await deleteBook(bookId);
}

/** 重下：清空该话图片缓存后重新排队（保留元数据与页列表） */
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

/** 清空全部任务与缓存（缓存中心「清理全部」入口） */
export async function clearAllCacheTasks(): Promise<number> {
  loopGen += 1; // 打断进行中任务
  tasks = [];
  legacyPages.clear();
  save();
  notify();
  const n = await clearAllAlbumCaches();
  await clearAllMeta();
  return n;
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
    const pages = await pagesOf(t.id);
    if (!pages) {
      t.status = "failed";
      t.error = "缓存数据丢失，请点「重下」重新缓存";
      t.updatedAt = Date.now();
      save();
      notify();
      continue;
    }
    let ok = 0;
    let fail = 0;
    const sid = t.id;
    for (let i = 0; i < pages.length; i += BATCH) {
      if (loopGen !== gen) break; // 任务被删除/重下
      if ((t.status as string) === "paused") break;
      const batch = pages.slice(i, i + BATCH);
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
      if (fail === 0 && ok >= pages.length) {
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
