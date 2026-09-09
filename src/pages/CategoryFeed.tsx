// 分类页：分类 chip + 排序/排行榜 + 子分类 + 结果网格
import { AlbumGrid } from "../ui/AlbumGrid";
import { SkeletonGrid } from "../ui/SkeletonGrid";
import { RANK_MODES, SORT_MODES } from "../core/constants";
import type { AlbumSummary, CategoryItem } from "../core/types";

interface Props {
  categories: CategoryItem[];
  items: AlbumSummary[];
  slug: string;
  sub: string;
  order: string;
  page: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
  gridKey: string;
  onPickCategory: (slug: string) => void;
  onPickSub: (slug: string, sub: string, order: string) => void;
  onSort: (order: string) => void;
  onLoadMore: () => void;
  onOpenAlbum: (a: AlbumSummary) => void;
}

export default function CategoryFeed({
  categories,
  items,
  slug,
  sub,
  order,
  page,
  hasMore,
  busy,
  error,
  gridKey,
  onPickCategory,
  onPickSub,
  onSort,
  onLoadMore,
  onOpenAlbum
}: Props) {
  const activeCat = categories.find((c) => String(c.slug ?? "") === String(slug ?? ""));
  const subCats = activeCat?.sub_categories || [];
  return (
    <div>
      <div className="card row">
        {categories.map((c) => {
          const s = String(c.slug ?? "");
          const active = s === String(slug ?? "") && !sub;
          return (
            <button key={s || String(c.id)} className={active ? "chip active" : "chip"} disabled={busy} onClick={() => onPickCategory(s)}>{c.name}</button>
          );
        })}
      </div>
      <div className="card row">
        <span className="chip-label">排序</span>
        {SORT_MODES.map(([k, label]) => (
          <button key={k} className={(order === k ? "chip active" : "chip") + " sort-chip"} disabled={busy} onClick={() => onSort(k)}>{label}</button>
        ))}
      </div>
      <div className="card row">
        <span className="chip-label">排行榜</span>
        {RANK_MODES.map(([k, label]) => (
          <button key={k} className={(order === k ? "chip active" : "chip") + " sort-chip"} disabled={busy} onClick={() => onSort(k)}>{label}</button>
        ))}
      </div>
      {subCats.length > 0 && (
        <div className="card row">
          {subCats.map((s) => {
            const subSlug = String(s.slug ?? "");
            const active = sub === subSlug;
            return (
              <button key={subSlug} className={active ? "chip active" : "chip"} disabled={busy} onClick={() => onPickSub(String(activeCat?.slug ?? ""), subSlug, order)}>{s.name}</button>
            );
          })}
        </div>
      )}
      {error && <div className="card err">{error}</div>}
      {busy && items.length === 0 ? <SkeletonGrid /> : null}
      <AlbumGrid key={gridKey} items={items} onOpen={onOpenAlbum} />
      {hasMore && <div className="card row"><button disabled={busy} onClick={onLoadMore}>加载更多（第 {page + 1} 页）</button></div>}
    </div>
  );
}
