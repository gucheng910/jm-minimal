// @vitest-environment jsdom
/**
 * 详情页「版面由数据驱动」的护栏测试。
 *
 * 为什么这个页面值得有一个组件级测试（**本仓库目前唯一的组件渲染测试**）：
 *   v7.2 把版面顺序从 JSX 搬进了 core/detailLayout。这是本次重构的**全部价值**，
 *   但它有一个很安静的失效方式——**只要有人把顺序重新写回 JSX，配置就失效了，
 *   而页面看起来完全正常**（因为默认配置恰好就是那个顺序）。
 *   纯函数测试覆盖不到这一点，所以这里直接渲染组件、断言 DOM 顺序真的跟着配置走。
 *
 * 数据层本身的自愈/边界在 core/detailLayout.test.ts（28 条）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { UI_KEYS } from "../core/constants";
import AlbumDetail from "./AlbumDetail";

// React 19 的 act 需要这个全局标记，否则会打印"act 环境未配置"的告警
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { localStorage.clear(); });

const noop = () => { /* noop */ };

/** 覆盖面尽量广的一份假数据：连载 + 标签 + 人物 + 相关 + 简介 + 已收藏 */
const FULL = {
  id: 302946,
  name: "秘密教学",
  book_name: "秘密教学",
  addtime: "2024-05-11",
  description: "简介".repeat(80),
  total_views: 123456,
  likes: 4210,
  is_favorite: true,
  author: ["某某老师"],
  tags: ["纯爱", "校园"],
  actors: ["角色A"],
  series: Array.from({ length: 12 }, (_, i) => ({ id: 302946 + i, name: "", sort: 146 - i })),
  related_list: [{ id: 1, name: "相关漫画一" }],
  total_photos: 47
};

interface Over {
  logged?: boolean;
  /**
   * 编辑态（「自定义 UI」画布）。v3.5 的折叠形态在编辑态**不可交互**，
   * 而那是"同一份数据、两种交互"的差别 —— 纯函数测不到，只能在这一层钉住。
   */
  editMode?: boolean;
  /** 画布选中回调：编辑态点区块里的任何地方都应当**选中该区块**（而不是触发块内交互） */
  onSelectBlock?: (id: string) => void;
}

function mkProps(detail: unknown, over: Over = {}) {
  return {
    detail, logged: true, busy: false,
    comments: null, commentTotal: 0, commentHasMore: false, commentLoadingMore: false,
    commentText: "", backLabel: "返回列表",
    onBack: noop, onCopyId: noop, onOpenAuthor: noop, onOpenTag: noop, onOpenActor: noop,
    onOpenRelated: noop, onSwitchChapter: noop, onBuy: noop, onToggleFavorite: noop,
    onRead: noop, onCommentChange: noop, onSubmitComment: noop, onLoadMoreComments: noop,
    ...over
  };
}

/** 把一条配置写进 localStorage（页面初值同步读它） */
function setLayout(cfg: unknown): void {
  localStorage.setItem(UI_KEYS.detailLayout, JSON.stringify(cfg));
}

function render(detail: unknown, over: Over = {}): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(AlbumDetail, mkProps(detail, over) as never)); });
  const html = host.innerHTML;
  act(() => { root.unmount(); });
  host.remove();
  return html;
}

/**
 * 渲染并**保持挂载** —— 要"点一下"的用例必须用它（上面的 `render()` 读完 innerHTML 就卸载了，
 * 点不动任何东西）。用完**必须** `unmount()`，否则这个用例的 DOM 会留在 `document.body` 里
 * 干扰下一个用例（`querySelector` 会跨用例命中）。
 */
function mount(detail: unknown, over: Over = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(AlbumDetail, mkProps(detail, over) as never)); });
  return {
    host,
    html: () => host.innerHTML,
    find: (sel: string) => host.querySelector(sel),
    findAll: (sel: string) => Array.from(host.querySelectorAll(sel)),
    /** 点一个元素：包在 `act` 里，否则 React 的 setState 不会在这个用例里刷新 */
    click: (el: Element | null | undefined) => {
      if (!el) throw new Error("要点的元素不存在");
      act(() => { (el as HTMLElement).click(); });
    },
    unmount: () => { act(() => { root.unmount(); }); host.remove(); }
  };
}

