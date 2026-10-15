import type { ReactNode } from "react";
import { DETAIL_NODE_META } from "../core/detailLayout";
import { useCanvasDrag } from "../hooks/useCanvasDrag";

/**
 * 「自定义 UI」画布里的一个可编辑块 —— 拖拽手柄 + 序号 + 选中描边。
 *
 * 只在编辑态渲染（`AlbumDetail` 的 `editMode`），线上路径一个这样的节点都没有。
 *
 * v2 手势（见 hooks/useCanvasDrag.ts）：
 *   · **整块可抓**：长按 280ms（触摸）/ 位移 > 4px（鼠标）起拖 —— 拖动中兄弟块让位；
 *   · **⠿ 手柄保留**：按下立即拖的精确路径，也是触摸手势被系统抢走时的退路。
 *
 * 两个刻意的点：
 *   1. **手柄与序号都绝对定位**，不占文档流 —— 这样套上这层框之后，
 *      块的排布与不套时一模一样，预览不会"一进编辑模式就错位"。
 *   2. **描边用 `outline` 不用 `border`/`box-shadow`**（调研结论：GrapesJS 的 `sw-visibility`
 *      就是画边界高亮；outline 不占盒、不改变布局，box-shadow 在老内核上合成开销大且易闪）。
 *      FLIP 让位动画给的是 `transform`，同样不碰文档流。
 *
 * v3 跟手（`hooks/useCanvasDrag.ts` 的 ghost）：
 *   起拖后**本元素留在文档流里当"坑"**（CSS 把它的内容藏掉、给一条品牌描边 + 插入缝），
 *   真正跟指针走的是克隆出来的 `.ed-ghost` 镜像。所以本元素**不承载跟手 transform**
 *   —— transform 仍归 FLIP 让位动画，两套互不打架。`blockRef` 就是给 hook 克隆用的。
 */

interface Props {
  id: string;
  selected: boolean;
  onSelect: (id: string) => void;
  onMoveTo: (id: string, index: number) => void;
  /**
   * 一次拖拽收尾（松手 / 手势取消）—— 上层据此做**一次**落盘 + 广播。
   * 拖动中的 onMoveTo 每帧都会跑，所以落盘不能放在那里（v3：拖动只动内存）。
   */
  onDragEnd?: () => void;
  /**
   * v3.5（用户第 2 条）：拖动**真正开始**那一帧回调一次 —— 上层据此收起已唤起的配置栏。
   * 见 `hooks/useCanvasDrag` 的同名参数说明。
   */
  onDragStart?: () => void;
  /**
   * v3.5.1 **行内落位**：被拖块独占一行且不满宽时，横向拖动把它拖进自己那一行的空位。
   * `col` 是 12 列制的行内起始列。纯顺序拖动不回调它（两种落位语义不抢手指）。
   */
  onMoveColTo?: (id: string, col: number) => void;
  /**
   * v3 流式槽位：这一块在 12 列网格里占几格（缺省 12 = 满宽）。
   *
   * 编辑态下**本元素就是网格项**（线上态是 `.d-slot`），所以 `data-span` 必须由这里渲染
   * —— 挂错元素会出现"编辑态并排、线上不并排"。满宽时一个属性都不写。
   */
  span?: number;
  children: ReactNode;
}

export default function EdBlock({ id, selected, onSelect, onMoveTo, onMoveColTo, onDragEnd, onDragStart, span, children }: Props) {
  const drag = useCanvasDrag(onMoveTo, id, onDragEnd, onDragStart, onMoveColTo);
  /**
   * chip 上显示的名字：**取自配置层**（`DETAIL_NODE_META`），不在 UI 里另写一份；
   * 去掉括注让 chip 放得下（"主视觉（封面 / 标题）" → "主视觉"）。
   * 配置层没有的 id（理论上不会发生）回落成 id 本身，不抛错、不空白。
   */
  const meta = (DETAIL_NODE_META as Record<string, { label: string } | undefined>)[id];
  const name = meta ? meta.label.split("（")[0] : id;
  return (
    <div
      ref={drag.blockRef}
      className={"ed-blk" + (selected ? " ed-sel" : "") + (drag.dragging ? " ed-drag" : "")}
      data-blk={id}
      {...(span !== undefined && span < 12 ? { "data-span": String(span) } : {})}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={"选中区块：" + name}
      {...drag.blockProps}
      onClick={(e) => { e.stopPropagation(); onSelect(id); }}
      onContextMenu={(e) => {
        // 长按在 Android 上会弹系统菜单（图片 / 链接尤其明显），它会**打断长按拖拽**的手势。
        // CSS 的 `-webkit-touch-callout: none` 只管 iOS，所以这里显式挡掉；
        // 编辑态的画布不需要右键菜单（块里的链接点开也没意义）。
        e.preventDefault();
      }}
      onKeyDown={(e) => {
        // 点选要有键盘路径：鼠标用户点画布，键盘/读屏用户 Tab 到块上按回车选中，
        // 然后用检查器里的 ▲▼ / 开关操作 —— 那三条才是真正的功能入口。
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onSelect(id);
        }
      }}
    >
      {/*
        v3.3：抓手（`.ed-grip` + 块名 chip）**已删除**。
        用户原话：「每个区块左上角的数字和六个点那个黑色的框去掉吧，碍眼，
        平时直接长按模块来拖动，不需要拖动它」。

        所以拖动入口只剩**长按区块本体**（`useCanvasDrag` 的长按计时 / 位移阈值），
        选中态由描边表达。`useCanvasDrag` 里仍保留 `gripProps`（其它调用方可能用），
        只是 EdBlock 不再渲染那个手柄了。
      */}
      {/*
        插入缝（v3）：落点那条线。它是**"坑"（.ed-drag）的子元素**，所以兄弟块让位时
        它会跟着坑一起滑到落点 —— 用户看到的"缝在哪"就是"会落在哪"。
        跟手的那一块不在这里：它是 hooks/useCanvasDrag 克隆出来的 .ed-ghost 镜像。
      */}
      {drag.dragging && <span className="ed-gap" aria-hidden="true" />}
      {children}
    </div>
  );
}
