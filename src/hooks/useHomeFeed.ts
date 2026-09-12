// 首页内容流（随机推荐 / 最新 / 加载更多）状态与数据：自带列表
import { useCallback, useRef, useState } from "react";
import { client } from "../core/api";
import { PAGE_SIZE } from "../core/constants";
import { prefetchCovers } from "../ui/AlbumCard";
import type { AlbumSummary } from "../core/types";

export type FeedKind = "latest" | null;

export interface HomeFeedOptions {
  /** 列表落地后回调：ContentView 据此决定是否切回 home（详情/阅读器打开时不抢） */
  onListShown?: () => void;
  /** 随机推荐加载失败的额外提示（toast） */
  onRandomFail?: () => void;
  /** 刷新/加载更多失败但旧列表还在时的提示：此时不进错误态，避免"内容明明在屏上却报网络错误" */
  onStaleFail?: (msg: string) => void;
}

export interface HomeFeedApi {
  items: AlbumSummary[];
  kind: FeedKind;
  page: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
  /** 直接写错误（冷启动等外部流程的失败提示） */
  setError: (msg: string) => void;
  /** 直接落地一份列表（冷启动预取、刷新等外部数据源） */
  show: (list: AlbumSummary[], kind: FeedKind, hasMore?: boolean, page?: number) => void;
  loadLatest: () => Promise<void>;
  loadRandom: () => Promise<void>;
  loadMore: () => void;
  reset: () => void;
  /** 当前是否已有列表内容（调用方据此决定要不要占用整屏错误态） */
  hasItems: () => boolean;
}

export function useHomeFeed(opts: HomeFeedOptions = {}): HomeFeedApi {
  const [items, setItems] = useState<AlbumSummary[]>([]);
  const [kind, setKind] = useState<FeedKind>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const itemsRef = useRef<AlbumSummary[]>([]);
  itemsRef.current = items;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const show = useCallback((list: AlbumSummary[], nextKind: FeedKind, more = false, p = 1) => {
    setItems(list);
    setError(""); // 有内容落地就不该再挂着错误卡（失败后重试成功、后台刷新成功都走这里）
    setKind(nextKind);
    setPage(p);
    setHasMore(more);
    prefetchCovers(list); // 首屏前 6 张封面预取（不阻塞渲染）
    optsRef.current.onListShown?.();
  }, []);

  const loadLatest = useCallback(async () => {
    const prev = itemsRef.current;
    setItems([]); // 刷新/切换分段：先出骨架（即时反馈），拿到数据再填充
    const list = await run(() => client.getLatest());
    if (list) { show(list, "latest", list.length >= PAGE_SIZE, 1); return; }
    if (prev.length > 0) {
      // 保住旧列表：run() 记下的错误要撤掉，否则列表上方会顶出一条"网络连接失败"（内容明明在）
      setItems(prev);
      setError("");
      optsRef.current.onStaleFail?.("刷新失败，已保留当前内容");
    }
  }, [run, show]);

  const loadRandom = useCallback(async () => {
    const prev = itemsRef.current;
    setItems([]);
    const list = await run(() => client.getRandomRecommend());
    if (list) {
      show(list, "latest", false, 1);
      return;
    }
    if (prev.length > 0) {
      setItems(prev);
      setError("");
      optsRef.current.onStaleFail?.("刷新失败，已保留当前内容");
      return;
    }
    // 完全没内容可展示：才给整屏错误 + DNS 引导（run() 已置 error，这里换成可操作的文案）
    setError("网络连接失败，推荐内容加载不出来。先去会员页「DNS 加速」配置 DoT 公共 DNS（可解决大多数运营商 DNS 污染）；配置后需删除后台重新进入 App 使设置生效，再重试；仍失败再尝试魔法或切换线路。");
    optsRef.current.onRandomFail?.();
  }, [run, show]);

  const loadMore = useCallback(() => {
    if (kind !== "latest" || busy || !hasMore) return;
    const p = page + 1;
    void (async () => {
      const list = await run(() => client.request<AlbumSummary[]>("/latest", { page: p }));
      if (list) { show([...itemsRef.current, ...list], "latest", list.length >= PAGE_SIZE, p); return; }
      // 底部分页失败：列表还在，只提示一句，别把整页顶成错误态
      if (itemsRef.current.length > 0) {
        setError("");
        optsRef.current.onStaleFail?.("加载更多失败，请稍后重试");
      }
    })();
  }, [kind, busy, hasMore, page, run, show]);

  const reset = useCallback(() => {
    setItems([]);
    setKind(null);
    setPage(1);
    setHasMore(false);
    setBusy(false);
    setError("");
  }, []);

  const hasItems = useCallback(() => itemsRef.current.length > 0, []);

  return { items, kind, page, hasMore, busy, error, setError, show, loadLatest, loadRandom, loadMore, reset, hasItems };
}
