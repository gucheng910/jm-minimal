// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { debouncedSetItem, debouncedSetJSON, getJSONNow, removeKeyNow, flushPendingWrites } from "./debounceStorage";

describe("debounceStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => {
    flushPendingWrites();
    vi.useRealTimers();
  });

  it("同一 key 的连续写入被合并，只落盘一次且写的是最后一次", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem");
    debouncedSetItem("k", "1", 500);
    debouncedSetItem("k", "2", 500);
    debouncedSetItem("k", "3", 500);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("k")).toBe("3");
  });

  it("落盘前读取返回 pending 值（写后立即读一致）", () => {
    debouncedSetJSON("j", { a: 1 }, 500);
    expect(localStorage.getItem("j")).toBeNull();
    expect(getJSONNow<{ a: number } | null>("j", null)).toEqual({ a: 1 });
    vi.advanceTimersByTime(500);
    expect(localStorage.getItem("j")).toBe('{"a":1}');
  });

  it("无值或 JSON 损坏时返回 fallback", () => {
    expect(getJSONNow<string[]>("missing", ["fb"])).toEqual(["fb"]);
    localStorage.setItem("bad", "{not json");
    expect(getJSONNow("bad", "fb")).toBe("fb");
  });

  it("removeKeyNow 取消待写入并删除已落盘值", () => {
    localStorage.setItem("r", "old");
    debouncedSetItem("r", "new", 500);
    removeKeyNow("r");
    vi.advanceTimersByTime(1000);
    expect(localStorage.getItem("r")).toBeNull();
    expect(getJSONNow("r", null)).toBeNull();
  });

  it("flushPendingWrites 立即落盘并清空队列（后续定时器不再写）", () => {
    debouncedSetItem("a", "1", 5000);
    debouncedSetItem("b", "2", 5000);
    flushPendingWrites();
    expect(localStorage.getItem("a")).toBe("1");
    expect(localStorage.getItem("b")).toBe("2");
    localStorage.removeItem("a");
    vi.advanceTimersByTime(10_000);
    expect(localStorage.getItem("a")).toBeNull();
  });
});
