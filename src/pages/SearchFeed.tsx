// 搜索页：搜索框 + 类型（下划线）+ 热词/记录 + 结果（共 N 部 · 排序 · 无限滚动）
// 排序与分类页共用同一个 SortSheet（列表功能）；排行榜不在这里。
import { useEffect, useRef, useState } from "react";
import { AlbumGrid } from "../ui/AlbumGrid";
import { SkeletonGrid } from "../ui/SkeletonGrid";
import UnderlineTabs from "../ui/UnderlineTabs";
import SortSheet from "../ui/SortSheet";
import { SORT_MODES } from "../core/constants";
import type { AlbumSummary } from "../core/types";

const TYPE_LABELS: Array<{ key: string; label: string }> = [
  { key: "site", label: "站内" },
  { key: "work", label: "作品" },
  { key: "author", label: "作者" },
  { key: "tag", label: "标签" },
  { key: "character", label: "登场人物" }
];

interface Props {
  query: string;
  type: string;
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
  gridKey: string;
  onQueryChange: (v: string) => void;
  onSubmit: () => void;
  onRunTerm: (term: string) => void;
  onTypeChange: (type: string) => void;
  onSort: (order: string) => void;
  onRetryHot: () => void;
  onClearHistory: () => void;
  onLoadMore: () => void;
  onOpenAlbum: (a: AlbumSummary) => void;
}

export default function SearchFeed({
  query,
  type,
  order,
  items,
  page,
  total,
  hasMore,
  busy,
  error,
  searched,
  hotTags,
  hotErr,
  history,
  gridKey,
  onQueryChange,
  onSubmit,
  onRunTerm,
  onTypeChange,
  onSort,
  onRetryHot,
  onClearHistory,
  onLoadMore,
  onOpenAlbum
}: Props) {
  const [sortOpen, setSortOpen] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  // 无限滚动：与分类页同一套做法，不再放「加载更多」按钮
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

  const sortLabel = (SORT_MODES.find(([key]) => key === order) || ["", "最新"])[1];

  return (
    <div>
      <form className="searchbar" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <input value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder="搜索漫画、作者、标签" />
        <button className="btn soft" disabled={busy || !query.trim()}>搜索</button>
      </form>

      <UnderlineTabs items={TYPE_LABELS} value={type} onChange={onTypeChange} />

      {!searched ? (
        <div>
          <p className="sectitle">热门搜索</p>
          {hotTags.length > 0 ? (
            <div className="chips">{hotTags.map((t) => <button key={t} className="chip" onClick={() => onRunTerm(t)}>{t}</button>)}</div>
          ) : hotErr ? (
            <div className="row">
              <span className="err small-err">加载失败：{hotErr}</span>
              <button className="op-link" onClick={onRetryHot}>重试</button>
            </div>
          ) : (
            <p className="muted">正在加载…</p>
          )}
          {history.length > 0 && (
            <>
              <div className="row hist-head">
                <p className="sectitle">搜索记录</p>
                <button className="op-link" onClick={onClearHistory}>清除</button>
              </div>
              <div className="chips">{history.map((t) => <button key={t} className="chip" onClick={() => onRunTerm(t)}>{t}</button>)}</div>
            </>
          )}
        </div>
      ) : (
        <div>
          <div className="toolrow">
            <span className="cnt">{total > 0 ? "已加载 " + items.length + " / 共 " + total.toLocaleString("zh-CN") + " 部" : ""}</span>
            <button className="sortbtn" type="button" onClick={() => setSortOpen(true)} data-sort-toggle>
              <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14m0 0l-3-3m3 3l3-3M17 19V5m0 0l-3 3m3-3l3 3" /></svg>
              {sortLabel}
            </button>
          </div>
          {error && <div className="card err">{error}</div>}
          {busy && items.length === 0 ? <SkeletonGrid /> : null}
          {!busy && !error && items.length === 0 ? <p className="muted sr-empty">没有找到相关漫画</p> : null}
          <AlbumGrid key={gridKey} items={items} onOpen={onOpenAlbum} />
          {hasMore && <div ref={sentinelRef} className="cat-sentinel" aria-hidden="true" />}
          {busy && items.length > 0 && hasMore ? <p className="cat-more">正在加载第 {page + 1} 页…</p> : null}
          <SortSheet open={sortOpen} onClose={() => setSortOpen(false)} value={order} onChange={onSort} />
        </div>
      )}
    </div>
  );
}
