// 分类页：分类行（含「排行榜」这个去处，行尾钉住「更多」）+ 二级行（四个榜 / 子分类）
//        + 工具行（共 N 部 · 排序）+ 结果网格（滚到底自动续）
//
// 视觉规则（v6）：选中一律"文字 + 下划线"，不用色块；工具条不套卡片；浮层从底部升起。
import { useEffect, useRef, useState } from "react";
import { AlbumGrid } from "../ui/AlbumGrid";
import { SkeletonGrid } from "../ui/SkeletonGrid";
import UnderlineTabs from "../ui/UnderlineTabs";
import SortSheet from "../ui/SortSheet";
import MoreCategoriesSheet from "../ui/MoreCategoriesSheet";
import { RANK_MODES, RANK_PLACE, SORT_MODES } from "../core/constants";
import type { AlbumSummary, CategoryBlock, CategoryItem } from "../core/types";

interface Props {
  categories: CategoryItem[];
  blocks: CategoryBlock[];
  items: AlbumSummary[];
  slug: string;
  sub: string;
  order: string;
  rank: string;
  page: number;
  hasMore: boolean;
  total: number;
  busy: boolean;
  error: string;
  gridKey: string;
  onPickPlace: (slug: string) => void;
  onPickRank: (key: string) => void;
  onPickSub: (sub: string) => void;
  onSort: (order: string) => void;
  onLoadMore: () => void;
  onOpenAlbum: (a: AlbumSummary) => void;
  /** 更多分类里点了一个词：按标签搜索 */
  onPickTerm: (term: string) => void;
}

export default function CategoryFeed({
  categories,
  blocks,
  items,
  slug,
  sub,
  order,
  rank,
  page,
  hasMore,
  total,
  busy,
  error,
  gridKey,
  onPickPlace,
  onPickRank,
  onPickSub,
  onSort,
  onLoadMore,
  onOpenAlbum,
  onPickTerm
}: Props) {
  const [sortOpen, setSortOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  // 无限滚动：不再放「加载更多」按钮，哨兵进入预读区就续页
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

  const activeCat = categories.find((c) => String(c.slug ?? "") === String(slug ?? ""));
  const subCats = activeCat?.sub_categories || [];
  const catTabs = [
    ...categories.map((c) => ({ key: String(c.slug ?? ""), label: c.name })),
    { key: RANK_PLACE, label: "排行榜" }
  ];
  const rankTabs = RANK_MODES.map(([key, label]) => ({ key, label }));
  const subTabs = subCats.map((s) => ({ key: String(s.slug ?? ""), label: s.name }));
  const sortLabel = (SORT_MODES.find(([key]) => key === order) || ["", "最新"])[1];
  const isRank = rank !== "";

  return (
    <div>
      {/* 分类行：横向滚动 + 行尾钉住的「更多」（独立控件，不与分类同级） */}
      <div className="catrow">
        <div className="catwrap">
          <UnderlineTabs items={catTabs} value={isRank ? RANK_PLACE : slug} onChange={onPickPlace} scroll />
          <span className="catfade" aria-hidden="true" />
        </div>
        <button className="morebtn" type="button" aria-label="更多分类" onClick={() => setMoreOpen(true)}>
          <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="6" cy="6" r="1.3" /><circle cx="12" cy="6" r="1.3" /><circle cx="18" cy="6" r="1.3" />
            <circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" />
            <circle cx="6" cy="18" r="1.3" /><circle cx="12" cy="18" r="1.3" /><circle cx="18" cy="18" r="1.3" />
          </svg>
          更多
        </button>
      </div>

      {/* 二级行：排行榜的四个榜（榜单即顺序，所以这一态不给排序按钮） / 分类的子分类 */}
      {isRank && <UnderlineTabs items={rankTabs} value={rank} onChange={onPickRank} />}
      {!isRank && subTabs.length > 0 && <UnderlineTabs items={subTabs} value={sub} onChange={onPickSub} />}

      {/* 工具行：共 N 部 + 排序（列表功能） */}
      <div className="toolrow">
        <span className="cnt">{total > 0 ? "共 " + total.toLocaleString("zh-CN") + " 部" : ""}</span>
        {!isRank && (
          <button className="sortbtn" type="button" onClick={() => setSortOpen(true)} data-sort-toggle>
            <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14m0 0l-3-3m3 3l3-3M17 19V5m0 0l-3 3m3-3l3 3" /></svg>
            排序：{sortLabel}
          </button>
        )}
      </div>

      {error && <div className="card err">{error}</div>}
      {busy && !error && items.length === 0 ? <SkeletonGrid /> : null}
      <AlbumGrid key={gridKey} items={items} onOpen={onOpenAlbum} />
      {hasMore && <div ref={sentinelRef} className="cat-sentinel" aria-hidden="true" />}
      {busy && items.length > 0 && hasMore ? <p className="cat-more">正在加载第 {page + 1} 页…</p> : null}

      <SortSheet open={sortOpen} onClose={() => setSortOpen(false)} value={order} onChange={onSort} />
      <MoreCategoriesSheet open={moreOpen} onClose={() => setMoreOpen(false)} blocks={blocks} onPick={(term) => { setMoreOpen(false); onPickTerm(term); }} />
    </div>
  );
}
