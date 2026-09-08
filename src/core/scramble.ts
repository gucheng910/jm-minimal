import { md5Hex } from "./crypto";

export function scrambleSliceCount(albumId: number | string, pageName: string): number {
  const idStr = String(albumId);
  const hash = md5Hex(idStr + pageName);
  let code = hash.charCodeAt(hash.length - 1);
  const num = parseInt(idStr, 10);
  // 与官方一致：专辑 ID 分段决定对 hash 取模 10 或 8
  if (num >= 268850 && num <= 421925) code %= 10;
  else if (num >= 421926) code %= 8;
  const counts: Record<number, number> = { 0: 2, 1: 4, 2: 6, 3: 8, 4: 10, 5: 12, 6: 14, 7: 16, 8: 18, 9: 20 };
  return counts[code] ?? 10;
}

// 复刻官方 wR：把服务端“横向切块图”按倒序拼回 canvas
export function drawUnscrambled(img: HTMLImageElement, albumId: number | string, scrambleId: number | string): HTMLCanvasElement | null {
  if (img.src.includes(".gif") || parseInt(String(albumId), 10) < parseInt(String(scrambleId), 10)) return null;
  const nameMatch = img.alt && img.alt.length > 0 ? img.alt : pageNameFromUrl(img.src);
  const parts = scrambleSliceCount(albumId, nameMatch);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.className = img.className;
  // willReadFrequently：接缝量测/修复会反复 getImageData，声明后走 CPU 侧画布，读回快得多
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const baseH = Math.floor(h / parts);
  const rem = h % parts;
  for (let c = 0; c < parts; c++) {
    let sh = baseH;
    const sy = h - baseH * (c + 1) - rem;
    let dy: number;
    if (c === 0) { sh += rem; dy = 0; } else { dy = baseH * c + rem; }
    ctx.drawImage(img, 0, sy, w, sh, 0, dy, w, sh);
  }
  return canvas;
}

function pageNameFromUrl(url: string): string {
  const clean = url.split("?")[0].split("/").pop() || "";
  return clean.replace(/\.(webp|jpg|jpeg|png|gif)$/i, "");
}

/** 页面图名（无扩展名）——切块数依赖它 */
export function pageNameOf(img: HTMLImageElement): string {
  return img.alt && img.alt.length > 0 ? img.alt : pageNameFromUrl(img.src);
}

/**
 * 接缝评分 = 边界处的「超额跳变」：该行对的跳变 − 该列自身的邻域基线跳变。
 *
 * 为什么不用"行平均台阶"：条纹只在平坦区域看得见（天空/白底/平色），行平均会被纹理
 * 稀释到 1 个单位以下而被判为"达标"，实际上那一条线在平坦区高达 5~30 个单位。
 * 因此这里逐列计算、只在平坦列上取中位数，并对所有边界取最差的一条（眼睛抓的就是最明显那条）。
 *
 * 单位是灰度级：亮度超额 > SEAM_EXCESS_LIMIT、或色度超额 > SEAM_EXCESS_CHROMA_LIMIT，即判为可见条纹。
 */
export const SEAM_EXCESS_LIMIT = 0.6;
export const SEAM_EXCESS_CHROMA_LIMIT = 1.0;
/** 列被视为「平坦」的邻域亮度跳变上限（灰度级） */
const SEAM_FLAT_LIMIT = 2.5;
/** 统计窗口半径（行） */
const SEAM_HALF = 12;
/** 修复停止线：修到超额低于该值即停（1.0 = 可见阈值，留一半余量） */
const SEAM_STOP_LEVEL = 0.5;

export interface SeamDetail {
  /** 亮度超额 / 阈值（>1 即超标） */
  lum: number;
  /** 色度超额 / 阈值 */
  chroma: number;
  /** 取两者较大者 */
  score: number;
}

