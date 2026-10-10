// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  measureSeamBands,
  measureSeamDetail,
  smoothSeams,
  SEAM_VISIBLE_SCORE
} from "./scramble";

/**
 * 去条纹（接缝修复）的判据测试 —— 2026-10-08「本无条纹处误判」修复的回归网。
 *
 * 原缺陷（合成图实测，见 docs/26 的后续编号）：只靠「邻域 |Δy| 中位数 < 2.5 ⇒ 平坦列」
 * 一个判据，中位数对一条细横线完全免疫 → 汉字笔画 / 韩漫全宽分隔条这类
 * 「平坦填充 + 干净边缘」的内容被判成条纹，覆盖 ≥50% 宽度时 score 高达 233（真条纹才 20），
 * 然后把笔画按权重 1 全糊掉（边缘跳变 140 → 1）。
 *
 * 这里用一个 Uint8ClampedArray 冒充 canvas，与真实 getImageData 的 8bit 取整一致
 * （量化是"停早"行为的成因，见最后一个用例）。
 */

const W = 256;
const H = 240;
const B = 120; // parts = 2 → baseH = 120、rem = 0 → 唯一边界正好落在第 120 行

interface Page {
  canvas: HTMLCanvasElement;
  lum: Uint8ClampedArray;
  w: number;
  h: number;
  b: number;
}

function makePage(w = W, h = H, b = B, tone = 200): Page {
  const lum = new Uint8ClampedArray(w * h).fill(tone);
  const ctx = {
    getImageData(x: number, y: number, gw: number, gh: number) {
      const data = new Uint8ClampedArray(gw * gh * 4);
      for (let j = 0; j < gh; j++) {
        for (let i = 0; i < gw; i++) {
          const v = lum[(y + j) * w + (x + i)];
          const o = (j * gw + i) * 4;
          data[o] = v;
          data[o + 1] = v;
          data[o + 2] = v;
          data[o + 3] = 255;
        }
      }
      return { data, width: gw, height: gh } as unknown as ImageData;
    },
    putImageData(img: ImageData, x: number, y: number) {
      for (let j = 0; j < img.height; j++) {
        for (let i = 0; i < img.width; i++) {
          lum[(y + j) * w + (x + i)] = img.data[(j * img.width + i) * 4];
        }
      }
    }
  };
  const canvas = { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, lum, w, h, b };
}

/** 整宽电平台阶：边界那一行起整体降 step 灰阶（模拟编码器切出来的接缝） */
function addStep(p: Page, step: number, fromRow = p.b): void {
  for (let y = fromRow; y < p.h; y++) for (let x = 0; x < p.w; x++) p.lum[y * p.w + x] -= step;
}

/** 一条内容横条：row0 起 rows 行高、x 取 [x0, x1)，填充 fill */
function addBar(p: Page, row0: number, rows: number, x0: number, x1: number, fill = 60): void {
  for (let y = row0; y < row0 + rows; y++) for (let x = x0; x < x1; x++) p.lum[y * p.w + x] = fill;
}

/** 边界处的最大单行跳变（眼睛看到的陡峭度） */
function boundaryJump(p: Page): number {
  let m = 0;
  for (let x = 0; x < p.w; x++) m = Math.max(m, Math.abs(p.lum[p.b * p.w + x] - p.lum[(p.b - 1) * p.w + x]));
  return m;
}
const snapshot = (p: Page) => Uint8ClampedArray.from(p.lum);
function changedPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n += 1;
  return n;
}
/** 某个矩形区域里被改动的像素数 */
function changedInRect(p: Page, before: Uint8ClampedArray, row0: number, row1: number, x0: number, x1: number): number {
  let n = 0;
  for (let y = row0; y < row1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * p.w + x;
      if (before[i] !== p.lum[i]) n += 1;
    }
  }
  return n;
}

describe("真条纹：该修的要修", () => {
  it("整宽电平台阶被判为可见，修复后边界跳变降到 1 灰阶以内", () => {
    const p = makePage();
    addStep(p, 12);
    expect(boundaryJump(p)).toBe(12);
    expect(measureSeamDetail(p.canvas, 2).score).toBeGreaterThan(SEAM_VISIBLE_SCORE);

    const kept = smoothSeams(p.canvas, 2);
    expect(kept).toBeGreaterThanOrEqual(1);
    expect(boundaryJump(p)).toBeLessThanOrEqual(1);
  });

  it("真条纹旁边 6 行外另有一条内容横条时，仍然判得出来（内容否决不能把真条纹一起否掉）", () => {
    const p = makePage();
    addStep(p, 12);
    addBar(p, p.b + 6, 10, 16, 240, 40);
    const bands = measureSeamBands(p.canvas, 2);
    expect(bands).toHaveLength(1);
    // 内容条那一片列被否决，但两侧留白列仍然干净、够样本量
    expect(bands[0].rejected).toBeGreaterThan(0);
    expect(bands[0].n).toBeGreaterThanOrEqual(8);
    expect(measureSeamDetail(p.canvas, 2).score).toBeGreaterThan(SEAM_VISIBLE_SCORE);
    expect(smoothSeams(p.canvas, 2)).toBeGreaterThanOrEqual(1);
  });
});

