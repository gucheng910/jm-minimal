// @vitest-environment jsdom
/**
 * 滚动宿主判定的回归测试（对应 2026-09-13 代码审查：同一决策在 Reader.tsx 里写了两份）。
 *
 * jsdom 不做排版，scrollHeight/clientHeight 恒为 0，所以这里的"能滚/不能滚"
 * 用 defineProperty 直接给元素打上量测值——测的是**判定逻辑**，不是浏览器排版。
 */
import { afterEach, describe, expect, it } from "vitest";
import { findScrollHost, measuredHost, resolveReaderScrollHost, scrollTopOf } from "./scrollHost";

function metrics(el: Element, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
}

function resetMetrics(el: Element) {
  delete (el as unknown as Record<string, unknown>).scrollHeight;
  delete (el as unknown as Record<string, unknown>).clientHeight;
}

function buildReader(html: string, rootClass = "reader-wrap"): HTMLElement {
  const root = document.createElement("div");
  root.className = rootClass;
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findScrollHost", () => {
  it("父级没有 overflow 容器时返回 null（= 窗口滚动）", () => {
    const root = buildReader('<div class="reader-cont"><figure class="jm-figure"></figure></div>');
    const fig = root.querySelector(".jm-figure")!;
    expect(findScrollHost(fig)).toBeNull();
  });

  it("找到最近的可滚动祖先（缓存中心的 .cache-overlay）", () => {
    const root = buildReader('<div class="cache-overlay"><div class="reader-cont"><figure class="jm-figure"></figure></div></div>');
    const overlay = root.querySelector(".cache-overlay") as HTMLElement;
    overlay.style.overflowY = "auto";
    metrics(overlay, 5000, 800);
    const fig = root.querySelector(".jm-figure")!;
    expect(findScrollHost(fig)).toBe(overlay);
    resetMetrics(overlay);
  });

  it("overflow:auto 但内容没溢出 → 不算滚动宿主", () => {
    const root = buildReader('<div class="wrap"><figure class="jm-figure"></figure></div>');
    const wrap = root.querySelector(".wrap") as HTMLElement;
    wrap.style.overflowY = "auto";
    metrics(wrap, 800, 800); // 没溢出
    expect(findScrollHost(root.querySelector(".jm-figure")!)).toBeNull();
    resetMetrics(wrap);
  });

  it("overflow:hidden 不算滚动宿主", () => {
    const root = buildReader('<div class="wrap"><figure class="jm-figure"></figure></div>');
    const wrap = root.querySelector(".wrap") as HTMLElement;
    wrap.style.overflowY = "hidden";
    metrics(wrap, 5000, 800);
    expect(findScrollHost(root.querySelector(".jm-figure")!)).toBeNull();
    resetMetrics(wrap);
  });
});

describe("measuredHost", () => {
  it("有嵌套滚动宿主时就用它", () => {
    const root = buildReader('<div class="cache-overlay"><figure class="jm-figure"></figure></div>');
    const overlay = root.querySelector(".cache-overlay") as HTMLElement;
    metrics(overlay, 5000, 800);
    expect(measuredHost(overlay)).toBe(overlay);
    resetMetrics(overlay);
  });

  it("老内核上 document.scrollingElement 返回不滚动的 body → 退到 documentElement", () => {
    const original = Object.getOwnPropertyDescriptor(Document.prototype, "scrollingElement");
    Object.defineProperty(document, "scrollingElement", { configurable: true, value: document.body });
    metrics(document.body, 800, 800); // body 自身不滚动（WebView 57 的表现）
    metrics(document.documentElement, 5000, 800);
    try {
      expect(measuredHost(null)).toBe(document.documentElement);
    } finally {
      if (original) Object.defineProperty(Document.prototype, "scrollingElement", original);
      resetMetrics(document.body);
      resetMetrics(document.documentElement);
    }
  });
});

describe("resolveReaderScrollHost", () => {
  it("窗口滚动：isWindow=true，量测回退到 documentElement", () => {
    const root = buildReader('<div class="reader-cont"><figure class="jm-figure"></figure></div>');
    metrics(document.documentElement, 5000, 800);
    const host = resolveReaderScrollHost(root);
    expect(host.isWindow).toBe(true);
    expect(host.scroller).toBeNull();
    expect(host.measured).toBe(document.documentElement);
    resetMetrics(document.documentElement);
  });

  it("离线阅读：认出 overlay 容器", () => {
    const root = buildReader('<div class="cache-overlay"><figure class="jm-figure"></figure></div>');
    const overlay = root.querySelector(".cache-overlay") as HTMLElement;
    overlay.style.overflowY = "scroll";
    metrics(overlay, 5000, 800);
    const host = resolveReaderScrollHost(root);
    expect(host.isWindow).toBe(false);
    expect(host.scroller).toBe(overlay);
    resetMetrics(overlay);
  });

  it("限定在传入 root 内查询：两个阅读器同时挂载时不会量到别人的 DOM", () => {
    const online = buildReader('<div class="cache-overlay"><figure class="jm-figure"></figure></div>', "reader-wrap");
    const offline = buildReader('<div class="cache-overlay"><figure class="jm-figure"></figure></div>', "reader-wrap");
    const onlineOverlay = online.querySelector(".cache-overlay") as HTMLElement;
    const offlineOverlay = offline.querySelector(".cache-overlay") as HTMLElement;
    onlineOverlay.style.overflowY = "auto";
    offlineOverlay.style.overflowY = "auto";
    metrics(onlineOverlay, 5000, 800);
    metrics(offlineOverlay, 9000, 800);

    expect(resolveReaderScrollHost(online).scroller).toBe(onlineOverlay);
    expect(resolveReaderScrollHost(offline).scroller).toBe(offlineOverlay);

    // 不限定范围时会串到第一个阅读器（这正是抽出这个函数要修掉的问题）
    expect(findScrollHost(document.querySelector(".jm-figure"))).toBe(onlineOverlay);

    resetMetrics(onlineOverlay);
    resetMetrics(offlineOverlay);
  });
});

describe("scrollTopOf", () => {
  it("窗口宿主读 window.scrollY", () => {
    const root = buildReader('<figure class="jm-figure"></figure>');
    metrics(document.documentElement, 5000, 800);
    const host = resolveReaderScrollHost(root);
    expect(scrollTopOf(host)).toBe(window.scrollY);
    resetMetrics(document.documentElement);
  });

  it("容器宿主读容器 scrollTop", () => {
    const root = buildReader('<div class="cache-overlay"><figure class="jm-figure"></figure></div>');
    const overlay = root.querySelector(".cache-overlay") as HTMLElement;
    overlay.style.overflowY = "auto";
    metrics(overlay, 5000, 800);
    overlay.scrollTop = 123;
    expect(scrollTopOf(resolveReaderScrollHost(root))).toBe(123);
    resetMetrics(overlay);
  });
});