export interface SeamBand {
  /** 边界行 */
  b: number;
  /** 平坦列上的亮度超额中位数（灰度级） */
  lum: number;
  /** 平坦列上的色度超额中位数（灰度级） */
  chroma: number;
  /** 参与统计的平坦列数 */
  n: number;
}

function bandExcessAt(ctx: CanvasRenderingContext2D, w: number, h: number, b: number, half: number): { lum: number; chroma: number; n: number } {
  const y0 = b - half;
  const y1 = b + half;
  if (y0 < 0 || y1 >= h) return { lum: 0, chroma: 0, n: 0 };
  const rows = y1 - y0 + 1;
  const mid = half;
  const d = ctx.getImageData(0, y0, w, rows).data;
  const lum = new Float32Array(rows * w);
  const chr = new Float32Array(rows * w);
  for (let i = 0; i < rows; i++) {
    const base = i * w;
    for (let x = 0; x < w; x++) {
      const o = (base + x) * 4;
      const r = d[o];
      const g = d[o + 1];
      const bl = d[o + 2];
      lum[base + x] = 0.299 * r + 0.587 * g + 0.114 * bl;
      chr[base + x] = (Math.abs(r - g) + Math.abs(bl - g)) / 2;
    }
  }
  const exL: number[] = [];
  const exC: number[] = [];
  const dl: number[] = [];
  const dc: number[] = [];
  for (let x = 0; x < w; x += 2) {
    const oMid = mid * w + x;
    const oUp = (mid - 1) * w + x;
    const dbL = Math.abs(lum[oMid] - lum[oUp]);
    const dbC = Math.abs(chr[oMid] - chr[oUp]);
    dl.length = 0;
    dc.length = 0;
    for (let i = 1; i < rows; i++) {
      if (Math.abs(i - mid) <= 1) continue;
      dl.push(Math.abs(lum[i * w + x] - lum[(i - 1) * w + x]));
      dc.push(Math.abs(chr[i * w + x] - chr[(i - 1) * w + x]));
    }
    dl.sort((a, b2) => a - b2);
    dc.sort((a, b2) => a - b2);
    const baseL = dl[dl.length >> 1];
    if (baseL >= SEAM_FLAT_LIMIT) continue; // 非平坦列：那是内容本身的横线，不参与统计
    exL.push(Math.max(0, dbL - baseL));
    exC.push(Math.max(0, dbC - dc[dc.length >> 1]));
  }
  const med = (arr: number[]) => {
    if (arr.length === 0) return 0;
    arr.sort((a, b2) => a - b2);
    return arr[arr.length >> 1];
  };
  return { lum: med(exL), chroma: med(exC), n: exL.length };
}

/** 逐个条带边界量测超额跳变 */
export function measureSeamBands(canvas: HTMLCanvasElement, parts: number, half = SEAM_HALF): SeamBand[] {
  const ctx = canvas.getContext("2d");
  if (!ctx || parts < 2) return [];
  const w = canvas.width;
  const h = canvas.height;
  const baseH = Math.floor(h / parts);
  const rem = h % parts;
  const out: SeamBand[] = [];
  for (let c = 1; c < parts; c++) {
    const b = baseH * c + rem;
    if (b - half < 0 || b + half >= h) continue;
    const e = bandExcessAt(ctx, w, h, b, half);
    out.push({ b, lum: e.lum, chroma: e.chroma, n: e.n });
  }
  return out;
}

export function measureSeamDetail(canvas: HTMLCanvasElement, parts: number): SeamDetail {
  const bands = measureSeamBands(canvas, parts);
  let lum = 0;
  let chroma = 0;
  for (const band of bands) {
    if (band.lum > lum) lum = band.lum;
    if (band.chroma > chroma) chroma = band.chroma;
  }
  const lumNorm = lum / SEAM_EXCESS_LIMIT;
  const chromaNorm = chroma / SEAM_EXCESS_CHROMA_LIMIT;
  return { lum: lumNorm, chroma: chromaNorm, score: Math.max(lumNorm, chromaNorm) };
}

