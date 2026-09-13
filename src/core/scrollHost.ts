/**
 * 阅读器的「滚动宿主」判定 —— **全项目唯一实现**。
 *
 * 阅读器有两种滚动宿主：
 *   · 在线阅读        —— 窗口滚动（window.scrollY）
 *   · 缓存中心离线阅读 —— 固定定位的 `.cache-overlay` 容器内滚动（container.scrollTop）
 *
 * 为什么要单独抽出来（2026-09-13 代码审查）：这段判断原本在 Reader.tsx 里有两份，
 * 一份在"当前页检测"的 effect 里内联走 DOM，一份是 `readerScrollHost()` 辅助函数，
 * 两处的判定条件并不完全一致。commit 39b8105 修的正是"老内核上只改了一处"造成的回归
 * （WebView 57 上 `document.scrollingElement` 返回 body，而 body 自身不滚动）。
 * 现在条件只写一遍，两处调用共享，并由 scrollHost.test.ts 兜住。
 */

/** 一个元素要算"能滚"，必须是 overflow auto/scroll **且内容确实溢出** */
function isScrollable(el: HTMLElement | null): boolean {
  if (!el) return false;
  const cs = getComputedStyle(el);
  if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") return false;
  return el.scrollHeight > el.clientHeight + 2;
}

/**
 * 从起始元素向上找最近的滚动容器。
 * 走到 body 就停（body 的滚动按"窗口滚动"处理，见下方 isWindow）。
 */
export function findScrollHost(start: Element | null): HTMLElement | null {
  let walk = start instanceof HTMLElement ? start.parentElement : null;
  while (walk && walk !== document.body) {
    if (isScrollable(walk)) return walk;
    walk = walk.parentElement;
  }
  return null;
}

/**
 * 量测用的元素：`scrollHeight / clientHeight / scrollTop` 以它为准。
 *
 * **不能只信 `document.scrollingElement`**：小米 4W（Android 6 / WebView 57）上它返回 `<body>`，
 * 而 body 自身不滚动（scrollHeight === clientHeight）→ "布局还没立起来"的守卫会恒为真，
 * 页码计数、浮标唤起、锚点补偿在老设备上全部失效（2026-09-12 真机定位）。
 * 所以按 嵌套宿主 → scrollingElement → documentElement → body 的顺序挑一个"真的能滚"的。
 */
export function measuredHost(scroller: HTMLElement | null): HTMLElement {
  const candidates: HTMLElement[] = [];
  if (scroller) candidates.push(scroller);
  const se = document.scrollingElement as HTMLElement | null;
  if (se) candidates.push(se);
  candidates.push(document.documentElement);
  if (document.body) candidates.push(document.body);
  for (const el of candidates) {
    if (el && el.scrollHeight > el.clientHeight + 2) return el;
  }
  return candidates[0] || document.documentElement;
}

export interface ReaderScrollHost {
  /** 真正滚动的元素；null 表示"窗口滚动" */
  scroller: HTMLElement | null;
  /** 量测元素（永远非 null） */
  measured: HTMLElement;
  /** 是否窗口滚动 —— 阅读参考线的坐标系随之不同，事件也挂到 window 上 */
  isWindow: boolean;
}

/**
 * 定位阅读器实际的滚动宿主。
 *
 * @param root 阅读器根元素（`.reader-wrap`）。**必须传**：不限定范围时
 *             `document.querySelectorAll(".jm-figure")` 会同时命中缓存中心里那份离线阅读器，
 *             两个阅读器同时挂载时会量到别人的 DOM。
 */
export function resolveReaderScrollHost(root?: HTMLElement | null): ReaderScrollHost {
  const scope: ParentNode = root || document;
  const figs = scope.querySelectorAll<HTMLElement>(".jm-figure");
  const seed: Element | null = figs.length > 0 ? figs[0] : root instanceof HTMLElement ? root : null;
  const scroller = findScrollHost(seed);
  return { scroller, measured: measuredHost(scroller), isWindow: scroller === null };
}

/** 滚动宿主上的当前滚动量（窗口宿主走 window.scrollY） */
export function scrollTopOf(host: ReaderScrollHost): number {
  return host.isWindow ? window.scrollY : host.scroller ? host.scroller.scrollTop : 0;
}

/** 把滚动位置写回宿主 */
export function scrollToTopOf(host: ReaderScrollHost, y: number): void {
  if (host.isWindow || !host.scroller) window.scrollTo(0, y);
  else host.scroller.scrollTop = y;
}

/** 相对滚动（锚点补偿用） */
export function scrollByHost(host: ReaderScrollHost, dy: number): void {
  if (host.isWindow || !host.scroller) window.scrollBy(0, dy);
  else host.scroller.scrollTop += dy;
}
