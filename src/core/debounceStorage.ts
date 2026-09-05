// localStorage 防抖写入：合并短时间内的重复写，主线程不阻塞；读取合并 pending 数据保证读写一致
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingData = new Map<string, string>();

export function debouncedSetItem(key: string, value: string, delayMs = 500): void {
  pendingData.set(key, value);
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    const v = pendingData.get(key);
    if (v !== undefined) {
      try { localStorage.setItem(key, v); } catch { /* ignore */ }
      pendingData.delete(key);
    }
    debounceTimers.delete(key);
  }, delayMs);
  debounceTimers.set(key, timer);
}

export function debouncedSetJSON(key: string, value: unknown, delayMs = 500): void {
  try { debouncedSetItem(key, JSON.stringify(value), delayMs); } catch { /* ignore */ }
}

/** 读取：优先返回尚未落盘的 pending 值（保证写后立即读一致性） */
export function getJSONNow<T>(key: string, fallback: T): T {
  try {
    const pending = pendingData.get(key);
    if (pending !== undefined) return JSON.parse(pending) as T;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

/** 立即删除（取消待写入） */
export function removeKeyNow(key: string): void {
  const t = debounceTimers.get(key);
  if (t) { clearTimeout(t); debounceTimers.delete(key); }
  pendingData.delete(key);
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function flushPendingWrites(): void {
  for (const [key, value] of pendingData) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }
  pendingData.clear();
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
}
