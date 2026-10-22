import { HOST_KEY_SECRET, HOST_URLS, UI_KEYS } from "./constants";
import { aesEcbDecrypt, md5Hex } from "./crypto";
import { fetchWithTimeout } from "./fetchTimeout";
import type { HostConfig } from "./types";

const HOST_TTL_MS = 12 * 60 * 60 * 1000; // 线路表 12 小时本地缓存

function parseHostText(text: string): HostConfig {
  const keyHex = md5Hex(HOST_KEY_SECRET);
  const plain = aesEcbDecrypt(text.replace(/^\uFEFF/, "").trim(), keyHex);
  return JSON.parse(plain) as HostConfig;
}

function readHostCache(): { ts: number; cfg: HostConfig } | null {
  try {
    const raw = localStorage.getItem(UI_KEYS.hostConfigCache);
    if (!raw) return null;
    const obj = JSON.parse(raw) as { ts: number; cfg: HostConfig };
    if (!obj || !obj.cfg || !obj.cfg.jm3_Server) return null;
    return obj;
  } catch {
    return null;
  }
}

function writeHostCache(cfg: HostConfig) {
  try { localStorage.setItem(UI_KEYS.hostConfigCache, JSON.stringify({ ts: Date.now(), cfg })); } catch { /* ignore */ }
}

export async function loadHostConfig(): Promise<HostConfig> {
  const cached = readHostCache();
  // 新鲜缓存直接使用（冷启动无需等待 host 文件网络往返）
  if (cached && Date.now() - cached.ts < HOST_TTL_MS) return cached.cfg;
  const errors: string[] = [];
  for (const url of HOST_URLS) {
    try {
      const resp = await fetchWithTimeout(url, { cache: "no-store" }, 6000);
      if (!resp.ok) throw new Error("http " + resp.status);
      const cfg = parseHostText(await resp.text());
      writeHostCache(cfg);
      return cfg;
    } catch (err) {
      errors.push(String(err));
    }
  }
  // 全部网络失败时回退到本地缓存（即使过期也比不可用强）
  if (cached) return cached.cfg;
  throw new Error("无法取得线路表: " + errors.join(" | "));
}

export function chooseLine(host: HostConfig, excludeName = "線路5"): string {
  const lines = host.jm3_Server.filter(([, name]) => name !== excludeName);
  const pick = lines[Math.floor(Math.random() * lines.length)];
  return pick ? pick[0] : host.jm3_Server[0][0];
}

/**
 * 并行"探活"挑线路：**第一个应答的赢**。
 *
 * 为什么需要它（2026-10-22 实测，见 docs/26 §11）：
 * 官方线路表有 5 条（`chooseLine` 默认排除「線路5」），它们是各自独立的 Cloudflare 前置域名，
 * **可达性随网络/时间各不相同**。实测那一轮：4 条通、1 条（`www.cdngwc.net`）连 TCP 都建不起来。
 * 而 `chooseLine` 是**随机**取的 —— 于是约 1/4 的冷启动会挑到死线路，之后每个请求（含登录）
 * 都只能超时，用户看到的就是"网络连接失败，请配 DNS"。
 *
 * 判据只看"能不能拿到 HTTP 响应"：jm 各线路对 `GET /` 返回 403，**那也是活的证据**；
 * 只有网络层失败（DNS/连接/TLS/超时）才当死 —— 所以这里不能看 `resp.ok`。
 *
 * 不用 `Promise.all`：死线路会一直等到超时（4s），把首屏拖住。这里是**谁先应答谁赢**，
 * 正常网络下耗时 = 最快那条线路的一个往返（0.2~0.5s）。
 */
export async function pickLiveLine(candidates: string[], timeoutMs = 4000): Promise<string> {
  const list = [...new Set(candidates.filter(Boolean))];
  if (list.length === 0) return "";
  return new Promise<string>((resolve) => {
    let left = list.length;
    let settled = false;
    const win = (h: string) => {
      if (settled) return;
      settled = true;
      resolve(h);
    };
    for (const h of list) {
      fetchWithTimeout("https://" + h + "/", { method: "GET", cache: "no-store", credentials: "omit" }, timeoutMs)
        .then(() => win(h)) // 拿到响应（哪怕 403）就是活的
        .catch(() => {
          left -= 1;
          // 全部不通：返回空串，交回调用方（它会退回原来的随机选择，行为与改造前一致）
          if (left === 0) win("");
        });
    }
  });
}
