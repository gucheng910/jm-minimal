// 网格加载骨架屏：内容未到时以占位卡片填充，避免转圈跳动
import { memo } from "react";
import { listColumnsClass, listFormClass } from "../core/listLayout";
import { useListLayout } from "../hooks/useListLayout";

const SKELETON_COUNT = 9;

/**
 * 网格骨架。**列数必须与真网格 `.list` 完全同源**（v3.13 修的 bug）。
 *
 * 病根：列数配置（`core/listLayout` 的 `columns`）只加在 `.list` 上（`.list.cols-2` / `.list.cols-3`），
 * 骨架的 `.skeleton-grid` 一直只有自己的两条断点规则 —— 于是用户把"每行列数"改成 3 列
 * （窄屏下真网格 3 列），加载时看到的却还是 **2 列骨架**：占位与真实内容对不上，
 * 加载完成的一瞬间整页跳一下（用户实测反馈："在 UI 自定义中改为三列依然还是以两列骨架屏演示加载"）。
 *
 * 修法就是**共用同一个函数**（`listColumnsClass`）+ 同名的类：
 * 只要"档位 → 类名"这份映射只有一处实现，两者就不可能再漂移。
 * 默认档位 `"auto"` 返回空串 ⇒ 不加类 ⇒ 与改造前逐字一致（红线）。
 *
 * 代价说明：这里多订阅一次 `jm:listLayout`（改列数时骨架会跟着重渲染）。
 * 骨架只在"空列表 + 正在加载"时存在，生命周期很短，且改列数时本来就要整页重排。
 */
export const SkeletonGrid = memo(function SkeletonGrid() {
  const layout = useListLayout();
  // 列数与形态一起镜像（列数那条见文件头的说明；形态不镜像的话"选了单列行、骨架还是三列网格"
  // 就是同一个 bug 的另一个侧面）。标题行数不影响骨架的几何，所以不镜像。
  const cls = [listFormClass(layout), listColumnsClass(layout)].filter(Boolean).join(" ");
  return (
    <div className={"skeleton-grid" + (cls ? " " + cls : "")} aria-hidden="true">
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
