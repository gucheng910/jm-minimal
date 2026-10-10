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
 * 内容否决（2026-10-08 加，修「本无条纹的地方被误判成条纹」）。
 *
 * 旧判据只有「邻域 |Δy| 中位数 < 2.5 ⇒ 平坦列」，而**中位数对一条细横线完全免疫**：
 * 3 行高的笔画在 ±12 窗的 22 个样本里只占 1~2 个。于是汉字笔画、韩漫面板分隔条这类
 * 「平坦填充 + 干净边缘」的内容被判成平坦列参与统计；只要它覆盖到采样列的 ≥50%，
 * 中位数就翻上去 —— 合成图实测：真条纹 score 20.0，被误判的内容横线 233.3（真条纹上限 18.7）。
 * 修复端又是同一个假设（"这里平坦，糊了看不出来"）→ 按权重 1 全量糊：
 * 实测 3 行高的文字横画，边缘跳变 140 → 1、笔画最深值 60 → 172（几乎抹掉）。
 *
 * 接缝是**编码器切出来的电平台阶**：它的 ±窗内除了边界那一对之外不该再有强横边。
 * 内容横线 / 色块 / 笔画一定有（自己另一条边，或相邻笔画）。
 * 所以：**该列的 ±否决窗内只要还检出别的强横边，就判为内容列** ——
 * 量测时从统计里剔除、修复时权重置 0（一处判据两端共用，避免检测端与修复端假设不一致）。
 *
 * 窗宽取 20 **不是拍的，是核的读取足迹**：最宽的 21 抽头核（kr=10）只**写入** b±10，
 * 但要**读取** b±2·kr = b±20（blurBoundary 的 j = i+k）。也就是说 ±20 之内的内容边缘
 * 都会被"拉"进写入像素：一条 140 灰阶的边如果离边界 15 行，写入行会被拽过去约 43%（几十灰阶的暗带）。
 * 所以 ±20 恰是"保护写入像素不受窗内内容污染"所需的窗口，再窄就会漏。
 * 佐证（合成图扫描）：±20 可拦掉 ≤18 行厚的内容条（汉字笔画 3~6 行、文字行 10~18 行、
 * 韩漫分隔条 5~10 行都覆盖），而真条纹在 ±12/16/20/24 各窗宽下都是 20.0 无损
 * —— 包含「真条纹 6 行外另有一条内容条」的干扰场景。
 *
 * 代价要说清：内容是横边的列**整列不糊**，所以那些列上的条纹也不修了
 * （合成图实测「真条纹 + 6 行外一条 10 行高的内容条」→ 内容条覆盖的 87% 宽度上条纹保留）。
 * 取向是「宁可少修一条轻微条纹，也不碰内容」。这样做的前提是：在明暗对比强的内容旁边，
 * 一条 1~19 灰阶的接缝本来就被内容盖住；而被糊掉的内容边缘是不可逆损伤。
 * 若真机日志（Reader 的 seam bands 那行）显示某类页面「否决列数」常态过大，
 * 再考虑更细的做法：把逐列掩码升级成逐行掩码（只跳过真正会被写到的那些行）。
 */
const SEAM_VETO_HALF = 20;
/**
 * 「强横边」判据的下限（灰度级）。
 * 🚨 必须是**相对该列自身底噪**的阈值，不能只看这个绝对数：真实扫描/JPEG 在平坦区
 * 也会有 ±4 上下的偶发跳变，固定 4 会让几乎每一列都被判成内容 —— 结果是整个功能静默失效
 * （n 掉到 0 → 边界直接被判「无证据」）。所以实际阈值取 vetoEdgeFor()。
 */
const SEAM_VETO_EDGE_MIN = 4;
/** 底噪系数：阈值 = max(下限, 系数 × 该列邻域 |Δy| 中位数)。4 倍让偶发噪声尖峰不触发否决，
 *  而内容边缘（笔画/分隔条/色块边，通常几十灰阶）在任何底噪下都远超阈值。 */
const SEAM_VETO_EDGE_K = 4;
/** 否决时排除边界 ± 这么多行：台阶摊开后是 2~3 行，别把自己那条边当成「内容」 */
const SEAM_VETO_SKIP = 2;
/** 参与统计的干净列少于这个数 ⇒ 样本不足，判为「无证据」（否决后只剩零星几列时中位数不可信） */
const SEAM_MIN_COLS = 8;
/**
 * 停早阈值：一遍修复让 level 下降不足这么多，就回滚这一遍并收工。
 *
 * 必须有的理由（合成图实测）：8bit 量化把奇数灰阶台阶的残留钉在正好 1 个灰阶，
 * level = 1 / 0.6 = 1.667，而修复停止线是 0.5 —— **数学上不可达**。
 * 于是每条边界必然跑满 6 遍：后 5 遍画面一个灰阶都不再变，却把 ±10 行继续摊平
 * （假阳性被多糊 5 遍）。步长 3 的台阶实测逐遍 level：1.667 ×6。
 */