describe("内容（本无条纹）：不能判、更不许动像素", () => {
  it("全宽文字横画（3 行高、88% 宽、上边缘正压在边界上）：不判为条纹，且一个像素都不改", () => {
    const p = makePage();
    addBar(p, p.b, 3, 16, 240, 60); // 旧实现：覆盖 112/128 个采样列 → score 233，整条笔画被抹平
    const before = snapshot(p);

    const band = measureSeamBands(p.canvas, 2)[0];
    expect(band.rejected).toBeGreaterThan(0); // 内容列被否决
    expect(band.n).toBeGreaterThanOrEqual(8); // 仍留够干净列 —— 说明拦住它的是"否决"，不是"样本不足"
    expect(measureSeamDetail(p.canvas, 2).score).toBeLessThanOrEqual(SEAM_VISIBLE_SCORE);
    expect(smoothSeams(p.canvas, 2)).toBe(0);
    expect(changedPixels(before, p.lum)).toBe(0);
  });

  it("韩漫风格的全宽面板分隔条（5 行高、100% 宽）：同样不判、不动", () => {
    const p = makePage();
    addBar(p, p.b, 5, 0, W, 25);
    const before = snapshot(p);
    expect(measureSeamDetail(p.canvas, 2).score).toBeLessThanOrEqual(SEAM_VISIBLE_SCORE);
    expect(smoothSeams(p.canvas, 2)).toBe(0);
    expect(changedPixels(before, p.lum)).toBe(0);
  });

  it("文字横画只覆盖 40% 宽度：本来就不判（锁住既有行为）", () => {
    const p = makePage();
    addBar(p, p.b, 3, 80, 182, 60); // 102/256 ≈ 40%
    expect(measureSeamDetail(p.canvas, 2).score).toBe(0);
    expect(smoothSeams(p.canvas, 2)).toBe(0);
  });

  it("干净图（只有 ±1 噪声）：不判", () => {
    const p = makePage();
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) p.lum[y * p.w + x] = 200 + ((x * 7 + y * 13) % 3) - 1;
    expect(measureSeamDetail(p.canvas, 2).score).toBeLessThanOrEqual(SEAM_VISIBLE_SCORE);
    expect(smoothSeams(p.canvas, 2)).toBe(0);
  });

  it("有底噪 + 偶发弱尖峰的图：否决阈值必须随底噪抬高，不许把整条边界判成「无证据」", () => {
    // 底噪 = 行间 ±2 交替（邻域 |Δy| 中位数 = 2）→ 阈值应抬到 8。
    // 每 6 行的那个 +4 尖峰落在"高"行上（两侧都是 200）→ 实际产生 6 灰阶的偶发跳变：
    // 固定阈值 4 会把它当内容 → 每一列都被否决 → n=0 → 真条纹一起漏掉；
    // 自适应阈值 8 不触发 → 真条纹照修。
    const p = makePage();
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) p.lum[y * p.w + x] = (y % 2 === 0 ? 200 : 202) + (y % 6 === 3 ? 4 : 0);
    }
    addStep(p, 12);
    const band = measureSeamBands(p.canvas, 2)[0];
    expect(band.n).toBeGreaterThanOrEqual(8); // 没有被噪声全否决
    expect(measureSeamDetail(p.canvas, 2).score).toBeGreaterThan(SEAM_VISIBLE_SCORE);
    expect(smoothSeams(p.canvas, 2)).toBeGreaterThanOrEqual(1);
  });
});

describe("修复端也不能碰内容列", () => {
  it("真条纹带一小块内容（边界下方 1~4 行、x=100..139）：内容块像素不变，留白处照修", () => {
    const p = makePage();
    addStep(p, 12);
    addBar(p, p.b + 1, 4, 100, 140, 40);
    const before = snapshot(p);

    expect(smoothSeams(p.canvas, 2)).toBeGreaterThanOrEqual(1);
    // 内容块及其 ±20 行范围：一像素不动（权重被内容否决置 0）
    expect(changedInRect(p, before, p.b - 20, p.b + 20, 100, 140)).toBe(0);
    // 留白列确实被修了：边界跳变在 x<80 处降到 1 灰阶以内
    let jumpLeft = 0;
    for (let x = 0; x < 80; x++) jumpLeft = Math.max(jumpLeft, Math.abs(p.lum[p.b * p.w + x] - p.lum[(p.b - 1) * p.w + x]));
    expect(jumpLeft).toBeLessThanOrEqual(1);
  });
});

