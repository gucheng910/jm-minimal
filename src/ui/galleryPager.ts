/**
 * 「自定义 UI」画廊的**翻页几何与吸附判定**（纯函数，可单测）。
 *
 * 为什么单独一个文件：这几条式子是上一版画廊最贵的一块 —— 上一版"缩小后相叠"的几何
 * 被调研报告算错过一次（把内边距减了两次：268+46+12+32 ≠ 390），那种错**在界面上表现为
 * "卡片跟容器对不齐"**，很难一眼看出是公式错。所以：
 *   · 几何全在这里，**自检等式** `卡宽 + 间距 + 露出 === 轨道宽` 有单测钉住；
 *   · 吸附规则（距离过半 **或** 速度达标）也有单测，不依赖浏览器里合成事件的时序。
 *
 * 模型（v3.6，隐喻换掉了）：Android Recents / M3 Carousel 都是**单轨 pager + 间距**，
 * 邻居卡**尺寸不变**、被**视口边缘**裁切；AOSP quickstep 里 `overview_minimum_next_prev_size
 * = 50dp`（至少露多少）、`overview_page_spacing = 16dp`。旧版把后卡缩到 0.704 再在
 * **屏幕中间**裁 —— 露出的是被切掉一半的标题和半个按钮，读起来是"渲染坏了"。
 */

/** 缩略图设计宽：卡片不许比它更宽（否则缩略图 k 被夹在 1、右侧留白） */
export const DESIGN_W = 390;
/** 卡间距 */
export const GAP = 12;
/** 邻居卡露出的下限 / 上限 / 占卡宽比例 */
export const PEEK_MIN = 40;
export const PEEK_MAX = 56;
export const PEEK_RATIO = 0.16;
/** 缩略图比例盒（150%）与宽屏卡名行高 */
export const ASPECT = 1.5;
export const LABEL_H = 30;
/** 甩动判定的速度门槛（px/ms）—— Hammer 的 swipe 默认 0.3（文档写 0.5，以源码为准） */
export const FLING_V = 0.3;
/**
 * 宽屏下**并排几列**（v3.13）。
 *
 * 原来宽屏是"所有页并排一行"（两页时正好两栏），v3.13 页面从 2 张变 4 张之后，
 * 同一套式子会把每张压到 `(768−3×12)/4 ≈ 183px` —— 实测断言
 * 「桌面卡片宽度必须落在 [200,390]」直接变红，也就是"四张小米粒浮在大片空白里"。
 * 固定 2 列 + 换行（`index.css` 里 `[data-mode="wide"] .ed-stack` 是 `grid`），
 * 页数再多也只是多一行，卡宽永远是 `min(390, (轨道宽−间距)/2)`。
 */
export const WIDE_COLS = 2;
/** 边界阻尼指数 */
export const RUBBER_POW = 0.7;

export interface PagerGeom {
  /** 轨道宽（= 容器内宽，即去掉 `.ed-gallery-inner` 的 padding） */
  w: number;
  /** 页数 */
  n: number;
  /** 宽屏：静态两栏，两页都完整可见，没有前/后之分 */
  wide: boolean;
  /** 卡宽（布局值，所有卡相同 → 底边天然齐） */
  cw: number;
  /** 邻居卡可见宽（宽屏 = 0） */
  peek: number;
  /** 相邻两卡左边缘间距 */
  pitch: number;
  /** 轨道高度 */
  stackH: number;
}

const clampNum = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 由轨道宽算出几何。
 *
 * **宽屏还是 peek 是倒推出来的，不是拍的断点**：peek 模式下 `卡宽 = w − 间距 − 露出`，
 * 要 ≤ 设计宽（390）就得 `w − 12 − 56 ≤ 390`。沿用调研报告里的 644 断点会在 w≈676 时
 * 掉进 peek 模式、卡宽算成 560 > 390 → 缩略图被夹在 1、右侧留白（历史 bug，有断言守着）。
 */
export function pagerGeom(w: number, n: number): PagerGeom {
  const wide = w - GAP - PEEK_MAX > DESIGN_W;
  const avail = w - GAP;
  const peek = wide ? 0 : clampNum(PEEK_RATIO * (avail / (1 + PEEK_RATIO)), PEEK_MIN, PEEK_MAX);
  const cw = wide ? Math.min(DESIGN_W, (w - (WIDE_COLS - 1) * GAP) / WIDE_COLS) : avail - peek;
  return {
    w, n, wide,
    cw,
    peek,
    pitch: cw + GAP,
    stackH: Math.round(cw * ASPECT + (wide ? LABEL_H : 0))
  };
}

/**
 * 第 k 页在最前时的**静息位移**（轨道坐标系）。
 * · 还有下一页 → 当前页贴左，下一页从右侧露出（`−k × 间距`）；
 * · 已经是最后一页 → 当前页**贴右**，上一页从左侧露出同样一段 ——
 *   否则最后一页时右侧会空出一条（而且上一页完全看不见）。
 */
export function restX(g: PagerGeom, k: number): number {
  const base = -k * g.pitch;
  return g.wide || k < g.n - 1 ? base : g.w - g.cw + base;
}

/** 卡 i 在轨道位移 x 时的左边缘 */
export function cardLeft(g: PagerGeom, i: number, x: number): number {
  return i * g.pitch + x;
}

/** 卡 i 在轨道里**真正露出**的宽度（用于判"谁是前卡"，含拖动中间态） */
export function visibleW(g: PagerGeom, i: number, x: number): number {
  const l = cardLeft(g, i, x);
  return Math.max(0, Math.min(l + g.cw, g.w) - Math.max(l, 0));
}

/** 最靠前的那张卡（宽屏返回 -1：两页地位相同） */
export function frontIndex(g: PagerGeom, x: number): number {
  if (g.wide) return -1;
  let best = 0;
  for (let i = 1; i < g.n; i++) if (visibleW(g, i, x) > visibleW(g, best, x)) best = i;
  return best;
}

/**
 * 边界阻尼：超出静息范围的部分按指数压缩（`pow(over, 0.7)`）。
 * 只有两页时会一直在边界，硬顶会显得"能一直拽"。
 */
export function rubberX(g: PagerGeom, v: number): number {
  const hi = restX(g, 0);
  const lo = restX(g, g.n - 1);
  if (v > hi) return hi + Math.pow(v - hi, RUBBER_POW);
  if (v < lo) return lo - Math.pow(lo - v, RUBBER_POW);
  return v;
}

/**
 * 松手时落在第几页。
 * · 速度达标（`|v| ≥ FLING_V`）→ 按方向翻一页（到边界就原地）；
 * · 否则看**距离**：越过两个静息位置的**中点**（等价于"过半步"）才提交。
 * 两页时两次静息位置相差 `卡宽 − 露出`（因为最后一页要贴右），所以用**实际静息位置**
 * 的中点判定，而不是固定像素 —— 步长不是常数。
 */
export function snapIndex(g: PagerGeom, start: number, x: number, v: number): number {
  if (g.n <= 1) return 0;
  if (Math.abs(v) >= FLING_V) {
    const cand = start + (v < 0 ? 1 : -1);
    return cand >= 0 && cand < g.n ? cand : start;
  }
  if (start < g.n - 1 && x <= (restX(g, start) + restX(g, start + 1)) / 2) return start + 1;
  if (start > 0 && x >= (restX(g, start) + restX(g, start - 1)) / 2) return start - 1;
  return start;
}
