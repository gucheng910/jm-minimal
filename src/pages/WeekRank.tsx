// 周榜页：期号 + 类型筛选 + 结果网格（由 ContentView 在 mode === "week" 时渲染）
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
  onBack: () => void;
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
  onBack
}: Props) {
  return (
    <div className="card">
      <button className="ghost" onClick={onBack}>返回列表</button>
      <h2>周榜（选择期号 + 类型）</h2>
      <div className="row">
        <select value={issue} onChange={(e) => onIssueChange(e.target.value)}>
          <option value="">选择期号</option>
          {payload.categories.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.time || c.id)}</option>)}
        </select>
        <select value={type} onChange={(e) => onTypeChange(e.target.value)}>
          <option value="">全部类型</option>
          {payload.type.map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.title)}</option>)}
        </select>
        <button disabled={busy || !issue || !type} onClick={onLoad}>加载该期</button>
      </div>
      {error && <div className="card err">{error}</div>}
      <AlbumGrid key={gridKey} items={items} onOpen={onOpenAlbum} />
    </div>
  );
}
