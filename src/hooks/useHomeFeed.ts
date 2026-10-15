// 首页内容流（随机推荐 / 最新 / 加载更多）状态与数据：自带列表
import { useCallback, useRef, useState } from "react";
import { client } from "../core/api";
import { PAGE_SIZE } from "../core/constants";
import { prefetchCovers } from "../ui/AlbumCard";
import { DNS_HINT } from "../core/platform";
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
  /**
   * **外部驱动的加载**（v3.13）：点亮骨架屏，直到 `endExternal()`。
   *
   * ── 为什么需要它（修的是"切到首页一片空白"的真 bug）────────────────────
   * 骨架屏的判据是 `busy && items.length === 0`（见 `ui/blocks/AlbumFeed`）。
   * 而首页有**两条**加载路径：
   *   ① `loadRandom / loadLatest / loadMore` —— 它们自己会 `setBusy(true)`；
   *   ② **启动流程**（`ContentView` 里那段 effect：还原最优线路 → 取 setting → 拉推荐，
   *      失败还隔 900ms 重试一次）—— 它直接调 `client.getRandomRecommend()`，
   *      过去**没有任何东西**告诉列表"现在正在请求"。
   * 于是从分类页切到首页、或者过完 18+ 门刚进首页时：空列表 + busy=false
   * = 骨架不画、网格也是空的 = **整片空白**，用户完全看不出在加载（用户实测反馈）。
   *
   * 为什么不干脆让那段直接调 `loadRandom()`：那会连带改掉它的失败文案、
   * 900ms 重试与 `onRandomFail` 的 toast 语义（那是**冷启动专用**的一套处理）。
   * 加一个显式的"我在加载"开关比"顺手把两套合并"风险小得多，也正是缺的那样东西。
   */
  beginExternal: () => void;
  /** 结束外部加载（幂等；正常路径由 `ContentView` 的 finally 调用） */
  endExternal: () => void;
}

export function useHomeFeed(opts: HomeFeedOptions = {}): HomeFeedApi {
  const [items, setItems] = useState<AlbumSummary[]>([]);
  const [kind, setKind] = useState<FeedKind>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 外部加载标志（见 `HomeFeedApi.beginExternal` 的说明）：与 `busy` 取并集对外暴露 */
  const [external, setExternal] = useState(false);
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
    setError("网络连接失败，推荐内容加载不出来。" + DNS_HINT + "；仍失败再尝试魔法或切换线路。");
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

  const beginExternal = useCallback(() => {
    setExternal(true);
    setError(""); // 与 run() 开跑时一致：新一轮加载开始，旧的错误卡就该让位给骨架
  }, []);
  const endExternal = useCallback(() => { setExternal(false); }, []);

  /**
   * ⚠️ 对外的 `busy` 是**两个来源的并集**：内部请求（`run()`）与外部加载（启动流程）。
   *    只暴露内部那一个，就是"切到首页一片空白"那个 bug 的直接成因。
   */
  return {
    items, kind, page, hasMore, busy: busy || external, error,
    setError, show, loadLatest, loadRandom, loadMore, reset, hasItems,
    beginExternal, endExternal
  };
}
