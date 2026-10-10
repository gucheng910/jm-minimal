import { md5Hex } from "./crypto";
import { emit } from "./bus";
import { isLowFx } from "./lowfx";
import { NO_SEAM } from "./constants";

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
/** 可见阈值：score 高于它即判为「看得见的条纹」。量测与修复共用一个口径，别再各写一份。 */
export const SEAM_VISIBLE_SCORE = 1.0;
/** 列被视为「平坦」的邻域亮度跳变上限（灰度级） */
const SEAM_FLAT_LIMIT = 2.5;
/** 统计窗口半径（行） */
const SEAM_HALF = 12;
/** 修复停止线：修到超额低于该值即停（1.0 = 可见阈值，留一半余量） */
const SEAM_STOP_LEVEL = 0.5;

/**
 * 内容判据（2026-10-08 加，2026-10-10 按真图实测重做）。
 *
 * 要修的问题：真条纹能变淡，但**本无条纹的地方也糊**——汉字笔画（"一"或字中的横）、
 * 韩漫面板分隔条被当成条纹模糊。合成图实测：同一步幅的真条纹 score 20，而
 * 3 行高的文字横画 score 233（旧判据只看「这条横线是否覆盖 ≥50% 采样列」，
 * 中位数对细横线免疫 → 覆盖过半就翻上去）；被判成条纹后按权重 1 全量糊，
 * 笔画边缘跳变 140 → 1、笔画最深值 60 → 172。
 *
 * 判别依据（**两条，都是「量级」而不是「有没有边」**）：
 * 1. **单行跳变上限**（量测端，`SEAM_JUMP_MAX`）：编码接缝是服务端有损编码留下的台阶，
 *    实测只有 1.7~18.7 灰阶；内容边缘（墨线/文字/分隔条）是几十上百灰阶。
 *    所以「边界行对的跳变本身就 ≥ 24 灰阶」的列 ⇒ 那是内容，不是接缝。这一条就能
 *    干净地杀掉文字/分隔条这类误判（140 / 175 灰阶），且对真条纹零损伤。
 * 2. **修复端只在边界近旁保护**（`SEAM_VETO_NEAR = 6`）：真正会被模糊破坏的是
 *    「跨在边界上的那几行内容」，所以只有 ±6 行内还有强边的列才不糊。
 *
 * ⚠ 曾经的错误做法（2026-10-08 那版，已废弃）：在**判定与修复两端**都用「±20 窗内
 * 只要还有强横边就整列否决」，还把权重横向平滑改成取 min。结果是真图上 30~60%
 * 的列被否决、幸存的列又被 min 拖到接近 0 权重 —— 修复"跑了 8~13 遍"却让
 * 边界跳变一个灰阶都没降下来（四张真图实测：跳变总降 73/115/145/28 → 0/0/4/0）。
 * 教训：**判定端可以严，修复端不能把整列抹掉**；而且验收必须量"跳变降了多少"，
 * 只量"修了几遍"会把这种回归放过去。
 */
const SEAM_JUMP_MAX = 24;
/** 参与统计的干净列少于这个数 ⇒ 样本不足，判为「无证据」（只剩零星几列时中位数不可信） */
const SEAM_MIN_COLS = 8;
/**
 * 停早阈值之一（评分）：一遍修复让 level 下降不足这么多，且跳变也没改善，才回滚这一遍并收工。
 *
 * 必须有的理由（合成图实测）：8bit 量化把奇数灰阶台阶的残留钉在正好 1 个灰阶，
 * level = 1 / 0.6 = 1.667，而修复停止线是 0.5 —— **数学上不可达**。
 * 只按评分判会把"跑满 6 遍却毫无改善"的遍数白烧掉。
 */
const SEAM_MIN_GAIN = 0.05;
/**
 * 停早阈值之二（肉眼指标）：一遍修复让**边界最大单行跳变**下降不足这么多灰阶（也没改善评分）才回滚。
 * 这条是 2026-10-10 补的：只看评分会把「加宽核」的那些有效遍数回滚掉 ——
 * 评分对台阶摊开多宽不敏感（量化把残留钉在 1 灰阶），而跳变会从 4.0 降到 1.0 以下。
 */
const SEAM_MIN_JUMP_GAIN = 0.5;

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
  /** 被内容判据剔除的列数（诊断用：看得出来判定是否过严） */
  rejected: number;
}

