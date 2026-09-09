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