const SEAM_MIN_GAIN = 0.05;

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
  /** 因「窗内还有别的强横边」被判为内容、从统计里剔除的列数（诊断用：看得出来否决是否过狠） */
  rejected: number;
}

/**
 * 该列在「排除边界 ±SEAM_VETO_SKIP 行」的 ±SEAM_VETO_HALF 窗内是否还有别的强横边。
 * 有 ⇒ 这一列落着内容（笔画 / 线稿 / 色块边 / 面板分隔条），不是编码器切出来的接缝。
 * lum 是窗口内的本地亮度数组，mid 是边界在该数组里的行号，edge 是本次要用的强度阈值。
 */
function hasContentEdge(lum: Float32Array, w: number, mid: number, rows: number, x: number, edge: number): boolean {
  const from = Math.max(1, mid - SEAM_VETO_HALF);
  const to = Math.min(rows - 1, mid + SEAM_VETO_HALF);
  for (let i = from; i <= to; i++) {
    if (Math.abs(i - mid) <= SEAM_VETO_SKIP) continue;
    if (Math.abs(lum[i * w + x] - lum[(i - 1) * w + x]) >= edge) return true;
  }
  return false;
}

/**
 * 内容判据的强度阈值：随该列的**自身底噪**抬高。
 * 底噪就用 flat 判据已经在算的那个量（邻域 |Δy| 中位数）：噪声大的列要求更硬的边才算内容，
 * 免得把 JPEG/扫描噪声当成内容 → 全列被否决 → 整个功能静默失效。
 */
function vetoEdgeFor(noise: number): number {
  return Math.max(SEAM_VETO_EDGE_MIN, SEAM_VETO_EDGE_K * noise);
}