export function measureSeamScore(canvas: HTMLCanvasElement, parts: number): number {
  return measureSeamDetail(canvas, parts).score;
}

// ---------------- 本地修复 ----------------

// ---------------- 开关 ----------------

const LS_ENABLED = "jmclient.deseam.v1";

function readEnabled(): boolean {
  try {
    const v = localStorage.getItem(LS_ENABLED);
    return v === null ? true : v === "1"; // 默认开启
  } catch {
    return true;
  }
}

/** 模块级缓存：applyScramble 每张图都会问一次，避免反复读 localStorage */
let seamEnabled = readEnabled();

/** 「去条纹」是否开启（持久化，全局生效，默认开启） */
export function deseaOn(): boolean {
  return seamEnabled;
}

export function setDeseam(on: boolean): void {
  seamEnabled = on;
  try { localStorage.setItem(LS_ENABLED, on ? "1" : "0"); } catch { /* ignore */ }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<boolean>("jm:deseam", { detail: on }));
  }
}

/** 高斯核（n 抽头） */
function gaussKernel(n: number): number[] {
  const kr = (n - 1) / 2;
  const s = n / 3.2;
  const k: number[] = [];
  for (let i = -kr; i <= kr; i++) k.push(Math.exp(-(i * i) / (2 * s * s)));
  return k;
}

/**
 * 核宽逐遍递增：5 → 9 → 13 → 17 → 21 抽头。
 *
 * 两条实测结论（指标 = "边界附近最大单行跳变"，即眼睛看到的陡峭度）：
 * 1. **不能固定用窄核**：台阶只摊开 5 行时残留跳变高达 4.0（原图 11.5），肉眼仍很明显；
 *    逐遍加宽到 21 行才能降到 1.0 以下。
 * 2. **起始核要比损伤强度再宽一级**：因为评分指标对"摊开宽度"不敏感，从窄核起步会让
 *    循环过早达标退出（只摊开 5 行）。按强度直接上宽核，重损边界的最大跳变可从 6.4 降到 2.7。
 */
const SEAM_KERNELS: number[][] = [5, 9, 13, 17, 21].map(gaussKernel);
/** 单边界最多修复遍数 */
const SEAM_MAX_PASS = 6;

function kernelIndex(level: number): number {
  if (level > 8) return 4;
  if (level > 4) return 3;
  if (level > 2.5) return 2;
  if (level > 1.6) return 1;
  return 0;
}

/**
 * 逐列模糊权重：垂直活跃度（邻域 |Δy| 中位数）越低越敢糊。
 * 垂直高斯只破坏"垂直方向"的细节，所以用垂直活跃度做掩码最合适：
 * 平坦列全量糊（那里本就没有垂直细节，糊了看不出来），
 * 有垂直细节的列权重衰减到 0（那里条纹本来就被细节盖住，不动它）。
 */
function columnWeights(ctx: CanvasRenderingContext2D, w: number, h: number, b: number, outer: number): Float32Array {
  const y0 = Math.max(0, b - outer);
  const y1 = Math.min(h - 1, b + outer);
  const rows = y1 - y0 + 1;
  const mid = b - y0;
  const d = ctx.getImageData(0, y0, w, rows).data;
  const lum = new Float32Array(rows * w);
  for (let i = 0; i < rows; i++) {
    const bs = i * w;
    for (let x = 0; x < w; x++) {
      const o = (bs + x) * 4;
      lum[bs + x] = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    }
  }
  const raw = new Float32Array(w);
  const dl: number[] = [];
  for (let x = 0; x < w; x++) {
    dl.length = 0;
    for (let i = 1; i < rows; i++) {
      if (Math.abs(i - mid) <= 1) continue;
      dl.push(Math.abs(lum[i * w + x] - lum[(i - 1) * w + x]));
    }
    dl.sort((a, b2) => a - b2);
    raw[x] = Math.max(0, Math.min(1, 1 - dl[dl.length >> 1] / SEAM_FLAT_LIMIT));
  }
  // 横向平滑权重，避免"糊/不糊"交界出现竖直硬边
  const out = new Float32Array(w);
  const R = 6;
  for (let x = 0; x < w; x++) {
    let s = 0;
    let n = 0;
    for (let k = -R; k <= R; k++) {
      const j = x + k;
      if (j >= 0 && j < w) { s += raw[j]; n += 1; }
    }
    out[x] = s / n;
  }
  return out;
}

