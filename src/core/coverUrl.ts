/**
 * 封面 URL 的唯一构造处（纯函数，不碰 DOM/React）。
 *
 * 从 `ui/AlbumCard.tsx` 挪到 core：现在有两个调用方 —— 卡片渲染（ui）与**18+ 门的预取**
 * （core/prewarm）。放在 ui 里会让 core 反过来 import ui（分层倒挂），也会让预取和渲染
 * 各写一份拼装规则、迟早走偏。`ui/AlbumCard` 仍然 re-export 它，历史导入路径不受影响。
 */
import { client } from "./api";
import type { AlbumSummary } from "./types";

/** 专辑封面地址：优先用接口给的直链，否则按 `img_host + /media/albums/<id>_3x4.jpg` 拼（带 t 签权） */
export function albumCoverUrl(a: AlbumSummary): string {
  const direct = a.image || "";
  if (direct.startsWith("http")) return direct;
  const rawHost = client.setting?.img_host as string | undefined;
  // 兜底：个别环境下 img_host 只有裸域名（没有 scheme），直接拼出来的地址会被当成相对路径 → 404。
  // 只对"看起来就是裸域名"的形态补 https://，路径形态（以 / 开头）不动。
  const host = rawHost && !/^https?:\/\//i.test(rawHost) && /^[a-z0-9.-]+(:\d+)?$/i.test(rawHost)
    ? "https://" + rawHost
    : rawHost;
  if (host && a.id) {
    // 官方封面/正文镜像需要 t 签权参数（= update_at），缺少时新专辑封面会 502/不稳定
    const upd = String(a.update_at || a.adddate || "");
    return host + "/media/albums/" + String(a.id) + "_3x4.jpg?v=" + upd + (upd ? "&t=" + upd : "");
  }
  return direct;
}
