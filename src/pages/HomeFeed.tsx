// 首页内容流：推荐 / 最新 / 每周必看（下划线分段）+ 错误提示 + 网格（滚到底自动续）
// 「每周必看」不是列表，是跳到周榜页（ContentView 处理），所以它不改分段选中态。
import { useEffect, useRef } from "react";
import { AlbumGrid } from "../ui/AlbumGrid";
import { SkeletonGrid } from "../ui/SkeletonGrid";
import UnderlineTabs from "../ui/UnderlineTabs";
import type { AlbumSummary } from "../core/types";

interface Props {
  items: AlbumSummary[];
  page: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
  /** 当前分段：random=推荐（随机推荐接口）/ latest=最新 */
  feed: "random" | "latest";
  gridKey: string;
  onPickFeed: (key: string) => void;
  onRetry: () => void;
  onGotoDns: () => void;
  onLoadMore: () => void;
  onOpenAlbum: (a: AlbumSummary) => void;
}

const HOME_TABS = [
  { key: "random", label: "推荐" },
  { key: "latest", label: "最新" },
  { key: "weekly", label: "每周必看" }
];

export default function HomeFeed({
  items,
  page,
  hasMore,
  busy,
  error,
  feed,
  gridKey,
  onPickFeed,
  onRetry,
  onGotoDns,
  onLoadMore,
  onOpenAlbum
}: Props) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  // 无限滚动：与分类页/搜索页同一套做法，不再放「加载更多」按钮
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || busy) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) loadMoreRef.current(); },
      { rootMargin: "420px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, busy, items.length]);

  return (
    <>
      <UnderlineTabs items={HOME_TABS} value={feed} onChange={onPickFeed} />
      {error && (
        <div className="card err">
          {error}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn soft sm" disabled={busy} onClick={onRetry}>重新加载</button>
            <button className="btn soft sm" onClick={onGotoDns}>去配 DNS</button>
          </div>
        </div>
      )}
      {busy && items.length === 0 ? <SkeletonGrid /> : null}
      <AlbumGrid key={gridKey} items={items} onOpen={onOpenAlbum} />
      {hasMore && <div ref={sentinelRef} className="cat-sentinel" aria-hidden="true" />}
      {busy && items.length > 0 && hasMore ? <p className="cat-more">正在加载第 {page + 1} 页…</p> : null}
    </>
  );
}
