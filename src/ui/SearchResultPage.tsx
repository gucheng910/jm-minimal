// 特殊搜索结果页（只读）：由详情页的作者/标签入口打开。
// 设计约束（与 ContentView 的页面栈配套）：
//   - 搜索词不可修改，只能返回；仅结果卡片可点击进入详情页；
//   - 由父级通过 open 控制进出场，组件保持挂载以保留滚动位置与已加载分页；
//   - 翻页用无限滚动（IntersectionObserver + 自身滚动容器）。
import { memo, useEffect, useRef, useState } from "react";
import { AlbumGrid } from "./AlbumGrid";
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
  // 进场：先以「关闭态」挂载，下一帧加 .open 触发从右侧滑入（React 挂载即带 .open 不会播动画）
  const [entered, setEntered] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    if (!open) { setEntered(false); return; }
    // 双 rAF：第一帧让浏览器把「关闭态（translateX(100%)）」真正绘制出来，
    // 第二帧再加 .open —— 单 rAF 时 React 会在同一帧内完成挂载+改类，过渡不会触发（表现为"没有动画"）。
    let id2 = 0;
    const id1 = requestAnimationFrame(() => { id2 = requestAnimationFrame(() => setEntered(true)); });
    return () => { cancelAnimationFrame(id1); if (id2) cancelAnimationFrame(id2); };
  }, [open]);

  // 换搜索词：回到顶部（同一个组件实例复用，不会重新挂载）
  // 用两参数形式：老内核（WebView < 61）不支持 scrollTo(options) 字典签名
  useEffect(() => { bodyRef.current?.scrollTo(0, 0); }, [resetKey]);

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
    <section className={"sr-layer" + (entered ? " open" : "")} aria-hidden={!open}>
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
        {error && <div className="card err">{error}</div>}
        {busy && items.length === 0 ? <SkeletonGrid /> : null}
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
