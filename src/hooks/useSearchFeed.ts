// 搜索页（底部导航「搜索」）的状态与数据：自带列表，与详情页的标签搜索页互不共享
import { useCallback, useRef, useState } from "react";
import { client } from "../core/api";
import { UI_KEYS } from "../core/constants";
import { debouncedSetJSON, getJSONNow, removeKeyNow } from "../core/debounceStorage";
import type { AlbumSummary } from "../core/types";

const SEARCH_HISTORY_KEY = UI_KEYS.searchHistory;

function loadSearchHistory(): string[] {
  return getJSONNow<string[]>(SEARCH_HISTORY_KEY, []);
}

function rememberSearch(q: string) {
  const list = loadSearchHistory().filter((x) => x !== q);
  list.unshift(q);
  debouncedSetJSON(SEARCH_HISTORY_KEY, list.slice(0, 12), 300);
}

export interface SearchFeedApi {
  query: string;
  setQuery: (v: string) => void;
  type: string;
  /** 列表排序（列表功能，不是排行榜）："" 最新 / mv 最多点击 / mp 最多图片 / tf 最多爱心 */
  order: string;
  items: AlbumSummary[];
  page: number;
  total: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
  searched: boolean;
  hotTags: string[];
  hotErr: string;
  history: string[];
  /** 进入搜索页时调用：读取搜索记录 + 拉热词（含一次重试） */
  init: () => Promise<void>;
  /** 用当前输入框内容搜索（第 1 页） */
  submit: () => void;
  /** 用指定词搜索（热词/搜索记录 chip） */
  runTerm: (term: string) => void;
  /** 切换搜索类型；已搜索过则立即按新类型重搜 */
  changeType: (type: string) => void;
  /** 切换结果排序（立即重搜第 1 页） */
  changeSort: (order: string) => void;
  retryHot: () => void;
  clearHistory: () => void;
  loadMore: () => void;
  reset: () => void;
}

/** onRedirectAid：搜索纯数字 JM 号时服务端返回 redirect_aid，由调用方直接打开详情页 */
export function useSearchFeed(onRedirectAid: (aid: string | number) => void): SearchFeedApi {
  const [query, setQuery] = useState("");
  const [type, setType] = useState("site");
  const [order, setOrder] = useState("");
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<AlbumSummary[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const [hotTags, setHotTags] = useState<string[]>([]);
  const [hotErr, setHotErr] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const reqIdRef = useRef(0);
  const initGenRef = useRef(0);
  const itemsRef = useRef<AlbumSummary[]>([]);
  itemsRef.current = items;
  const redirectRef = useRef(onRedirectAid);
  redirectRef.current = onRedirectAid;

  const search = useCallback(async (q: string, p: number, replace: boolean, searchType: string, sortOrder: string) => {
    const reqId = ++reqIdRef.current;
    setBusy(true);
    setError("");
    // 新搜索/刷新：先清空旧结果让骨架立现（即时反馈）；失败时回滚，避免网络抖动清空整页
    const prev = itemsRef.current;
    if (replace) setItems([]);
    try {
      const result = await client.search(q, p, 0, searchType, sortOrder);
      if (reqIdRef.current !== reqId) return; // 换词/换类型/换排序后丢弃过期回包
      if (replace && result.redirect_aid) {
        redirectRef.current(result.redirect_aid);
        return;
      }
      const totalNum = Number(result.total || 0);
      const content = result.content || [];
      const next = replace ? content : [...itemsRef.current, ...content];
      setItems(next);
      setPage(p);
      setTotal(totalNum);
      setHasMore(next.length < totalNum);
    } catch (err) {
      if (reqIdRef.current === reqId) {
        if (replace && prev.length > 0) setItems(prev);
        setError(String(err));
      }
    } finally {
      if (reqIdRef.current === reqId) setBusy(false);
    }
  }, []);

  const submit = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    rememberSearch(q);
    setHistory(loadSearchHistory());
    setSearched(true);
    void search(q, 1, true, type, order);
  }, [query, type, order, search]);

  const runTerm = useCallback((term: string) => {
    setQuery(term);
    rememberSearch(term);
    setHistory(loadSearchHistory());
    setSearched(true);
    void search(term, 1, true, type, order);
  }, [type, order, search]);

  const changeType = useCallback((nextType: string) => {
    setType(nextType);
    const q = query.trim();
    if (searched && q) void search(q, 1, true, nextType, order);
  }, [query, searched, order, search]);

  const changeSort = useCallback((nextOrder: string) => {
    setOrder(nextOrder);
    const q = query.trim();
    if (searched && q) void search(q, 1, true, type, nextOrder);
  }, [query, searched, type, search]);

  const retryHot = useCallback(() => {
    setHotErr("");
    client.getHotTags()
      .then((t) => { if (Array.isArray(t) && t.length) { setHotTags(t); setHotErr(""); } })
      .catch((e) => setHotErr(String(e).slice(0, 120)));
  }, []);

  const clearHistory = useCallback(() => {
    removeKeyNow(SEARCH_HISTORY_KEY);
    setHistory([]);
  }, []);

  const loadMore = useCallback(() => {
    const q = query.trim();
    if (!q || busy || !hasMore) return;
    void search(q, page + 1, false, type, order);
  }, [query, busy, hasMore, page, type, order, search]);

  const reset = useCallback(() => {
    reqIdRef.current++;
    initGenRef.current++;
    setBusy(false);
    setError("");
  }, []);

  const init = useCallback(async () => {
    const gen = ++initGenRef.current;
    const alive = () => initGenRef.current === gen;
    setHistory(loadSearchHistory());
    setHotErr("");
    try {
      if (!client.apiBase) { try { await client.init(); } catch { return; } }
      if (!client.setting) client.getSetting().catch(() => { /* 后台尽力，不阻塞热词 */ });
      const loadTags = async (): Promise<string[]> => {
        const t = await client.getHotTags();
        return Array.isArray(t) ? t : [];
      };
      let tags: string[] = [];
      try { tags = await loadTags(); } catch (err) { if (alive()) setHotErr(String(err).slice(0, 100)); }
      if (alive() && tags.length === 0) {
        await new Promise((r) => setTimeout(r, 900));
        try { tags = await loadTags(); } catch (err) { if (alive()) setHotErr(String(err).slice(0, 100)); }
      }
      if (alive() && tags.length > 0) { setHotErr(""); setHotTags(tags); }
    } catch { /* 静默 */ }
  }, []);

  return { query, setQuery, type, order, items, page, total, hasMore, busy, error, searched, hotTags, hotErr, history, init, submit, runTerm, changeType, changeSort, retryHot, clearHistory, loadMore, reset };
}
