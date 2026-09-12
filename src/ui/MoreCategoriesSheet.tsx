// 更多分类浮层：官方 /categories 的 blocks（实测结构 { title, content: string[] }）
// 4 组共约 47 个词，点任意词 = 一次标签搜索（search_type=tag），复用只读搜索结果页
import type { CategoryBlock } from "../core/types";
import { useSheetTransition } from "../hooks/useSheetTransition";
import { SkeletonRows } from "./SkeletonRows";

interface Props {
  open: boolean;
  onClose: () => void;
  blocks: CategoryBlock[];
  onPick: (term: string) => void;
}

export default function MoreCategoriesSheet({ open, onClose, blocks, onPick }: Props) {
  const { mounted, entering, closing } = useSheetTransition(open);
  if (!mounted) return null;
  return (
    <div className="drawer-backdrop" data-entering={entering ? "" : undefined} data-closed={closing ? "" : undefined} onClick={onClose}>
      <div className="source-drawer app-sheet sheet-tall" data-entering={entering ? "" : undefined} data-closed={closing ? "" : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h3>更多分类</h3></div>
        <div className="sheet-scroll">
          {blocks.map((b) => (
            <div key={b.title}>
              <p className="grpname">{b.title}</p>
              <div className="tags">
                {b.content.map((term) => (
                  <button key={term} type="button" onClick={() => onPick(term)}>{term}</button>
                ))}
              </div>
            </div>
          ))}
          {blocks.length === 0 && (
            <>
              <SkeletonRows count={8} />
              <p className="sheet-empty">分组数据未就绪，稍后重试</p>
            </>
          )}
        </div>
        <p className="sheet-result">点词即按标签搜索；分组与词都来自官方 /categories 的 blocks，不写死在客户端。</p>
      </div>
    </div>
  );
}
