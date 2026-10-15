// @vitest-environment jsdom
/**
 * 画廊缩略图（ui/PageThumb）—— 只测三条**契约**，不测观感：
 *   1. **懒挂载**：有 `IntersectionObserver` 时，进入视口前只给骨架、不进视口不渲染真实页面；
 *   2. **兜底**：没有 `IntersectionObserver`（老内核极端情况）时直接挂载 ——
 *      宁可多渲染，也不要留一张空卡片；
 *   3. **缩放比**：`k = 卡片内宽 / 390`（390 = 手机设计宽）。这条是"所见即所得"的前提：
 *      算错了缩略图就会被裁掉一半或只占卡片一角。
 *   另加一条防御：**量不到宽度时不许渲染真实页面** —— 否则会以 390px 原尺寸闪一下。
 *
 * 真实渲染出来的页面长什么样、有没有 fixed 浮层漏出来，属于**真实浏览器**里的视觉契约，
 * 交给 e2e（tools/e2e/editor-gallery.mjs）验。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import PageThumb from "./PageThumb";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ unmount: () => void }> = [];
const hosts: HTMLElement[] = [];

/** jsdom 里没有排版：`offsetWidth` 恒为 0 —— 组件靠它算缩放比，所以必须自己给一个"布局宽度"。
 *  ⚠️ 组件**刻意**不用 `getBoundingClientRect()`（v3.5）：卡片现在处在一叠卡的 `transform` 之下，
 *     那个 API 返回的是**视觉缩放后**的宽度（拉开态 ≈ 卡宽的一半），会把缩略图算成双重缩放。
 *     这里因此与实现同源地 stub `offsetWidth`，测的才是真实契约。 */
let rectW = 195;
const origOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

beforeEach(() => {
  rectW = 195;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() { return rectW; }
  });
});

afterEach(() => {
  for (const r of roots.splice(0)) act(() => { r.unmount(); });
  for (const h of hosts.splice(0)) h.remove();
  if (origOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", origOffsetWidth);
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
});

function render(node: ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  act(() => { root.render(node); });
  roots.push(root);
  return host;
}

/** 装一个假 IntersectionObserver：记下回调，由用例决定何时"进入视口" */
function stubIO() {
  let cb: IntersectionObserverCallback | null = null;
  let observed = 0;
  class FakeIO {
    root = null;
    rootMargin = "";
    thresholds: number[] = [];
    constructor(c: IntersectionObserverCallback) { cb = c; }
    observe() { observed++; }
    unobserve() { /* noop */ }
    disconnect() { /* noop */ }
    takeRecords(): IntersectionObserverEntry[] { return []; }
  }
  (globalThis as Record<string, unknown>).IntersectionObserver = FakeIO;
  return {
    observed: () => observed,
    enter: (isIntersecting: boolean) => {
      act(() => { cb?.([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver); });
    }
  };
}

/** 缩略图内容用一个标记节点代替真实页面：本文件测的是"何时渲染"，不是渲染了什么 */
function thumb() {
  return createElement(PageThumb, { render: () => createElement("b", null, "PAGE") });
}

describe("PageThumb（画廊缩略图）", () => {
  it("有 IntersectionObserver 时：进入视口前只显示骨架，不渲染真实页面", () => {
    const io = stubIO();
    const host = render(thumb());
    expect(io.observed()).toBe(1);                       // 观察了容器
    expect(host.querySelector(".ed-thumb-skel")).not.toBeNull();
    expect(host.textContent).not.toContain("PAGE");
  });

  it("进入视口后由真实渲染接管，骨架撤掉，data-ready 置位", () => {
    const io = stubIO();
    const host = render(thumb());
    io.enter(true);
    expect(host.textContent).toContain("PAGE");
    expect(host.querySelector(".ed-thumb-skel")).toBeNull();
    expect(host.querySelector(".ed-thumb")?.getAttribute("data-ready")).toBe("1");
  });

  it("没有 IntersectionObserver（老内核兜底）时直接挂载，不留空卡片", () => {
    delete (globalThis as Record<string, unknown>).IntersectionObserver;
    const host = render(thumb());
    expect(host.textContent).toContain("PAGE");
    expect(host.querySelector(".ed-thumb-skel")).toBeNull();
  });

  it("缩放比 = 卡片内宽 / 390（设计宽）", () => {
    rectW = 156; // 156 / 390 = 0.4
    const io = stubIO();
    const host = render(thumb());
    io.enter(true);
    const inner = host.querySelector(".ed-thumb-inner") as HTMLElement | null;
    expect(inner).not.toBeNull();
    expect(inner?.style.transform).toBe("scale(0.4)");
  });

  it("量不到宽度（0）时保持骨架，不用 390px 原尺寸闪一下", () => {
    rectW = 0;
    const io = stubIO();
    const host = render(thumb());
    io.enter(true);
    expect(host.textContent).not.toContain("PAGE");
    expect(host.querySelector(".ed-thumb")?.getAttribute("data-ready")).not.toBe("1");
  });

  /**
   * 这条是**历史 bug 的护栏**：v3.3 之前画廊卡片没有宽度上限，桌面 1280 上卡宽被拉到 618px
   * → k = 618/390 = **1.59**，缩略图把页面**放大**到比真机还大（"缩略图"的语义就没了）。
   * 现在 k 必须夹在 1：只许缩小、不许放大。
   */
  it("卡片比设计宽（390）还宽时，缩放比夹在 1 —— 只许缩小、不许放大", () => {
    rectW = 640; // 640 / 390 ≈ 1.64 → 必须夹到 1
    const io = stubIO();
    const host = render(thumb());
    io.enter(true);
    const inner = host.querySelector(".ed-thumb-inner") as HTMLElement | null;
    expect(inner).not.toBeNull();
    expect(inner?.style.transform).toBe("scale(1)");
  });
});
