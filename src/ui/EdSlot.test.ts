// @vitest-environment jsdom
/**
 * v3.5：**内层元素不再是可点选的模块**（用户第 3 条）—— 本文件原来测的是「内嵌可拖」。
 *
 * ── 为什么整份改写（不是删测试）────────────────────────────────────────
 * 用户原话：「**主视觉是一个大模块**，封面信息栏和四宫格等等也是在主视觉的配置里设置，
 * **而不是也都做成可点击的模块**」。
 *
 * 所以旧文件的 11 条断言里：
 *   · **保留/改写**：headless 的"元素数量不变"精神 → 现在更强：编辑态与线上态的内层
 *     **共用空绑定**（`PLAIN_BIND`），DOM 逐字一致；
 *   · **反转**：旧文件第 252 行那条「编辑态：三个内嵌容器挂 `data-drag-list`，
 *     主视觉内的槽位带 `data-blk`」—— 现在必须**恰好相反**：编辑态 **没有** `.ed-slot`、
 *     内层元素**不带** `data-blk`；
 *   · **删除**：5 条"嵌套守卫"用例（内层起拖时父块不许同时起拖）。它们的**主体**
 *     （内嵌可拖）已按用户要求移除，场景不再存在。守卫代码本身仍留在
 *     `hooks/useCanvasDrag`（`src.closest(ITEM_SEL) !== el`）—— 留着是防御性的，
 *     不为洁癖去动已验证的起拖路径。
 *
 * ⚠️ jsdom 没有布局引擎（rect / offset 全是 0），所以这里**不验几何**：
 * 落点判定交给 `core/dropIndex.test.ts`（纯函数）与 e2e。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { PLAIN_BIND } from "./EdSlot";
import AlbumDetail from "../pages/AlbumDetail";
import { CANVAS_DETAIL_PROPS } from "./customUiCanvasProps";
import { DEFAULT_DETAIL_LAYOUT, visibleBlocks } from "../core/detailLayout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ unmount: () => void }> = [];
const hosts: HTMLElement[] = [];

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const r of roots.splice(0)) act(() => { r.unmount(); });
  for (const h of hosts.splice(0)) h.remove();
  vi.useRealTimers();
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

describe("PLAIN_BIND：空绑定（内层两种模式共用它）", () => {
  it("类名 / 属性 / 处理器 / 插入缝**全是空的** —— 注入既有元素后不留任何痕迹", () => {
    expect(PLAIN_BIND.cls).toBe("");
    expect(Object.keys(PLAIN_BIND.attrs)).toEqual([]);
    expect(Object.keys(PLAIN_BIND.handlers)).toEqual([]);
    expect(PLAIN_BIND.gap).toBe(null);
    expect(() => PLAIN_BIND.ref(null)).not.toThrow();
  });
});

describe("AlbumDetail：线上态零痕迹（红线）", () => {
  it("线上态：没有 .ed-blk / .ed-slot / data-drag-list / data-blk", () => {
    const host = render(createElement(AlbumDetail, { ...CANVAS_DETAIL_PROPS, editMode: false }));
    expect(host.querySelectorAll(".ed-blk").length).toBe(0);
    expect(host.querySelectorAll(".ed-slot").length).toBe(0);
    expect(host.querySelectorAll("[data-drag-list]").length).toBe(0);
    expect(host.querySelectorAll("[data-blk]").length).toBe(0);
  });
});

describe("v3.5：内层不再可点选（用户第 3 条）", () => {
  it("【反转】编辑态：**一个 `.ed-slot` 都没有**（旧断言要求内层带槽位类，正好相反）", () => {
    const host = render(createElement(AlbumDetail, { ...CANVAS_DETAIL_PROPS, editMode: true }));
    expect(host.querySelectorAll(".ed-slot").length).toBe(0);
  });

  it("【反转】编辑态：内层元素**不带 data-blk**（只有顶层块才是可选单元）", () => {
    const host = render(createElement(AlbumDetail, { ...CANVAS_DETAIL_PROPS, editMode: true }));
    // 内层的三类元素：标题 / 四宫格字段 / 封面盒
    const title = host.querySelector(".d-title");
    const fact = host.querySelector(".d-facts .fact");
    expect(title).not.toBeNull();
    expect(fact).not.toBeNull();
    expect(title!.hasAttribute("data-blk")).toBe(false);
    expect(fact!.hasAttribute("data-blk")).toBe(false);
    expect(title!.className).not.toMatch(/ed-slot/);
    expect(fact!.className).not.toMatch(/ed-slot/);
  });

  it("编辑态的 `.ed-blk` 数量 = **可见顶层块**数量（内层一个都不算）", () => {
    const host = render(createElement(AlbumDetail, { ...CANVAS_DETAIL_PROPS, editMode: true }));
    const blocks = host.querySelectorAll(".ed-blk");
    expect(blocks.length).toBe(visibleBlocks(DEFAULT_DETAIL_LAYOUT).length);
    for (let i = 0; i < blocks.length; i++) {
      expect(blocks[i].parentElement!.className).toMatch(/detail-card/);
    }
  });

  it("内层元素的可点选痕迹（role=button / tabIndex / aria-pressed）一个都没有", () => {
    const host = render(createElement(AlbumDetail, { ...CANVAS_DETAIL_PROPS, editMode: true }));
    const title = host.querySelector(".d-title")!;
    expect(title.getAttribute("role")).toBeNull();
    expect(title.getAttribute("tabindex")).toBeNull();
    expect(title.getAttribute("aria-pressed")).toBeNull();
  });
});
