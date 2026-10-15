import { describe, expect, it } from "vitest";
import {
  DESIGN_W,
  FLING_V,
  GAP,
  PEEK_MAX,
  PEEK_MIN,
  cardLeft,
  frontIndex,
  pagerGeom,
  restX,
  rubberX,
  snapIndex,
  visibleW
} from "./galleryPager";

/**
 * 画廊翻页几何 / 吸附判定的契约。
 *
 * 这些式子为什么值得单测：上一版（"缩小后相叠"）的几何被调研报告算错过一次 ——
 * 把内边距减了两次（268+46+12+32 ≠ 390），而那种错在界面上表现为"卡片跟容器对不齐"，
 * 不看公式很难定位。所以第一条就是**自检等式**。
 */

const N = 2;
const PHONE = 358;      // 390 手机：390 − 2×16 padding
const DESKTOP = 768;    // 桌面 1280：inner max-width 800 − 2×16

describe("galleryPager 几何", () => {
  it("【自检】手机：卡宽 + 间距 + 露出 === 轨道宽（±0.5）", () => {
    const g = pagerGeom(PHONE, N);
    expect(g.wide).toBe(false);
    expect(Math.abs(g.cw + GAP + g.peek - PHONE)).toBeLessThanOrEqual(0.5);
  });

  it("手机：露出量落在 [40,56] 且 ≤ 0.17×卡宽（只露边缘，不是露半张）", () => {
    const g = pagerGeom(PHONE, N);
    expect(g.peek).toBeGreaterThanOrEqual(PEEK_MIN);
    expect(g.peek).toBeLessThanOrEqual(PEEK_MAX);
    expect(g.peek).toBeLessThanOrEqual(0.17 * g.cw);
  });

  it("手机：卡宽 ≈298（上一版是 252/满宽 358 两种病态）", () => {
    const g = pagerGeom(PHONE, N);
    expect(Math.round(g.cw)).toBe(298);
  });

  it("任何宽度下卡宽都不超过缩略图设计宽（否则 k 被夹在 1、右侧留白）", () => {
    for (let w = 200; w <= 900; w += 2) {
      const g = pagerGeom(w, N);
      expect(g.cw).toBeLessThanOrEqual(DESIGN_W + 0.5);
    }
  });

  it("中等宽度（676）走两栏、卡宽 332 —— 不是「掉进 peek 模式算成 560」", () => {
    const g = pagerGeom(676, N);
    expect(g.wide).toBe(true);
    expect(g.peek).toBe(0);
    expect(g.cw).toBeLessThanOrEqual(DESIGN_W);
  });

  it("桌面 768：两栏各 378（k=0.97，不放大）", () => {
    const g = pagerGeom(DESKTOP, N);
    expect(g.wide).toBe(true);
    expect(Math.round(g.cw)).toBe(378);
  });

  /**
   * ★ v3.13：宽屏下**页数增加不该让卡变小**（页数从 2 变 4 时真踩到过）。
   *
   * 旧式子是 `(w − (n−1)×GAP) / n` = "所有页并排一行"：n=4 时每张 183px，
   * 比判据"桌面卡宽必须落在 [200,390]"还小 —— 界面上就是"四张小米粒浮在大片空白里"。
   * 现在固定 `WIDE_COLS = 2` 列、多出来的换行，所以**四页与两页的卡宽必须逐字相等**。
   */
  it("★ 宽屏四页与两页的卡宽**完全相同**（宽屏固定两列，页数多了换行）", () => {
    const two = pagerGeom(DESKTOP, 2);
    const four = pagerGeom(DESKTOP, 4);
    expect(four.wide).toBe(true);
    expect(four.cw).toBe(two.cw);
    expect(Math.round(four.cw)).toBe(378);
    expect(four.cw).toBeGreaterThanOrEqual(200);   // 与 e2e 的"桌面卡宽"判据同一个下限
    expect(four.pitch).toBe(two.pitch);
  });

  it("极窄（200）仍能算出正数卡宽，且露出取到下限 40", () => {
    const g = pagerGeom(200, N);
    expect(g.peek).toBe(PEEK_MIN);
    expect(g.cw).toBeGreaterThan(100);
  });
});

