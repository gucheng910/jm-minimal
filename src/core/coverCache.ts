/**
 * 封面图的**持久化缓存**（IndexedDB）—— 解决"第二次进列表封面要重新下载"。
 *
 * 为什么不用 Cache API：`docs` 与 capacitor.config 里都有记录 —— iOS 壳用的是
 * `capacitor://localhost`，Cache API 在该 scheme 下可用性未经验证（离线库因此给 iOS 走 Filesystem）。
 * IndexedDB 在两种壳里都稳，而且这里的读写都发生在 **Worker** 里（不占主线程）。
 *
 * 键就用**完整 URL**（含 `?t=<update_at>`）：JM 的封面地址带 t 签权参数，`update_at` 一变 URL 就变，
 * 天然实现了"过期即失效"，不需要再算 TTL。仍保留一个最大年龄兜底（防止永不清理）。
 *
 * 所有函数都不抛异常（IDB 不可用/被占用/配额满都静默降级成"没有缓存"）——
 * 缓存只是加速，缺了必须不影响显示。
 */

const DB_NAME = "jm-covers";
const DB_VERSION = 1;
const STORE = "covers";
/** 最多保留多少张封面 */
const MAX_ENTRIES = 400;
/** 最多占多少字节（封面原图常见 40~120KB，24MB 约等于 200~400 张） */
const MAX_BYTES = 24 * 1024 * 1024;
/** 超过这个年龄的条目在写入时顺手清掉（30 天；正常情况下 URL 里的 t 会先变） */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CoverRecord {
  /** 完整 URL（主键） */
  url: string;
  blob: Blob;
  /** 写入时间（LRU/年龄判定用） */
  ts: number;
  /** 字节数（配额统计用：不必每次读 blob 才知道大小） */
  size: number;
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
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "url" }).createIndex("ts", "ts", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** 在事务里跑一个 IDB 请求；任何失败都 resolve(null) */
function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | null): Promise<T | null> {
  return openDb().then((db) => new Promise<T | null>((resolve) => {
    if (!db) { resolve(null); return; }
    let t: IDBTransaction;
    try { t = db.transaction(STORE, mode); } catch { resolve(null); return; }
    let req: IDBRequest<T> | null = null;
    try { req = fn(t.objectStore(STORE)); } catch { resolve(null); return; }
    if (!req) { resolve(null); return; }
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => resolve(null);
    t.onabort = () => resolve(null);
  }));
}

/** 读一张封面；没命中返回 null */
export async function coverGet(url: string): Promise<Blob | null> {
  if (!url) return null;
  const rec = await run<CoverRecord | undefined>("readonly", (s) => s.get(url) as IDBRequest<CoverRecord | undefined>);
  if (!rec || !rec.blob) return null;
  if (Date.now() - (rec.ts || 0) > MAX_AGE_MS) return null; // 太老：当作没有（新的会在下次写入时落盘）
  return rec.blob;
}

/**
 * 写一张封面（含淘汰）。返回是否写成功 —— 失败不影响显示，只是下次还要重新下载。
 * 淘汰策略：条数超过 MAX_ENTRIES 或总字节超过 MAX_BYTES 时，按 ts 从旧到新删，
 * 一次最多删 20 条（避免一次 put 里做太久）。
 */
export async function coverPut(url: string, blob: Blob): Promise<boolean> {
  if (!url || !blob || !blob.size) return false;
  const ts = Date.now();
  const rec: CoverRecord = { url, blob, ts, size: blob.size };
  const ok = await run<IDBValidKey>("readwrite", (s) => s.put(rec) as IDBRequest<IDBValidKey>);
  if (ok === null) return false;
  await evict();
  return true;
}

/** 按 LRU 淘汰；同时清掉过老条目 */
export async function evict(): Promise<void> {
  const all = await run<CoverRecord[]>("readonly", (s) => s.getAll() as IDBRequest<CoverRecord[]>);
  if (!all || all.length === 0) return;
  const now = Date.now();
  const sorted = all.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)); // 旧 → 新
  let bytes = sorted.reduce((n, r) => n + (r.size || 0), 0);
  let count = sorted.length;
  const doomed: string[] = [];
  for (const r of sorted) {
    const tooOld = now - (r.ts || 0) > MAX_AGE_MS;
    if (!tooOld && count <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    if (doomed.length >= 20) break;
    doomed.push(r.url);
    count -= 1;
    bytes -= (r.size || 0);
  }
  for (const url of doomed) {
    await run<undefined>("readwrite", (s) => s.delete(url) as IDBRequest<undefined>);
  }
}

/** 统计（诊断/测试用） */
export async function coverStats(): Promise<{ count: number; bytes: number }> {
  const all = await run<CoverRecord[]>("readonly", (s) => s.getAll() as IDBRequest<CoverRecord[]>);
  if (!all) return { count: 0, bytes: 0 };
  return { count: all.length, bytes: all.reduce((n, r) => n + (r.size || 0), 0) };
}

/** 清空（设置页"清除缓存"可以接这里；目前只给测试/诊断用） */
export async function coverClear(): Promise<void> {
  await run("readwrite", (s) => s.clear() as IDBRequest<undefined>);
}
