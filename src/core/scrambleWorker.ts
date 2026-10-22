/**
 * 切块重排 / 去条纹的 Worker 入口。
 *
 * 为什么要有它：这两件事都是**纯像素计算**，而它们原来跑在 WebView 主线程上 ——
 * 切块重排实测 ~9ms/页，接缝修复最坏 191ms/页，长章节连续翻页时正好和滚动、React 渲染
 * 抢同一个线程。搬到 Worker 之后主线程只做一次 `drawImage` 贴图。
 *
 * 协议（一条请求一条回复，双程都不复用画布）：
 *   主线程 → Worker：{ id, bitmap, w, h, parts, repair, threshold }
 *   Worker → 主线程：{ id, ok, fixed, bands, bitmap?, error? }
 *
 * 用 `transferToImageBitmap()` 把结果**转移**回去（零拷贝，所有权归还主线程）：
 * 这样 Worker 里不留任何画布，也就不存在"页面卸载了但 Worker 还攥着一张 8MB 位图"的泄漏
 * —— 内存边界完全由主线程的 DOM（窗口化后的那几页）决定。
 *
 * 注意：这里**不能** import core/scramble.ts（它带 isLowFx / bus 事件 / localStorage）。
 * 只依赖纯内核 core/seamPixels.ts。
 */
import { ctx2d, drawSlices, SEAM_VISIBLE_SCORE, smoothSeams } from "./seamPixels";
import type { SeamFixInfo } from "./seamPixels";

export interface ScrambleJob {
  id: number;
  bitmap: ImageBitmap;
  w: number;
  h: number;
  parts: number;
  /** 是否在这一趟里连去条纹一起做（进视口后的第二遍会带它） */
  repair: boolean;
  threshold?: number;
}

export interface ScrambleReply {
  id: number;
  ok: boolean;
  /** 实际保留的修复遍数 */
  fixed: number;
  /** 每条边界的修复细节（主线程照原样打日志） */
  bands: SeamFixInfo[];
  bitmap?: ImageBitmap;
  error?: string;
}

/** 不引 WebWorker 的 lib（会和 DOM lib 的全局声明打架），只声明用到的那两个成员 */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ScrambleJob>) => void) | null;
  postMessage: (msg: ScrambleReply, transfer?: Transferable[]) => void;
};

scope.onmessage = (e: MessageEvent<ScrambleJob>) => {
  const job = e.data;
  let bitmap = job.bitmap;
  try {
    const canvas = new OffscreenCanvas(job.w, job.h);
    const ctx = ctx2d(canvas);
    if (!ctx) throw new Error("OffscreenCanvas 没有 2d 上下文");
    drawSlices(ctx, bitmap, job.w, job.h, job.parts);
    // 原图位图用完即放（不 close 会等到 GC，一张 1200×1800 就是 8.6MB）
    try { bitmap.close(); } catch { /* ignore */ }
    bitmap = undefined as unknown as ImageBitmap;

    const bands: SeamFixInfo[] = [];
    let fixed = 0;
    if (job.repair && job.parts >= 2) {
      fixed = smoothSeams(canvas, job.parts, job.threshold ?? SEAM_VISIBLE_SCORE, (info) => { bands.push(info); });
    }
    const out = canvas.transferToImageBitmap();
    scope.postMessage({ id: job.id, ok: true, fixed, bands, bitmap: out }, [out]);
  } catch (err) {
    try { bitmap?.close?.(); } catch { /* ignore */ }
    scope.postMessage({ id: job.id, ok: false, fixed: 0, bands: [], error: String((err as { message?: string })?.message || err) });
  }
};
