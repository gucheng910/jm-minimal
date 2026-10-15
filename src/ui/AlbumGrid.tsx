// 列表网格容器（memo：父级 busy/error 变化时不重渲整屏卡片）
//
// 也是「列表页展示编排」的**唯一接线点**：所有卡片网格都从这里出来，
// 所以在这里订阅一次配置（useListLayout），再把配置当 prop 发给每张卡片 ——
// 比让每张卡片各自订阅省得多（一屏几十个监听器 vs 一个）。
import { memo } from "react";
import { AlbumCard } from "./AlbumCard";
import { listColumnsClass, listFormClass, listTitleClass } from "../core/listLayout";
import { useListLayout } from "../hooks/useListLayout";
import type { AlbumSummary } from "../core/types";

export const AlbumGrid = memo(function AlbumGrid({ items, onOpen, onRemove, skeleton }: {
  items: AlbumSummary[];
  onOpen: (a: AlbumSummary) => void;
  /** 传下去即可显示删除角标；不传则与原来完全一致（其它列表不受影响） */
  onRemove?: (a: AlbumSummary) => void;
  /**
   * 占位渲染（**只在「自定义 UI」的画布/缩略图传 true**，见 AlbumDetail 的 `skeleton`）：
   * 卡片封面不生成 URL、不加载图片，只渲染"失败回退"式的文字占位。
   * 不传 = false，其它所有列表行为逐字不变。
   */
  skeleton?: boolean;
}) {
  const layout = useListLayout();
  /**
   * 三个轴一起翻译成类名（`core/listLayout` 只出类名，像素全在 index.css）：
   *   · `form-*`  —— 卡片形态（压字 / 单列行）
   *   · `cols-*`  —— 用户显式选的列数（行卡形态下恒为空串，见 `listColumnsClass`）
   *   · `title-1` —— 标题只留一行
   * **每个轴的默认档都返回空串** ⇒ 默认配置下这个 div 仍然是 `class="list"`（红线）。
   */
  const cls = [listFormClass(layout), listColumnsClass(layout), listTitleClass(layout)].filter(Boolean).join(" ");
  return (
    // cls 为空串时不加类 —— 也就是"完全跟随断点"，与改造前逐字一致
    <div className={"list" + (cls ? " " + cls : "")}>
      {items.map((a) => (
        <AlbumCard key={String(a.id)} album={a} onOpen={onOpen} onRemove={onRemove} layout={layout} skeleton={skeleton} />
      ))}
    </div>
  );
});
