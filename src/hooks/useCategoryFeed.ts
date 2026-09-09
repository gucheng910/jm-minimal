// 分类页（最新/排行榜/子分类）状态与数据：自带列表，不再与首页共享 items
import { useCallback, useRef, useState } from "react";
import { client } from "../core/api";
import { prefetchCovers } from "../ui/AlbumCard";
import type { AlbumSummary, CategoryItem } from "../core/types";

export interface CategoryFeedApi {
  categories: CategoryItem[];
  items: AlbumSummary[];
  slug: string;
  sub: string;
  order: string;
  page: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
  /** 拉分类目录（顶部分类 chip） */
  openCategories: () => Promise<void>;
  /** 加载某分类某页；order 省略时沿用当前排序 */
  load: (slug: string, sub?: string, page?: number, replace?: boolean, order?: string) => Promise<void>;
  changeSort: (order: string) => void;
  loadMore: () => void;
  reset: () => void;
}

export function useCategoryFeed(): CategoryFeedApi {
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [items, setItems] = useState<AlbumSummary[]>([]);
  const [slug, setSlug] = useState("");
  const [sub, setSub] = useState("");
  const [order, setOrder] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reqIdRef = useRef(0);
  // 镜像当前列表，供 loadMore 拼页时读取，避免把 items 塞进 useCallback 依赖
  const itemsRef = useRef<AlbumSummary[]>([]);
  itemsRef.current = items;

  const openCategories = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const cats = await client.getCategories();
      setCategories(cats.categories || []);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const load = useCallback(async (nextSlug: string, nextSub = "", p = 1, replace = true, nextOrder?: string) => {
    // 官方参数：子分类用 "主slug_子slug" 拼接
    const c = nextSub ? nextSlug + "_" + nextSub : nextSlug;
    const o = nextOrder !== undefined ? nextOrder : order;
    const reqId = ++reqIdRef.current;
    setBusy(true);
    setError("");
    try {
      const result = await client.getCategoryAlbums(c, p, o);
      if (reqIdRef.current !== reqId) return; // 切分类/切排序后丢弃过期回包
      const content = result.content || [];
      const total = Number(result.total || 0);
      const next = replace ? content : [...itemsRef.current, ...content];
      setSlug(nextSlug);
      setSub(nextSub);
      if (nextOrder !== undefined) setOrder(nextOrder);
      setItems(next);
      setPage(p);
      setHasMore(next.length < total);
      prefetchCovers(next);
    } catch (err) {
      if (reqIdRef.current === reqId) setError(String(err));
    } finally {
      if (reqIdRef.current === reqId) setBusy(false);
    }
  }, [order]);

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

  return { categories, items, slug, sub, order, page, hasMore, busy, error, openCategories, load, changeSort, loadMore, reset };
}
