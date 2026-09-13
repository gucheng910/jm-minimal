// 周榜：期号 + 类型筛选 + 结果网格。
// 两处复用：① ContentView 在 mode === "week" 时整页渲染（带「返回列表」）；
//            ② 首页「每周必看」分段内联渲染（inline，不要返回按钮与说明标题）。
import { AlbumGrid } from "../ui/AlbumGrid";
import type { AlbumSummary, WeekPayload } from "../core/types";

interface Props {
  payload: WeekPayload;
  items: AlbumSummary[];
  issue: string;
  type: string;
  busy: boolean;
  error: string;
  gridKey: string;
  onIssueChange: (v: string) => void;
  onTypeChange: (v: string) => void;
  onLoad: () => void;
  onOpenAlbum: (a: AlbumSummary) => void;
  /** 内联渲染时不需要（没有"上一页"可返回） */
  onBack?: () => void;
  /** 首页内联：隐藏「返回列表」与「周榜（选择期号 + 类型）」标题 */
  inline?: boolean;
}

export default function WeekRank({
  payload,
  items,
  issue,
  type,
  busy,
  error,
  gridKey,
  onIssueChange,
  onTypeChange,
  onLoad,
  onOpenAlbum,
  onBack,
  inline
}: Props) {
  return (
    <div className="card">
      {!inline && <button className="ghost" onClick={onBack}>返回列表</button>}
      {!inline && <h2>周榜（选择期号 + 类型）</h2>}
      <div className="row">
        <select value={issue} onChange={(e) => onIssueChange(e.target.value)} aria-label="选择期号">
          <option value="">选择期号</option>
          {payload.categories.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.time || c.id)}</option>)}
        </select>
        <select value={type} onChange={(e) => onTypeChange(e.target.value)} aria-label="选择类型">
          <option value="">全部类型</option>
          {payload.type.map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.title)}</option>)}
        </select>
        <button disabled={busy || !issue} onClick={onLoad}>加载该期</button>
      </div>
      {items.length === 0 && error && <div className="card err">{error}</div>}
      <AlbumGrid key={gridKey} items={items} onOpen={onOpenAlbum} />
    </div>
  );
}
