// 首页内容流视图：最新 / 排行榜入口 + 错误提示 + 列表
import { AlbumGrid } from "../ui/AlbumGrid";
import { SkeletonGrid } from "../ui/SkeletonGrid";
import type { AlbumSummary } from "../core/types";

interface Props {
  items: AlbumSummary[];
  page: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
  gridKey: string;
  onLatest: () => void;
  onRanking: () => void;
  onRetry: () => void;
  onGotoDns: () => void;
  onLoadMore: () => void;
  onOpenAlbum: (a: AlbumSummary) => void;
}

export default function HomeFeed({
  items,
  page,
  hasMore,
  busy,
  error,
  gridKey,
  onLatest,
  onRanking,
  onRetry,
  onGotoDns,
  onLoadMore,
  onOpenAlbum
}: Props) {
  return (
    <>
      <div className="card row">
        <button className="ghost" disabled={busy} onClick={onLatest}>最新</button>
        <button className="ghost" disabled={busy} onClick={onRanking}>排行榜</button>
      </div>
      {error && (
        <div className="card err">
          {error}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="ghost" disabled={busy} onClick={onRetry}>重新加载推荐</button>
            <button className="ghost" onClick={onGotoDns}>去配 DNS</button>
          </div>
        </div>
      )}
      {busy && items.length === 0 ? <SkeletonGrid /> : null}
      <AlbumGrid key={gridKey} items={items} onOpen={onOpenAlbum} />
      {hasMore && <div className="card row"><button disabled={busy} onClick={onLoadMore}>加载更多（第 {page + 1} 页）</button></div>}
    </>
  );
}
