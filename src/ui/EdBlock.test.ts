// @vitest-environment jsdom
/**
 * 画布块拖拽手势（hooks/useCanvasDrag.ts，经 ui/EdBlock 接线）。
 *
 * 这个 hook 的价值全在**手势分界线**上，所以测试也只测分界线：
 *   1. 触摸：长按 280ms 才起拖（按下就拖会和滚动画布打架）；
 *   2. 计时没到就大幅移动 = 是滚动 → 取消长按，**绝不许起拖**（手势不被劫持）；
 *   3. 鼠标：位移阈值起拖（点击与拖拽靠位移区分）；
 *   4. ⠿ 手柄：按下立即拖 —— 触摸手势被系统抢走时的退路，必须永远可用；
 *   5. pointercancel / pointerup 一律复位（来电/切后台会走到 cancel）。
 *
 * v3 追加（跟手镜像 / 插入缝）只测**不变量**，不测观感：
 *   6. 起拖后有 `.ed-ghost` 镜像，但镜像**不许**算成一块（`.ed-blk` 计数不变）——
 *      镜像一旦混进块集合，落点判定与顺序断言会整体歪一格；
 *   7. 拖动中有 `.ed-gap` 插入缝，且它挂在"坑"上（跟着让位动画一起滑）；
 *   8. 松手 / cancel / 卸载三条路，镜像与缝都得撤干净。
 *   （跟手的 transform 变化是**真实浏览器**里的视觉契约，交给 e2e 的 `canvas-ghost` 验。）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import EdBlock from "./EdBlock";

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

/** 两块 a / b，套在 [data-drag-list] 容器里（hook 靠它反查所属列表）。
 *  children 走 createElement 第三参（react(no-children-prop)）；Props 的 children
 *  在类型上是必填，用断言补平（测试里只给文本子节点）。 */
type EdProps = ComponentProps<typeof EdBlock>;
function eb(id: string, onMoveTo: (id: string, index: number) => void) {
  const props = { id, index: id === "a" ? 0 : 1, selected: false, onSelect: () => { /* noop */ }, onMoveTo } as unknown as EdProps;
  return createElement(EdBlock, props, id.toUpperCase());
}

function mountBlocks(onMoveTo: (id: string, index: number) => void): HTMLElement {
  return render(createElement("div", { "data-drag-list": "" }, eb("a", onMoveTo), eb("b", onMoveTo)));
}

/** 合成 pointer 事件（jsdom 没有 PointerEvent，用 MouseEvent + 补字段）。
 *  `pointerId` 默认 1；多指用例传 2/3 来表达"另一根手指"。 */
function pe(target: Element, type: string, y: number, pointerType = "touch", pointerId = 1) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, clientX: 0 });
  Object.defineProperty(ev, "pointerType", { value: pointerType });
  Object.defineProperty(ev, "pointerId", { value: pointerId });
  act(() => { target.dispatchEvent(ev); });
}

/**
 * 原生 Touch 事件（jsdom 没有 TouchEvent，用 Event + 补 `touches`）。
 * `fingers` 表达手指根数（多指 = 系统缩放/系统手势，不该被我们抢）。
 * 返回事件本身，好断言 `defaultPrevented` —— v3 的真机病根就锁在这一条上。
 */
function te(target: Element, type: string, y: number, fingers = 1) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "touches", {
    value: type === "touchend"
      ? []
      : Array.from({ length: fingers }, (_, i) => ({ clientX: 0, clientY: y, identifier: i }))
  });
  act(() => { target.dispatchEvent(ev); });
  return ev;
}

const blk = (host: HTMLElement, i: number) => host.querySelectorAll<HTMLElement>(".ed-blk")[i];

