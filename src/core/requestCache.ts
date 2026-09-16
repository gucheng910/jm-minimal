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

/**
 * 按路径前缀失效（如传 "album" 可清掉 "album?id=123"）。
 *
 * 用途：**写操作之后必须让相关只读缓存失效**，否则紧接着的重新拉取会命中旧值。
 * 实例（真机反馈的"购买成功但按钮不变"）：
 *   /album 有 30s 内存缓存，POST /coin_buy_comics 成功后立刻 getAlbumFull() 重拉，
 *   命中购买**之前**的快照（purchased 仍是未购形态）→ UI 永远切不到已解锁态，
 *   且重进详情只要还在 30s 内也一样 —— 看起来像"购买没生效"，其实数据根本没重新取。
 * 前缀匹配用 path 起点 + "?" 或全等，避免 "album" 误伤 "albumDownload" 这类同前缀路径。
 */
export function invalidatePath(prefix: string): number {
  let n = 0;
  for (const key of memCache.keys()) {
    if (key === prefix || key.startsWith(prefix + "?")) {
      memCache.delete(key);
      n += 1;
    }
  }
  return n;
}

/** 仅测试用：清空全部内存缓存 */
export function clearMemCache(): void {
  memCache.clear();
}
