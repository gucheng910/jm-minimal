// 纯展示组件：封面（含 t 签权 URL / 失败重试）+ 标题行，供各处列表复用
import { memo, useEffect, useRef, useState } from "react";
import { decodeCover, drawCover, imageOffloadAvailable, warmCover } from "../core/imageOffload";
import { albumCoverUrl } from "../core/coverUrl";
import { DEFAULT_LIST_LAYOUT, listSubtitle } from "../core/listLayout";
import type { ListLayoutConfig } from "../core/listLayout";
import type { AlbumSummary } from "../core/types";

// 封面 URL 的构造已挪到 core/coverUrl（18+ 门的预取也要用，见 core/prewarm）；
// 这里 re-export 保持历史导入路径不变（ContentView / AlbumDetail 都从这里取）。
export { albumCoverUrl };

function Cover({ url, alt }: { url?: string; alt: string }) {
  const [tries, setTries] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const timer = useRef<number | null>(null);
  /**
   * 封面是否退回老的 `<img>` 路径。
   * 默认取反于「有没有 Worker 通道」：现代内核先走 canvas（Worker 里 fetch + 解码 + 降采样），
   * 任何一步不可用（内核太老 / 图床不给 CORS / 超时）就**永久退回** `<img>` —— 那条路是原封不动的旧实现。
   */
  const [useImg, setUseImg] = useState(() => !imageOffloadAvailable());
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const full = url || "";
  const dead = tries >= 6; // 超过恢复上限才永久占位（重挂载/刷新会重新开始）
  // 失败自动重试：快速退避 0.8s/1.6s/3.2s，之后每 45s 尝试恢复一次，避免一次失败就永远空白
  const src = full && tries > 0 ? full + (full.includes("?") ? "&" : "?") + "retry=" + tries : full;

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  /**
   * 淡入只做 opacity（140ms，零位移）：弱网下列表里的封面是逐张"蹦"出来的。
   * 用动画而不是 transition 是因为要「在图片就绪之后」才开始淡入；
   * 命中浏览器缓存时 onLoad 可能在 React 挂上监听之前就触发，所以补一次 complete 检查。
   * （canvas 路径没有这个竞态：画布是我们自己画的，画完才 setLoaded。）
   */
  useEffect(() => {
    if (useImg === false) return;
    setLoaded(false);
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0) setLoaded(true);
  }, [src, useImg]);

  /**
   * Worker 路径：量出**这一张的实际显示盒**（列表 56×72、网格按列数不同），
   * 让 Worker 直接解到这个尺寸（×dpr，封顶 2）—— 列表里的封面原图常见 600×800，
   * 而这里只需要 ~112×144 个像素。解码与缩放全在 Worker 里，主线程只做一次 drawImage。
   */
  useEffect(() => {
    if (useImg || !full) return;
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    const rect = box.getBoundingClientRect();
    const boxW = rect.width || 56;
    const boxH = rect.height || 72;
    const dpr = Math.min(2, Math.max(1, typeof devicePixelRatio === "number" ? devicePixelRatio : 1));
    canvas.width = Math.max(1, Math.round(boxW * dpr));
    canvas.height = Math.max(1, Math.round(boxH * dpr));
    setLoaded(false);
    let cancelled = false;
    void decodeCover(full, boxW, boxH).then((bmp) => {
      if (cancelled) { try { bmp?.close(); } catch { /* ignore */ } return; }
      if (!bmp) { setUseImg(true); return; } // 这条路不通：退回 <img>（含它自己的重试）
      const target = canvasRef.current;
      if (target) drawCover(target, bmp);
      try { bmp.close(); } catch { /* ignore */ }
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [full, useImg]);

  // ⚠️ 所有 Hook 必须在这行之前：`setting` 迟到时封面 URL 会从空串变成真实地址，
  // 若提前 return 掉就变成「两次渲染的 Hook 数量不同」——React 会直接抛错整屏白。
  // （2026-09-13 oxlint 的 react-hooks/rules-of-hooks 抓到的真实缺陷）
  if (!full) return <div className="thumb empty"><span>{alt}</span></div>;

  const scheduleNext = () => {
    if (timer.current) window.clearTimeout(timer.current);
    const delay = tries < 3 ? [800, 1600, 3200][tries] : 45000;
    timer.current = window.setTimeout(() => setTries((t) => t + 1), delay);
  };
  return (
    <span className="thumb-box" ref={boxRef}>
      {useImg ? (
        <img ref={imgRef} className={"thumb" + (loaded ? " in" : "")} key={src} src={src} alt={alt} loading="lazy" decoding="async"
          style={dead ? { opacity: 0 } : undefined}
          onLoad={() => { setLoaded(true); if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } }}
          onError={() => { if (!dead) scheduleNext(); }} />
      ) : (
        /* 与 <img> 同一个 .thumb 类：尺寸/fade-in/圆角全靠同一套 CSS，
           像素由 Worker 解到「显示盒 × dpr」，cover 裁切在 drawCover 里做（不拉变形）。
           无障碍：书名本来就由同级的 .thumb-fallback 与 .title 读出来了，
           这里只是画，标 aria-hidden 免得读屏把同一本书念两遍。 */
        <canvas ref={canvasRef} className={"thumb" + (loaded ? " in" : "")} aria-hidden="true" />
      )}
      <span className="thumb-fallback"><span>{alt}</span></span>
    </span>
  );
}

/**
 * 首屏/翻页的封面预取。
 *
 * 两条路：
 *   · 有 Worker（现代内核）：`warmCover` 在 Worker 里取字节并**落进持久缓存**，不解码、不回传位图。
 *     真正滚到那张时就是缓存命中 → 0 网络。这是"封面一下就出来"的关键。
 *   · 没有 Worker（老内核）：退回原来的 `new Image()`（只发请求、等浏览器缓存）。
 *
 * 预热是**低优先级**的（core/imageOffload 的两条队列）：正在显示的那几张永远排在前面。
 */
export function prefetchCovers(list: AlbumSummary[], count = 6): void {
  try {
    for (const a of list.slice(0, count)) {
      const url = albumCoverUrl(a);
      if (!url) continue;
      if (imageOffloadAvailable()) {
        void warmCover(url).then((ok) => {
          // 这个图床给不了 CORS：预热这条路不通，退回 <img> 预取（至少让 HTTP 缓存有货）
          if (!ok) prefetchViaImg(url);
        });
      } else {
        prefetchViaImg(url);
      }
    }
  } catch { /* ignore */ }
}

/** 老路径：只发请求，把货塞进浏览器 HTTP 缓存（不解码） */
function prefetchViaImg(url: string): void {
  if (!url.startsWith("http")) return;
  try {
    const im = new Image();
    im.decoding = "async";
    im.src = url;
  } catch { /* ignore */ }
}

export const AlbumCard = memo(function AlbumCard({ album, onOpen, onRemove, layout, skeleton }: {
  album: AlbumSummary;
  onOpen: (a: AlbumSummary) => void;
  /**
   * 给了就显示右上角删除角标（足迹/收藏的「管理」模式用）。
   * 用 span[role=button] 而不是 <button>：外层卡片本身就是 button，里面再嵌 button 是非法 HTML。
   */
  onRemove?: (a: AlbumSummary) => void;
  /**
   * 列表页展示编排（副标题写哪几个字段、什么顺序）。由 AlbumGrid 统一传入 ——
   * 它是所有卡片网格的唯一入口，订阅一次就够，不必每张卡片各订一份。
   * 不传时按默认顺序渲染，与改造前逐字一致。
   */
  layout?: ListLayoutConfig;
  /**
   * 占位渲染（**只在「自定义 UI」的画布/缩略图传 true**）：不生成封面 URL、不加载图片，
   * 直接渲染"失败回退"式的文字占位（灰底 + 居中书名），与图片加载失败时露出的那一层**同一套视觉**。
   * 不传 = false → 线上所有列表逐字不变。
   */
  skeleton?: boolean;
}) {
  const subtitle = listSubtitle(layout || DEFAULT_LIST_LAYOUT, album);
  return (
    <button className="list-item" onClick={() => onOpen(album)}>
      {skeleton ? (
        /* 与 Cover 的失败回退层同构：.thumb-box（有尺寸）+ .thumb-fallback（铺满 + 居中文字）。
           刻意**不**走 Cover：连 albumCoverUrl 都不调用，杜绝任何真实封面请求。 */
        <span className="thumb-box">
          <span className="thumb-fallback"><span>{album.name}</span></span>
        </span>
      ) : (
        <Cover url={albumCoverUrl(album)} alt={album.name} />
      )}
      {onRemove && (
        <span
          className="card-remove"
          role="button"
          tabIndex={0}
          aria-label={"删除 " + album.name}
          onClick={(e) => { e.stopPropagation(); onRemove(album); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onRemove(album); }
          }}
        >×</span>
      )}
      <div>
        <div className="title">{album.name}</div>
        {/* 空内容由 CSS 的 `.list-item .muted:empty { display:none }` 收掉，这里不做判断 */}
        <div className="muted">{subtitle}</div>
      </div>
    </button>
  );
});
