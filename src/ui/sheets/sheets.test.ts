// @vitest-environment jsdom
/**
 * 阅读器 4 个弹层组件。
 *
 * 为什么要专门测这 4 个：
 *   它们是从 Reader.tsx 内联弹体搬出来的，搬家最大的风险不是"显示得对不对"，而是
 *   **回调接错**。其中一类特别隐蔽——把回调直接交给 `onClick={fn}` 会把**点击事件当成第一个实参**
 *   传进去；在 Reader 那边 `runSpeedTest(gen, opts)` 的 `gen` 会被污染成事件对象，
 *   表现为"重新测速点了没反应 / 行为诡异"，而且不报错。搬运时确实踩到过这一处，所以这里逐条钉住。
 *
 * 另外钉住几条容易随着重构悄悄丢掉的规则：
 *   · 已缓存的话在选话弹层里必须是"勾上且不可动"；缓存进行中点遮罩不关；
 *   · 「翻页方向」只在单页模式出现（连续滚动没有左右分区）；
 *   · 离线时未缓存的话标「离线不可读」。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ReaderSourceSheet } from "./ReaderSourceSheet";
import { ReaderSettingsSheet } from "./ReaderSettingsSheet";
import { ReaderChapterSheet } from "./ReaderChapterSheet";
import { ReaderCacheSheet } from "./ReaderCacheSheet";
import { cachedPagesText } from "./chapterText";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => { /* noop */ };
type El = HTMLElement;
const q = (h: El, s: string) => h.querySelector(s) as El | null;
const qa = (h: El, s: string) => Array.from(h.querySelectorAll(s)) as El[];
const txt = (el: El | null) => (el ? (el.textContent || "").trim() : "");

let hosts: El[] = [];
afterEach(() => { hosts.forEach((h) => h.remove()); hosts = []; });

function render(node: ReactNode): El {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  act(() => { root.render(node); });
  return host;
}

