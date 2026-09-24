// 页面栈（导航的唯一真相）—— 纯函数，无副作用、不碰 DOM/网络，因此全部可单元测试。
//
// 为什么要有这个模块（2026-09-24 重做）：
//   上一版把「搜索层栈」硬塞进一套为单层设计的状态机里，于是同时存在
//   mode / srOpen / srParent / detailFrom / srStack 五份会互相牵制的状态，
//   派生出来的返回逻辑在「详情B → 搜索X」这种交替链路里会算错目标页面（表现为"回错页面"）。
//   这里改成**把详情层与搜索层放进同一个栈**，栈顶就是当前屏幕，返回 = 弹一层：
//
//     列表 → 详情A → 搜索X → 详情B → 搜索Y
//     返回：        A ← X ← B ← Y        （每弹一层正好是链路上的前一屏）
//
//   于是"返回该回哪里"不再需要任何额外状态：栈自己就是答案。
//
// 不变量（单元测试守着）：
//   · 栈非空时，栈里每个搜索层下方必然存在一个详情层（否则搜索层没有"背后的详情"）；
//   · 深度裁剪只从栈底裁，且裁完仍以详情层开头。
import type { AlbumDetail, AlbumSummary } from "./types";
import type { SRKind } from "../ui/SearchResultPage";

/** 详情层：栈里的一屏详情（进入搜索层之前的那一屏） */
export interface DetailScreen {
  k: "detail";
  /** 层唯一 id：异步回包与滚动恢复都只认它 */
  id: number;
  /** 乐观快照 + 完整详情；返回这一层时用它恢复页面 */
  snap: AlbumDetail;
  /** 离开这一层时的滚动位置（回来时恢复） */
  scroll: number;
}

/** 搜索层：详情页作者/标签/登场人物 → 只读搜索结果页 */
export interface SearchScreen {
  k: "search";
  id: number;
  srKind: SRKind;
  text: string;
  items: AlbumSummary[];
  page: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
}

export type Screen = DetailScreen | SearchScreen;

/** 栈深上限：只从栈底裁旧层，防止反复搜索把内存拖垮 */
export const NAV_MAX_DEPTH = 8;

export function topScreen(stack: Screen[]): Screen | null {
  return stack.length ? stack[stack.length - 1] : null;
}

export function isSearch(scr: Screen | null): scr is SearchScreen {
  return !!scr && scr.k === "search";
}

export function isDetail(scr: Screen | null): scr is DetailScreen {
  return !!scr && scr.k === "detail";
}

/** 该 id 是否还在栈里（异步回包守卫用它，替代上一版"渲染期镜像 ref"那种有竞态的写法） */
export function hasScreen(stack: Screen[], id: number): boolean {
  return stack.some((s) => s.id === id);
}

/**
 * 栈里最靠上的详情层 = 当前应该渲染的那一屏详情。
 *   · 栈顶是详情层 → 就是它自己；
 *   · 栈顶是搜索层 → 是它下面的详情层（搜索层是不透明覆盖层，详情藏在背后）。
 */
export function lastDetail(stack: Screen[]): DetailScreen | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    const s = stack[i];
    if (s.k === "detail") return s;
  }
  return null;
}

/**
 * 压入一层，超深从栈底裁旧层。
 * 约束：裁完栈里必须仍有详情层 —— 搜索层是不透明覆盖层，没有"背后的详情"就无处可回。
 *   · 常规情况：保留末尾 max 层（其中自然含详情层）；
 *   · 极端情况（在同一个详情上连点很多次标签，末尾 max 层里没有详情层）：
 *     改为保留「最近的那个详情层 + 它之后最新的 max-1 层」，既不丢不变量也不无限增长。
 */
export function pushScreen(stack: Screen[], scr: Screen, max = NAV_MAX_DEPTH): Screen[] {
  const next = [...stack, scr];
  if (next.length <= max) return next;
  const win = next.slice(next.length - max);
  if (win.some((s) => s.k === "detail")) return win;
  let d = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].k === "detail") { d = i; break; }
  }
  if (d < 0) return win; // 整栈都没有详情层（正常路径不会发生）：保持窗口，至少不越裁越乱
  const rest = next.slice(Math.max(d + 1, next.length - (max - 1)));
  return [next[d], ...rest];
}

/** 弹掉栈顶一层：调用方据 popped 决定"谁在动画里退场" */
export function popScreen(stack: Screen[]): { rest: Screen[]; popped: Screen | null } {
  if (!stack.length) return { rest: stack, popped: null };
  return { rest: stack.slice(0, -1), popped: stack[stack.length - 1] };
}

/** 就地修改某一层（搜索结果回填、滚动位置记录）。id 不存在时原样返回，方便 React 跳过重渲。 */
export function patchScreen(
  stack: Screen[],
  id: number,
  patch: Partial<Omit<DetailScreen, "k" | "id">> & Partial<Omit<SearchScreen, "k" | "id">>
): Screen[] {
  let hit = false;
  const next = stack.map((s) => {
    if (s.id !== id) return s;
    hit = true;
    return { ...s, ...patch } as Screen;
  });
  return hit ? next : stack;
}

/** 按 id 取某一层（读搜索层当前的分页/忙碌状态用） */
export function screenById(stack: Screen[], id: number): Screen | null {
  return stack.find((s) => s.id === id) ?? null;
}
