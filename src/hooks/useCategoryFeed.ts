// 分类页状态：分类行（含「排行榜」这个去处）、二级行（子分类 / 四个榜）、排序、分页
//
// 概念区分（这一版的核心）：
//   · 排行榜 = 去处：与「同人」「单本」并列的入口，选中后出现二级榜（总榜/月榜/周榜/日榜）
//   · 排序   = 列表功能：改变当前列表的先后顺序（最新/最多点击/最多图片/最多爱心）
// 两者在服务端都落到同一个 o 参数，但 UI 上永远是两个位置，不会混在一起。
import { useCallback, useRef, useState } from "react";
import { client } from "../core/api";
import { prefetchCovers } from "../ui/AlbumCard";
import { RANK_PLACE } from "../core/constants";
import type { AlbumSummary, CategoryBlock, CategoryItem } from "../core/types";

export interface CategoryFeedApi {
  categories: CategoryItem[];
  blocks: CategoryBlock[];
  items: AlbumSummary[];
  /** 当前去处：分类 slug，或 RANK_PLACE（排行榜） */
  slug: string;
  sub: string;
  order: string;
  /** 非空表示当前在排行榜里，值就是榜 key */
  rank: string;
  page: number;
  hasMore: boolean;
  total: number;
  busy: boolean;
  error: string;
  /** 拉分类目录 + 更多分类分组 */
  openCategories: () => Promise<void>;
  /** 按分类加载某页；order 省略时沿用当前排序 */
  load: (slug: string, sub?: string, page?: number, replace?: boolean, order?: string) => Promise<void>;
  /** 选中一个去处（分类 slug 或 RANK_PLACE） */
  pickPlace: (slug: string) => void;
  /** 选中某个榜（总榜/月榜/周榜/日榜） */
  pickRank: (key: string) => void;
  /** 选中子分类 */
  pickSub: (sub: string) => void;
  /** 列表排序 */
  changeSort: (order: string) => void;
  loadMore: () => void;
  reset: () => void;
}

/** onStaleFail：刷新/加载更多失败但旧列表还在时的提示（此时不进错误态，避免内容在屏上却报网络错误） */
export function useCategoryFeed(onStaleFail?: (msg: string) => void): CategoryFeedApi {
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [blocks, setBlocks] = useState<CategoryBlock[]>([]);
  const [items, setItems] = useState<AlbumSummary[]>([]);
  const [slug, setSlug] = useState("");
  const [sub, setSub] = useState("");
  const [order, setOrder] = useState("");
  const [rank, setRank] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reqIdRef = useRef(0);
  // 镜像当前列表与排序，供 loadMore/切分类读取，避免把它们塞进依赖导致回调抖动
  const itemsRef = useRef<AlbumSummary[]>([]);
  itemsRef.current = items;
  const orderRef = useRef("");
  orderRef.current = order;
  const rankRef = useRef("");
  rankRef.current = rank;

  const openCategories = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const cats = await client.getCategories();
      setCategories(cats.categories || []);
      // blocks 实测为 { title, content: string[] }[]：更多分类浮层直接用
      setBlocks(Array.isArray(cats.blocks) ? cats.blocks.filter((b) => b && Array.isArray(b.content)) : []);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  /** 真正的取数：c 是官方 categories/filter 的 c 参数，slug/sub 是给 UI 记的状态 */
  const fetchList = useCallback(async (c: string, o: string, p: number, replace: boolean, nextSlug: string, nextSub: string) => {
    const reqId = ++reqIdRef.current;
    setBusy(true);
    setError("");
    // 刷新/切分类立刻清空旧列表 → 骨架立现（"刷新也要即时反馈"）；失败时再放回去，网络抖动不至于清空整页
    const prev = itemsRef.current;
    if (replace) setItems([]);
    try {
      const result = await client.getCategoryAlbums(c, p, o);
      if (reqIdRef.current !== reqId) return; // 切分类/切排序后丢弃过期回包
      const content = result.content || [];
      const totalNum = Number(result.total || 0);
      const next = replace ? content : [...itemsRef.current, ...content];
      setSlug(nextSlug);
      setSub(nextSub);
      setOrder(o);
      setItems(next);
      setPage(p);
      setTotal(totalNum);
      // content 为空即到底：避免服务端重复返回同一页时无限滚动打转
      setHasMore(content.length > 0 && next.length < totalNum);
      prefetchCovers(next);
    } catch (err) {
      if (reqIdRef.current === reqId) {
        if (prev.length > 0) {
          // 旧列表还能用：回滚并撤掉错误态，只提示一句（同 useHomeFeed 的处理）
          setItems(prev);
          setError("");
          onStaleFail?.(replace ? "刷新失败，已保留当前内容" : "加载更多失败，请稍后重试");
        } else {
          setError(String(err));
        }
      }
    } finally {
      if (reqIdRef.current === reqId) setBusy(false);
    }
  }, []);

  const load = useCallback(async (nextSlug: string, nextSub = "", p = 1, replace = true, nextOrder?: string) => {
    const o = nextOrder !== undefined ? nextOrder : orderRef.current;
    const isRank = nextSlug === RANK_PLACE;
    // 官方参数：子分类用 "主slug_子slug" 拼接；排行榜不带分类（全局榜）
    const c = isRank ? "" : (nextSub ? nextSlug + "_" + nextSub : nextSlug);
    await fetchList(c, o, p, replace, isRank ? RANK_PLACE : nextSlug, isRank ? "" : nextSub);
  }, [fetchList]);

  const pickPlace = useCallback((next: string) => {
    if (next === RANK_PLACE) {
      const k = rankRef.current || "mv";
      setRank(k);
      void load(RANK_PLACE, "", 1, true, k);
      return;
    }
    setRank("");
    void load(next, "", 1, true, ""); // 回到分类：排序回到「最新」
  }, [load]);

  const pickRank = useCallback((key: string) => {
    setRank(key);
    void load(RANK_PLACE, "", 1, true, key);
  }, [load]);

  const pickSub = useCallback((nextSub: string) => {
    void load(slug, nextSub, 1, true, rankRef.current || orderRef.current);
  }, [load, slug]);

  const changeSort = useCallback((o: string) => {
    setOrder(o);
    void load(slug, sub, 1, true, o);
  }, [load, slug, sub]);

  const loadMore = useCallback(() => {
    if (busy || !hasMore) return;
    void load(slug, sub, page + 1, false);
  }, [busy, hasMore, load, slug, sub, page]);

  const reset = useCallback(() => {
    reqIdRef.current++;
    setBusy(false);
    setError("");
  }, []);

  return {
    categories, blocks, items, slug, sub, order, rank, page, hasMore, total, busy, error,
    openCategories, load, pickPlace, pickRank, pickSub, changeSort, loadMore, reset
  };
}
