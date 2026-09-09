// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type VT = { ready: Promise<void>; finished: Promise<void>; skipTransition(): void };

function installVT(finished?: Promise<void>) {
  const calls: Array<() => void> = [];
  const start = vi.fn((cb: () => void) => {
    calls.push(cb);
    return {
      ready: Promise.resolve(),
      finished: finished || Promise.resolve(),
      skipTransition: () => {}
    } as VT;
  });
  Object.defineProperty(document, "startViewTransition", { value: start, configurable: true, writable: true });
  return { start, calls };
}

let navTransition: typeof import("./viewTransition").navTransition;

describe("navTransition（页面推拉转场）", () => {
  beforeEach(async () => {
    vi.resetModules(); // 每个用例拿一份干净的模块状态（running 锁）
    ({ navTransition } = await import("./viewTransition"));
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    delete document.documentElement.dataset.nav;
    delete (window as unknown as { __jmVT?: unknown }).__jmVT;
  });
  afterEach(() => {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    vi.useRealTimers();
  });

  it("浏览器不支持 View Transitions 时：直接执行更新，不写方向标记", () => {
    const update = vi.fn();
    navTransition("push", update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.nav).toBeUndefined();
  });

  it("系统开启「减少动态效果」时：直接执行更新，不启动转场", () => {
    const { start } = installVT();
    // jsdom 环境里 window.matchMedia 可能不存在，直接定义（被测代码对缺失有 typeof 兜底）
    Object.defineProperty(window, "matchMedia", {
      value: (q: string) => ({ matches: true, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
      configurable: true,
      writable: true
    });
    const update = vi.fn();
    navTransition("push", update);
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("支持时：更新只在转场回调里执行，并写入方向标记与计数", () => {
    const { start, calls } = installVT();
    const update = vi.fn();
    navTransition("push", update);
    expect(start).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.nav).toBe("push");
    calls[0]();
    expect(update).toHaveBeenCalledTimes(1);
    expect((window as unknown as { __jmVT?: { count: number; last: string } }).__jmVT).toMatchObject({ count: 1, last: "push" });
  });

  it("转场结束后解锁，下一次导航仍能走转场", async () => {
    const { start, calls } = installVT();
    navTransition("push", vi.fn());
    calls[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.documentElement.dataset.nav).toBeUndefined();
    navTransition("pop", vi.fn());
    expect(start).toHaveBeenCalledTimes(2);
    expect(document.documentElement.dataset.nav).toBe("pop");
  });

  it("上一个转场还没结束时的连续导航：降级为直接更新（不叠加转场）", () => {
    const { start } = installVT(new Promise<void>(() => { /* 永不落定 */ }));
    navTransition("push", vi.fn());
    const second = vi.fn();
    navTransition("pop", second);
    expect(start).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("返回的 Promise 在「更新已落地」后才 resolve（调用方据此排序异步工作）", async () => {
    const { calls } = installVT();
    const order: string[] = [];
    const p = navTransition("push", () => order.push("update")).then(() => order.push("after"));
    order.push("sync-after-call");
    expect(order).toEqual(["sync-after-call"]); // 走转场时更新是异步的，必须 await
    calls[0]();
    await p;
    expect(order).toEqual(["sync-after-call", "update", "after"]);
  });

  it("不支持转场时：更新同步执行，Promise 立即 resolve", async () => {
    const order: string[] = [];
    await navTransition("push", () => order.push("update")).then(() => order.push("after"));
    expect(order).toEqual(["update", "after"]);
  });

  it("finished 一直不落定时，1.2s 兜底解锁（避免后续导航全部失去动画）", async () => {
    vi.useFakeTimers();
    const { start } = installVT(new Promise<void>(() => { /* 永不落定 */ }));
    navTransition("push", vi.fn());
    expect(document.documentElement.dataset.nav).toBe("push");
    vi.advanceTimersByTime(1200);
    expect(document.documentElement.dataset.nav).toBeUndefined();
    navTransition("pop", vi.fn());
    expect(start).toHaveBeenCalledTimes(2);
  });
});
