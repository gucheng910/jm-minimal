// 纯展示组件：封面（含 t 签权 URL / 失败重试）+ 标题行，供各处列表复用
import { memo, useEffect, useRef, useState } from "react";
import { client } from "../core/api";
import { DEFAULT_LIST_LAYOUT, listSubtitle } from "../core/listLayout";
import type { ListLayoutConfig } from "../core/listLayout";
import type { AlbumSummary } from "../core/types";

export function albumCoverUrl(a: AlbumSummary): string {
  const direct = a.image || "";
  if (direct.startsWith("http")) return direct;
  const host = client.setting?.img_host as string | undefined;
  if (host && a.id) {
    // 官方封面/正文镜像需要 t 签权参数（= update_at），缺少时新专辑封面会 502/不稳定
    const upd = String(a.update_at || a.adddate || "");
    return host + "/media/albums/" + String(a.id) + "_3x4.jpg?v=" + upd + (upd ? "&t=" + upd : "");
  }
  return direct;
}

function Cover({ url, alt }: { url?: string; alt: string }) {
  const [tries, setTries] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const timer = useRef<number | null>(null);
  const full = url || "";
  const dead = tries >= 6; // 超过恢复上限才永久占位（重挂载/刷新会重新开始）
  // 失败自动重试：快速退避 0.8s/1.6s/3.2s，之后每 45s 尝试恢复一次，避免一次失败就永远空白
  const src = full && tries > 0 ? full + (full.includes("?") ? "&" : "?") + "retry=" + tries : full;

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  /**
   * 淡入只做 opacity（140ms，零位移）：弱网下列表里的封面是逐张"蹦"出来的。
   * 用动画而不是 transition 是因为要「在图片就绪之后」才开始淡入；
   * 命中浏览器缓存时 onLoad 可能在 React 挂上监听之前就触发，所以补一次 complete 检查。
   */
  useEffect(() => {
    setLoaded(false);
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0) setLoaded(true);
  }, [src]);

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
    <span className="thumb-box">
      <img ref={imgRef} className={"thumb" + (loaded ? " in" : "")} key={src} src={src} alt={alt} loading="lazy" decoding="async"
        style={dead ? { opacity: 0 } : undefined}
        onLoad={() => { setLoaded(true); if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } }}
        onError={() => { if (!dead) scheduleNext(); }} />
      <span className="thumb-fallback"><span>{alt}</span></span>
    </span>
  );
}

/** 首屏封面预取（不阻塞渲染，命中浏览器缓存后立即显示） */
export function prefetchCovers(list: AlbumSummary[], count = 6): void {
  try {
    for (const a of list.slice(0, count)) {
      const url = albumCoverUrl(a);
      if (url.startsWith("http")) {
        const im = new Image();
        im.decoding = "async";
        im.src = url;
      }
    }
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
