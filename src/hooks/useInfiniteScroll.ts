import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * 列表触底续页（哨兵进入预读区就调 onLoadMore）。
 *
 * 抽出来的原因：首页 / 分类页 / 搜索页原来各写了一份**逐字相同**的实现
 * （effect + sentinelRef + loadMoreRef 三件套，三处一模一样）。
 * 三份拷贝的问题不是行数，而是**改一处忘两处**——比如调预读距离、或处理
 * "列表被替换后要重挂观察器"，只有一处改了就会表现成"某个列表翻页不灵"。
 *
 * 行为与原来三处完全一致（包括依赖数组与 420px 预读距离），抽取不改语义。
 */
export interface UseInfiniteScrollOptions {
  hasMore: boolean;
  busy: boolean;
  /**
   * 已加载条数。
   * 它进依赖数组是有意的：列表被整批替换/清空后，哨兵元素的挂载状态会变，
   * 需要重新 observe（原来是三处各自传 `items.length`）。
   */
  count: number;
  onLoadMore: () => void;
  /** 预读距离。默认 `"420px 0px"`（与原来三处写死的值一致） */
  rootMargin?: string;
}

/**
 * @returns 哨兵元素的 ref —— 调用方把它挂在一个空 div 上（class `cat-sentinel`）。
 */
export function useInfiniteScroll({
  hasMore,
  busy,
  count,
  onLoadMore,
  rootMargin = "420px 0px"
}: UseInfiniteScrollOptions): RefObject<HTMLDivElement | null> {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // 用 ref 承接回调：调用方每次渲染都会传新的闭包，直接进依赖会让观察器反复重建
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || busy) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) loadMoreRef.current(); },
      { rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, busy, count, rootMargin]);

  return sentinelRef;
}
