// 下拉刷新容器：指示器完全自持（手动改 DOM 绕开 React 重渲染以保帧率）
// 结构上隔离——指示器节点只存在于本组件内，不会被复用成别的页面元素
// （1.6.3 白屏事故的根因正是"指示器节点被 React 复用 + 遗留定时器打 display:none"）
//
// 2026-09-12 动效评审整改：
//   · 揭示方式从「逐帧改指示器 height」（布局属性）改成「容器 translateY + 指示器绝对定位在内容上方」——只动 transform；
//   · touchmove 不再逐个写样式，统一在 rAF 里写一次（原来每个事件都触发样式与布局回算）。
import { useEffect, useRef, type ReactNode, type TouchEvent } from "react";

const MAX_PULL = 110;          // 阻力公式校正：拉到 110px 时即可达到阈值
const REFRESH_THRESHOLD = 70;  // 阈值 70px，正常手指下滑一次即可触发
const INDICATOR_H = 60;        // 与 .ptr-indicator 的 height 一致（顶到 -60px）

interface Props {
  onRefresh: () => void | Promise<void>;
  children: ReactNode;
}

export default function PullToRefresh({ onRefresh, children }: Props) {
  const startYRef = useRef(0);
  const posRef = useRef(0);
  const refreshingRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const indRef = useRef<HTMLDivElement | null>(null);
  const arrowRef = useRef<HTMLSpanElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const rafRef = useRef(0);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  /** 动手改 DOM 前先确认节点还是它自己（防被复用） */
  function indicator(): HTMLDivElement | null {
    const el = indRef.current;
    return el && el.isConnected && el.classList.contains("ptr-indicator") ? el : null;
  }

  /** 真正写样式：只动 transform / opacity（GPU 属性） */
  function apply(pos: number) {
    const wrap = wrapRef.current;
    const ind = indicator();
    const arr = arrowRef.current;
    const lab = labelRef.current;
    if (!wrap || !ind || !arr || !lab) return;
    wrap.style.transform = pos > 0 ? "translateY(" + pos + "px)" : "";
    ind.style.opacity = String(Math.min(pos / REFRESH_THRESHOLD, 1));
    const reach = pos >= REFRESH_THRESHOLD;
    arr.style.transform = reach ? "rotate(180deg)" : "rotate(" + Math.min(pos / REFRESH_THRESHOLD * 180, 180) + "deg)";
    arr.style.color = reach ? "var(--brand)" : "var(--ink-2)";
    lab.textContent = reach ? "松手刷新" : "继续下拉";
  }

  /** touchmove 只记录位置，帧内合并成一次写（避免样式重算风暴） */
  function schedule(pos: number) {
    posRef.current = pos;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      apply(posRef.current);
    });
  }

  function hideUI() {
    const wrap = wrapRef.current;
    const ind = indicator();
    if (!wrap || !ind) return;
    wrap.style.transition = "transform var(--t-ui) var(--ease-out)";
    ind.style.transition = "opacity var(--t-ui) var(--ease-out)";
    wrap.style.transform = "";
    ind.style.opacity = "0";
    setTimeout(() => {
      // 刷新已开始的话不要在这里清理（否则"正在刷新…"会在刷新途中消失）
      if (refreshingRef.current) return;
      // 过渡结束后清掉内联过渡（节点可能已不在：重新取一次并校验）
      if (wrapRef.current === wrap && wrap.isConnected) wrap.style.transition = "";
      const el = indicator();
      if (el) el.style.transition = "";
    }, 240);
  }

  function showRefreshingUI() {
    const wrap = wrapRef.current;
    const ind = indicator();
    const arr = arrowRef.current;
    const lab = labelRef.current;
    if (!wrap || !ind || !arr || !lab) return;
    wrap.style.transition = "none";
    ind.style.transition = "none";
    wrap.style.transform = "translateY(" + INDICATOR_H + "px)";
    ind.style.opacity = "1";
    arr.style.transform = "none";
    arr.className = "ptr-spinner";
    lab.textContent = "正在刷新…";
  }

  function handleStart(e: TouchEvent) {
    if (window.scrollY > 0 || refreshingRef.current) return;
    startYRef.current = e.touches[0].clientY;
  }

  function handleMove(e: TouchEvent) {
    if (startYRef.current === 0 || refreshingRef.current) return;
    const raw = e.touches[0].clientY - startYRef.current;
    if (raw <= 0) {
      schedule(0);
      return;
    }
    // 阻力公式（更平缓）：pos = raw / (1 + raw/k)
    // raw=70 → pos≈53；raw=150 → pos≈91；raw=300 → pos≈120（封顶）
    schedule(Math.min(raw / (1 + raw / 220), MAX_PULL));
  }

  function handleEnd() {
    if (startYRef.current === 0) return;
    startYRef.current = 0;
    const finalPos = posRef.current;
    posRef.current = 0;
    hideUI();
    if (finalPos < REFRESH_THRESHOLD) return; // 未达阈值，自动回弹
    refreshingRef.current = true;
    showRefreshingUI();
    Promise.resolve().then(() => onRefresh()).finally(() => {
      refreshingRef.current = false;
      hideUI(); // 刷新结束后收起指示器（原实现缺这一步，靠 180ms 定时器"碰巧"隐藏）
    });
  }

  return (
    <div ref={wrapRef} className="ptr-wrap" onTouchStart={handleStart} onTouchMove={handleMove} onTouchEnd={handleEnd}>
      <div ref={indRef} className="ptr-indicator" style={{ opacity: 0 }} aria-hidden="true">
        <span ref={arrowRef} className="ptr-arrow">↓</span>
        <span ref={labelRef}></span>
      </div>
      {children}
    </div>
  );
}
