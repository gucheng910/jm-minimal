// 首页内容流：推荐 / 最新 / 每周必看（下划线分段）+ 错误提示 + 网格（滚到底自动续）
// 「每周必看」也是首页的一个真实分段：选中它就地把周榜渲染在首页里（不再跳到分类/周榜页），
// 所以它会正常占用分段选中态。周榜块由 ContentView 通过 weekly 传入（复用 pages/WeekRank 的 inline 模式）。
//
// 结果区（错误 / 骨架 / 网格 / 续页哨兵 / 加载中）已抽到 ui/blocks 的 AlbumFeed ——
// 这一段原来在首页、分类页、搜索页各写了一遍（无限滚动逻辑三份逐字相同）。
import type { ReactNode } from "react";
import UnderlineTabs from "../ui/UnderlineTabs";
import { AlbumFeed } from "../ui/blocks";
import type { AlbumSummary } from "../core/types";

interface Props {
  items: AlbumSummary[];
  page: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
  /** 当前分段：random=推荐（随机推荐接口）/ latest=最新 / weekly=每周必看（内联周榜） */
  feed: "random" | "latest" | "weekly";
  /** 「每周必看」分段的内容（ContentView 传入的内联周榜块，或加载中的骨架） */
  weekly?: ReactNode;
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
  weekly,
  gridKey,
  onPickFeed,
  onRetry,
  onGotoDns,
  onLoadMore,
  onOpenAlbum
}: Props) {
  return (
    <>
      <UnderlineTabs items={HOME_TABS} value={feed} onChange={onPickFeed} />
      {feed === "weekly" ? weekly : (
        <AlbumFeed
          items={items}
          gridKey={gridKey}
          page={page}
          hasMore={hasMore}
          busy={busy}
          error={error}
          onOpen={onOpenAlbum}
          onLoadMore={onLoadMore}
          /* 首页的错误卡多两个出口：重新加载 / 去配 DNS（分类与搜索页是纯文案错误卡） */
          errorActions={
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn soft sm" disabled={busy} onClick={onRetry}>重新加载</button>
              <button className="btn soft sm" onClick={onGotoDns}>去配 DNS</button>
            </div>
          }
        />
      )}
    </>
  );
}