describe("触摸：长按起拖", () => {
  it("长按 280ms 后进入拖动态，拖动中实时换位，松手复位", () => {
    const moves: Array<[string, number]> = [];
    const host = mountBlocks((id, index) => moves.push([id, index]));
    const a = blk(host, 0);

    pe(a, "pointerdown", 0);
    expect(a.className).not.toContain("ed-drag"); // 按下 ≠ 起拖
    act(() => { vi.advanceTimersByTime(300); });
    expect(a.className).toContain("ed-drag");     // 长按到点才起拖

    pe(a, "pointermove", 5000);                   // jsdom 里块都是 0 高：y 越大越靠后
    expect(moves.length).toBeGreaterThan(0);
    expect(moves[moves.length - 1][0]).toBe("a");

    pe(a, "pointerup", 5000);
    expect(a.className).not.toContain("ed-drag");
  });

  it("【关键】计时没到就大幅移动 = 滚动：取消长按，绝不许起拖", () => {
    const moves: Array<[string, number]> = [];
    const host = mountBlocks((id, index) => moves.push([id, index]));
    const a = blk(host, 0);

    pe(a, "pointerdown", 0);
    pe(a, "pointermove", 200);          // 12px 内是犹豫，超过 = 滚动意图
    act(() => { vi.advanceTimersByTime(500); });
    expect(a.className).not.toContain("ed-drag");
    pe(a, "pointermove", 5000);         // 之后再怎么动也不起拖（计时已取消）
    expect(moves.length).toBe(0);
    pe(a, "pointerup", 5000);
    expect(a.className).not.toContain("ed-drag");
  });

  it("12px 内的小抖动不取消长按（手指不可能绝对不动）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    pe(a, "pointerdown", 0);
    pe(a, "pointermove", 5);
    act(() => { vi.advanceTimersByTime(300); });
    expect(a.className).toContain("ed-drag");
    pe(a, "pointerup", 5);
  });
});

describe("鼠标：位移阈值起拖", () => {
  it("4px 内是点击，超过才拖", () => {
    const moves: Array<[string, number]> = [];
    const host = mountBlocks((id, index) => moves.push([id, index]));
    const b = blk(host, 1);

    pe(b, "pointerdown", 0, "mouse");
    pe(b, "pointermove", 2, "mouse");
    expect(b.className).not.toContain("ed-drag");
    pe(b, "pointermove", 10, "mouse");
    expect(b.className).toContain("ed-drag");
    /**
     * ⚠️ v3.5：起拖之后**还要走够死区**（`max(24px, 0.5 × 块高)`）落点才会变 ——
     * jsdom 没有布局引擎（所有 offset/rect 都是 0，块高取不到 → 死区走 24px 下限），
     * 而跟手镜像每帧只朝指针走 35%（`FOLLOW_EASE`），所以这里多推几次让镜像收敛过去。
     * 旧版门槛是"接触即换位"（几像素就够），那时一次 move 就够 —— 这是**判据反转**，有意改的
     * （用户原话："太灵敏了，稍微动一下就变化许多"）。
     */
    for (const y of [30, 50, 70, 90, 110]) pe(b, "pointermove", y, "mouse");
    expect(moves.length).toBeGreaterThan(0);
    pe(b, "pointerup", 110, "mouse");
    expect(b.className).not.toContain("ed-drag");
  });
});

describe("【v3.3】块上不再有抓手：只靠长按块本体拖动", () => {
  it("DOM 里没有 .ed-grip / .ed-namechip / 序号角标（用户要求去掉那个碍眼的黑框）", () => {
    const host = mountBlocks(() => { /* noop */ });
    expect(host.querySelectorAll(".ed-grip").length).toBe(0);
    expect(host.querySelectorAll(".ed-namechip").length).toBe(0);
    expect(host.querySelectorAll(".ed-badge").length).toBe(0);
  });

  it("长按块本体仍能起拖并报告落点（拖动入口只剩这一条）", () => {
    const moves: Array<[string, number]> = [];
    const host = mountBlocks((id, index) => moves.push([id, index]));
    const a = blk(host, 0);

    pe(a, "pointerdown", 0);
    expect(a.className).not.toContain("ed-drag");   // 还没到长按阈值
    act(() => { vi.advanceTimersByTime(300); });
    expect(a.className).toContain("ed-drag");       // 长按到点 → 进拖动态

    pe(a, "pointermove", 40);
    // v3.5：要推过死区（jsdom 里块高取不到 → 24px 下限），镜像每帧只走 35%
    for (const y of [60, 80, 100, 120]) pe(a, "pointermove", y);
    expect(moves.length).toBeGreaterThan(0);
    pe(a, "pointerup", 120);
    expect(a.className).not.toContain("ed-drag");
  });
});

describe("复位", () => {
  it("pointercancel 一律复位（来电/切后台会走到它）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    pe(a, "pointerdown", 0);
    act(() => { vi.advanceTimersByTime(300); });
    expect(a.className).toContain("ed-drag");
    pe(a, "pointercancel", 0);
    expect(a.className).not.toContain("ed-drag");
  });

  it("计时中被 cancel：长按不再生效", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    pe(a, "pointerdown", 0);
    pe(a, "pointercancel", 0);
    act(() => { vi.advanceTimersByTime(500); });
    expect(a.className).not.toContain("ed-drag");
  });
});

