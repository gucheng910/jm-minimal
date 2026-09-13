import { useCallback, useEffect, useRef, useState } from "react";
import { useBackHandler } from "../hooks/useBackHandler";
import { client } from "../core/api";
import { loadHistory, removeHistory, type HistoryEntry } from "../core/history";
import { AlbumGrid } from "./AlbumGrid";
import { SkeletonGrid } from "./SkeletonGrid";
import { pushToast } from "./toast";
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
  closing,
  hidden
}: {
  kind: "favorite" | "history";
  onOpenAlbum: (aid: number | string) => void;
  onClose: () => void;
  /** 出场过渡中的状态（由 App 的 useSheetTransition 给） */
  entering?: boolean;
  closing?: boolean;
  /**
   * 被详情页盖住时置 true：**保持挂载**（列表内容与滚动位置都不丢），只是不可见、不接收事件。
   * 从足迹/收藏点开漫画后由 App 设置，详情返回时再揭开 —— 这样返回落回原来的列表，
   * 而不是落回首页。
   */
  hidden?: boolean;
}) {
  const [items, setItems] = useState<AlbumSummary[] | null>(null);
  const [error, setError] = useState("");
  /** 管理态：卡片上出现删除角标 */
  const [manage, setManage] = useState(false);
  /** 书 id → 最后阅读的话 id（足迹点击进详情用） */
  const openTarget = useRef<Record<string, string>>({});
  const title = kind === "favorite" ? "我的收藏" : "我的足迹";

  useBackHandler(() => {
    // 被详情页盖住时不能消费返回键：jm:back 是同步按注册顺序派发的，
    // 这里若先消费，详情页自己的返回就永远不会触发
    // （ContentView 换 tab 时会重挂载，注册顺序可能排到本浮层之后）。
    if (hidden) return false;
    onClose();
  }, [onClose, hidden]);

  useEffect(() => {
    let alive = true;
    // 先清空：否则切到「收藏」时上一次的列表还留在屏上，请求失败就成了"内容在、却报网络错误"
    setItems(null);
    setError("");
    setManage(false);
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

  /**
   * 管理态删除。
   * 足迹：删本地条目（removeHistory 延迟 0，立即落盘）。
   * 收藏：走官方取消收藏接口 —— 同一个 POST，服务端自己判断是加还是删（见 core/api.toggleFavorite）。
   * 删完立刻从列表移除，不等重新拉取（否则要等一次网络往返才看到变化）。
   */
  const handleRemove = useCallback(async (a: AlbumSummary) => {
    const id = String(a.id);
    if (kind === "history") {
      removeHistory(id);
      delete openTarget.current[id];
      setItems((list) => (list ? list.filter((x) => String(x.id) !== id) : list));
      return;
    }
    try {
      await client.toggleFavorite(a.id);
      setItems((list) => (list ? list.filter((x) => String(x.id) !== id) : list));
    } catch (err) {
      pushToast("取消收藏失败：" + String(err).slice(0, 60), "err");
    }
  }, [kind]);

  return (
    <div
      className="cache-overlay"
      data-entering={entering ? "" : undefined}
      data-closed={closing ? "" : undefined}
      data-hidden={hidden ? "" : undefined}
    >
      <div className="cache-header">
        <h2>{title}</h2>
        <div className="lib-actions">
          {items && items.length > 0 && (
            <button className="ghost lib-manage" onClick={() => setManage((m) => !m)} aria-pressed={manage}>
              {manage ? "完成" : "管理"}
            </button>
          )}
          <button className="ghost" aria-label="关闭" onClick={onClose}><CloseIcon size={18} /></button>
        </div>
      </div>
      {error && <div className="card err">{error}</div>}
      {!items && !error && <SkeletonGrid />}
      {items && items.length === 0 && <p className="muted cache-empty">还没有内容，去逛一逛吧</p>}
      {items && items.length > 0 && (
        <AlbumGrid
          items={items}
          onRemove={manage ? handleRemove : undefined}
          onOpen={(album) => onOpenAlbum(openTarget.current[String(album.id)] || album.id)}
        />
      )}
    </div>
  );
}
