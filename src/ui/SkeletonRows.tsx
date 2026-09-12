// 行式列表骨架：给"不是封面网格"的列表用（缓存详情的目录、阅读器换话列表、更多分类、换源浮层）。
// 与封面骨架同一套扫光（复用 .skeleton-title / .skeleton-meta 的 ::after），低配模式也会保留扫光。
import { memo } from "react";

export const SkeletonRows = memo(function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div className="skeleton-rows" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div className="skeleton-row" key={i}>
          <div className="skeleton-row-main">
            <div className="skeleton-title" />
            <div className="skeleton-meta" />
          </div>
        </div>
      ))}
    </div>
  );
});
