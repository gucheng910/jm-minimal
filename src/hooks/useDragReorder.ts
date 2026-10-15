import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * 列表行的**拖拽排序**手势。
 *
 * 只做一件事：把"手指在行上拖"翻译成 `onMoveTo(id, index)` 这一个回调。
 * 它不认识任何页面、不认识任何配置结构，所以详情页 / 列表页 / 将来的阅读器都能用。
 *
 * 为什么用 Pointer Events 而不是 HTML5 `draggable`：
 *   · `draggable` 在移动端 WebView 上基本不可用（没有鼠标拖拽语义）；
 *   · Pointer Events 是 Chrome 55+，**WebView 57 支持**，且 `Reader.tsx` 里已经在用
 *     `setPointerCapture`，是本项目验证过的写法。
 *
 * 四条刻意的设计：
 *   1. **手柄独立**：只在左边的 ⠿ 上起拖，不是整行。否则"拖动排序"会和"上下滚页面"打架
 *      —— 这正是调研里说"拖拽手感更好，但要处理触摸与滚动冲突"的那件事。
 *      手柄上必须配 `touch-action: none`（CSS），浏览器才不会把它当成滚动手势。
 *   2. **拖动中实时换位**，但每次只回调一次 `onMoveTo`（直接给目标下标），
 *      而不是逐格 ±1 —— 逐格会在中途产生 N 个中间状态，每个都触发重排，拖起来一抖一抖。
 *   3. **越界夹住**：手指拖出容器外很常见，这时 index 会被夹到 0 / 末位，不报错也不乱动。
 *   4. **一个实例能服务多个列表**：所属列表是从手柄 `closest("[data-drag-list]")` 反查的，
 *      不是存成单个 ref。否则一个面板里有 4 个分区就得写 4 个 hook 实例（不能在循环里调 hook）。
 *
 * ▲▼ 按钮**保留**：它是无障碍路径（读屏 / 精确微调），也是一旦手势在某台机器上不灵时的退路。
 */

export interface DragReorderApi {
  /** 正在拖的那一项 id（调用方据此加视觉态）；没在拖时为 null */
  dragging: string | null;
  /** 绑到每一行的拖拽手柄上 */
  gripProps: (id: string) => {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
    onPointerCancel: (e: ReactPointerEvent) => void;
  };
}

/** 手柄所在的那个列表容器：调用方给行容器加 `data-drag-list` */
const LIST_ATTR = "data-drag-list";

export function useDragReorder(onMoveTo: (id: string, index: number) => void): DragReorderApi {
  const [dragging, setDragging] = useState<string | null>(null);
  // 用 ref 而不是 state 存"当前拖的是谁 / 在哪个列表里"：pointermove 是高频事件，
  // 走 state 会每帧重渲染，拖起来会掉帧
  const dragIdRef = useRef<string | null>(null);
  const listRef = useRef<HTMLElement | null>(null);

  /** 指针当前位置该落在第几格：用每行的**中线**判，比用 top/bottom 稳（行高不等时也不会跳） */
  function indexAt(list: HTMLElement, clientY: number): number {
    const rows = Array.from(list.children) as HTMLElement[];
    if (rows.length === 0) return 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length - 1;
  }

  function endDrag(e: ReactPointerEvent) {
    dragIdRef.current = null;
    listRef.current = null;
    setDragging(null);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  function gripProps(id: string) {
    return {
      onPointerDown: (e: ReactPointerEvent) => {
        // 不 preventDefault 的话，长按会弹出系统的文字选择/放大镜
        e.preventDefault();
        const list = (e.currentTarget as HTMLElement).closest("[" + LIST_ATTR + "]") as HTMLElement | null;
        dragIdRef.current = id;
        listRef.current = list;
        setDragging(id);
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 老内核无此 API 时退化成不捕获 */ }
      },
      onPointerMove: (e: ReactPointerEvent) => {
        const cur = dragIdRef.current;
        const list = listRef.current;
        if (!cur || !list) return;
        onMoveTo(cur, indexAt(list, e.clientY));
      },
      onPointerUp: endDrag,
      // 来电/切后台会走到这里，必须复位，否则视觉态会一直挂着
      onPointerCancel: endDrag,
    };
  }

  return { dragging, gripProps };
}

export { LIST_ATTR };
