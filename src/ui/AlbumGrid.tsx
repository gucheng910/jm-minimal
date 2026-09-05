// 列表网格容器（memo：父级 busy/error 变化时不重渲整屏卡片）
import { memo } from "react";
import { AlbumCard } from "./AlbumCard";
import type { AlbumSummary } from "../core/types";

export const AlbumGrid = memo(function AlbumGrid({ items, onOpen }: { items: AlbumSummary[]; onOpen: (a: AlbumSummary) => void }) {
  return (
    <div className="list">
      {items.map((a) => (
        <AlbumCard key={String(a.id)} album={a} onOpen={onOpen} />
      ))}
    </div>
  );
});
