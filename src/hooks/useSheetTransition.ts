// 浮层出入场：状态为 true 时挂载并播入场过渡，状态变 false 后先播完出场过渡再卸载。
//
// 为什么需要：这些浮层原来是 {open && <div/>}，关闭瞬间就从 DOM 消失——
// 入场 240ms 很讲究，出场却是硬切（2026-09-12 动效评审的第一条）。
// 另外入场起始态用「双 rAF」落地：单 rAF 时挂载与改类在同一帧，浏览器来不及绘制起始态，
// 过渡不会触发（这个坑在 SearchResultPage 上踩过一次）。
import { useEffect, useRef, useState } from "react";

interface SheetTransition {
  /** 是否保留在 DOM 中（含出场动画期间） */
  mounted: boolean;
  /** 入场起始帧：true 时元素处于「收起」位置且不过渡，下一帧转 false 触发过渡 */
  entering: boolean;
  /** 正在播出场过渡：true 时元素处于「收起」位置，且不再接收点击 */
  closing: boolean;
}

export function useSheetTransition(open: boolean, exitMs = 220): SheetTransition {
  const [mounted, setMounted] = useState(open);
  const [entering, setEntering] = useState(false);
  const [closing, setClosing] = useState(false);
  const mountedRef = useRef(open);
  mountedRef.current = mounted;

  useEffect(() => {
    if (open) {
      const first = !mountedRef.current;
      setClosing(false);
      setMounted(true);
      if (!first) { setEntering(false); return; }
      setEntering(true);
      let id2 = 0;
      const id1 = requestAnimationFrame(() => { id2 = requestAnimationFrame(() => setEntering(false)); });
      return () => { cancelAnimationFrame(id1); if (id2) cancelAnimationFrame(id2); };
    }
    if (!mountedRef.current) return;
    setEntering(false);
    setClosing(true);
    const t = window.setTimeout(() => { setClosing(false); setMounted(false); }, exitMs);
    return () => window.clearTimeout(t);
  }, [open, exitMs]);

  return { mounted, entering, closing };
}
