// 离线元数据（IndexedDB）
// 为什么不是 localStorage：每话 pages 约 5 KB，整本 146 话约 800 KB；localStorage 每次进度落盘
// 都要全量 JSON 重写（实测 ~11 ms 主线程）且有 9.4 MB 硬顶 + 静默失败（见 docs/28 §2.2）。
// IDB 按话增量写（0.3 ms/话），配额 ~10 GB。
import type { AlbumDetail, ReadPage } from "./types";
import { albumTags, authorNames } from "./albumMeta";
import { bookIdOf } from "./series";

const DB_NAME = "jm-offline";
const DB_VERSION = 1;
const BOOKS = "books";
const CHAPTERS = "chapters";

export interface BookChapter {
  id: string;
  name: string;
  sort: number;
}

/** 书级元数据：离线详情页的唯一数据源（简介/标签/作者/目录） */
export interface BookMeta {
  bookId: string;
  name: string;
  author: string[];
  tags: string[];
  description: string;
  cover?: string;
  chapters: BookChapter[];
  updatedAt: number;
}

/** 单话缓存记录（页列表按话存，与 Cache API 的 jm-offline-<话id> 一一对应） */
export interface ChapterMeta {
  chapterId: string;
  bookId: string;
  name?: string;
  sort?: number;
  scrambleId?: number | string;
  total: number;
  pages: ReadPage[];
  cachedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") { resolve(null); return; }
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BOOKS)) db.createObjectStore(BOOKS, { keyPath: "bookId" });
      if (!db.objectStoreNames.contains(CHAPTERS)) {
        db.createObjectStore(CHAPTERS, { keyPath: "chapterId" }).createIndex("bookId", "bookId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // 别的标签页占着旧版本：降级为「无 IDB」，调用方走内存兜底
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** 事务包装：IDB 事务在事件循环空转后自动失效，因此只在事务内放 IDB 请求 */
function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | null): Promise<T | null> {
  return openDb().then((db) => new Promise<T | null>((resolve) => {
    if (!db) { resolve(null); return; }
    let t: IDBTransaction;
    try { t = db.transaction(store, mode); } catch { resolve(null); return; }
    let req: IDBRequest<T> | null = null;
    try { req = fn(t.objectStore(store)); } catch { resolve(null); return; }
    if (!req) { resolve(null); return; }
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => resolve(null);
    t.onabort = () => resolve(null);
  }));
}

export async function idbAvailable(): Promise<boolean> {
  return (await openDb()) !== null;
}

export function putBook(meta: BookMeta): Promise<unknown> {
  return tx(BOOKS, "readwrite", (s) => s.put(meta));
}

export async function getBook(bookId: string): Promise<BookMeta | null> {
  return (await tx<BookMeta>(BOOKS, "readonly", (s) => s.get(bookId))) || null;
}

export function putChapter(meta: ChapterMeta): Promise<unknown> {
  return tx(CHAPTERS, "readwrite", (s) => s.put(meta));
}

export async function getChapter(chapterId: string): Promise<ChapterMeta | null> {
  return (await tx<ChapterMeta>(CHAPTERS, "readonly", (s) => s.get(chapterId))) || null;
}

export function deleteChapter(chapterId: string): Promise<unknown> {
  return tx(CHAPTERS, "readwrite", (s) => s.delete(chapterId));
}

/** 删除一本书及其全部话记录（图片缓存由 offline.ts 负责） */
export async function deleteBook(bookId: string): Promise<void> {
  const list = await listChapters(bookId);
  await Promise.all(list.map((c) => deleteChapter(c.chapterId)));
  await tx(BOOKS, "readwrite", (s) => s.delete(bookId));
}

export async function listChapters(bookId: string): Promise<ChapterMeta[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    let t: IDBTransaction;
    try { t = db.transaction(CHAPTERS, "readonly"); } catch { resolve([]); return; }
    const rq = t.objectStore(CHAPTERS).index("bookId").getAll(bookId);
    rq.onsuccess = () => resolve((rq.result as ChapterMeta[]) || []);
    rq.onerror = () => resolve([]);
  });
}

export async function listBooks(): Promise<BookMeta[]> {
  return (await tx<BookMeta[]>(BOOKS, "readonly", (s) => s.getAll())) || [];
}

export async function clearAllMeta(): Promise<void> {
  await tx(CHAPTERS, "readwrite", (s) => s.clear());
  await tx(BOOKS, "readwrite", (s) => s.clear());
}

/**
 * 书 id 纠正：旧版本把「话 id」当成了书 id 存下来，联网拿到 series_id 后要把
 * 该书记录改挂到正确的书 id 上，否则 listChapters(新书 id) 会是空的。
 */
export async function rebindBook(oldBookId: string, newBookId: string): Promise<void> {
  if (!oldBookId || !newBookId || oldBookId === newBookId) return;
  const chapters = await listChapters(oldBookId);
  for (const c of chapters) await putChapter({ ...c, bookId: newBookId });
  await tx(BOOKS, "readwrite", (s) => s.delete(oldBookId));
}

/** 从详情构造书级元数据（话级 payload 的作者/简介为空，调用前应先用 getAlbumFull 补全） */
export function bookMetaFromDetail(d: AlbumDetail, cover?: string): BookMeta {
  const series = Array.isArray(d.series) ? d.series : [];
  return {
    bookId: bookIdOf(d),
    name: d.book_name || d.name || "",
    author: authorNames(d),
    tags: albumTags(d),
    description: String(d.description || ""),
    cover: cover || "",
    chapters: series.map((s) => {
      const n = Number(s.sort);
      return { id: String(s.id), name: String(s.name || ""), sort: Number.isFinite(n) ? n : 0 };
    }),
    updatedAt: Date.now()
  };
}

/** 章节显示名："第12话"；第 1 话接口名称为空时用 sort 兜底 */
export function chapterLabel(c: { name?: string; sort?: number | string } | undefined | null): string {
  if (!c) return "";
  const name = String(c.name || "").trim();
  if (name) return name;
  const n = Number(c.sort);
  return Number.isFinite(n) && n > 0 ? "第" + n + "话" : "";
}
