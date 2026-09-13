// 列表网格容器（memo：父级 busy/error 变化时不重渲整屏卡片）
import { memo } from "react";
import { AlbumCard } from "./AlbumCard";
import type { AlbumSummary } from "../core/types";

export const AlbumGrid = memo(function AlbumGrid({ items, onOpen, onRemove }: {
  items: AlbumSummary[];
  onOpen: (a: AlbumSummary) => void;
  /** 传下去即可显示删除角标；不传则与原来完全一致（其它列表不受影响） */
  onRemove?: (a: AlbumSummary) => void;
}) {
  return (
    <div className="list">
      {items.map((a) => (
        <AlbumCard key={String(a.id)} album={a} onOpen={onOpen} onRemove={onRemove} />
      ))}
    </div>
  );
});