describe("详情页：默认版面（不依赖配置）", () => {
  it("区块齐全，顺序与 v7.1 一致：动作区在简介之前", () => {
    const html = render(FULL);
    expect(html).toContain("detail-card");
    for (const cls of ["d-head", "d-hero", "d-tags", "d-actors", "actrow", "d-desc", "d-tabs"]) {
      expect(html).toContain(cls);
    }
    expect(html.indexOf("actrow")).toBeLessThan(html.indexOf("d-desc"));
    expect(html.indexOf("d-head")).toBeLessThan(html.indexOf("d-hero"));
  });

  it("四宫格默认是 作者 / 话数 / JM号 / 收录", () => {
    const html = render(FULL);
    expect(html.indexOf("作者")).toBeLessThan(html.indexOf("JM号"));
    expect(html.indexOf("JM号")).toBeLessThan(html.indexOf("收录"));
  });

  it("主视觉默认封面在左、信息栏在右", () => {
    const html = render(FULL);
    expect(html.indexOf("d-cover-box")).toBeLessThan(html.indexOf("d-hero-info"));
  });

  it("空数据不白屏（无标签/人物/相关/简介/连载）", () => {
    const html = render({ id: 1, name: "无题", total_photos: 20, series: [], tags: [], actors: [] });
    expect(html).toContain("detail-card");
    expect(html).toContain("actrow");   // 仍能阅读
    expect(html).not.toContain("d-tags");
  });

  it("未登录时不渲染收藏按钮", () => {
    expect(render(FULL, { logged: false })).not.toContain("btn soft fav");
    expect(render(FULL)).toContain("btn soft fav");
  });
});

describe("详情页：配置真的驱动版面（防止顺序被写回 JSX）", () => {
  it("改 blocks 顺序 → DOM 顺序跟着变", () => {
    setLayout({ blocks: ["back", "hero", "actors", "tags", "notice", "desc", "action", "detail"] });
    const html = render(FULL);
    expect(html.indexOf("d-desc")).toBeLessThan(html.indexOf("actrow"));
  });

  it("隐藏区块 → 它真的不出现", () => {
    setLayout({ hidden: ["tags", "actors", "notice"] });
    const html = render(FULL);
    expect(html).not.toContain("d-tags");
    expect(html).not.toContain("d-actors");
    expect(html).toContain("actrow"); // 其余照旧
  });

  it("四宫格字段顺序跟着配置走（JM号上移）", () => {
    setLayout({ facts: ["jmId", "author", "chapCount", "addDate"] });
    const html = render(FULL);
    expect(html.indexOf("JM号")).toBeLessThan(html.indexOf("作者"));
  });

  it("主视觉左右栏可换位（封面到右边）", () => {
    setLayout({ heroSlots: ["info", "cover"] });
    const html = render(FULL);
    expect(html.indexOf("d-hero-info")).toBeLessThan(html.indexOf("d-cover-box"));
  });

  it("信息栏内部顺序可调（数据条提到标题上面）", () => {
    setLayout({ heroInfoSlots: ["stat", "title", "facts"] });
    const html = render(FULL);
    expect(html.indexOf("d-stat")).toBeLessThan(html.indexOf("d-title"));
  });
});

describe("详情页：护栏", () => {
  it("【关键】action 藏不掉（藏了就走不出去）；v3.3 起 back **可以**藏掉", () => {
    setLayout({ hidden: ["back", "action"] });
    const html = render(FULL);
    // back 已按用户要求改成可隐藏（"手机上其实一些用户用不上"）→ .d-head 不再渲染
    expect(html).not.toContain("backtxt");
    // action 仍钉死：它是唯一的阅读 / 收藏出口
    expect(html).toContain("actrow");
  });

  it("【关键】localStorage 是坏数据也不白屏", () => {
    localStorage.setItem(UI_KEYS.detailLayout, "{ 这不是 JSON");
    const html = render(FULL);
    expect(html).toContain("detail-card");
    expect(html).toContain("d-head");
  });

  it("【关键】未知区块 id 不会渲染出空白", () => {
    setLayout({ blocks: ["ghost", "hero", "detail"] });
    const html = render(FULL);
    expect(html).toContain("d-hero");
    expect(html).toContain("d-tabs");
    expect(html).not.toContain("undefined");
  });

  it("目录/评论/相关在**默认形态**下仍是互斥 tab（v3.5：可各自隐藏，但不做成可摆放的区块）", () => {
    const html = render(FULL);
    expect(html).toContain("d-tabs");
    expect(html).toContain("chap-list");        // 默认停在目录
    expect(html).not.toContain("related-block"); // 相关漫画面板未选中
  });
});

