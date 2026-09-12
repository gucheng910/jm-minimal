import { fetchWithTimeout } from "./fetchTimeout";

export interface SpeedSample {
  label: string;
  url: string;
  ms: number;
  ok: boolean;
  /** 调用方自定义标记（图源测速里放源 key），用于把样本精确映射回业务对象 */
  tag?: string;
}

export interface SpeedItem {
  label: string;
  url: string;
  noCors?: boolean;
  tag?: string;
}

export async function measureUrl(label: string, url: string, timeoutMs = 6000, noCors = false, tag?: string): Promise<SpeedSample> {
  const start = performance.now();
  try {
    const resp = await fetchWithTimeout(url, { cache: "no-store", mode: noCors ? "no-cors" : "cors" }, timeoutMs);
    const ms = Math.round(performance.now() - start);
    return { label, url, ms, ok: noCors ? true : resp.ok, tag };
  } catch {
    const ms = Math.round(performance.now() - start);
    return { label, url, ms, ok: false, tag };
  }
}


/**
 * 用 <img> 真实加载一张图来测速。
 * 为什么不复用 measureUrl(noCors: true)：no-cors 的响应是 opaque，**HTTP 403/404 也算 resolve**，
 * 于是"能连上但根本不给图"的图床会被误判为可用（2026-09-11 小米 4W 上封面全白就是这个原因：
 * 自动选优选中的图床对 logo 返回 403 被当成 ok，换到真实封面就全挂）。
 * <img> 的 onerror 在 HTTP 错误码时也会触发，能真正区分"能不能拿到图"。
 */
export function measureImage(label: string, url: string, timeoutMs = 6000, tag?: string): Promise<SpeedSample> {
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
      resolve({ label, url, ms: Math.round(performance.now() - start), ok, tag });
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

/** 同 measureAll，但用 <img> 真实解码（用于图床测速） */
export async function measureImages(items: SpeedItem[], timeoutMs = 6000): Promise<SpeedSample[]> {
  const out = await Promise.all(items.map((x) => measureImage(x.label, x.url, timeoutMs, x.tag)));
  return out.sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : a.ok ? -1 : 1));
}
export async function measureAll(items: SpeedItem[], concurrency = 4): Promise<SpeedSample[]> {
  const out: SpeedSample[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const samples = await Promise.all(batch.map((x) => measureUrl(x.label, x.url, 6000, x.noCors, x.tag)));
    out.push(...samples);
  }
  return out.sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : a.ok ? -1 : 1));
}

/**
 * 挑"该切到哪个源"：**只按能不能真出图 + 快不快**，但官方图源优先于 express（tag = "0"）。
 *
 * 两条踩过的坑，都写进这个函数里，避免调用方各写一遍再走回去：
 *  1) 不能信数组顺序找"第一个 ok"：measureAll/measureImages 虽然排过序，但那是实现细节，
 *     一旦有人改了排序或传进来没排序的样本，就会静默切到错的源。
 *  2) 不能只挑最快：express（快速通道）对封面/logo 常返 200，正文 photos 却被 CDN 重置
 *     （2026-09-11 小米 4W 实测），按最快挑必然选它 → 封面正常、整本正文全黑。
 *     所以有任何一个官方源可用时就不用 express，express 只在官方源全挂时兜底。
 *
 * 另外：调用方不要把结果再按 host 反查回 key（host 可能带尾斜杠/彼此重复/互为子串），
 * 直接把 key 放进 SpeedItem.tag，这里返回的样本自带 tag。
 */
export function pickFastestSource(samples: SpeedSample[], expressTag = "0"): SpeedSample | null {
  const ok = samples.filter((s) => s.ok);
  if (ok.length === 0) return null;
  const official = ok.filter((s) => String(s.tag ?? "") !== String(expressTag));
  const pool = official.length > 0 ? official : ok;
  return pool.reduce((best, s) => (s.ms < best.ms ? s : best), pool[0]);
}