describe("v3 跟手镜像（ghost）与插入缝", () => {
  /** 镜像挂在 [data-drag-list] 里（这样能保留 .detail-card[data-dl-*] 的样式上下文） */
  const ghosts = (host: HTMLElement) => host.querySelectorAll<HTMLElement>(".ed-ghost");
  /** 长按到点起拖 */
  const longPress = (el: HTMLElement) => {
    pe(el, "pointerdown", 0);
    act(() => { vi.advanceTimersByTime(300); });
  };

  it("起拖后抬起镜像：它是纯替身，不许混进「块」集合", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    expect(host.querySelectorAll(".ed-blk").length).toBe(2);

    longPress(a);

    expect(ghosts(host).length).toBe(1);
    const g = ghosts(host)[0];
    // 这三个标记任何一个留在镜像上，FLIP / indexAt / e2e 顺序断言都会被它骗
    expect(g.classList.contains("ed-blk")).toBe(false);
    expect(g.hasAttribute("data-blk")).toBe(false);
    expect(g.classList.contains("ed-ghost")).toBe(true);
    // 编辑痕迹（缝）不跟着复制，否则 e2e 的缝计数会多出来
    // （v3.3 起抓手/序号已从块上删除，这里只剩缝要查）
    expect(g.querySelectorAll(".ed-gap").length).toBe(0);
    // 块的计数一格不多
    expect(host.querySelectorAll(".ed-blk").length).toBe(2);
    pe(a, "pointerup", 0);
  });

  it("拖动中有插入缝，且它挂在「坑」上（要让位动画把它一起带走）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    longPress(a);

    expect(a.className).toContain("ed-drag");     // 本块变成"坑"
    expect(host.querySelectorAll(".ed-gap").length).toBe(1);
    expect(a.querySelectorAll(".ed-gap").length).toBe(1); // 缝在坑里，不在镜像里
    pe(a, "pointerup", 0);
  });

  it("松手：镜像与缝一起撤走", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    longPress(a);
    expect(ghosts(host).length).toBe(1);

    pe(a, "pointerup", 0);

    expect(ghosts(host).length).toBe(0);
    expect(host.querySelectorAll(".ed-gap").length).toBe(0);
    expect(a.className).not.toContain("ed-drag");
  });

  it("pointercancel：镜像也要撤（来电 / 切后台会走到它）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    longPress(a);
    expect(ghosts(host).length).toBe(1);

    pe(a, "pointercancel", 0);

    expect(ghosts(host).length).toBe(0);
    expect(host.querySelectorAll(".ed-gap").length).toBe(0);
  });

  it("拖到一半卸载：镜像不许留在页面上（卸载兜底）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    longPress(a);
    expect(ghosts(host).length).toBe(1);

    const root = roots[roots.length - 1];
    act(() => { root.unmount(); });
    roots.pop(); // 已经卸过了，别让 afterEach 再卸一次

    expect(ghosts(host).length).toBe(0);
  });
});

describe("v3 真机触摸：把滚动手势抢过来（手机上拖不动的病根）", () => {
  /**
   * 旧版只靠 Pointer 事件，而 `.ed-blk` 没有 `touch-action`：手势一开始浏览器就把
   * **竖向平移判给滚动**，长按到点、手指一动就 `pointercancel` —— 拖拽当场死。
   * 修法是块上一个**非被动**的原生 `touchmove`：**抓起之后每一次都 preventDefault**。
   * 下面几条锁的就是这个契约（合成 pointer 事件测不出它，所以以前 e2e 全绿也是假安全）。
   */
  it("抓起后 touchmove 必须被 preventDefault（否则平移被判给滚动，拖拽被打断）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    pe(a, "pointerdown", 0);
    act(() => { vi.advanceTimersByTime(300); });
    expect(a.className).toContain("ed-drag");

    expect(te(a, "touchmove", 40).defaultPrevented).toBe(true); // ← 病根就是这一条以前没人做
    pe(a, "pointerup", 0);
  });

  it("没抓起时不许碰手势（滚动照常：该滚滚、该拖拖）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);

    expect(te(a, "touchmove", 40).defaultPrevented).toBe(false); // 连按下都没有
    pe(a, "pointerdown", 0);
    expect(te(a, "touchmove", 41).defaultPrevented).toBe(false); // 长按还没到点 = 用户想滚
    pe(a, "pointerup", 0);
  });

  it("touchcancel（浏览器判定要滚了）把待命的长按作废", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    pe(a, "pointerdown", 0);
    te(a, "touchcancel", 0);
    act(() => { vi.advanceTimersByTime(500); });
    expect(a.className).not.toContain("ed-drag");
  });

  it("多指按下：长按作废（别跟系统缩放抢手势）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    pe(a, "pointerdown", 0);
    te(a, "touchmove", 0, 2);
    act(() => { vi.advanceTimersByTime(500); });
    expect(a.className).not.toContain("ed-drag");
  });

  it("touchcancel 中途收尾：镜像撤干净，且落盘回调只跑一次（幂等）", () => {
    let ends = 0;
    const props = {
      id: "a", index: 0, selected: false,
      onSelect: () => { /* noop */ },
      onMoveTo: () => { /* noop */ },
      onDragEnd: () => { ends++; }
    } as unknown as EdProps;
    const host = render(createElement("div", { "data-drag-list": "" }, createElement(EdBlock, props, "A")));
    const a = host.querySelectorAll<HTMLElement>(".ed-blk")[0];

    pe(a, "pointerdown", 0);
    act(() => { vi.advanceTimersByTime(300); });
    expect(host.querySelectorAll(".ed-ghost").length).toBe(1);

    te(a, "touchcancel", 0);
    expect(host.querySelectorAll(".ed-ghost").length).toBe(0);
    expect(ends).toBe(1);

    pe(a, "pointercancel", 0); // 同一个手势的另一条事件流：不许再提交一次
    expect(ends).toBe(1);
  });
});

