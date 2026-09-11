import { fetchWithTimeout } from "./fetchTimeout";

export interface SpeedSample {
  label: string;
  url: string;
  ms: number;
  ok: boolean;
}

export interface SpeedItem {
  label: string;
  url: string;
  noCors?: boolean;
}

export async function measureUrl(label: string, url: string, timeoutMs = 6000, noCors = false): Promise<SpeedSample> {
  const start = performance.now();
  try {
    const resp = await fetchWithTimeout(url, { cache: "no-store", mode: noCors ? "no-cors" : "cors" }, timeoutMs);
    const ms = Math.round(performance.now() - start);
    return { label, url, ms, ok: noCors ? true : resp.ok };
  } catch {
    const ms = Math.round(performance.now() - start);
    return { label, url, ms, ok: false };
  }
}


/**
 * 用 <img> 真实加载一张图来测速。
 * 为什么不复用 measureUrl(noCors: true)：no-cors 的响应是 opaque，**HTTP 403/404 也算 resolve**，
 * 于是"能连上但根本不给图"的图床会被误判为可用（2026-09-11 小米 4W 上封面全白就是这个原因：
 * 自动选优选中的图床对 logo 返回 403 被当成 ok，换到真实封面就全挂）。
 * <img> 的 onerror 在 HTTP 错误码时也会触发，能真正区分"能不能拿到图"。
 */
export function measureImage(label: string, url: string, timeoutMs = 6000): Promise<SpeedSample> {
  const start = performance.now();
  return new Promise<SpeedSample>((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve({ label, url, ms: Math.round(performance.now() - start), ok });
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

/** 同 measureAll，但用 <img> 真实解码（用于图床测速） */
export async function measureImages(items: SpeedItem[], timeoutMs = 6000): Promise<SpeedSample[]> {
  const out = await Promise.all(items.map((x) => measureImage(x.label, x.url, timeoutMs)));
  return out.sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : a.ok ? -1 : 1));
}
export async function measureAll(items: SpeedItem[], concurrency = 4): Promise<SpeedSample[]> {
  const out: SpeedSample[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const samples = await Promise.all(batch.map((x) => measureUrl(x.label, x.url, 6000, x.noCors)));
    out.push(...samples);
  }
  return out.sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : a.ok ? -1 : 1));
}
