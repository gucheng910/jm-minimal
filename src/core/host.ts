import { HOST_KEY_SECRET, HOST_URLS, UI_KEYS } from "./constants";
import { aesEcbDecrypt, md5Hex } from "./crypto";
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      clearTimeout(timer);
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