/**
 * 多指（审计 S-1：镜像永久泄漏 + 拖拽被第二根手指劫持）。
 *
 * 手机单手握持、双指缩放、误触都会走到这里。旧版三处缺口导致三个用户可见的毛病：
 *   ① `begin()` 无重入守卫 → 第二根手指长按会**再克隆一个镜像**，而 `ghostRef` 只记得
 *      最后一个，前一个成了永远清不掉的孤儿（用户看到"界面坏了"）；
 *   ② 全文件没有 pointerId 归属追踪 → 第二根手指一动就把落点与镜像带走；
 *   ③ `stopGhost` 只删 ref 里那一个 → 孤儿无处回收。
 */
describe("多指（多根手指 / 一屏两块）", () => {
  const ghosts = (host: HTMLElement) => host.querySelectorAll<HTMLElement>(".ed-ghost");
  const longPress = (el: HTMLElement, pointerId = 1) => {
    pe(el, "pointerdown", 0, "touch", pointerId);
    act(() => { vi.advanceTimersByTime(300); });
  };

  it("拖拽中第二根手指按住同一块：不产生第二个镜像，不许劫持落点与收尾", () => {
    const moves: Array<[string, number]> = [];
    const host = mountBlocks((id, index) => moves.push([id, index]));
    const a = blk(host, 0);

    longPress(a, 1); // 第一根手指起拖
    expect(ghosts(host).length).toBe(1);

    longPress(a, 2); // 第二根手指按住同一块并停满长按阈值
    expect(ghosts(host).length).toBe(1); // ① 重入守卫：镜像仍然只有一个

    const before = moves.length;
    pe(a, "pointermove", 5000, "touch", 2); // ② 第二根手指移动
    expect(moves.length).toBe(before);      // 落点一次都不许被它改

    pe(a, "pointermove", 5000, "touch", 1); // 第一根手指照常驱动
    expect(moves.length).toBeGreaterThan(before);

    pe(a, "pointerup", 5000, "touch", 2);   // 第二根手指松开
    expect(a.className).toContain("ed-drag"); // 别人的拖拽不许被它结束

    pe(a, "pointerup", 5000, "touch", 1);   // 第一根手指松开才收尾
    expect(a.className).not.toContain("ed-drag");
    expect(ghosts(host).length).toBe(0);
  });

  it("一块在拖时，另一块不许同时起拖（全局单拖：两个镜像会互相打架）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    const b = blk(host, 1);

    longPress(a, 1);
    expect(ghosts(host).length).toBe(1);

    longPress(b, 2); // 第二根手指按住**另一块**
    expect(ghosts(host).length).toBe(1);       // 没多出第二个镜像
    expect(b.className).not.toContain("ed-drag"); // 那块没被拖起来

    pe(a, "pointerup", 0, "touch", 1);
    expect(ghosts(host).length).toBe(0);
  });

  it("收尾兜底：连没有 ref 指向的残留镜像也一并清掉（③）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    const list = host.querySelector<HTMLElement>("[data-drag-list]")!;

    longPress(a, 1);
    expect(ghosts(host).length).toBe(1);

    // 伪造一个"上一次异常收尾"留下的孤儿：没有任何 ref 指向它
    const orphan = document.createElement("div");
    orphan.className = "ed-ghost";
    list.appendChild(orphan);
    expect(ghosts(host).length).toBe(2);

    pe(a, "pointerup", 0, "touch", 1);
    expect(ghosts(host).length).toBe(0); // 真镜像与孤儿都不许留下
  });
});