function bandExcessAt(ctx: CanvasRenderingContext2D, w: number, h: number, b: number, half: number): { lum: number; chroma: number; n: number; rejected: number } {
  if (b - half < 0 || b + half >= h) return { lum: 0, chroma: 0, n: 0, rejected: 0 };
  // 读窗口就是统计圈（±half）—— 与旧版一致：判定端不再需要宽窗
  const y0 = b - half;
  const y1 = b + half;
  const rows = y1 - y0 + 1;
  const mid = half;                 // 边界在本次读回的数据里的行号
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
  let rejected = 0;
  for (let x = 0; x < w; x += 2) {
    const oMid = mid * w + x;
    const oUp = (mid - 1) * w + x;
    const dbL = Math.abs(lum[oMid] - lum[oUp]);
    const dbC = Math.abs(chr[oMid] - chr[oUp]);
    // 内容判据（量级）：这一列的边界跳变本身太大 ⇒ 那是内容边缘（墨线/文字/分隔条），不是接缝。
    // 编码接缝实测只有 1.7~18.7 灰阶，内容边缘几十上百，所以这条几乎零误伤、又能干净杀掉误判。
    if (dbL >= SEAM_JUMP_MAX) { rejected += 1; continue; }
    dl.length = 0;
    dc.length = 0;
    const lo = Math.max(1, mid - half + 1);
    const hi = Math.min(rows - 1, mid + half);
    for (let i = lo; i <= hi; i++) {
      if (Math.abs(i - mid) <= 1) continue;
      dl.push(Math.abs(lum[i * w + x] - lum[(i - 1) * w + x]));
      dc.push(Math.abs(chr[i * w + x] - chr[(i - 1) * w + x]));
    }
    dl.sort((a, b2) => a - b2);
    dc.sort((a, b2) => a - b2);
    if (dl.length === 0) continue; // half ≤ 1 的退化入参：别让 undefined 传染成 NaN
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
  return { lum: med(exL), chroma: med(exC), n: exL.length, rejected };
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
    out.push({ b, lum: e.lum, chroma: e.chroma, n: e.n, rejected: e.rejected });
  }
  return out;
}

