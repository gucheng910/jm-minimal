import type { ReactNode } from "react";
import { AlbumGrid } from "../AlbumGrid";
import { SkeletonGrid } from "../SkeletonGrid";
import { FeedError } from "./FeedError";
import { useInfiniteScroll } from "../../hooks/useInfiniteScroll";
import type { AlbumSummary } from "../../core/types";

/**
 * 列表结果区（错误 → 骨架 → 空态 → 网格 → 续页哨兵 → 加载中提示）。
 *
 * 抽出来的原因：这一整段在首页 / 分类页 / 搜索页各写了一遍，只有两处细节不同
 * （首页错误卡多两个按钮；搜索页多一行空态）。三个页面原来都要自己维护
 * "骨架与网格的显隐条件"，很容易只改一处。
 *
 * ⚠️ 内部的**渲染顺序是版面的一部分，不要随手调整**：
 *    骨架必须在网格之前（否则加载时会先闪一下旧列表的空白），
 *    哨兵必须在网格之后（否则会在首屏就触发续页）。
 *
 * 与 core/detailLayout.ts 的关系：这是详情页那套"展示模块"思路在列表页的延续 ——
 * 三个列表页现在共用同一个结果区模块，将来要做列表页的自定义布局时，
 * 可配置的单元就是这一个（而不是散在三个文件里的 5 段 JSX）。
 */
export interface AlbumFeedProps {
  items: AlbumSummary[];
  /** 换源/换筛选后要整块重建网格时用的 key（React 的 key，不参与渲染） */
  gridKey: string;
  /** 当前页号；用于"正在加载第 N+1 页…"文案 */
  page: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
  onOpen: (a: AlbumSummary) => void;
  /** 给了就在卡片上显示删除角标（收藏/足迹的管理模式用） */
  onRemove?: (a: AlbumSummary) => void;
  onLoadMore: () => void;
  /** 错误卡正文之后的附加操作（首页的「重新加载 / 去配 DNS」）；不传就是纯文本错误卡 */
  errorActions?: ReactNode;
  /** 骨架之后、网格之前的空态（搜索页的「没有找到相关漫画」）。
      调用方自己判条件传入；不传就没有这一行。 */
  empty?: ReactNode;
}

export function AlbumFeed({
  items,
  gridKey,
  page,
  hasMore,
  busy,
  error,
  onOpen,
  onRemove,
  onLoadMore,
  errorActions,
  empty
}: AlbumFeedProps) {
  const sentinelRef = useInfiniteScroll({ hasMore, busy, count: items.length, onLoadMore });

  return (
    <>
      {/* 错误只在"列表还是空的"时候占位；已有内容时错误靠 toast/其他方式告知，不该顶掉列表 */}
      <FeedError error={items.length === 0 ? error : ""}>{errorActions}</FeedError>
      {busy && !error && items.length === 0 ? <SkeletonGrid /> : null}
      {empty}
      <AlbumGrid key={gridKey} items={items} onOpen={onOpen} onRemove={onRemove} />
      {hasMore && <div ref={sentinelRef} className="cat-sentinel" aria-hidden="true" />}
      {busy && items.length > 0 && hasMore ? <p className="cat-more">正在加载第 {page + 1} 页…</p> : null}
    </>
  );
}
