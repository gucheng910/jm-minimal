// 搜索页：搜索框 + 类型 chip + 热词/搜索记录 + 结果网格
import { AlbumGrid } from "../ui/AlbumGrid";
import { SkeletonGrid } from "../ui/SkeletonGrid";
import type { AlbumSummary } from "../core/types";

const TYPE_LABELS: Array<{ key: string; label: string }> = [
  { key: "site", label: "站内搜索" },
  { key: "work", label: "作品" },
  { key: "author", label: "作者" },
  { key: "tag", label: "标签" },
  { key: "character", label: "登场人物" }
];

interface Props {
  query: string;
  type: string;
  items: AlbumSummary[];
  page: number;
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
  onRetryHot: () => void;
  onClearHistory: () => void;
  onLoadMore: () => void;
  onOpenAlbum: (a: AlbumSummary) => void;
}

export default function SearchFeed({
  query,
  type,
  items,
  page,
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
  onRetryHot,
  onClearHistory,
  onLoadMore,
  onOpenAlbum
}: Props) {
  return (
    <div>
      <form className="searchbar card" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <input value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder="搜索（官方接口）" />
        <button disabled={busy || !query.trim()}>搜索</button>
      </form>
      <div className="card row">
        {TYPE_LABELS.map((t) => (
          <button key={t.key} className={type === t.key ? "chip active" : "chip"} onClick={() => onTypeChange(t.key)}>{t.label}</button>
        ))}
      </div>
      {!searched ? (
        <div>
          <div className="card">
            <h3>热门搜索</h3>
            {hotTags.length > 0 ? (
              <div className="row">{hotTags.map((t) => <button key={t} className="chip" onClick={() => onRunTerm(t)}>{t}</button>)}</div>
            ) : hotErr ? (
              <div className="row">
                <span className="err small-err">加载失败：{hotErr}</span>
                <button className="ghost" onClick={onRetryHot}>重试</button>
              </div>
            ) : (
              <p className="muted">正在加载…</p>
            )}
          </div>
          {history.length > 0 && (
            <div className="card">
              <div className="row"><h3>搜索记录</h3><button onClick={onClearHistory}>清除</button></div>
              <div className="row">{history.map((t) => <button key={t} className="chip" onClick={() => onRunTerm(t)}>{t}</button>)}</div>
            </div>
          )}
        </div>
      ) : (
        <div>
          {error && <div className="card err">{error}</div>}
          {busy && items.length === 0 ? <SkeletonGrid /> : null}
          <AlbumGrid key={gridKey} items={items} onOpen={onOpenAlbum} />
          {hasMore && <div className="card row"><button disabled={busy} onClick={onLoadMore}>加载更多（第 {page + 1} 页）</button></div>}
        </div>
      )}
    </div>
  );
}