// ───────────────────────── 更快的源 ─────────────────────────
describe("ReaderSourceSheet", () => {
  const rows = [
    { key: "1", title: "图源1", host: "h1", ms: 123, ok: true },
    { key: "2", title: "图源2", host: "h2", ms: 45, ok: true }
  ];

  it("渲染标题、两行图源，当前源标「（当前）」且带 ✓", () => {
    const h = render(createElement(ReaderSourceSheet, {
      open: true, onClose: noop, testing: false, rows, currentKey: "1", busyKey: null,
      onChangeSource: noop, onRetest: noop
    }));
    expect(txt(q(h, ".sheet-head h3"))).toBe("更快的源");
    const rs = qa(h, ".sheet-row");
    expect(rs).toHaveLength(2);
    expect(txt(q(rs[0], ".title"))).toBe("图源1（当前）");
    expect(txt(q(rs[1], ".title"))).toBe("图源2");
    expect(txt(q(rs[0], ".badge"))).toBe("✓");
  });

  it("【关键】点某一行时，回调收到的是 key，不是点击事件", () => {
    const onChangeSource = vi.fn();
    const h = render(createElement(ReaderSourceSheet, {
      open: true, onClose: noop, testing: false, rows, currentKey: "1", busyKey: null,
      onChangeSource, onRetest: noop
    }));
    act(() => { qa(h, ".sheet-row")[1].click(); });
    expect(onChangeSource).toHaveBeenCalledTimes(1);
    expect(onChangeSource).toHaveBeenCalledWith("2");
  });

  it("【关键】「重新测速」回调**不带任何实参**（带了就会把事件对象灌进 runSpeedTest 的 gen）", () => {
    const onRetest = vi.fn();
    const h = render(createElement(ReaderSourceSheet, {
      open: true, onClose: noop, testing: false, rows, currentKey: "1", busyKey: null,
      onChangeSource: noop, onRetest
    }));
    act(() => { (qa(h, ".sheet-actions button")[0]).click(); });
    expect(onRetest).toHaveBeenCalledTimes(1);
    expect(onRetest.mock.calls[0]).toHaveLength(0);
  });

  it("切换中：该行转圈、写「正在切换…」、整层不可点", () => {
    const h = render(createElement(ReaderSourceSheet, {
      open: true, onClose: noop, testing: false, rows, currentKey: "1", busyKey: "2",
      onChangeSource: noop, onRetest: noop
    }));
    const rs = qa(h, ".sheet-row");
    expect(q(rs[1], ".row-spin")).toBeTruthy();
    expect(txt(q(rs[1], ".muted"))).toBe("正在切换…");
    expect(rs.every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    expect((q(h, ".sheet-actions button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("测速中：顶部文案变「正在测速…」，但耗时列仍写已测到的值", () => {
    const h = render(createElement(ReaderSourceSheet, {
      open: true, onClose: noop, testing: true, rows, currentKey: "1", busyKey: null,
      onChangeSource: noop, onRetest: noop
    }));
    expect(txt(q(h, ".muted"))).toBe("正在测速…");
    // 行内是 [host, ms, 不可用].filter(Boolean).join(" · ")
    expect(txt(q(qa(h, ".sheet-row")[0], ".muted"))).toBe("h1 · 123 ms");
  });

  it("未测速且不可用 → 写「不可用」；测速中不写", () => {
    const bad = [{ key: "1", title: "图源1", host: "h1", ok: false }];
    const a = render(createElement(ReaderSourceSheet, {
      open: true, onClose: noop, testing: false, rows: bad, currentKey: "1", busyKey: null,
      onChangeSource: noop, onRetest: noop
    }));
    expect(txt(q(qa(a, ".sheet-row")[0], ".muted"))).toContain("不可用");
    const b = render(createElement(ReaderSourceSheet, {
      open: true, onClose: noop, testing: true, rows: bad, currentKey: "1", busyKey: null,
      onChangeSource: noop, onRetest: noop
    }));
    expect(txt(q(qa(b, ".sheet-row")[0], ".muted"))).not.toContain("不可用");
  });

  it("关闭时不渲染", () => {
    const h = render(createElement(ReaderSourceSheet, {
      open: false, onClose: noop, testing: false, rows, currentKey: "1", busyKey: null,
      onChangeSource: noop, onRetest: noop
    }));
    expect(h.innerHTML).toBe("");
  });
});

// ───────────────────────── 阅读设置 ─────────────────────────
function settings(over: Record<string, unknown> = {}) {
  return createElement(ReaderSettingsSheet, {
    open: true, onClose: noop, mode: "continuous", onMode: noop, offline: false,
    deseam: false, onToggleDeseam: noop, tapInvert: false, onTapInvert: noop,
    current: 5, total: 20, jumpInput: "5", onJumpInput: noop, onJumpTo: noop,
    statusOn: [], onToggleStatus: noop,   // v3.12：默认一条都不显示
    ...over
  });
}

describe("ReaderSettingsSheet", () => {
  it("标题、两种模式、当前模式带 ✓", () => {
    const h = render(settings());
    expect(txt(q(h, ".sheet-head h3"))).toBe("阅读设置");
    const rows = qa(h, ".sheet-list .sheet-row");
    expect(rows).toHaveLength(2);
    expect(txt(q(rows[0], ".title"))).toBe("连续滚动");
    expect(txt(q(rows[1], ".title"))).toBe("单页");
    expect(String(rows[0].className)).toContain("active");
  });

  it("选模式回调收到的是模式字符串", () => {
    const onMode = vi.fn();
    const h = render(settings({ onMode }));
    act(() => { qa(h, ".sheet-list .sheet-row")[1].click(); });
    expect(onMode).toHaveBeenCalledWith("single");
  });

  it("【关键】「翻页方向」只在单页模式出现", () => {
    expect(q(render(settings()), ".seg-choice")).toBeNull();
    const h = render(settings({ mode: "single" }));
    expect(q(h, ".seg-choice")).toBeTruthy();
    expect(qa(h, ".seg-choice button")).toHaveLength(2);
  });

  it("左右反转的两个按钮：回调收到布尔值（false / true），且 aria-pressed 跟着走", () => {
    const onTapInvert = vi.fn();
    const h = render(settings({ mode: "single", onTapInvert }));
    const [left, right] = qa(h, ".seg-choice button");
    expect(left.getAttribute("aria-pressed")).toBe("true");   // 未反转时「左←上一页」是选中态
    act(() => { left.click(); });
    expect(onTapInvert).toHaveBeenCalledWith(false);
    act(() => { right.click(); });
    expect(onTapInvert).toHaveBeenCalledWith(true);
  });

  it("去条纹按钮：离线时不出现；在线时出现且文案随开关变", () => {
    // ⚠️ 注意（既有行为，非本次引入）：关态下 className 是 **空串**，
    //    只有开态才带 .btn-deseam，所以这里按"第一组 settings-actions 里有没有 button"来找。
    //    v3.17：这三行不再挂 `.sheet-actions`（那条规则会把末位按钮无条件画成黑主按钮），
    //    选择器相应从 `.sheet-actions.settings-actions` 收窄成 `.settings-actions`。
    const blockOf = (h: El) => qa(h, ".settings-actions")[0];
    const btnOf = (h: El) => qa(blockOf(h), "button")[0] ?? null;

    expect(btnOf(render(settings({ offline: true })))).toBeNull();
    expect(txt(btnOf(render(settings({ deseam: false }))))).toBe("去条纹");
    expect(txt(btnOf(render(settings({ deseam: true }))))).toBe("去条纹 ✓");
    // 开态才带 .btn-deseam 这个类
    expect(String(btnOf(render(settings({ deseam: true })))!.className)).toContain("btn-deseam");
    expect(String(btnOf(render(settings({ deseam: false })))!.className)).toBe("");
  });

  it("【关键】「重新测速」同类问题：跳页相关回调收到的是数字/字符串，不是事件", () => {
    const onJumpTo = vi.fn();
    const onJumpInput = vi.fn();
    const h = render(settings({ onJumpTo, onJumpInput, current: 5, total: 20 }));
    act(() => { (q(h, "input.page-input") as HTMLInputElement).focus(); });
    const input = q(h, "input.page-input") as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "12");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onJumpInput).toHaveBeenCalledWith("12");

    const actions = qa(h, ".settings-actions.page-jump button");
    // 上一页 / 下一页
    act(() => { actions[0].click(); });
    act(() => { actions[1].click(); });
    expect(onJumpTo).toHaveBeenCalledWith(4);
    expect(onJumpTo).toHaveBeenCalledWith(6);
  });

  it("跳到第 1 页时不给「上一页」；已到末页不给「下一页」；current>1 才有「回到开头」", () => {
    const first = render(settings({ current: 1, total: 20 }));
    const fa = qa(first, ".settings-actions.page-jump button");
    expect((fa[0] as HTMLButtonElement).disabled).toBe(true);      // 上一页禁用
    expect(fa.some((b) => txt(b) === "回到开头")).toBe(false);

    const last = render(settings({ current: 20, total: 20 }));
    const la = qa(last, ".settings-actions.page-jump button");
    expect(la.some((b) => txt(b) === "下一页" && (b as HTMLButtonElement).disabled)).toBe(true);
    expect(la.some((b) => txt(b) === "回到开头")).toBe(true);
  });

  it("页码与总数写出来了", () => {
    const h = render(settings({ current: 5, total: 20 }));
    expect(txt(q(h, ".muted.mono-num"))).toBe("/20");
  });

  /**
   * v3.12 状态栏条目的开关（调研：**进度条不是原子单元**）。
   * 这一组测的是"抽屉里能开关、回调收到的是**条目 id**"——
   * 真正的显示效果由 core/chromeLayout（单测）+ driver-reader（真页）验。
   */
  it("状态栏四个开关都在，文案固定为 章节名 / 页码 / 百分比 / 时间", () => {
    const h = render(settings({ statusOn: [] }));
    const btns = qa(h, ".settings-actions button").filter((b) => /章节名|页码|百分比|时间/.test(txt(b)));
    expect(btns.map((b) => txt(b).replace(/\s*✓$/, ""))).toEqual(["章节名", "页码", "百分比", "时间"]);
  });

  it("【关键】回调收到的是**条目 id**，不是事件对象；aria-pressed 与 ✓ 跟着 statusOn 走", () => {
    const onToggleStatus = vi.fn();
    const off = render(settings({ statusOn: [], onToggleStatus }));
    const pctBtn = qa(off, ".settings-actions button").find((b) => txt(b).indexOf("百分比") >= 0) as HTMLButtonElement;
    expect(pctBtn.getAttribute("aria-pressed")).toBe("false");
    expect(txt(pctBtn)).toBe("百分比");
    act(() => { pctBtn.click(); });
    expect(onToggleStatus).toHaveBeenCalledWith("pct");

    const on = render(settings({ statusOn: ["pct", "clock"] }));
    const pctOn = qa(on, ".settings-actions button").find((b) => txt(b).indexOf("百分比") >= 0) as HTMLButtonElement;
    const pageOff = qa(on, ".settings-actions button").find((b) => txt(b) === "页码") as HTMLButtonElement;
    expect(pctOn.getAttribute("aria-pressed")).toBe("true");
    expect(String(pctOn.className)).toContain("on");
    expect(txt(pctOn)).toBe("百分比 ✓");
    expect(pageOff.getAttribute("aria-pressed")).toBe("false");
  });
});

// ───────────────────────── 换话 ─────────────────────────
const CHAPTERS = [
  { id: "900001", name: "", sort: 1 },
  { id: "900002", name: "第2话", sort: 2 }
];

function chapter(over: Record<string, unknown> = {}) {
  return createElement(ReaderChapterSheet, {
    open: true, onClose: noop, chapters: CHAPTERS, bookName: "连载书A", albumId: "900002",
    curLabel: "第2话", offline: false, cachedIds: new Map(), chapterMetas: [],
    switchBusy: false, switchKey: null, nextChapter: null, nextChapterText: "",
    onSwitch: noop, ...over
  });
}

describe("ReaderChapterSheet", () => {
  it("标题带书名；顶部写出「共 N 话 · 当前 X」", () => {
    const h = render(chapter());
    expect(txt(q(h, ".sheet-head h3"))).toBe("切换话数：连载书A");
    expect(txt(q(h, ".muted"))).toBe("共 2 话 · 当前 第2话");
  });

  it("没有书名时标题不拼冒号", () => {
    const h = render(chapter({ bookName: undefined }));
    expect(txt(q(h, ".sheet-head h3"))).toBe("切换话数");
  });

  it("当前话标「（当前）」并高亮", () => {
    const h = render(chapter());
    const rows = qa(h, ".sheet-row");
    expect(String(rows[1].className)).toContain("active");
    expect(txt(q(rows[1], ".title"))).toBe("第2话（当前）");
  });

  it("【关键】点某话时回调收到的是那一话对象本身", () => {
    const onSwitch = vi.fn();
    const h = render(chapter({ onSwitch }));
    act(() => { qa(h, ".sheet-row")[0].click(); });
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch.mock.calls[0][0]).toMatchObject({ id: "900001" });
  });

  it("已是最后一话：按钮不可点且写「已是最后一话」", () => {
    const h = render(chapter({ nextChapter: null }));
    const btn = q(h, ".chap-next") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(txt(btn)).toBe("已是最后一话");
  });

  it("有下一话：按钮可点、显示传入的文案、带箭头", () => {
    const h = render(chapter({
      nextChapter: { chapter: CHAPTERS[1] }, nextChapterText: "下一话 · 第3话"
    }));
    const btn = q(h, ".chap-next") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(txt(btn)).toContain("下一话 · 第3话");
    expect(q(btn, ".chev")).toBeTruthy();
  });

  it("【关键】离线时未缓存的话标「离线不可读」；在线时不标", () => {
    const online = render(chapter({ offline: false }));
    expect(txt(qa(online, ".sheet-row")[0])).not.toContain("离线不可读");
    const off = render(chapter({ offline: true }));
    expect(txt(qa(off, ".sheet-row")[0])).toContain("离线不可读");
  });

  it("切换中：该行转圈、整列表禁用", () => {
    const h = render(chapter({ switchBusy: true, switchKey: "900001" }));
    const rows = qa(h, ".sheet-row");
    expect(q(rows[0], ".row-spin")).toBeTruthy();
    expect(rows.every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
  });

  it("目录为空时出骨架", () => {
    const h = render(chapter({ chapters: [] }));
    expect(q(h, ".skeleton-rows, .skeleton-row, .skeleton")).toBeTruthy();
  });
});

// ───────────────────────── 选话缓存 ─────────────────────────
function cacheSheet(over: Record<string, unknown> = {}) {
  return createElement(ReaderCacheSheet, {
    open: true, onClose: noop, chapters: CHAPTERS, albumId: "900002",
    cachedIds: new Map([["900001", { pages: 4 } as never]]),
    chapterMetas: [{ chapterId: "900001", total: 4 } as never],
    busy: false, selected: new Set<string>(), onToggle: noop,
    onSelectAll: noop, onInvert: noop, onConfirm: noop, ...over
  });
}

describe("ReaderCacheSheet", () => {
  it("【关键】已缓存的话：勾上 + 不可动 + 带 ✓ 徽标", () => {
    const h = render(cacheSheet());
    const boxes = qa(h, "input[type=checkbox]") as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[0].disabled).toBe(true);
    expect(String(qa(h, ".check-row")[0].className)).toContain("disabled");
    expect(q(h, ".badge.ok")).toBeTruthy();
    // 未缓存的第 2 话可以勾
    expect(boxes[1].checked).toBe(false);
    expect(boxes[1].disabled).toBe(false);
  });

  it("勾选回调收到的是话 id", () => {
    const onToggle = vi.fn();
    const h = render(cacheSheet({ onToggle }));
    act(() => { (qa(h, "input[type=checkbox]")[1] as HTMLInputElement).click(); });
    expect(onToggle).toHaveBeenCalledWith("900002");
  });

  it("【关键】全选/反选/确认都不带实参（否则事件对象会灌进调用方）", () => {
    const onSelectAll = vi.fn(); const onInvert = vi.fn(); const onConfirm = vi.fn();
    const h = render(cacheSheet({ onSelectAll, onInvert, onConfirm, selected: new Set(["900002"]) }));
    const btns = qa(h, ".sheet-actions button");
    act(() => { btns.forEach((b) => b.click()); });
    expect(onSelectAll.mock.calls[0]).toHaveLength(0);
    expect(onInvert.mock.calls[0]).toHaveLength(0);
    expect(onConfirm.mock.calls[0]).toHaveLength(0);
  });

  it("一个都没选时「确认」不可点；选了就带数量", () => {
    const empty = render(cacheSheet({ selected: new Set() }));
    const b0 = qa(empty, ".sheet-actions button")[2] as HTMLButtonElement;
    expect(b0.disabled).toBe(true);
    expect(txt(b0)).toBe("确认开始缓存（0）");

    const some = render(cacheSheet({ selected: new Set(["900002"]) }));
    const b1 = qa(some, ".sheet-actions button")[2] as HTMLButtonElement;
    expect(b1.disabled).toBe(false);
    expect(txt(b1)).toBe("确认开始缓存（1）");
  });

  it("缓存进行中：文案「加入中…」、整层按钮禁用、关闭按钮也禁用", () => {
    const h = render(cacheSheet({ busy: true }));
    expect(txt(qa(h, ".sheet-actions button")[2])).toBe("加入中…");
    expect(qa(h, ".sheet-actions button").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect((q(h, ".sheet-close") as HTMLButtonElement).disabled).toBe(true);
    expect((qa(h, "input[type=checkbox]")[1] as HTMLInputElement).disabled).toBe(true);
  });

  it("【关键】缓存进行中点遮罩不关；不在进行中则关", () => {
    const onClose = vi.fn();
    const busy = render(cacheSheet({ busy: true, onClose }));
    act(() => { (q(busy, ".drawer-backdrop") as El).click(); });
    expect(onClose).not.toHaveBeenCalled();

    const idle = render(cacheSheet({ busy: false, onClose }));
    act(() => { (q(idle, ".drawer-backdrop") as El).click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── 共享的缓存文案 ─────────────────────────
describe("cachedPagesText（两个弹层共用的那一段）", () => {
  it("未缓存", () => {
    expect(cachedPagesText(undefined, undefined)).toBe("未缓存");
  });
  it("已缓存且页数正好", () => {
    expect(cachedPagesText({ pages: 4 } as never, { total: 4 } as never)).toBe("已缓存 · 4 页");
  });
  it("已缓存但比总页数少（拆章缓存）→ 写出 N/M", () => {
    expect(cachedPagesText({ pages: 4 } as never, { total: 10 } as never)).toBe("已缓存 · 4 页/10");
  });
  it("没有 meta 记录时只写页数", () => {
    expect(cachedPagesText({ pages: 4 } as never, undefined)).toBe("已缓存 · 4 页");
  });
});
