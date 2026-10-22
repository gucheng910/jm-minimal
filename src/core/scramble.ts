import { md5Hex } from "./crypto";
import { emit } from "./bus";
import { isLowFx } from "./lowfx";
import { NO_SEAM } from "./constants";
import {
  measureSeamBands as measureSeamBandsCore,
  measureSeamDetail as measureSeamDetailCore,
  measureSeamScore as measureSeamScoreCore,
  smoothSeams as smoothSeamsCore,
  SEAM_EXCESS_CHROMA_LIMIT,
  SEAM_EXCESS_LIMIT,
  SEAM_VISIBLE_SCORE
} from "./seamPixels";
import type { PixelCanvas, SeamBand, SeamDetail, SeamFixInfo } from "./seamPixels";

/**
 * 「切块重排 + 去条纹」的门面。
 *
 * 像素算法本体在 core/seamPixels.ts（纯函数，Worker 与主线程共用）；这个文件只负责
 * DOM 相关与状态相关的那一圈：切块数推导、开关持久化、以及**降级路径**的同步绘制。
 * 现代内核上重排与修复都走 Worker（core/scrambleOffload.ts），主线程只做一次位图贴图。
 */

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

/** 这一页需不需要重排（gif 不切块；早于 scramble_id 的老专辑是整图） */
export function needsUnscramble(img: HTMLImageElement, albumId: number | string, scrambleId?: number | string): boolean {
  if (scrambleId === undefined || scrambleId === null || scrambleId === "") return false;
  if (img.src.includes(".gif")) return false;
  return !(parseInt(String(albumId), 10) < parseInt(String(scrambleId), 10));
}

/** 建一张用于显示的 canvas（尺寸=原图；是否 CPU 侧由调用方决定） */
export function makeCanvas(img: HTMLImageElement, willReadOften: boolean): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.className = img.className;
  // willReadFrequently：接缝量测/修复会反复 getImageData，声明后走 CPU 侧画布，读回快得多。
  // Worker 路径下主线程只贴一次位图、从不回读，所以那边不能传（会把 GPU 合成路径关掉）。
  canvas.getContext("2d", willReadOften ? { willReadFrequently: true } : undefined);
  return canvas;
}

/**
 * **降级路径**在主线程同步把切块图拼回 canvas —— 现在是 `core/scrambleOffload.paintScrambled`
 * 内部的一条分支（没有再单独导出函数：两条路共用 core/seamPixels 的 `drawSlices`/`smoothSeams`，
 * 也就不会出现"两条路的算法渐渐走偏"这种老问题）。
 */
function pageNameFromUrl(url: string): string {
  const clean = url.split("?")[0].split("/").pop() || "";
  return clean.replace(/\.(webp|jpg|jpeg|png|gif)$/i, "");
}

/** 页面图名（无扩展名）——切块数依赖它 */
export function pageNameOf(img: HTMLImageElement): string {
  return img.alt && img.alt.length > 0 ? img.alt : pageNameFromUrl(img.src);
}

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

// ---------------- 像素内核的门面 ----------------
// 老安卓包（NO_SEAM 构建）里这三个函数是空实现：常量条件会被打包器整块摇掉。

export { SEAM_EXCESS_CHROMA_LIMIT, SEAM_EXCESS_LIMIT, SEAM_VISIBLE_SCORE };
export type { PixelCanvas, SeamBand, SeamDetail, SeamFixInfo };

/** 逐个条带边界量测超额跳变 */
export function measureSeamBands(canvas: PixelCanvas, parts: number, half?: number): SeamBand[] {
  if (NO_SEAM) return [];
  return measureSeamBandsCore(canvas, parts, half);
}

export function measureSeamDetail(canvas: PixelCanvas, parts: number): SeamDetail {
  if (NO_SEAM) return { lum: 0, chroma: 0, score: 0 }; // 老安卓包不带这个功能
  return measureSeamDetailCore(canvas, parts);
}

export function measureSeamScore(canvas: PixelCanvas, parts: number): number {
  if (NO_SEAM) return 0;
  return measureSeamScoreCore(canvas, parts);
}

export function smoothSeams(
  canvas: PixelCanvas,
  parts: number,
  threshold = SEAM_VISIBLE_SCORE,
  onBand?: (info: SeamFixInfo) => void
): number {
  if (NO_SEAM) return 0; // 老安卓包不带这个功能
  return smoothSeamsCore(canvas, parts, threshold, onBand);
}
