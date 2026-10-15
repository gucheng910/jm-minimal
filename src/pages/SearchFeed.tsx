// 搜索页：搜索框 + 类型（下划线）+ 热词/记录 + 结果（共 N 部 · 排序 · 无限滚动）
// 排序与分类页共用同一个 SortSheet（列表功能）；排行榜不在这里。
//
// 工具行与结果区已抽到 ui/blocks（FeedToolRow / AlbumFeed）——与分类页共用同一份实现。
import { useState } from "react";
import UnderlineTabs from "../ui/UnderlineTabs";
import SortSheet from "../ui/SortSheet";
import { AlbumFeed, FeedToolRow } from "../ui/blocks";
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
          <FeedToolRow
            label={total > 0 ? "已加载 " + items.length + " / 共 " + total.toLocaleString("zh-CN") + " 部" : ""}
            sort={{ label: sortLabel, onOpen: () => setSortOpen(true) }}
          />

          <AlbumFeed
            items={items}
            gridKey={gridKey}
            page={page}
            hasMore={hasMore}
            busy={busy}
            error={error}
            onOpen={onOpenAlbum}
            onLoadMore={onLoadMore}
            /* 搜索特有的空态：骨架之后、网格之前 */
            empty={!busy && !error && items.length === 0
              ? <p className="muted sr-empty">没有找到相关漫画</p>
              : null}
          />

          <SortSheet open={sortOpen} onClose={() => setSortOpen(false)} value={order} onChange={onSort} />
        </div>
      )}
    </div>
  );
}
