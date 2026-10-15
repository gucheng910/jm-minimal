// 更多分类浮层：官方 /categories 的 blocks（实测结构 { title, content: string[] }）
// 4 组共约 47 个词，点任意词 = 一次标签搜索（search_type=tag），复用只读搜索结果页
// 外壳走 ui/blocks 的 Sheet（panelClassName 带 sheet-tall：这层内容比别的浮层高）。
import type { CategoryBlock } from "../core/types";
import { SkeletonRows } from "./SkeletonRows";
import { Sheet } from "./blocks";

interface Props {
  open: boolean;
  onClose: () => void;
  blocks: CategoryBlock[];
  onPick: (term: string) => void;
}

export default function MoreCategoriesSheet({ open, onClose, blocks, onPick }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title="更多分类" panelClassName="app-sheet sheet-tall">
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
    </Sheet>
  );
}
