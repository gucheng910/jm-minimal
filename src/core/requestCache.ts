// 只读接口的轻量内存缓存（不落盘）：categories/week/hotTags 这类参数稳定、变化慢的数据
const MEM_CACHE_LIMIT = 50;
const memCache = new Map<string, { ts: number; ttl: number; data: unknown }>();

// 缓存 key 中剥离的时间戳/随机参数（否则 key 每次变化、缓存永不命中）
const STRIP_PARAMS = new Set(["t", "ts", "_", "stamp", "time", "retry", "v"]);

export function makeKey(path: string, params: Record<string, unknown>): string {
  const sorted = Object.keys(params)
    .filter((k) => !STRIP_PARAMS.has(k))
    .sort()
    .map((k) => k + "=" + String(params[k]))
    .join("&");
  return path + (sorted ? "?" + sorted : "");
}

export function getMemCache<T>(key: string): T | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts >= entry.ttl) {
    memCache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setMemCache<T>(key: string, data: T, ttlMs: number): void {
  if (memCache.has(key)) memCache.delete(key);
  else if (memCache.size >= MEM_CACHE_LIMIT) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
  memCache.set(key, { ts: Date.now(), ttl: ttlMs, data });
}

export function invalidateCache(key: string): void {
  memCache.delete(key);
}
