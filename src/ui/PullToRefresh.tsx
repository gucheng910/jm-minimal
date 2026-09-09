// 下拉刷新容器：指示器完全自持（手动改 DOM 绕开 React 重渲染以保帧率）
// 结构上隔离——指示器节点只存在于本组件内，不会被复用成别的页面元素
// （1.6.3 白屏事故的根因正是"指示器节点被 React 复用 + 遗留定时器打 display:none"）
import { useRef, type ReactNode, type TouchEvent } from "react";

const MAX_PULL = 110;          // 阻力公式校正：拉到 110px 时即可达到阈值
const REFRESH_THRESHOLD = 70;  // 阈值 70px，正常手指下滑一次即可触发

interface Props {
  onRefresh: () => void | Promise<void>;
  children: ReactNode;
}

export default function PullToRefresh({ onRefresh, children }: Props) {
  const startYRef = useRef(0);
  const posRef = useRef(0);
  const refreshingRef = useRef(false);
  const indRef = useRef<HTMLDivElement | null>(null);
  const arrowRef = useRef<HTMLSpanElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);

  /** 动手改 DOM 前先确认节点还是它自己（防被复用） */
  function indicator(): HTMLDivElement | null {
    const el = indRef.current;
    return el && el.isConnected && el.classList.contains("ptr-indicator") ? el : null;
  }

  function updateUI(pos: number) {
    const ind = indicator();
    const arr = arrowRef.current;
    const lab = labelRef.current;
    if (!ind || !arr || !lab) return;
    ind.style.height = Math.min(pos * 0.7, 60) + "px";
    ind.style.opacity = String(Math.min(pos / REFRESH_THRESHOLD, 1));
    ind.style.display = "flex";
    const reach = pos >= REFRESH_THRESHOLD;
    arr.style.transform = reach ? "rotate(180deg)" : "rotate(" + Math.min(pos / REFRESH_THRESHOLD * 180, 180) + "deg)";
    arr.style.color = reach ? "var(--brand)" : "var(--ink-2)";
    lab.textContent = reach ? "松手刷新" : "继续下拉";
  }

  function hideUI() {
    const ind = indicator();
    if (!ind) return;
    ind.style.transition = "height 0.18s ease, opacity 0.18s ease";
    ind.style.height = "0px";
    ind.style.opacity = "0";
    setTimeout(() => {
      // 刷新已开始的话不要在这里收起（否则"正在刷新…"会在刷新途中消失）
      if (refreshingRef.current) return;
      // 180ms 后节点可能已不在（组件卸载）：重新取一次并校验
      const el = indicator();
      if (el) {
        el.style.display = "none";
        el.style.transition = "";
      }
    }, 180);
  }

  function showRefreshingUI() {
    const ind = indicator();
    const arr = arrowRef.current;
    const lab = labelRef.current;
    if (!ind || !arr || !lab) return;
    ind.style.transition = "none";
    ind.style.height = "60px";
    ind.style.opacity = "1";
    ind.style.display = "flex";
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
      posRef.current = 0;
      updateUI(0);
      return;
    }
    // 阻力公式（更平缓）：pos = raw / (1 + raw/k)
    // raw=70 → pos≈53；raw=150 → pos≈91；raw=300 → pos≈120（封顶）
    const pos = Math.min(raw / (1 + raw / 220), MAX_PULL);
    posRef.current = pos;
    updateUI(pos);
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
    <div onTouchStart={handleStart} onTouchMove={handleMove} onTouchEnd={handleEnd}>
      <div ref={indRef} className="ptr-indicator" style={{ height: 0, opacity: 0, display: "none" }}>
        <span ref={arrowRef} className="ptr-arrow">↓</span>
        <span ref={labelRef}></span>
      </div>
      {children}
    </div>
  );
}
