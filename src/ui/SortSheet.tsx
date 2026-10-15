// 排序浮层：列表功能（不是排行榜）
// 选中项用「对勾 + 深色文字」，没有反色块；点一项即生效并收起
// 外壳（遮罩 / 面板 / 头部）走 ui/blocks 的 Sheet —— 与其余 6 个弹层共用同一份实现。
import { CheckIcon } from "./icons";
import { SORT_MODES } from "../core/constants";
import { Sheet } from "./blocks";

const HINT: Record<string, string> = {
  "": "先新后旧",
  mv: "按点击量",
  mp: "按页数",
  tf: "按收藏数"
};

interface Props {
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (key: string) => void;
}

export default function SortSheet({ open, onClose, value, onChange }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title="排序" panelClassName="app-sheet">
      <div className="sheet-list">
        {SORT_MODES.map(([key, label]) => {
          const on = key === value;
          return (
            <button
              key={key || "latest"}
              type="button"
              className={"opt-row" + (on ? " on" : "")}
              onClick={() => { onChange(key); onClose(); }}
            >
              <CheckIcon size={18} className="ck" />
              <span className="nm">{label}</span>
              <span className="mu">{HINT[key] || ""}</span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