describe("v3.5：`detail` 的形态与三个面板（用户第 4 条）", () => {
  /** 折叠形态的配置（形态维度只有一个入口：core/detailLayout 的注册表） */
  const FOLDED = { forms: { detail: "folded" } };

  it("【红线】默认形态 = 今天的样子：横栏 + 目录面板，折叠形态的 DOM 一个字节都不多", () => {
    const m = mount(FULL);
    try {
      expect(m.find(".d-tabs")).not.toBeNull();
      expect(m.findAll(".d-fold")).toHaveLength(0);   // 没配过形态 → 一个折叠节点都不渲染
      expect(m.find(".chap-list")).not.toBeNull();    // 默认停在目录
      expect(m.find(".related-block")).toBeNull();    // 相关漫画未选中
      expect(m.findAll(".d-tabs .tk").map((b) => b.textContent)).toEqual(["目录", "评论", "相关漫画 1"]);
    } finally { m.unmount(); }
  });

  it("折叠形态：三行都在、计数文字对、横栏不再出现", () => {
    setLayout(FOLDED);
    const m = mount(FULL);
    try {
      expect(m.findAll(".d-fold-item")).toHaveLength(3);
      // 计数：「目录 12 话」（12 话连载）；「评论」不写数字（commentTotal=0 时我们并不知道是
      // 0 条还是还没加载，写"评论 0"是错的）；「相关漫画 1」。
      expect(m.findAll(".d-fold-name").map((e) => e.textContent))
        .toEqual(["目录 12 话", "评论", "相关漫画 1"]);
      expect(m.find(".d-tabs")).toBeNull();               // 折叠形态不再画横栏
      expect(m.findAll(".d-fold-body")).toHaveLength(0);  // 初始全是收起的
    } finally { m.unmount(); }
  });

  it("【关键】折叠形态在**编辑态不可交互**：行是静态 div，点它 = 选中区块，内容不展开", () => {
    setLayout(FOLDED);
    const picked: string[] = [];
    const m = mount(FULL, { editMode: true, onSelectBlock: (id) => picked.push(id) });
    try {
      const heads = m.findAll(".d-fold-head");
      expect(heads).toHaveLength(3);
      // 编辑态渲染 div 而不是 button：画布上"点一下"只该有一个含义 —— 选中这个区块。
      // 有 button 就会和"展开"抢手势，用户点哪儿都觉得别扭。
      for (const h of heads) {
        expect(h.tagName).toBe("DIV");
        expect(h.className).toContain("static");
      }
      expect(m.findAll("button.d-fold-head")).toHaveLength(0);
      m.click(heads[0]);
      expect(picked).toEqual(["detail"]);                  // 点它 = 选中这一块（冒泡到 EdBlock）
      expect(m.findAll(".d-fold-body")).toHaveLength(0);   // 且**没有**展开
    } finally { m.unmount(); }
  });

  it("折叠形态在**预览态**可展开 / 收起（同一时刻只展开一个，与原来的互斥 tab 同语义）", () => {
    setLayout(FOLDED);
    const m = mount(FULL);
    try {
      const heads = () => m.findAll(".d-fold-head");
      expect(heads()[0].tagName).toBe("BUTTON");
      m.click(heads()[0]);
      expect(m.findAll(".d-fold-body")).toHaveLength(1);
      expect(m.find(".d-fold-body .chap-list")).not.toBeNull();  // 第一行展开的是目录
      m.click(heads()[1]);                                        // 点第二行 → 第一行自动收起
      const bodies = m.findAll(".d-fold-body");
      expect(bodies).toHaveLength(1);
      expect(bodies[0].querySelector(".chap-list")).toBeNull();
      m.click(heads()[1]);                                        // 再点一次 → 全部收起
      expect(m.findAll(".d-fold-body")).toHaveLength(0);
    } finally { m.unmount(); }
  });

  it("隐藏「评论」「相关漫画」→ 只剩目录，且**横栏消失**（一个标签的横栏是白占一行高度）", () => {
    setLayout({ hidden: ["cmt", "rel"] });
    const m = mount(FULL);
    try {
      expect(m.find(".d-tabs")).toBeNull();
      expect(m.find(".chap-list")).not.toBeNull();        // 目录照常显示
      expect(m.findAll(".d-fold-item")).toHaveLength(0);  // 形态没变，仍是横栏那一种
    } finally { m.unmount(); }
  });

  it("隐藏一个 → 横栏只剩两个标签（横栏规则：可见面板 > 1 才画）", () => {
    setLayout({ hidden: ["rel"] });
    const m = mount(FULL);
    try {
      expect(m.findAll(".d-tabs .tk").map((b) => b.textContent)).toEqual(["目录", "评论"]);
    } finally { m.unmount(); }
  });

  it("【关键】正在看的面板被关掉 → 自动落到还可见的第一个（不会变成空盒）", () => {
    // `tab` 的初值是 "dir"；把 dir 关掉后若不派生 activePanel，这一块会"横栏也没有、内容也没有"。
    setLayout({ hidden: ["dir"] });
    const m = mount(FULL);
    try {
      const tks = m.findAll(".d-tabs .tk");
      expect(tks.map((b) => b.textContent)).toEqual(["评论", "相关漫画 1"]);
      expect(tks[0].getAttribute("data-on")).toBe("1");   // 落在还可见的第一个上
      expect(m.find(".chap-list")).toBeNull();             // 被关掉的目录确实没渲染
    } finally { m.unmount(); }
  });

  it("面板顺序跟着配置走（把相关漫画提到最前）", () => {
    setLayout({ panels: ["rel", "dir", "cmt"], hidden: ["cmt"] });
    const m = mount(FULL);
    try {
      expect(m.findAll(".d-tabs .tk").map((b) => b.textContent)).toEqual(["相关漫画 1", "目录"]);
    } finally { m.unmount(); }
  });
});
