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

/**
 * 是否「已购买」。
 *
 * ★ 判据必须与官方逐字节一致（官方 APK 2.1.6 `pages/Comic/Detail.tsx:200`）：
 *     const isPurchased = purchased || purchased === "";
 *   即 **purchased 为「假值且不等于空串」时才算未购** —— undefined / null / 0 / false。
 *   非空字符串（**含 "0" 与 "false"**）以及空串 "" 都算**已购**。服务端契约如此。
 *
 * 为什么不能"猜布尔真值"（1.x 的错法，真机反馈：购买成功后按钮不消失、从列表重进依旧）：
 *   旧实现把 "0" / "false" / "" 一律当未购，而服务端买过之后返回的正是这类形态，
 *   于是钱已扣、权益已生效，本地却永远判"未购买" —— 且**每次重进都会重新算出同样的错误答案**，
 *   看起来像"没生效"，实际是判据认错了。
 *
 * 另注：官方 `handleClick` 判定"能不能读"时**只看 purchased，不看 price**，
 * 所以 price 只用于「展示应付金额」，不参与是否已购的判断（见 parsePaid）。
 */
export function isPurchased(d: AlbumDetail | null | undefined): boolean {
  if (!d) return false;
  const v = d.purchased;
  return Boolean(v) || v === "";
}

/**
 * 是否「付费且未购」（决定详情页显示购买入口还是阅读入口）。
 * price 有效 = 这是付费内容；再叠加未购才是"要钱"。
 */
export function parsePaid(d: AlbumDetail): boolean {
  const p = Number(d.price);
  if (!(p > 0)) return false;
  return !isPurchased(d);
}

/** 应付 JCoin：price 有效时返回数值，否则 0（仅用于展示，不参与已购判断） */
export function priceOf(d: AlbumDetail | null | undefined): number {
  const p = Number(d?.price);
  return Number.isFinite(p) && p > 0 ? p : 0;
}
