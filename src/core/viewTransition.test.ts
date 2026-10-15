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

/**
 * 更新回调的看门狗 —— 守一个**实测到**的静默卡死（报告 §14.5）。
 *
 * 现场证据：给 `document.startViewTransition` 装 CDP 探针后只看到
 * `vtCalls: ["SVT-called"]`，**没有 `cb-enter`**，也没有抛错 ——
 * 浏览器注册了回调却从不进入（headless/不出帧时会出现）。
 * 于是 `update()` 永不执行、`applied` 永不落定，
 * 用户看到的是「点卡片什么都不发生、也不发请求、控制台还是干净的」。
 *
 * 下面这组的桩就是"注册了但永不调用"。
 */
describe("navTransition：更新回调不进入时不许静默卡死", () => {
  /** 与主 describe 同款：每个用例拿一份干净的模块状态（running 是模块级变量） */
  beforeEach(async () => {
    vi.resetModules();
    ({ navTransition } = await import("./viewTransition"));
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    delete document.documentElement.dataset.nav;
    delete (window as unknown as { __jmVT?: unknown }).__jmVT;
    vi.useFakeTimers();
  });
  afterEach(() => {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
    vi.useRealTimers();
  });

  it("回执从未进入：update 仍会被执行，Promise 也会落定", async () => {
    installVT();
    const update = vi.fn();
    let settled = false;
    const p = navTransition("push", update).then(() => { settled = true; });

    // 注册了，但没人调用它 —— 此刻还没执行
    expect(update).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.nav).toBe("push");

    await vi.advanceTimersByTimeAsync(600);
    expect(update).toHaveBeenCalledTimes(1);
    await p;
    expect(settled).toBe(true);
  });

  it("【关键】回调先到就不会被看门狗补第二次", async () => {
    const { calls } = installVT();
    const update = vi.fn();
    const p = navTransition("push", update);
    calls[0]();                                   // 正常路径：回调按时进
    await vi.advanceTimersByTimeAsync(2000);      // 推过 600ms 也推过 1200ms
    await p;
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("迟到但没超过看门狗的回调：仍由回调那次执行，看门狗不补刀", async () => {
    const { calls } = installVT();
    const update = vi.fn();
    const p = navTransition("push", update);
    await vi.advanceTimersByTimeAsync(300);       // 还没到 600ms
    calls[0]();
    expect(update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(update).toHaveBeenCalledTimes(1);      // 到点后也不重复
    await p;
  });

  it("卡死只影响这一次：下一次导航照常走转场（不会被 running 永久挡住）", async () => {
    const first = installVT();
    const a = vi.fn();
    const p1 = navTransition("push", a);
    await vi.advanceTimersByTimeAsync(600);
    await p1;
    expect(a).toHaveBeenCalledTimes(1);

    // 推过 1200ms 的 running 解锁，换一个"回调立刻进"的桩
    await vi.advanceTimersByTimeAsync(1500);
    const { start, calls } = installVT();
    const b = vi.fn();
    const p2 = navTransition("pop", b);
    expect(start).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();             // 又走了正常的"回调里执行"
    calls[0]();
    expect(b).toHaveBeenCalledTimes(1);
    await p2;
    void first;
  });

  it("看门狗的等待期里 data-nav 一直挂着（调用方仍能看出'正在转场'）", async () => {
    // finished 用"永不落定"，这样解锁只能靠 1200ms 兜底，才能看清 data-nav 的生命周期
    installVT(new Promise<void>(() => { /* 永不落定 */ }));
    const p = navTransition("push", vi.fn());
    expect(document.documentElement.dataset.nav).toBe("push");
    await vi.advanceTimersByTimeAsync(599);
    expect(document.documentElement.dataset.nav).toBe("push");
    await vi.advanceTimersByTimeAsync(1);        // 600ms：看门狗到了
    expect(document.documentElement.dataset.nav).toBe("push"); // 还要等 1200ms 的兜底才清
    await vi.advanceTimersByTimeAsync(700);      // 累计 1300ms > 1200ms
    await p;
    expect(document.documentElement.dataset.nav).toBeUndefined();
  });

  it("降级路径（不支持 VT）不受影响：同步执行、不排队看门狗", () => {
    const update = vi.fn();
    navTransition("push", update);
    expect(update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
