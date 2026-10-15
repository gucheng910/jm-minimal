import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSheetTransition } from "../../hooks/useSheetTransition";

/**
 * 底部弹层外壳（遮罩 + 面板 + 头部）。
 *
 * 抽出来的原因：这段结构在改造前有 **7 个使用点**，每个都把同一套
 * `drawer-backdrop` / `source-drawer` / `data-entering` / `data-closed` / 阻止冒泡 抄了一遍：
 *   · ui/SortSheet、ui/MoreCategoriesSheet、ui/SourceSheet（3 个独立组件）
 *   · Reader.tsx 里 4 个内联弹层（更快的源 / 阅读设置 / 换话 / 选话缓存）
 * 抄 7 遍的实际代价是"改一处忘六处"：比如入场起始态的 `data-entering` 写错、
 * 或忘了在面板上 `stopPropagation`（点面板内部就把浮层关了）。
 *
 * ⚠️ **`data-entering` / `data-closed` 这两个属性是动效的接口，不要省**：
 *    浮层的入场/出场过渡完全靠它们驱动（见 hooks/useSheetTransition 与 index.css 的
 *    `[data-entering]` / `[data-closed]` 规则）。少了它们表现是"动效硬切"。
 *
 * ⚠️ 面板上的 `stopPropagation` 也是必需的：遮罩负责"点外面关闭"，
 *    少了它点面板内部会冒泡到遮罩 → 浮层自己关掉。
 */
export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** 面板标题（`.sheet-head > h3`）。不传则不渲染标题（但若 showClose 为真，头部仍会出现） */
  title?: ReactNode;
  /** 右上角 × 关闭按钮。**默认不渲染**——排序/更多分类两个浮层本来就没有它 */
  showClose?: boolean;
  /** 关闭按钮禁用（如换源正在生效时） */
  closeDisabled?: boolean;
  /**
   * 点遮罩时的动作，默认 `onClose`。
   * 需要"某些状态下点了也不关"的浮层（换源切换中、选话缓存进行中）用它，
   * 而不是在组件里自己再抄一层遮罩。
   */
  onBackdrop?: () => void;
  /** 追加到面板上的类名（如 `sheet-tall` / `reader-sheet` / `app-sheet`） */
  panelClassName?: string;
  /** 追加到遮罩上的类名（如 `reader-sheet-backdrop`） */
  backdropClassName?: string;
  /**
   * 渲染到 `document.body`。
   * 阅读器内的 4 个弹层**必须**开：否则会被控制条（fixed inset:0 z40）
   * 与缓存中心的 overlay 压在下面。
   */
  portal?: boolean;
  /** 出场过渡时长；默认 220ms（与原来各处一致） */
  exitMs?: number;
  children: ReactNode;
}

export function Sheet({
  open,
  onClose,
  title,
  showClose = false,
  closeDisabled = false,
  onBackdrop,
  panelClassName,
  backdropClassName,
  portal = false,
  exitMs,
  children
}: SheetProps) {
  const { mounted, entering, closing } = useSheetTransition(open, exitMs);
  if (!mounted) return null;

  const node = (
    <div
      className={"drawer-backdrop" + (backdropClassName ? " " + backdropClassName : "")}
      data-entering={entering ? "" : undefined}
      data-closed={closing ? "" : undefined}
      /* 一律包一层箭头函数：把回调直接交给 onClick 会把**点击事件当成第一个实参**传进去。
         当前所有调用方都是零参回调所以没出过事，但这是"哪天有人给 onClose 加个参数就静默出错"
         的那类隐患——阅读器的 4 个弹层就真的踩到过（runSpeedTest 的 gen 被灌成事件对象）。 */
      onClick={() => { (onBackdrop || onClose)(); }}
    >
      <div
        className={"source-drawer" + (panelClassName ? " " + panelClassName : "")}
        data-entering={entering ? "" : undefined}
        data-closed={closing ? "" : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {(title !== undefined || showClose) && (
          <div className="sheet-head">
            {title !== undefined && <h3>{title}</h3>}
            {showClose && (
              <button type="button" className="sheet-close" aria-label="关闭" disabled={closeDisabled} onClick={() => onClose()}>×</button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );

  return portal ? createPortal(node, document.body) : node;
}