/**
 * v3.1：用户实测的"拖拽卡死"（原话：「稍微晃一下…组件悬着动不了」「黑框还在原地」「拖拽失效了」）。
 *
 * 真机因果链：拖动中换位用 `insertBefore` **移动 DOM 节点** → 节点一移动，指针捕获
 * （触摸是浏览器隐式给的）被释放（实测 `lostcapture:1`）→ 此后事件**不再投递给被拖块**，
 * 而投给"手指下方当前的元素"（实测：12 个 move 只有 3 个命中被拖块，其余落在
 * `d-title` / `d-hero-info`，`pointerup` 也落在 `d-title`）。
 *
 * 下面几例把事件**派发到别的元素**上，就是那个现象的最小复刻；修法是把 move/up/cancel
 * 挂到 window（对捕获丢失免疫），元素级处理器只负责起拖。
 *
 * ⚠️ 关于"卡死自愈"分支：模块级兜底（window 上监听指针消失）已经让**陈旧占用态在事件
 * 层面不可达** —— 这正是修法的目的。所以这里断言的是**用户可见的契约**（收尾必达、
 * 锁必释放、二次可拖）；自愈分支属纵深防御，覆盖的是未知路径（如内核不派发 pointerup）。
 */
describe("v3.1 捕获丢失不再卡死（window 级收尾）", () => {
  const ghosts = (host: HTMLElement) => host.querySelectorAll<HTMLElement>(".ed-ghost");
  const longPress = (el: HTMLElement, pointerId = 1) => {
    pe(el, "pointerdown", 0, "touch", pointerId);
    act(() => { vi.advanceTimersByTime(300); });
  };

  it("【关键】move 落在别处（事件不回被拖块）时，镜像仍必须跟随", () => {
    const moves: Array<[string, number]> = [];
    const host = mountBlocks((id, index) => moves.push([id, index]));
    const a = blk(host, 0);
    longPress(a);
    const g = ghosts(host)[0];
    expect(g).toBeTruthy();
    const before = g.style.transform;

    pe(document.body, "pointermove", 5000); // 目标不是被拖块 —— 捕获丢失后的真机行为

    expect(moves.length).toBeGreaterThan(0);      // 落点仍在推进
    expect(g.style.transform).not.toBe(before);   // 镜像仍在跟手（否则「悬着动不了」）
    pe(document.body, "pointerup", 5000);
  });

  it("【关键】在被拖块之外松手也必须收尾干净（否则「黑框还在原地」）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    longPress(a);
    expect(a.className).toContain("ed-drag");
    expect(ghosts(host).length).toBe(1);

    pe(document.body, "pointerup", 5000); // 松手落在别处

    expect(a.className).not.toContain("ed-drag");
    expect(ghosts(host).length).toBe(0);
    expect(host.querySelectorAll(".ed-gap").length).toBe(0);
  });

  it("【关键】窗口级收尾后能立刻再拖一次（全局锁没泄漏 = 否则「拖拽失效了」）", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    const b = blk(host, 1);

    longPress(a, 1);
    pe(document.body, "pointerup", 0, "touch", 1); // 第一次在块外松手
    expect(ghosts(host).length).toBe(0);

    longPress(b, 2);                               // 紧接着拖第二块
    expect(b.className).toContain("ed-drag");
    expect(ghosts(host).length).toBe(1);
    // 第二次收尾也要认对指针：只有驱动它的那根手指松开才算结束（S-1 的归属校验不破）
    pe(document.body, "pointerup", 0, "touch", 1);
    expect(ghosts(host).length).toBe(1);            // 非驱动指针抬起来，拖拽不许被打断
    pe(document.body, "pointerup", 0, "touch", 2);
    expect(ghosts(host).length).toBe(0);
  });

  it("窗口失焦（切页 / 下拉通知栏 / 来电）一律收尾，不留悬挂态", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    longPress(a);
    expect(ghosts(host).length).toBe(1);

    act(() => { window.dispatchEvent(new Event("blur")); });

    expect(a.className).not.toContain("ed-drag");
    expect(ghosts(host).length).toBe(0);
  });

  it("lostpointercapture 不是结束信号：捕获丢了但手指还在动，拖拽必须继续", () => {
    const host = mountBlocks(() => { /* noop */ });
    const a = blk(host, 0);
    longPress(a);

    act(() => { a.dispatchEvent(new Event("lostpointercapture", { bubbles: true })); });

    expect(a.className).toContain("ed-drag"); // 没被误当成收尾
    expect(ghosts(host).length).toBe(1);
    pe(document.body, "pointerup", 0);
  });
});