export function measureSeamDetail(canvas: HTMLCanvasElement, parts: number): SeamDetail {
  if (NO_SEAM) return { lum: 0, chroma: 0, score: 0 }; // 老安卓包不带这个功能
  const bands = measureSeamBands(canvas, parts);
  let lum = 0;
  let chroma = 0;
  for (const band of bands) {
    // 干净样本不足的边界不参与「取最差」：否决掉内容列之后只剩零星几列时，中位数不可信
    if (band.n < SEAM_MIN_COLS) continue;
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
/** 低配机上"已按新默认值处理过"的标记：只强关一次，之后用户手动打开就不再覆盖 */
const LS_LOWFX_DEFAULTED = "jmclient.deseam.lowfx.v1";

function readEnabled(): boolean {
  try {
    if (isLowFx()) {
      // 旧版本去条纹默认是开的，老机器上那个 "1" 不是用户的选择（每张正文图都要 canvas 重排，
      // 这台机器吃不住）。本版首次运行强制关一次并打标记，之后用户想开就开。
      if (localStorage.getItem(LS_LOWFX_DEFAULTED) !== "1") {
        localStorage.setItem(LS_LOWFX_DEFAULTED, "1");
        localStorage.setItem(LS_ENABLED, "0");
        return false;
      }
      return localStorage.getItem(LS_ENABLED) === "1";
    }
    const v = localStorage.getItem(LS_ENABLED);
    return v === null ? true : v === "1";
  } catch {
    return !isLowFx();
  }
}

/** 模块级缓存：applyScramble 每张图都会问一次，避免反复读 localStorage */
let seamEnabled = readEnabled();

/** 「去条纹」是否开启（持久化，全局生效；高配默认开、低配默认关） */
export function deseaOn(): boolean {
  if (NO_SEAM) return false;
  return seamEnabled;
}

export function setDeseam(on: boolean): void {
  if (NO_SEAM) return;
  seamEnabled = on;
  try { localStorage.setItem(LS_ENABLED, on ? "1" : "0"); } catch { /* ignore */ }
  if (typeof window !== "undefined") {
    emit("jm:deseam", on);
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
 * 实测结论（指标 = "边界附近最大单行跳变"，即眼睛看到的陡峭度；8bit 合成图已复算）：
 * 1. **不能固定用窄核**：台阶只摊开 5 行时残留跳变 4.00（原图 12.00，作者实测 4.0 / 11.5），
 *    肉眼仍很明显；加宽到 21 抽头才能降到 1.0 以下。
 * 2. **起始核按损伤强度再宽一级**：这是有效的工程经验（重损边界一次到位），
 *    但**理由不是**"评分指标对摊开宽度不敏感" —— 8bit 复算显示 5 抽头一遍的 score 仍有 6.667
 *    （远高于停止线 0.5），不会过早退出；小台阶（≤7 灰阶）则无论核宽都被量化钉在 1.667。
 *    真正需要提防的是"跑满 6 遍却没有改善"，那条由 SEAM_MIN_GAIN 的停早 + 回滚兜住。
 *
 * ⚠️ 因为 `start = min(4, kernelIndex(level) + 1) ≥ 1`，数组里第 0 项（**5 抽头实际取不到**，
 * 最小起步是 9 抽头）。保留它是为了不打乱这套档位映射；改 kernelIndex 时别忘了一起看。
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
 *
 * 2026-10-10 只保留一处窄保护：**跨在边界上的内容**（±SEAM_VETO_NEAR 行内有强边）权重置 0，
 * 用来避免"真条纹恰好穿过文字/线稿时把内容糊掉"。
 *
 * ⚠️ 2026-10-08 那版这里做过两件事，都已在真图上证伪并撤掉：
 * 1. 用 ±20 窗判内容 → 真图上 30~60% 的列被置 0，修复形同虚设（四张真图跳变总降 73/115/145/28 → 0/0/4/0）；
 * 2. 横向平滑改成 `min(raw, 均值)` → 幸存的列被邻居的 0 拖到接近 0，进一步把修复抹平。
 * 现在平滑回到原来的均值（避免"糊/不糊"交界出现竖直硬边），保护半径收到 6 行。
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
    // 上下要夹住：边缘处窗口会被裁窄，不夹就可能读到窗口之外（undefined → NaN 权重）
    const lo = Math.max(1, mid - outer + 1);
    const hi = Math.min(rows - 1, mid + outer);
    for (let i = lo; i <= hi; i++) {
      if (Math.abs(i - mid) <= 1) continue;
      dl.push(Math.abs(lum[i * w + x] - lum[(i - 1) * w + x]));
    }
    dl.sort((a, b2) => a - b2);
    const baseL = dl.length === 0 ? Infinity : dl[dl.length >> 1]; // 量不了 → 当作"有细节"，不糊
    raw[x] = Math.max(0, Math.min(1, 1 - baseL / SEAM_FLAT_LIMIT));
  }
  // 横向平滑权重，避免"糊/不糊"交界出现竖直硬边。
  //
  // 🚨 2026-10-10：这里试过两种"保护内容列"的写法，都在真图上把修复搞废了（实测数据见文件顶部说明）：
  //   · 在 raw 里把「边界近旁有强边的列」置 0 —— 真图上纸纹/JPEG 振铃/网点让命中率极高，
  //     模糊改了 6000~10000 个像素却只把"可见台阶列数"从 755 降到 484（旧版降到 39）；
  //   · 再取 min(raw, 均值) —— 幸存的列被邻居的 0 拖成"半糊"，进一步摊不平台阶。
  // 所以修复路径**保持原样**（这条是唯一验证过有效的配方）；误判改由判定端的
  // SEAM_JUMP_MAX 拦（内容横线的跳变是几十上百灰阶，编码接缝实测只有 1.7~18.7）。
  // 代价：真条纹恰好穿过文字/线稿时，那些列仍会被一起摊平（想治它需要逐行掩码，见 docs/26 §7.7）。
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
 * 逐列权重 wgt 为 0 的列（有垂直细节 / 落着内容横边的列）原样保留。
 *
 * 返回**回滚函数**（把这一遍写回之前的像素恢复回去），越界时返回 null。
 * 有回滚才做得到「没换来改善就不留痕迹」，见 smoothSeams 的停早逻辑。
 */
function blurBoundary(ctx: CanvasRenderingContext2D, w: number, h: number, b: number, K: number[], outer: number, wgt: Float32Array): (() => void) | null {
  const kr = (K.length - 1) / 2;
  const y0 = b - outer;
  const y1 = b + outer;
  if (y0 < 0 || y1 >= h) return null;
  const rows = y1 - y0 + 1;
  const band = ctx.getImageData(0, y0, w, rows);
  const d = band.data;
  const ksum = K.reduce((a, x) => a + x, 0);
  const copy = new Uint8ClampedArray(d);
  for (let i = outer - kr; i <= outer + kr; i++) {
    for (let x = 0; x < w; x++) {
      const wv = wgt[x];
      if (wv <= 0.01) continue; // 有垂直细节 / 是内容列的列：原样保留，不糊
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
  return () => { band.data.set(copy); ctx.putImageData(band, 0, y0); };
}

/**
 * 边界处最大单行跳变（亮度）——「肉眼看到的陡峭度」，与作者当初的指标一致。
 * 传 wgt 时只统计**这一遍真正会动到的列**（权重 > 0.01），用来判断"这一遍有没有换来改善"；
 * 不传则统计全部列，那是用户肉眼看到的量（修复没覆盖到的列仍然留着条纹，日志里要如实反映）。
 *
 * 为什么决策要用"只看会动到的列"：边界跳变是**全列最大值**，而修复总是刻意跳过一部分列
 * （纹理列/内容列）；拿全列最大值当改善判据，会让每一次有效的修复都显得"没改善"而被回滚
 * —— 这正是 2026-10-10 那次"跑了十几遍却一个灰阶没降"的一半原因。
 */
function boundaryJump(ctx: CanvasRenderingContext2D, w: number, b: number, wgt?: Float32Array): number {
  const up = ctx.getImageData(0, b - 1, w, 1).data;
  const dn = ctx.getImageData(0, b, w, 1).data;
  let m = 0;
  for (let x = 0; x < w; x++) {
    if (wgt && wgt[x] <= 0.01) continue;
    const d = Math.abs(
      (0.299 * dn[x * 4] + 0.587 * dn[x * 4 + 1] + 0.114 * dn[x * 4 + 2]) -
      (0.299 * up[x * 4] + 0.587 * up[x * 4 + 1] + 0.114 * up[x * 4 + 2])
    );
    if (d > m) m = d;
  }
  return m;
}

/** 单条边界的修复结果（诊断/调参用：Reader 把它打进 [jmd] 日志） */
export interface SeamFixInfo extends SeamBand {
  /** 判定用的 level（修复前） */
  level: number;
  /** 修复后的残留 level */
  endLevel: number;
  /** 边界最大单行跳变：修复前 / 修复后（肉眼指标，验收就看它降了多少） */
  jumpBefore: number;
  jumpAfter: number;
  /** 实际保留的修复遍数（被回滚的那一遍不计） */
  repaired: number;
}

/**
 * 逐边界本地修复：核宽逐遍递增（5→9→13→17→21），修完立即复测该边界，未达标就用更宽的核再来一遍。
 * 返回**实际保留**的修复遍数；达标的边界不动、样本不足的边界不碰。
 *
 * 停早 + 回滚：一遍修复之后，**评分与边界跳变两项都没改善**才把它撤掉并收工。
 * 只看评分不够 —— 8bit 量化把奇数灰阶台阶的残留钉在 1 灰阶（level=1.667 > 停止线 0.5），
 * 加宽的那几遍在评分上"看不出改善"，却在肉眼指标（跳变）上确实有效；只看评分会把它们回滚掉。
 */
export function smoothSeams(
  canvas: HTMLCanvasElement,
  parts: number,
  threshold = SEAM_VISIBLE_SCORE,
  onBand?: (info: SeamFixInfo) => void
): number {
  if (NO_SEAM) return 0; // 老安卓包不带这个功能
  const ctx = canvas.getContext("2d");
  if (!ctx || parts < 2) return 0;
  const w = canvas.width;
  const h = canvas.height;
  let fixed = 0;
  for (const band of measureSeamBands(canvas, parts)) {
    const level0 = Math.max(band.lum / SEAM_EXCESS_LIMIT, band.chroma / SEAM_EXCESS_CHROMA_LIMIT);
    let level = level0;
    let repaired = 0;
    const jump0 = boundaryJump(ctx, w, band.b); // 日志用：全列（用户肉眼看到的）
    let jumpVisible = jump0;
    if (level > threshold && band.n >= SEAM_MIN_COLS) {
      const wgt = columnWeights(ctx, w, h, band.b, 16);
      let prevTouched = boundaryJump(ctx, w, band.b, wgt); // 决策用：只看会动到的列
      const start = Math.min(SEAM_KERNELS.length - 1, kernelIndex(level) + 1);
      for (let pass = 0; pass < SEAM_MAX_PASS && level > SEAM_STOP_LEVEL; pass++) {
        const K = SEAM_KERNELS[Math.min(SEAM_KERNELS.length - 1, start + pass)];
        const undo = blurBoundary(ctx, w, h, band.b, K, 16, wgt);
        if (!undo) break;
        const again = bandExcessAt(ctx, w, h, band.b, SEAM_HALF);
        const next = Math.max(again.lum / SEAM_EXCESS_LIMIT, again.chroma / SEAM_EXCESS_CHROMA_LIMIT);
        const touched = boundaryJump(ctx, w, band.b, wgt);
        // 评分没改善、**它动到的那些列**的跳变也没改善 → 这一遍是白做（还会继续摊平 ±10 行），撤掉收工
        if (level - next < SEAM_MIN_GAIN && prevTouched - touched < SEAM_MIN_JUMP_GAIN) { undo(); break; }
        level = next;
        prevTouched = touched;
        jumpVisible = boundaryJump(ctx, w, band.b);
        repaired += 1;
        fixed += 1;
      }
    }
    onBand?.({
      ...band, level: level0, endLevel: level,
      jumpBefore: jump0, jumpAfter: jumpVisible, repaired
    });
  }
  return fixed;
}