describe("停早 + 回滚（8bit 量化不动点）", () => {
  it("奇数灰阶台阶（步长 3）只保留 1 遍修复：残留被量化钉在 1 灰阶，再修也无改善", () => {
    const p = makePage();
    addStep(p, 3);
    expect(smoothSeams(p.canvas, 2)).toBe(1); // 旧实现必然跑满 6 遍
    expect(boundaryJump(p)).toBe(1);
    // 残留 level = 1 灰阶 / 0.6 = 1.667：高于停止线 0.5，所以"没进展就停"是唯一的止血点
    expect(measureSeamDetail(p.canvas, 2).score).toBeCloseTo(1.667, 3);
  });

  it("已经达标的边界一遍都不跑（返回 0，且不动像素）", () => {
    const p = makePage();
    addStep(p, 0.5); // 低于可见阈值
    const before = snapshot(p);
    expect(smoothSeams(p.canvas, 2)).toBe(0);
    expect(changedPixels(before, p.lum)).toBe(0);
  });
});

describe("退化与边界情形", () => {
  it("干净列不足 8 的窄图：判为无证据，不修（避免否决后只剩几列时中位数乱翻）", () => {
    const p = makePage(64, 240, 120); // 采样列只有 32 个
    addBar(p, p.b, 3, 4, 60, 60); // 覆盖 28/32 → 只剩 4 个干净列
    const band = measureSeamBands(p.canvas, 2)[0];
    expect(band.n).toBeLessThan(8);
    expect(measureSeamDetail(p.canvas, 2).score).toBe(0);
    expect(smoothSeams(p.canvas, 2)).toBe(0);
  });

  it("parts < 2（不切块的图）直接跳过", () => {
    const p = makePage();
    addStep(p, 12);
    expect(measureSeamBands(p.canvas, 1)).toEqual([]);
    expect(smoothSeams(p.canvas, 1)).toBe(0);
  });

  it("边界贴着图片上下边缘时不算数（量测窗口必须完整）", () => {
    const p = makePage(64, 24, 12); // parts=2 → baseH=12 → 边界=12，±12 越界
    addStep(p, 12);
    expect(measureSeamBands(p.canvas, 2)).toEqual([]);
    expect(measureSeamDetail(p.canvas, 2).score).toBe(0);
  });

  it("边界离下边缘不足 ±20 行（否决窗被裁）时仍不许写坏像素", () => {
    // h=400 / parts=20 → baseH=20 → 最后一条边界 b=380，距下边缘 19 行：
    // 否决窗 ±20 被裁到 19，读回的窗口比基线要用的 ±16 还窄 ——
    // 一旦越界读到 undefined，NaN 会一路传到 Uint8ClampedArray（NaN → 0，画面上就是黑块）。
    const p = makePage(64, 400, 380);
    addStep(p, 12, 380);
    const bands = measureSeamBands(p.canvas, 20);
    expect(bands.map((x) => x.b)).toContain(380);

    smoothSeams(p.canvas, 20);
    let min = 255;
    for (let y = 360; y < 400; y++) for (let x = 0; x < p.w; x++) min = Math.min(min, p.lum[y * p.w + x]);
    expect(min).toBeGreaterThan(100); // 出现 NaN→0 就会掉到 0
    let jump = 0;
    for (let x = 0; x < p.w; x++) jump = Math.max(jump, Math.abs(p.lum[380 * p.w + x] - p.lum[379 * p.w + x]));
    expect(jump).toBeLessThanOrEqual(1);
  });

  it("读窗口被边缘裁窄时量测仍不许产出 NaN（不变量）", () => {
    // half 直接给 20（读窗口 = 20），b=380 时下边缘会参与裁剪。
    // 这一条锁的是不变量「边缘带上的量测值必须是有限数」：基线循环一旦读到窗口之外，
    // undefined → NaN 会一路传到 score（而 NaN 在所有比较里都是 false → 静默 fail-open）。
    // 注：当前几何下 measureSeamBands 的 b±half 守卫已经挡住了会被裁窄的边界，
    // 所以这条不是某个已发生缺陷的复现，而是防止以后改窗口/改守卫时把它带回来。
    const p = makePage(64, 400, 380);
    addStep(p, 12, 380);
    const wide = measureSeamBands(p.canvas, 20, 20);
    expect(wide.length).toBeGreaterThan(0);
    for (const band of wide) {
      expect(Number.isFinite(band.lum)).toBe(true);
      expect(Number.isFinite(band.chroma)).toBe(true);
    }
    expect(Number.isFinite(measureSeamDetail(p.canvas, 20).score)).toBe(true);
  });
});
