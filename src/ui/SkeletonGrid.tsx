// 网格加载骨架屏：内容未到时以占位卡片填充，避免转圈跳动
import { memo } from "react";

const SKELETON_COUNT = 9;

export const SkeletonGrid = memo(function SkeletonGrid() {
  return (
    <div className="skeleton-grid" aria-hidden="true">
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        <div className="skeleton-item" key={i}>
          <div className="skeleton-thumb-wrapper">
            <div className="skeleton-thumb" />
          </div>
          <div className="skeleton-title" />
          <div className="skeleton-meta" />
        </div>
      ))}
    </div>
  );
});
