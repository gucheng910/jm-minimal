// @vitest-environment jsdom
/**
 * 列表触底续页 hook。
 *
 * 这段逻辑原来是首页/分类页/搜索页各写一份**逐字相同**的实现，
 * 所以这里测的重点是那三份拷贝里容易只改一处的几件事：
 *   · hasMore=false 或 busy=true 时**不许挂观察器**（否则会在加载中重复触发续页，把同一页请求打多份）；
 *   · 回调走 ref —— 调用方每次渲染都传新闭包，不能因为闭包变了就重建观察器（否则滚动中反复 disconnect/observe）；
 *   · 依赖里带 count —— 列表被整批替换后要重新 observe，否则"翻页到某一页就不动了"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useInfiniteScroll } from "./useInfiniteScroll";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 记录所有被创建的观察器实例，便于断言 observe/disconnect 次数 */
interface FakeIO {
  cb: (entries: Array<{ isIntersecting: boolean }>) => void;
  margin: string | undefined;
  targets: Element[];
  observed: number;
  disconnected: number;
}
let instances: FakeIO[] = [];

class FakeIntersectionObserver {
  root = null; rootMargin = ""; thresholds: number[] = [];
  private rec: FakeIO;
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void, opts?: { rootMargin?: string }) {
    this.rec = { cb, margin: opts?.rootMargin, targets: [], observed: 0, disconnected: 0 };
    instances.push(this.rec);
  }
  observe(el: Element) { this.rec.targets.push(el); this.rec.observed += 1; }
  unobserve() { /* noop */ }
  disconnect() { this.rec.disconnected += 1; }
  takeRecords() { return []; }
}

beforeEach(() => { instances = []; (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver; });
afterEach(() => { document.body.innerHTML = ""; });

/** 把 hook 挂到一个真实元素上，返回触发交叉与重渲的手段 */
function mount(initial: { hasMore: boolean; busy: boolean; count: number; onLoadMore: () => void }) {
  let props = initial;
  const calls: Array<() => void> = [];
  function Probe() {
    const ref = useInfiniteScroll({
      hasMore: props.hasMore,
      busy: props.busy,
      count: props.count,
      onLoadMore: () => props.onLoadMore()
    });
    return createElement("div", { ref, className: "sentinel" });
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  calls.push(() => { act(() => { root.render(createElement(Probe)); }); });
  calls[0]();
  return {
    rerender(next: Partial<typeof initial>) {
      props = { ...props, ...next };
      act(() => { root.render(createElement(Probe)); });
    },
    get last() { return instances[instances.length - 1]; },
    get count() { return instances.length; },
    unmount() { act(() => { root.unmount(); }); host.remove(); }
  };
}

describe("useInfiniteScroll", () => {
  it("hasMore && !busy 时挂观察器，并把哨兵交给它", () => {
    const m = mount({ hasMore: true, busy: false, count: 6, onLoadMore: () => { /* noop */ } });
    expect(instances).toHaveLength(1);
    expect(instances[0].observed).toBe(1);
    expect(instances[0].targets[0].className).toBe("sentinel");
    m.unmount();
  });

  it("【关键】hasMore=false 时不挂（没有下一页就不该观察）", () => {
    mount({ hasMore: false, busy: false, count: 6, onLoadMore: () => { /* noop */ } });
    expect(instances).toHaveLength(0);
  });

  it("【关键】busy=true 时不挂（否则加载中会被反复触发，同一页打多份请求）", () => {
    mount({ hasMore: true, busy: true, count: 6, onLoadMore: () => { /* noop */ } });
    expect(instances).toHaveLength(0);
  });

  it("进入预读区就调用 onLoadMore", () => {
    const fn = vi.fn();
    mount({ hasMore: true, busy: false, count: 6, onLoadMore: fn });
    act(() => { instances[0].cb([{ isIntersecting: true }]); });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("未交叉时不调用", () => {
    const fn = vi.fn();
    mount({ hasMore: true, busy: false, count: 6, onLoadMore: fn });
    act(() => { instances[0].cb([{ isIntersecting: false }]); });
    expect(fn).not.toHaveBeenCalled();
  });

  it("从 busy 恢复会重新挂上（加载完成后要能继续续页）", () => {
    const m = mount({ hasMore: true, busy: true, count: 6, onLoadMore: () => { /* noop */ } });
    expect(instances).toHaveLength(0);
    m.rerender({ busy: false });
    expect(instances).toHaveLength(1);
    m.unmount();
  });

  it("count 变化会重挂（列表被整批替换后要重新 observe）", () => {
    const m = mount({ hasMore: true, busy: false, count: 6, onLoadMore: () => { /* noop */ } });
    expect(instances).toHaveLength(1);
    m.rerender({ count: 86 });
    expect(instances).toHaveLength(2);       // 重新构建了一个
    expect(instances[0].disconnected).toBe(1); // 旧的被断开
    m.unmount();
  });

  it("【关键】回调换新闭包但条件不变 → 不重建观察器（滚动中反复重建会漏掉交叉）", () => {
    let n = 0;
    const m = mount({ hasMore: true, busy: false, count: 6, onLoadMore: () => { n += 1; } });
    expect(instances).toHaveLength(1);
    // 换一个全新的 onLoadMore 闭包（每次渲染都会发生），但 hasMore/busy/count 都没变
    m.rerender({ onLoadMore: () => { n += 100; } });
    expect(instances).toHaveLength(1);       // 没有重建
    act(() => { instances[0].cb([{ isIntersecting: true }]); });
    expect(n).toBe(100);                     // 而且用的是**最新**那个回调
    m.unmount();
  });

  it("默认预读距离是 420px（与原来三处写死的值一致）", () => {
    mount({ hasMore: true, busy: false, count: 6, onLoadMore: () => { /* noop */ } });
    expect(instances[0].margin).toBe("420px 0px");
  });

  it("卸载时断开观察器", () => {
    const m = mount({ hasMore: true, busy: false, count: 6, onLoadMore: () => { /* noop */ } });
    m.unmount();
    expect(instances[0].disconnected).toBe(1);
  });
});
