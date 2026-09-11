// 纯展示组件：封面（含 t 签权 URL / 失败重试）+ 标题行，供各处列表复用
import { memo, useEffect, useRef, useState } from "react";
import { client } from "../core/api";
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
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  // 无图/未知地址：占位直接展示完整书名
  if (!full) return <div className="thumb empty"><span>{alt}</span></div>;
  const dead = tries >= 6; // 超过恢复上限才永久占位（重挂载/刷新会重新开始）
  // 失败自动重试：快速退避 0.8s/1.6s/3.2s，之后每 45s 尝试恢复一次，避免一次失败就永远空白
  const src = tries > 0 ? full + (full.includes("?") ? "&" : "?") + "retry=" + tries : full;
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

export const AlbumCard = memo(function AlbumCard({ album, onOpen }: { album: AlbumSummary; onOpen: (a: AlbumSummary) => void }) {
  return (
    <button className="list-item" onClick={() => onOpen(album)}>
      <Cover url={albumCoverUrl(album)} alt={album.name} />
      <div>
        <div className="title">{album.name}</div>
        <div className="muted">{[album.author, album.category?.title, album.sub].filter(Boolean).join(" · ")}</div>
      </div>
    </button>
  );
});
