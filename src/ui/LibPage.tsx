import { useEffect, useState } from "react";
import { useBackHandler } from "../hooks/useBackHandler";
import { client } from "../core/api";
import { UI_KEYS } from "../core/constants";
import { AlbumGrid } from "./AlbumGrid";
import { SkeletonGrid } from "./SkeletonGrid";
import type { AlbumSummary } from "../core/types";
import { CloseIcon } from "./icons";

function loadLocalHistory(): AlbumSummary[] {
  try {
    const arr = JSON.parse(localStorage.getItem(UI_KEYS.history) || "[]") as AlbumSummary[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export default function LibPage({
  kind,
  onOpenAlbum,
  onClose
}: {
  kind: "favorite" | "history";
  onOpenAlbum: (aid: number | string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<AlbumSummary[] | null>(null);
  const [error, setError] = useState("");
  const title = kind === "favorite" ? "我的收藏" : "我的足迹";

  useBackHandler(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (kind === "history") {
          // 足迹仅使用本地 localStorage，无需登录
          if (alive) setItems(loadLocalHistory());
          return;
        }
        // 收藏需要登录才能请求官方接口
        if (!client.apiBase) await client.init();
        const result = await client.getFavorites();
        const obj = result as { list?: AlbumSummary[]; content?: AlbumSummary[]; data?: { list?: AlbumSummary[] } };
        const list = obj.list || obj.content || obj.data?.list || [];
        if (alive) setItems(list);
      } catch (err) {
        if (alive) setError(String(err));
      }
    })();
    return () => { alive = false; };
  }, [kind]);

  return (
    <div className="cache-overlay">
      <div className="cache-header">
        <h2>{title}</h2>
        <button className="ghost" aria-label="关闭" onClick={onClose}><CloseIcon size={18} /></button>
      </div>
      {error && <div className="card err">{error}</div>}
      {!items && !error && <SkeletonGrid />}
      {items && items.length === 0 && <p className="muted cache-empty">还没有内容，去逛一逛吧</p>}
      {items && items.length > 0 && (
        <AlbumGrid items={items} onOpen={(album) => onOpenAlbum(album.id)} />
      )}
    </div>
  );
}
