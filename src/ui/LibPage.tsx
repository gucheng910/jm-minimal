import { useEffect, useRef, useState } from "react";
import { useBackHandler } from "../hooks/useBackHandler";
import { client } from "../core/api";
import { loadHistory, type HistoryEntry } from "../core/history";
import { AlbumGrid } from "./AlbumGrid";
import { SkeletonGrid } from "./SkeletonGrid";
import type { AlbumSummary } from "../core/types";
import { CloseIcon } from "./icons";

/**
 * 足迹条目 → 列表卡片。
 * 合并后一条 = 一本书：卡片用「书 id」取封面（封面是书级的），
 * 点击则打开最后阅读的那一话（映射见 openTarget）。
 */
function historyToCards(list: HistoryEntry[]): AlbumSummary[] {
  return list.map((h) => ({
    id: h.bookId,
    name: h.name || String(h.id),
    author: h.author,
    adddate: h.adddate,
    description: h.description,
    sub: h.chapterName ? "读到 " + h.chapterName : undefined
  }));
}

export default function LibPage({
  kind,
  onOpenAlbum,
  onClose,
  entering,
  closing
}: {
  kind: "favorite" | "history";
  onOpenAlbum: (aid: number | string) => void;
  onClose: () => void;
  /** 出场过渡中的状态（由 App 的 useSheetTransition 给） */
  entering?: boolean;
  closing?: boolean;
}) {
  const [items, setItems] = useState<AlbumSummary[] | null>(null);
  const [error, setError] = useState("");
  /** 书 id → 最后阅读的话 id（足迹点击进详情用） */
  const openTarget = useRef<Record<string, string>>({});
  const title = kind === "favorite" ? "我的收藏" : "我的足迹";

  useBackHandler(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    // 先清空：否则切到「收藏」时上一次的列表还留在屏上，请求失败就成了"内容在、却报网络错误"
    setItems(null);
    setError("");
    (async () => {
      try {
        if (kind === "history") {
          // 足迹仅使用本地存储，无需登录；连载多话已在 history.ts 合并为一本
          const list = loadHistory();
          openTarget.current = Object.fromEntries(list.map((h) => [h.bookId, h.id]));
          if (alive) setItems(historyToCards(list));
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
    <div className="cache-overlay" data-entering={entering ? "" : undefined} data-closed={closing ? "" : undefined}>
      <div className="cache-header">
        <h2>{title}</h2>
        <button className="ghost" aria-label="关闭" onClick={onClose}><CloseIcon size={18} /></button>
      </div>
      {error && <div className="card err">{error}</div>}
      {!items && !error && <SkeletonGrid />}
      {items && items.length === 0 && <p className="muted cache-empty">还没有内容，去逛一逛吧</p>}
      {items && items.length > 0 && (
        <AlbumGrid items={items} onOpen={(album) => onOpenAlbum(openTarget.current[String(album.id)] || album.id)} />
      )}
    </div>
  );
}
