// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  measureSeamBands,
  measureSeamDetail,
  smoothSeams,
  SEAM_VISIBLE_SCORE
} from "./scramble";

/**
 * 去条纹（接缝修复）的判据测试 —— 「本无条纹处误判」修复的回归网（2026-10-08 起，2026-10-10 重做）。
 *
 * 原缺陷（合成图实测）：只靠「邻域 |Δy| 中位数 < 2.5 ⇒ 平坦列」一个判据，中位数对一条细横线
 * 完全免疫 → 汉字笔画 / 韩漫全宽分隔条这类「平坦填充 + 干净边缘」的内容被判成条纹
 * （覆盖 ≥50% 宽度时 score 高达 233，真条纹才 20），然后按权重 1 把笔画全糊掉（边缘跳变 140 → 1）。
 *
 * 现在的判据是**量级**：编码接缝实测只有 1.7~18.7 灰阶，而内容边缘是几十上百，
 * 所以边界行对跳变 ≥ SEAM_JUMP_MAX 的列直接判为内容、不参与统计（那一条边界也就不修了）。
 *
 * ⚠️ 2026-10-10 的教训（写在用例里防复发）：
 *   · 修复端**不许**再按"窗内有没有边"去保护内容列 —— 真图上纸纹/JPEG 振铃/网点让命中率极高，
 *     实测模糊改了 6000~10000 个像素却只把"可见台阶列数"从 755 降到 484（旧版降到 39）。
 *   · 验收必须量**边界跳变降了多少**。只断言"修了几遍 / 判为超标"会把上面那种回归放过去。
 *
 * 这里用一个 Uint8ClampedArray 冒充 canvas，与真实 getImageData 的 8bit 取整一致。
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
/** 同上，但只在满足条件的列上取最大（用来把"内容列/干净列"分开验收） */
function rowJump(p: Page, pick: (x: number) => boolean): number {
  let m = 0;
  for (let x = 0; x < p.w; x++) {
    if (!pick(x)) continue;
    m = Math.max(m, Math.abs(p.lum[p.b * p.w + x] - p.lum[(p.b - 1) * p.w + x]));
  }
  return m;
}
const snapshot = (p: Page) => Uint8ClampedArray.from(p.lum);
function changedPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n += 1;
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

  it("真条纹旁边 6 行外另有一条内容横条时，仍然判得出来**并且真的修下去**", () => {
    const p = makePage();
    addStep(p, 12);
    addBar(p, p.b + 6, 10, 16, 240, 40);
    const bands = measureSeamBands(p.canvas, 2);
    expect(bands).toHaveLength(1);
    expect(bands[0].n).toBeGreaterThanOrEqual(8);
    expect(measureSeamDetail(p.canvas, 2).score).toBeGreaterThan(SEAM_VISIBLE_SCORE);

    // 留白列（避开内容条覆盖的 x 区间）必须真的被修：跳变降下来才算数
    const before = rowJump(p, (x) => x < 16 || x >= 240);
    expect(smoothSeams(p.canvas, 2)).toBeGreaterThanOrEqual(1);
    expect(rowJump(p, (x) => x < 16 || x >= 240)).toBeLessThanOrEqual(Math.max(1, before - 6));
  });

  it("满页零散内容边（真图那种纸纹/墨点）：不许因为保护过头而修不动（2026-10-10 回归）", () => {
    // 每列在「距边界 7~20 行」处随机放 3 个 6 灰阶的尖峰，模拟真图里到处都有的零散边。
    // 旧版「±20 窗内还有强横边就整列否决」会把这些列全否掉 → 修复跑了却一个灰阶都降不下来
    // （真图实测：跳变总降 73/115/145/28 → 0/0/4/0）。现在按「跳变幅度」判内容，
    // 这些 6 灰阶的小边远低于接缝上限，不该影响修复。
    const p = makePage();
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let x = 0; x < p.w; x++) {
      if (x % 4 === 0) continue; // 每 4 列留一列完全干净，用来量"修复到底有没有效果"
      for (let k = 0; k < 3; k++) {
        const far = 7 + Math.floor(rnd() * 13); // 7~19 行 > 修复端保护半径 6
        const y = rnd() < 0.5 ? p.b - far : p.b + far;
        if (y < 1 || y >= p.h) continue;
        p.lum[y * p.w + x] += 6; // 单行抬高 → 上下各一条 6 灰阶的边
      }
    }
    addStep(p, 12);

    const clean = (x: number) => x % 4 === 0;
    const before = rowJump(p, clean);
    expect(before).toBe(12);
    expect(measureSeamDetail(p.canvas, 2).score).toBeGreaterThan(SEAM_VISIBLE_SCORE);

    expect(smoothSeams(p.canvas, 2)).toBeGreaterThanOrEqual(1);
    expect(rowJump(p, clean)).toBeLessThanOrEqual(2); // 干净列上的条纹必须真的被抹平
  });
});

