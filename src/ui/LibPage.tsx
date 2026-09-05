import { useEffect, useState } from "react";
import { useBackHandler } from "../hooks/useBackHandler";
import { client } from "../core/api";
import { UI_KEYS } from "../core/constants";
import { AlbumGrid } from "./AlbumGrid";
import type { AlbumSummary } from "../core/types";
import { pushToast } from "./toast";
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
        if (!client.apiBase) await client.init();
        const result = kind === "favorite"
          ? await client.getFavorites()
          : await client.getWatchHistory();
        const obj = result as { list?: AlbumSummary[]; content?: AlbumSummary[]; data?: { list?: AlbumSummary[] } };
        const official = obj.list || obj.content || obj.data?.list || [];
        let list = official;
        if (kind === "history") {
          // 官方 watch_list 仅记录官方客户端的阅读行为；与本地阅读足迹合并展示
          const local = loadLocalHistory();
          const seen = new Set(official.map((x) => String(x.id)));
          list = [...local.filter((x) => !seen.has(String(x.id))), ...official];
        }
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
      {!items && !error && <p className="muted cache-empty">加载中…</p>}
      {items && items.length === 0 && <p className="muted cache-empty">还没有内容，去逛一逛吧</p>}
      {items && items.length > 0 && (
        <AlbumGrid items={items} onOpen={(album) => onOpenAlbum(album.id)} />
      )}
    </div>
  );
}