function bandExcessAt(ctx: CanvasRenderingContext2D, w: number, h: number, b: number, half: number): { lum: number; chroma: number; n: number; rejected: number } {
  if (b - half < 0 || b + half >= h) return { lum: 0, chroma: 0, n: 0, rejected: 0 };
  // 读窗口同时覆盖统计圈（±half）与否决圈（±SEAM_VETO_HALF）：一次 getImageData 两用，
  // 不额外多读一次。边缘处按实际可用行裁剪，统计圈的完整性由上面那行守卫保证。
  const read = Math.max(half, SEAM_VETO_HALF);
  const y0 = Math.max(0, b - read);
  const y1 = Math.min(h - 1, b + read);
  const rows = y1 - y0 + 1;
  const mid = b - y0;               // 边界在本次读回的数据里的行号
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
    dl.length = 0;
    dc.length = 0;
    // 基线统计仍只用 ±half 那一圈（口径与旧版逐字一致）；内容否决才看更宽的 ±SEAM_VETO_HALF。
    // 上下要夹住：读窗口比 half 宽，边缘处会被裁窄，不夹就会读到窗口之外（undefined → NaN 一路传下去）。
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
    // 内容列：阈值随该列底噪抬高（baseL 就是底噪），别把噪声当内容
    if (hasContentEdge(lum, w, mid, rows, x, vetoEdgeFor(baseL))) { rejected += 1; continue; }
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
 * 2026-10-08 两处加固（配合内容否决）：
 * 1. **内容列一律 0**：垂直活跃度只认「持续的垂直纹理」，对「平坦填充 + 干净边缘」免疫
 *    —— 合成图实测一根 2 列宽的垂直笔画、一块纯色填充的 raw 权重都是 1.00，
 *    于是被判成"平坦"，修复时按权重 1 全量糊（笔画边缘 140 → 1）。
 *    这里再跑一次 hasContentEdge：内容是横边的列（笔画/线稿/色块边/分隔条）一点不动。
 * 2. **横向平滑取 min 而不是直接用均值**：均值会把「平坦邻居」的权重抹进内容列
 *    （实测细密纹理的 0 被抹成 0.08→0.77 的斜坡）。取 min 后内容列只会更低、绝不会被抬高，
 *    而 ±6 的斜坡仍在（out 是 raw 与均值的逐点较小者，本身连续）→ 不会出现糊/不糊的竖直硬边。
 */
function columnWeights(ctx: CanvasRenderingContext2D, w: number, h: number, b: number, outer: number): Float32Array {
  // 读窗口要覆盖否决圈；权重的基线统计仍只用 ±outer（与旧版口径一致）
  const read = Math.max(outer, SEAM_VETO_HALF);
  const y0 = Math.max(0, b - read);
  const y1 = Math.min(h - 1, b + read);
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
    // 上下要夹住：读窗口比 outer 宽，边缘处会被裁窄（今天靠 blurBoundary 的同款守卫兜着，
    // 不夹就可能读到窗口之外 → NaN 权重），量不了就不碰（raw = 0）。
    const lo = Math.max(1, mid - outer + 1);
    const hi = Math.min(rows - 1, mid + outer);
    for (let i = lo; i <= hi; i++) {
      if (Math.abs(i - mid) <= 1) continue;
      dl.push(Math.abs(lum[i * w + x] - lum[(i - 1) * w + x]));
    }
    dl.sort((a, b2) => a - b2);
    const baseL = dl.length === 0 ? Infinity : dl[dl.length >> 1]; // 量不了 → 当作"有细节"，不糊
    const w0 = Math.max(0, Math.min(1, 1 - baseL / SEAM_FLAT_LIMIT));
    if (w0 <= 0.01) { raw[x] = 0; continue; } // 纹理/噪声列：本来就不糊，不必再看内容
    // 内容列：一点不动。阈值随该列底噪抬高，避免把噪声当成内容 → 全列否决 → 功能静默失效。
    if (hasContentEdge(lum, w, mid, rows, x, vetoEdgeFor(baseL))) { raw[x] = 0; continue; }
    raw[x] = w0;
  }
  // 横向平滑权重，避免"糊/不糊"交界出现竖直硬边；再与 raw 取 min，保证内容列不被抬高
  const out = new Float32Array(w);
  const R = 6;
  for (let x = 0; x < w; x++) {
    let s = 0;
    let n = 0;
    for (let k = -R; k <= R; k++) {
      const j = x + k;
      if (j >= 0 && j < w) { s += raw[j]; n += 1; }
    }
    out[x] = Math.min(raw[x], s / n);
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

/** 单条边界的修复结果（诊断/调参用：Reader 把它打进 [jmd] 日志） */
export interface SeamFixInfo extends SeamBand {
  /** 判定用的 level（修复前） */
  level: number;
  /** 修复后的残留 level */
  endLevel: number;
  /** 实际保留的修复遍数（被回滚的那一遍不计） */
  repaired: number;
}

/**
 * 逐边界本地修复：核宽逐遍递增（5→9→13→17→21），修完立即复测该边界，未达标就用更宽的核再来一遍。
 * 返回**实际保留**的修复遍数；达标的边界不动、样本不足的边界不碰。
 *
 * 两个 2026-10-08 的改动：
 * 1. **停早 + 回滚**：一遍修复让 level 下降不足 SEAM_MIN_GAIN，就把这一遍撤掉并收工。
 *    没有它时，8bit 量化把奇数灰阶台阶的残留钉在 1.667（> 停止线 0.5）→ 必然跑满 6 遍，
 *    后 5 遍画面一个灰阶都不再变却继续摊平 ±10 行（误判会被多糊 5 遍）。
 * 2. **样本量门槛**：干净列不足 SEAM_MIN_COLS 的边界不修 —— 内容列被否决之后只剩零星几列时，
 *    那个中位数不可信。
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
    if (level > threshold && band.n >= SEAM_MIN_COLS) {
      const wgt = columnWeights(ctx, w, h, band.b, 16);
      const start = Math.min(SEAM_KERNELS.length - 1, kernelIndex(level) + 1);
      for (let pass = 0; pass < SEAM_MAX_PASS && level > SEAM_STOP_LEVEL; pass++) {
        const K = SEAM_KERNELS[Math.min(SEAM_KERNELS.length - 1, start + pass)];
        const undo = blurBoundary(ctx, w, h, band.b, K, 16, wgt);
        if (!undo) break;
        const again = bandExcessAt(ctx, w, h, band.b, SEAM_HALF);
        const next = Math.max(again.lum / SEAM_EXCESS_LIMIT, again.chroma / SEAM_EXCESS_CHROMA_LIMIT);
        // 这一遍几乎没换来改善 → 撤掉它并收工：宁可留下轻微条纹，也不把画面越摊越平
        if (level - next < SEAM_MIN_GAIN) { undo(); break; }
        level = next;
        repaired += 1;
        fixed += 1;
      }
    }
    onBand?.({ ...band, level: level0, endLevel: level, repaired });
  }
  return fixed;
}