describe("内容（本无条纹）：不能判、更不许动像素", () => {
  it("全宽文字横画（3 行高、88% 宽、上边缘正压在边界上）：不判为条纹，且一个像素都不改", () => {
    const p = makePage();
    addBar(p, p.b, 3, 16, 240, 60); // 旧实现：覆盖 112/128 个采样列 → score 233，整条笔画被抹平
    const before = snapshot(p);

    const band = measureSeamBands(p.canvas, 2)[0];
    expect(band.rejected).toBeGreaterThan(0); // 这些列的跳变远超接缝上限 → 判为内容、不参与统计
    expect(band.n).toBeGreaterThanOrEqual(8); // 仍留够干净列 —— 说明拦住它的是"内容判据"，不是"样本不足"
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

  it("有底噪 + 偶发弱尖峰的图：噪声不许影响判定与修复（判据是量级）", () => {
    // 底噪 = 行间 ±2 交替 + 每 6 行一个 6 灰阶的偶发尖峰（真图上就是纸纹/振铃那种量级）。
    // 它们远低于接缝上限 24 灰阶 → 不该被当成内容、也不该把判定搞成"无证据"。
    const p = makePage();
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) p.lum[y * p.w + x] = (y % 2 === 0 ? 200 : 202) + (y % 6 === 3 ? 6 : 0);
    }
    addStep(p, 12);
    const band = measureSeamBands(p.canvas, 2)[0];
    expect(band.n).toBeGreaterThanOrEqual(8);
    expect(measureSeamDetail(p.canvas, 2).score).toBeGreaterThan(SEAM_VISIBLE_SCORE);
    const clean = () => true;
    const before = rowJump(p, clean);
    expect(smoothSeams(p.canvas, 2)).toBeGreaterThanOrEqual(1);
    expect(rowJump(p, clean)).toBeLessThanOrEqual(Math.max(1, before - 6)); // 必须真的摊平
  });
});

describe("修复端：只按垂直活跃度做掩码（内容保护已按真图实测撤掉）", () => {
  it("真条纹穿过一小块内容（边界下方 1~4 行、x=100..139）：条纹本身必须被摊平", () => {
    // 说明：这里**不再**断言"内容块像素不变"。2026-10-10 在真图上量过：
    // 按"窗内有没有边"保护内容列会让修复整体失效（可见台阶列数 755→484，而旧版能降到 39）。
    // 代价是真条纹穿过文字/线稿时那些列会被一起摊平；要治它得改成逐行掩码（见 docs/26 §7.7）。
    const p = makePage();
    addStep(p, 12);
    addBar(p, p.b + 1, 4, 100, 140, 40);

    expect(smoothSeams(p.canvas, 2)).toBeGreaterThanOrEqual(1);
    // 关键：**条纹**必须真的被摊平 —— 只看内容块以外的列（内容块自己的边缘被糊掉是已知代价）
    expect(rowJump(p, (x) => x < 100 || x >= 140)).toBeLessThanOrEqual(1);
    // 顺带记录：内容块边缘也会被摊开（这正是"逐行掩码"以后要治的地方）
    expect(boundaryJump(p)).toBeLessThanOrEqual(5);
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
