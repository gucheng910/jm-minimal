// 连载「书 / 话」两级模型（实测：/album?id=<任意一话> 都返回整本书的 series[] 与 series_id）
// - bookIdOf：把任意一话归一成"书 id"（series_id 为 0/空 = 单本，书 id 就是自己的 id）
// - seriesMap：照片(话) id → 书 id 的本地索引。任意一次 /album 回包都会带回整本书的 series[]，
//   所以一次请求就能种入整本的映射，后续合并（足迹/缓存）无需再联网。
// - mergeBookMeta：用书级 payload 补全话级 payload 缺失的字段（作者/简介/标签/目录）
import type { AlbumDetail } from "./types";
import { debouncedSetJSON, getJSONNow } from "./debounceStorage";

export const SERIES_MAP_KEY = "jmclient.seriesMap.v1";
/** 映射表上限（约 40 本连载）；超出后淘汰最旧的一批，避免无限膨胀 */
const MAX_ENTRIES = 6000;
const EVICT_TO = 4000;

export type SeriesMap = Record<string, string>;

let cache: SeriesMap | null = null;

/** 书 id：series_id 有效时用它，否则（0 / 空 / 缺失）说明是单本，书 id = 自身 id */
export function bookIdOf(d: Pick<AlbumDetail, "id" | "series_id"> | null | undefined): string {
  if (!d || d.id === undefined || d.id === null) return "";
  const sid = String(d.series_id ?? "").trim();
  return sid && sid !== "0" ? sid : String(d.id);
}

/** 多话作品（连载）；单本的 series 是空数组 */
export function isSeriesWork(d: Pick<AlbumDetail, "series"> | null | undefined): boolean {
  return Array.isArray(d?.series) && d!.series!.length > 1;
}

export function loadSeriesMap(): SeriesMap {
  if (cache) return cache;
  const raw = getJSONNow<SeriesMap>(SERIES_MAP_KEY, {});
  cache = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return cache;
}

/** 照片(话) id → 书 id；未收录时回落到自身 id（单本语义） */
export function knownBookId(photoId: number | string): string {
  return loadSeriesMap()[String(photoId)] || String(photoId);
}

/** 用一次 /album 回包种入整本书的映射（含书 id 自身） */
export function rememberSeries(d: AlbumDetail | null | undefined): void {
  if (!d || d.id === undefined || d.id === null) return;
  const map = loadSeriesMap();
  const bookId = bookIdOf(d);
  let changed = map[String(d.id)] !== bookId;
  map[String(d.id)] = bookId;
  const series = Array.isArray(d.series) ? d.series : [];
  for (const s of series) {
    if (!s || s.id === undefined || s.id === null) continue;
    const k = String(s.id);
    if (map[k] !== bookId) { map[k] = bookId; changed = true; }
  }
  if (!changed) return;
  evictIfNeeded(map);
  debouncedSetJSON(SERIES_MAP_KEY, map, 800);
}

/** 对象键保持插入顺序：超限时淘汰最旧的一批 */
function evictIfNeeded(map: SeriesMap): void {
  const keys = Object.keys(map);
  if (keys.length <= MAX_ENTRIES) return;
  for (const k of keys.slice(0, keys.length - EVICT_TO)) delete map[k];
}

export function seriesMapSize(): number {
  return Object.keys(loadSeriesMap()).length;
}

export function clearSeriesMap(): void {
  cache = {};
  try { localStorage.removeItem(SERIES_MAP_KEY); } catch { /* ignore */ }
}

/**
 * 用书级 payload 补全话级 payload。
 * 书名保留话级的（"书名-第2话"更利于识别），作者/简介/标签/目录取书级的
 * —— 实测话级 payload 的 author 为空数组、description 为空串。
 */
export function mergeBookMeta(chapter: AlbumDetail, book: AlbumDetail | null | undefined): AlbumDetail {
  if (!book) return chapter;
  const pick = <T,>(a: T[] | undefined, b: T[] | undefined): T[] | undefined =>
    Array.isArray(b) && b.length > 0 ? b : a;
  return {
    ...chapter,
    author: pick(chapter.author, book.author),
    tags: pick(chapter.tags, book.tags),
    works: pick(chapter.works, book.works),
    actors: pick(chapter.actors, book.actors),
    description: book.description || chapter.description,
    series: Array.isArray(book.series) && book.series.length > 0 ? book.series : chapter.series,
    series_id: book.series_id ?? chapter.series_id,
    book_name: book.name || chapter.book_name
  };
}

// ────────────────────────────────────────────────
// 目录要显示哪几话、按什么顺序（v3.9，调研 TOP8 第 4 条）
// ────────────────────────────────────────────────

/** 目录排序档：`asc` = 服务端给的顺序（默认，= 加这一项之前的现状）；`desc` = 按话号倒序（新话在前） */
export type ChapterOrder = "asc" | "desc";
/** 目录筛选档：`all` = 全都显示（默认）；`cached` = 只显示**本地已缓存且真有页**的话 */
export type ChapterFilter = "all" | "cached";

/**
 * 目录（章节列表）的**可见列表**：先按 `filter` 过滤，再按 `order` 排序。
 *
 * 纯函数（不碰 DOM、不碰 I/O）—— `cached` 由调用方扫描后传进来（见 `core/offline.scanCachedChapters`），
 * 所以这一层能在 node 里直接测。
 *
 * ⚠️ 三条判据：
 *   ① **默认档（`asc` + `all`）必须原样返回服务端给的顺序**（`slice()` 而已，不排序）——
 *      这是"没配过的用户 DOM 逐字不变"那条红线；
 *   ② 倒序**按 `sort` 排**，不是 `series.reverse()`：实测有作品的回包顺序本身就不严格按 `sort`，
 *      reverse 只会把乱序原样反过来（用户看到的仍然是乱的）。`sort` 无效（缺失/0/非数字）的项
 *      **排到最后并保持它们之间的原相对顺序**（稳定排序，同 `sort` 的也保持原相对顺序）；
 *   ③ 筛选只看"**有页**的缓存"：`scanCachedChapters` 对"只有封面、没有页"的目录也会给条目
 *      （判据与 1.7.2 修复一致），但那**读不了** —— 进"只看已缓存"只会点开一个空阅读器。
 *      所以这里要求 `pages > 0`。
 */
export function visibleChapters<T extends { id: number | string; sort?: number | string }>(
  series: readonly T[],
  order: ChapterOrder,
  filter: ChapterFilter,
  cached: ReadonlyMap<string, { pages: number }>
): T[] {
  /** 可读的缓存 = **有页**（只有封面的条目读不了，见上面判据③） */
  const isCached = (id: string): boolean => {
    const info = cached.get(id);
    return !!info && Number(info.pages) > 0;
  };
  const out = filter === "cached" ? series.filter((s) => isCached(String(s.id))) : series.slice();
  if (order !== "desc") return out;

  const idx = new Map<T, number>();
  out.forEach((s, i) => idx.set(s, i));
  const num = (s: T): number | null => {
    const n = Number(s.sort);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  out.sort((a, b) => {
    const na = num(a);
    const nb = num(b);
    if (na === null && nb === null) return idx.get(a)! - idx.get(b)!;   // 都无效：保持原相对顺序
    if (na === null) return 1;                                          // 无效的排到最后
    if (nb === null) return -1;
    if (na !== nb) return nb - na;                                      // 话号倒序
    return idx.get(a)! - idx.get(b)!;                                   // 同话号：保持原相对顺序
  });
  return out;
}