describe("galleryPager 静息位置与可见宽", () => {
  it("第一页：自己贴左、邻居从右侧露出恰好 peek", () => {
    const g = pagerGeom(PHONE, N);
    const x = restX(g, 0);
    expect(cardLeft(g, 0, x)).toBe(0);
    expect(visibleW(g, 0, x)).toBeCloseTo(g.cw, 5);
    expect(visibleW(g, 1, x)).toBeCloseTo(g.peek, 5);
  });

  it("最后一页：自己贴右、上一页从左侧露出同样一段（否则右边空一条）", () => {
    const g = pagerGeom(PHONE, N);
    const x = restX(g, 1);
    expect(cardLeft(g, 1, x) + g.cw).toBeCloseTo(g.w, 5);
    expect(visibleW(g, 1, x)).toBeCloseTo(g.cw, 5);
    expect(visibleW(g, 0, x)).toBeCloseTo(g.peek, 5);
    expect(cardLeft(g, 0, x) + g.cw).toBeCloseTo(g.peek, 5);
  });

  it("两次静息位置相差 卡宽 − 露出（因为最后一页要贴右，步长不是常数）", () => {
    const g = pagerGeom(PHONE, N);
    expect(restX(g, 0) - restX(g, 1)).toBeCloseTo(g.cw - g.peek, 5);
  });

  it("前卡判定：跟随「谁露得更多」，中点处两者等宽 → 判给原前卡（不打平局抖动）", () => {
    const g = pagerGeom(PHONE, N);
    const mid = (restX(g, 0) + restX(g, 1)) / 2;
    expect(frontIndex(g, restX(g, 0))).toBe(0);
    expect(frontIndex(g, restX(g, 1))).toBe(1);
    // 中点：两张卡露出的一样多（都是 (w−GAP)/2）→ 不能来回翻，判给原来那张
    expect(visibleW(g, 0, mid)).toBeCloseTo(visibleW(g, 1, mid), 5);
    expect(frontIndex(g, mid)).toBe(0);
    expect(frontIndex(g, mid - 20)).toBe(1);   // 越过中点 → 后者在前
    expect(frontIndex(g, mid + 20)).toBe(0);
    const w = pagerGeom(DESKTOP, N);
    expect(frontIndex(w, 0)).toBe(-1);                                 // 宽屏两栏：没有前/后
  });

  it("宽屏两栏：两卡都在 [0,w] 内、互不重叠", () => {
    const g = pagerGeom(DESKTOP, N);
    const x = restX(g, 0);
    expect(cardLeft(g, 0, x)).toBe(0);
    expect(cardLeft(g, 1, x)).toBeCloseTo(g.cw + GAP, 5);
    expect(cardLeft(g, 1, x) + g.cw).toBeLessThanOrEqual(DESKTOP + 0.5);
  });
});

describe("galleryPager 吸附", () => {
  const g = pagerGeom(PHONE, N);
  const step = restX(g, 0) - restX(g, 1);   // 250

  it("距离过半 → 翻页；不足一半且速度≈0 → 回弹", () => {
    expect(snapIndex(g, 0, restX(g, 0) - 0.55 * step, 0)).toBe(1);
    expect(snapIndex(g, 0, restX(g, 0) - 0.40 * step, 0)).toBe(0);
  });

  it("【判别性】快划 40px（v=0.5 ≥ 0.3）→ 必须翻页 —— 距离远不够，靠速度", () => {
    const x = restX(g, 0) - 40;
    expect(40).toBeLessThan(0.5 * step);          // 前提：距离没到"过半"
    expect(snapIndex(g, 0, x, -0.5)).toBe(1);     // 速度说了算
    expect(snapIndex(g, 0, x, -0.29)).toBe(0);    // 差一点点速度 → 回弹
  });

  it("反向：从第二页快划回来", () => {
    const x = restX(g, 1) + 40;
    expect(snapIndex(g, 1, x, 0.5)).toBe(0);
    expect(snapIndex(g, 1, x, 0.1)).toBe(1);
  });

  it("边界：没有上一页/下一页时，速度再大也只能原地", () => {
    expect(snapIndex(g, 0, restX(g, 0) + 40, 0.9)).toBe(0);
    expect(snapIndex(g, 1, restX(g, 1) - 40, -0.9)).toBe(1);
  });

  it("单页时不移动", () => {
    const g1 = pagerGeom(PHONE, 1);
    expect(snapIndex(g1, 0, -300, -2)).toBe(0);
  });

  it("速度门槛的常量值与调研一致（Hammer 源码 0.3）", () => {
    expect(FLING_V).toBe(0.3);
  });
});

describe("galleryPager 边界阻尼", () => {
  const g = pagerGeom(PHONE, N);

  it("范围内原样返回", () => {
    expect(rubberX(g, -100)).toBe(-100);
  });

  it("拖过头被压缩（100px 只走 pow(100,0.7)≈25px），且两端对称", () => {
    const hi = rubberX(g, restX(g, 0) + 100) - restX(g, 0);
    const lo = restX(g, 1) - rubberX(g, restX(g, 1) - 100);
    expect(hi).toBeCloseTo(Math.pow(100, 0.7), 5);
    expect(lo).toBeCloseTo(hi, 5);
    expect(hi).toBeLessThan(100);
  });
});
