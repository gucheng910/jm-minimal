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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(url, { cache: "no-store", mode: noCors ? "no-cors" : "cors", signal: ctrl.signal });
    clearTimeout(timer);
    const ms = Math.round(performance.now() - start);
    return { label, url, ms, ok: noCors ? true : resp.ok };
  } catch {
    const ms = Math.round(performance.now() - start);
    return { label, url, ms, ok: false };
  }
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
