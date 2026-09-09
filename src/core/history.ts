// 阅读足迹：本地记录，按「书」合并（连载多话只占一条）
// 存储键仍是 UI_KEYS.history，但条目升级为 HistoryEntry；读到旧版（AlbumSummary[]）时自动迁移并回写。
import { UI_KEYS } from "./constants";
import { debouncedSetJSON, getJSONNow } from "./debounceStorage";
import { knownBookId } from "./series";

export interface HistoryEntry {
  /** 最后阅读的话 id（继续阅读用） */
  id: string;
  /** 书 id：合并去重键（单本 = 自身 id） */
  bookId: string;
  /** 书级书名（列表标题） */
  name: string;
  author?: string;
  adddate?: string | number;
  description?: string;
  /** "第12话"；单本为空 */
  chapterName?: string;
  sort?: number | string;
  /** 总话数（连载时用于展示） */
  chapters?: number;
  lastReadAt: number;
}

const KEY = UI_KEYS.history;
export const HISTORY_MAX = 50;

/** 存储里的原始条目：可能是 v2（HistoryEntry），也可能是 v1（AlbumSummary，无 bookId/lastReadAt） */
interface RawEntry {
  id?: number | string;
  bookId?: string;
  name?: string;
  author?: unknown;
  adddate?: string | number;
  description?: unknown;
  chapterName?: unknown;
  sort?: number | string;
  chapters?: number;
  lastReadAt?: number;
}

function pickStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** 归一化 + 同书合并 + 迁移旧格式（AlbumSummary[]） */
function normalize(list: unknown[]): { entries: HistoryEntry[]; migrated: boolean } {
  const out: HistoryEntry[] = [];
  let migrated = false;
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") { migrated = true; return; }
    const r = raw as RawEntry;
    const id = String(r.id ?? "");
    if (!id) { migrated = true; return; }
    const bookId = String(r.bookId || knownBookId(id));
    const lastReadAt = Number(r.lastReadAt) || 0;
    if (!r.bookId || !lastReadAt) migrated = true;
    out.push({
      id,
      bookId,
      name: String(r.name || ""),
      author: pickStr(r.author),
      adddate: r.adddate,
      description: pickStr(r.description),
      chapterName: pickStr(r.chapterName),
      sort: r.sort,
      chapters: typeof r.chapters === "number" ? r.chapters : undefined,
      // 旧数据没有时间戳：用序号倒推，保持原有"最近在前"的顺序
      lastReadAt: lastReadAt || Date.now() - i * 1000
    });
  });

  const byBook = new Map<string, HistoryEntry>();
  for (const e of out) {
    const cur = byBook.get(e.bookId);
    if (!cur) { byBook.set(e.bookId, e); continue; }
    migrated = true;
    const newer = cur.lastReadAt >= e.lastReadAt ? cur : e;
    const older = newer === cur ? e : cur;
    byBook.set(e.bookId, {
      ...newer,
      name: newer.name || older.name,
      author: newer.author || older.author,
      description: newer.description || older.description,
      chapters: newer.chapters ?? older.chapters
    });
  }

  const entries = [...byBook.values()].sort((a, b) => b.lastReadAt - a.lastReadAt).slice(0, HISTORY_MAX);
  if (entries.length !== list.length) migrated = true;
  return { entries, migrated };
}

export function loadHistory(): HistoryEntry[] {
  const raw = getJSONNow<unknown>(KEY, []);
  const list = Array.isArray(raw) ? raw : [];
  const { entries, migrated } = normalize(list);
  if (migrated) debouncedSetJSON(KEY, entries, 300); // 一次性回写，之后不再重复推断
  return entries;
}

/** 记录一次阅读：同书覆盖（只保留最近读的那一话） */
export function saveHistory(entry: HistoryEntry): void {
  const list = loadHistory().filter((x) => x.bookId !== entry.bookId);
  list.unshift({ ...entry, lastReadAt: entry.lastReadAt || Date.now() });
  debouncedSetJSON(KEY, list.slice(0, HISTORY_MAX), 500);
}

export function clearHistory(): void {
  debouncedSetJSON(KEY, [], 0);
}