/**
 * 边界平滑：R/G/B 同时按同一核做垂直高斯（亮度与色度一起被摊平）。
 * 逐列权重 wgt 为 0 的列（有垂直细节）原样保留。
 */
function blurBoundary(ctx: CanvasRenderingContext2D, w: number, h: number, b: number, K: number[], outer: number, wgt: Float32Array): boolean {
  const kr = (K.length - 1) / 2;
  const y0 = b - outer;
  const y1 = b + outer;
  if (y0 < 0 || y1 >= h) return false;
  const rows = y1 - y0 + 1;
  const band = ctx.getImageData(0, y0, w, rows);
  const d = band.data;
  const ksum = K.reduce((a, x) => a + x, 0);
  const copy = new Uint8ClampedArray(d);
  for (let i = outer - kr; i <= outer + kr; i++) {
    for (let x = 0; x < w; x++) {
      const wv = wgt[x];
      if (wv <= 0.01) continue; // 有垂直细节的列：原样保留，不糊
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let k = -kr; k <= kr; k++) {
        const j = Math.min(rows - 1, Math.max(0, i + k));
        const wt = K[k + kr];
        const o = (j * w + x) * 4;
        r += copy[o] * wt;
        g += copy[o + 1] * wt;
        bl += copy[o + 2] * wt;
      }
      const o = (i * w + x) * 4;
      d[o] = copy[o] + (r / ksum - copy[o]) * wv;
      d[o + 1] = copy[o + 1] + (g / ksum - copy[o + 1]) * wv;
      d[o + 2] = copy[o + 2] + (bl / ksum - copy[o + 2]) * wv;
    }
  }
  ctx.putImageData(band, 0, y0);
  return true;
}

/**
 * 逐边界本地修复：核宽逐遍递增（5→9→13→17→21），修完立即复测该边界，未达标就用更宽的核再来一遍。
 * 返回处理的边界条数；达标的边界不动。
 */
export function smoothSeams(canvas: HTMLCanvasElement, parts: number, threshold = 1.0): number {
  const ctx = canvas.getContext("2d");
  if (!ctx || parts < 2) return 0;
  const w = canvas.width;
  const h = canvas.height;
  let fixed = 0;
  for (const band of measureSeamBands(canvas, parts)) {
    let level = Math.max(band.lum / SEAM_EXCESS_LIMIT, band.chroma / SEAM_EXCESS_CHROMA_LIMIT);
    if (level <= threshold) continue;
    const wgt = columnWeights(ctx, w, h, band.b, 16);
    const start = Math.min(SEAM_KERNELS.length - 1, kernelIndex(level) + 1);
    for (let pass = 0; pass < SEAM_MAX_PASS && level > SEAM_STOP_LEVEL; pass++) {
      const K = SEAM_KERNELS[Math.min(SEAM_KERNELS.length - 1, start + pass)];
      if (!blurBoundary(ctx, w, h, band.b, K, 16, wgt)) break;
      fixed += 1;
      const again = bandExcessAt(ctx, w, h, band.b, SEAM_HALF);
      level = Math.max(again.lum / SEAM_EXCESS_LIMIT, again.chroma / SEAM_EXCESS_CHROMA_LIMIT);
    }
  }
  return fixed;
}
