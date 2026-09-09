import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeKey, getMemCache, setMemCache, invalidateCache } from "./requestCache";

describe("makeKey", () => {
  it("参数按 key 排序，顺序不同也命中同一条缓存", () => {
    expect(makeKey("/search", { b: 2, a: 1 })).toBe("/search?a=1&b=2");
    expect(makeKey("/search", { a: 1, b: 2 })).toBe("/search?a=1&b=2");
  });

  it("剥离时间戳/随机参数，否则每次请求 key 都变、缓存永不命中", () => {
    expect(makeKey("/setting", { t: 123, lang: "CN" })).toBe("/setting?lang=CN");
    expect(makeKey("/album", { id: 7, retry: 3, v: "x", _: 1, ts: 2, stamp: 3, time: 4 })).toBe("/album?id=7");
  });

  it("没有有效参数时只返回路径", () => {
    expect(makeKey("/latest", {})).toBe("/latest");
    expect(makeKey("/latest", { t: 1 })).toBe("/latest");
  });
});

describe("内存缓存 TTL", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("TTL 内命中，过期后返回 null 并删除条目", () => {
    setMemCache("t1", { a: 1 }, 1000);
    expect(getMemCache<{ a: number }>("t1")).toEqual({ a: 1 });
    vi.advanceTimersByTime(999);
    expect(getMemCache<{ a: number }>("t1")).toEqual({ a: 1 });
    vi.advanceTimersByTime(1);
    expect(getMemCache("t1")).toBeNull();
    expect(getMemCache("t1")).toBeNull();
  });

  it("未写入的 key 返回 null", () => {
    expect(getMemCache("t1-missing")).toBeNull();
  });

  it("invalidateCache 立即失效", () => {
    setMemCache("t1-inv", "v", 60_000);
    invalidateCache("t1-inv");
    expect(getMemCache("t1-inv")).toBeNull();
  });

  it("超过 50 条时淘汰最早写入的一条（独立模块实例）", async () => {
    vi.resetModules();
    const m = await import("./requestCache");
    for (let i = 0; i < 51; i++) m.setMemCache("cap" + i, i, 60_000);
    expect(m.getMemCache("cap0")).toBeNull();
    expect(m.getMemCache("cap1")).toBe(1);
    expect(m.getMemCache("cap50")).toBe(50);
  });
});
