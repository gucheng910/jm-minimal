// 详情页的纯派生逻辑：作者名归一化、付费未购判断（抽出来便于单测）
import type { AlbumDetail } from "./types";

/** 详情页作者：完整详情是 string[]，列表乐观快照可能是 "a/b" 字符串，两种都要兼容 */
export function authorNames(d: AlbumDetail | null): string[] {
  if (!d) return [];
  const raw = d.author as unknown;
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split("/").map((x) => x.trim()).filter(Boolean);
  return [];
}

/** 详情页标签：一律转字符串（个别专辑若返回非字符串，直接当 React 子节点渲染会抛错导致整屏白屏） */
export function albumTags(d: AlbumDetail | null): string[] {
  if (!d) return [];
  const raw = d.tags as unknown;
  return Array.isArray(raw) ? raw.filter(Boolean).map((t) => String(t)) : [];
}

/** 是否付费未购：price 为有效金额且 purchased 无已购标记 */
export function parsePaid(d: AlbumDetail): boolean {
  const p = Number(d.price);
  if (!(p > 0)) return false;
  const own = typeof d.purchased === "string"
    ? !["", "0", "false", "null", "undefined"].includes(String(d.purchased).toLowerCase())
    : Boolean(d.purchased);
  return !own;
}
