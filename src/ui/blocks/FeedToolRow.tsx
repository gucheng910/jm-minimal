/**
 * 列表工具行：左侧计数 + 右侧排序胶囊。
 *
 * 抽出来的原因：分类页与搜索页各写了一遍（连那个排序图标的 path 都是逐字复制的）。
 * 两处只有文案不同（分类「共 N 部」/ 搜索「已加载 X / 共 N 部」），排序按钮的显隐条件不同
 * （分类的排行榜态不给排序）。所以这里只接"已经拼好的文案"与"可选的排序动作"。
 *
 * 与 FeedError 同一个位置（blocks/ 模块池）——列表页共用的展示件都放这里。
 */
export interface FeedToolRowProps {
  /** 左侧计数文案。调用方拼好；空串时 `<span className="cnt">` 仍然渲染（与原来一致） */
  label: string;
  /**
   * 排序按钮。**不传就不渲染这个按钮**——
   * 分类页的排行榜态正是靠不传它来表达"榜单即顺序，无需排序"。
   */
  sort?: {
    /** 当前排序的显示名（如「最多爱心」） */
    label: string;
    onOpen: () => void;
  };
}

export function FeedToolRow({ label, sort }: FeedToolRowProps) {
  return (
    <div className="toolrow">
      <span className="cnt">{label}</span>
      {sort && (
        <button className="sortbtn" type="button" onClick={sort.onOpen} data-sort-toggle>
          <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14m0 0l-3-3m3 3l3-3M17 19V5m0 0l-3 3m3-3l3 3" /></svg>
          排序：{sort.label}
        </button>
      )}
    </div>
  );
}
