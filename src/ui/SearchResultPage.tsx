// 特殊搜索结果页（只读）：由详情页的作者/标签入口打开。
// 设计约束（与 ContentView 的页面栈配套）：
//   - 搜索词不可修改，只能返回；仅结果卡片可点击进入详情页；
//   - 由父级通过 open 控制进出场，组件保持挂载以保留滚动位置与已加载分页；
//   - 栈里每一层都是独立实例（各自保有滚动与分页），只有栈顶那层 open；
//   - 进出场都用 transition（**可被打断**：手快时从当前位移继续滑），
//     方向由 data-nav 决定"关闭位在右还是左"，见下方 phase 说明。
import { memo, useEffect, useRef, useState } from "react";
import { AlbumGrid } from "./AlbumGrid";
import { scrollToTop } from "../core/dom";
import { SkeletonGrid } from "./SkeletonGrid";
import type { AlbumSummary } from "../core/types";

export type SRKind = "tag" | "author" | "character";

/** 只读搜索页标题与官方 search_type 的映射 */
export const KIND_META: Record<SRKind, { label: string; searchType: string }> = {
  tag: { label: "标签", searchType: "tag" },
  author: { label: "作者", searchType: "author" },
  character: { label: "登场人物", searchType: "character" }
};

interface Props {
  /** 是否在前台（false 时保持在 DOM 中但不可见/不可点，用于出场动画与滚动位置保留） */
  open: boolean;
  /**
   * 这次「进入」的方向，只决定入场动画：
   *   · "push"（默认）：从右侧拉入（由详情/列表进入搜索层）；
   *   · "pop"：从左侧归位 —— 从搜索层里的详情返回时用，是进入动效的**反方向**，
   *     读者看到的才是"返回"，而不是"又被从右边拉进来一次"。
   * 退出一律向右滑出（关闭这个面板的方向），由 CSS transition 负责。
   */
  navDir?: "push" | "pop";
  /** 层叠顺序：栈里越靠上的搜索层给的越大（都是 fixed 定位，靠它排先后） */
  zIndex?: number;
  kind: SRKind;
  text: string;
  items: AlbumSummary[];
  busy: boolean;
  error: string;
  hasMore: boolean;
  /** 搜索词变化时用它重置滚动到顶部 */
  resetKey: string;
  /** 图床配置变化计数（与首页列表一致，用于封面重新加载） */
  coverTick: number;
  onBack: () => void;
  onOpenAlbum: (a: AlbumSummary) => void;
  onLoadMore: () => void;
}

export const SearchResultPage = memo(function SearchResultPage({
  open,
  navDir = "push",
  zIndex,
  kind,
  text,
  items,
  busy,
  error,
  hasMore,
  resetKey,
  coverTick,
  onBack,
  onOpenAlbum,
  onLoadMore
}: Props) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  /**
   * 进出场相位（**不用 keyframes**，实测动画被移除时会瞬间回到底位 → 301px 硬跳）：
   *   closed     → 关闭位（由 data-nav 决定在右还是左）
   *   positioned → 关闭位 + 禁用过渡：把元素瞬间摆到该方向的关闭位（此时在屏幕外、不可见）
   *   open       → 挂 .open，靠 transition 从关闭位滑到位；退出就是去掉 .open，同一属性反向过渡
   * 用 transition 而非 animation 的关键理由：transition 可被打断并**从当前位移继续**，
   * 所以"入场还没播完就返回"不会硬跳，而是从当前位置平滑滑出。
   */
  const [phase, setPhase] = useState<"closed" | "positioned" | "open">("closed");
  useEffect(() => {
    if (!open) { setPhase("closed"); return; }
    setPhase("positioned");
    // 双 rAF：第一帧让浏览器按 data-nav 把关闭位真正绘制出来，第二帧再加 .open 触发过渡
    // （单 rAF 时 React 会在同一帧内完成摆位+改类，过渡不会触发）
    let id2 = 0;
    const id1 = requestAnimationFrame(() => { id2 = requestAnimationFrame(() => setPhase("open")); });
    return () => { cancelAnimationFrame(id1); if (id2) cancelAnimationFrame(id2); };
  }, [open]);

  // 换搜索词/首次挂载：回到顶部
  // 走 scrollToTop：老内核（WebView < 61）连 Element.scrollTo 方法都没有，直接调会抛错冒到错误边界
  useEffect(() => { scrollToTop(bodyRef.current); }, [resetKey]);

  // 无限滚动：哨兵进入滚动容器（含 320px 预读区）且还有下一页时加载
  useEffect(() => {
    const root = bodyRef.current;
    const el = sentinelRef.current;
    if (!open || !root || !el || !hasMore || busy) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) loadMoreRef.current(); },
      { root, rootMargin: "320px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [open, hasMore, busy, items.length]);

  const label = KIND_META[kind].label;

  return (
    <section
      className={"sr-layer" + (phase === "positioned" ? " sr-positioning" : "") + (phase === "open" ? " open" : "")}
      data-nav={navDir}
      style={zIndex != null ? { zIndex } : undefined}
      aria-hidden={!open}
    >
      <header className="sr-head">
        <button className="sr-back" aria-label="返回" onClick={onBack}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <div className="sr-title">
          <h2>{label}「{text}」</h2>
          <span className="sr-count">已加载 {items.length} 部</span>
        </div>
      </header>
      <div className="sr-body" ref={bodyRef}>
        {items.length === 0 && error && <div className="card err">{error}</div>}
        {busy && !error && items.length === 0 ? <SkeletonGrid /> : null}
        {!busy && !error && items.length === 0 ? <p className="muted sr-empty">没有找到相关漫画</p> : null}
        <AlbumGrid key={"srg" + coverTick} items={items} onOpen={onOpenAlbum} />
        {hasMore && (
          <div className="card row sr-more">
            <button disabled={busy} onClick={onLoadMore}>{busy ? "加载中…" : "加载更多"}</button>
          </div>
        )}
        <div ref={sentinelRef} className="sr-sentinel" aria-hidden="true" />
      </div>
    </section>
  );
});
