import type { ReactNode } from "react";

/**
 * 内层元素的**空绑定**（`PLAIN_BIND`）—— v3.5 之后本文件只剩这一件东西。
 *
 * ── 这里原来是什么，为什么没了（用户第 3 条）────────────────────────────
 * v3 曾在这里实现「画布内嵌结构可直接拖」：一个 **headless** 组件 `EdSlot`，
 * 它自己不产生 DOM，而是把类名 / 属性 / 手势**注入既有元素**
 * （`<h2 class="d-title">` → `<h2 class="d-title ed-slot">`）。当时的理由很硬：
 * `.d-hero` 是 flex、`.d-facts` 是 grid，套 wrapper 会塌，而 `display:contents`
 * 在 compat 内核（WebView 57 / Chromium 57）不支持。
 *
 * 用户实测后的要求是**反方向**的：
 *   「**主视觉是一个大模块**，封面信息栏和四宫格等等也是在主视觉的配置里设置，
 *     **而不是也都做成可点击的模块**」。
 * 所以内层不再有点击/拖动入口 —— 编辑态与线上态**共用同一个空绑定**，
 * 内层 DOM 因此与线上逐字一致；内层的顺序/显隐改在配置栏里调（`ui/NodeOrderList`）。
 *
 * ── 为什么留着这个类型与常量 ────────────────────────────────────────
 * `AlbumDetail` 的内层渲染函数（`withSlot`）签名里带着它：元素结构只写一处、
 * 两种模式共用一份 render，不会出现"编辑态一份、线上态另一份，日久漂移"。
 * 空绑定保证注入进去的 `cls` / `attrs` / `handlers` / `gap` 全部是空值。
 */
export interface SlotBind {
  /** 追加到既有类名后面的编辑态类（**线上与编辑态现在都是空串**） */
  cls: string;
  attrs: Record<string, never>;
  /** 引用（内层不再需要元素引用，恒为 noop） */
  ref: (el: HTMLElement | null) => void;
  handlers: Record<string, never>;
  /** 插入缝（内层不渲染，恒为 null） */
  gap: ReactNode;
}

/**
 * **线上态与编辑态共用的空绑定**：`cls` 空、属性空、处理器空。
 *
 * 两个模式共用它是有意的：`AlbumDetail` 里那些 `<div class="fact">` / `<h2 class="d-title">`
 * 只写一份结构，于是"编辑器里看到的"与"线上渲染的"不可能漂移。
 */
export const PLAIN_BIND: SlotBind = {
  cls: "",
  attrs: {} as SlotBind["attrs"],
  ref: () => { /* 内层不需要元素引用 */ },
  handlers: {} as SlotBind["handlers"],
  gap: null
};
