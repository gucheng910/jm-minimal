/**
 * 封面图解码降采样的主线程客户端（配套 core/imageWorker.ts）。
 *
 * 收益两层：
 *   1. **不在主线程解码**，而且只解到显示尺寸（列表 56×72 / 网格 183×244，原图常见 600×800）；
 *   2. **持久缓存**（core/coverCache，存在 Worker 侧的 IndexedDB 里）：看过的封面下次直接读盘，
 *      0 次网络请求 —— 这是"封面一下就出来"的关键，光靠解码优化做不到。
 *
 * 排队：**解码（用户在看）优先，预热（滚到后面才用）靠后**。两条队列共用一个 Worker，
 * 同时最多 4 张在途（一屏十几张，4 张足够喂满，又不会一次申请太多位图）。
 *
 * 三条安全阀（任何一条触发都静默退回原来的 `<img>` 路径，观感与改造前一致）：
 *   1. **内核不支持**（没有 Worker / OffscreenCanvas / createImageBitmap）；
 *   2. **图床不给 CORS**：`fetch` 会失败 —— 按 **host** 拉黑，之后同一图床不再尝试，
 *      不会每张封面都白跑一次跨域请求（`<img>` 本来不需要 CORS，所以这条路更严格）；
 *   3. **超时/异常**：单张 6s 没回来就放弃这一次。
 */
import type { CoverJob, CoverReply } from "./imageWorker";

/** 单张封面的超时 */
const JOB_TIMEOUT_MS = 6000;
/** 同时在途的封面任务数 */
const MAX_CONCURRENT = 4;
/** 目标尺寸上限（CSS px × dpr 之后的封顶）：再大的封面对列表也没有意义 */
const MAX_TARGET_PX = 720;

/** 拿不到 CORS 的图床：直接跳过 Worker 路径（键是 host） */
const blockedHosts = new Set<string>();

interface Pending {
  id: number;
  host: string;
  warm: boolean;
  resolve: (reply: CoverReply | null) => void;
  timer: number;
}

interface Task {
  url: string;
  width: number;
  height: number;
  warm: boolean;
  resolve: (reply: CoverReply | null) => void;
}

let worker: Worker | null | undefined; // undefined = 还没创建；null = 用不了
let seq = 0;
let inFlight = 0;
const urgent: Task[] = [];
const idle: Task[] = [];
const pending = new Map<number, Pending>();

function bumpStat(key: string, n = 1): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, number | undefined>;
  w[key] = (w[key] || 0) + n;
}

/** 有没有封面解码通道可用 */
export function imageOffloadAvailable(): boolean {
  return typeof Worker !== "undefined"
    && typeof OffscreenCanvas !== "undefined"
    && typeof createImageBitmap === "function";
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

function dispose(reason: string): void {
  const w = worker;
  worker = null;
  try { w?.terminate(); } catch { /* ignore */ }
  for (const [, p] of pending) {
    window.clearTimeout(p.timer);
    p.resolve(null);
  }
  pending.clear();
  inFlight = 0;
  const left = [...urgent, ...idle];
  urgent.length = 0;
  idle.length = 0;
  for (const t of left) t.resolve(null);
  if (typeof console !== "undefined") console.log("[jmd] 封面 Worker 关闭：" + reason);
}

function ensureWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (!imageOffloadAvailable()) { worker = null; return null; }
  try {
    const w = new Worker(new URL("./imageWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<CoverReply>) => {
      const reply = e.data;
      const p = pending.get(reply.id);
      if (!p) return;
      pending.delete(reply.id);
      window.clearTimeout(p.timer);
      inFlight = Math.max(0, inFlight - 1);
      if (reply.ok) {
        if (reply.cached) bumpStat("__jmCoverHits");
        if (p.warm) bumpStat("__jmCoverWarm");
      } else if (p.host) {
        // 该图床大概率不给 CORS：拉黑，之后这个 host 一律走 <img>
        blockedHosts.add(p.host);
      }
      p.resolve(reply.ok ? reply : null);
      pump();
    };
    w.onerror = () => dispose("worker onerror");
    w.onmessageerror = () => dispose("worker onmessageerror");
    worker = w;
    return w;
  } catch (err) {
    worker = null;
    if (typeof console !== "undefined") console.log("[jmd] 封面 Worker 建不起来，走 <img>：" + String(err).slice(0, 80));
    return null;
  }
}

/** 投递：先清空紧急队列，再轮到预热队列 */
function pump(): void {
  const w = worker;
  if (!w) return;
  while (inFlight < MAX_CONCURRENT) {
    const task = urgent.shift() || idle.shift();
    if (!task) return;
    inFlight += 1;
    const id = ++seq;
    const host = hostOf(task.url);
    const timer = window.setTimeout(() => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      inFlight = Math.max(0, inFlight - 1);
      p.resolve(null);
      pump();
    }, JOB_TIMEOUT_MS);
    pending.set(id, { id, host, warm: task.warm, resolve: task.resolve, timer });
    bumpStat("__jmCoverJobs");
    try {
      (w as Worker).postMessage({ id, url: task.url, width: task.width, height: task.height, warm: task.warm } satisfies CoverJob);
    } catch {
      pending.delete(id);
      window.clearTimeout(timer);
      inFlight = Math.max(0, inFlight - 1);
      task.resolve(null);
    }
  }
}

function enqueue(task: Omit<Task, "resolve">): Promise<CoverReply | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  const host = hostOf(task.url);
  if (host && blockedHosts.has(host)) return Promise.resolve(null);
  return new Promise((resolve) => {
    (task.warm ? idle : urgent).push({ ...task, resolve });
    pump();
  });
}

/** 目标宽度/高度的统一算法（CSS px × dpr，封顶） */
function targetPx(cssPx: number): number {
  const dpr = Math.min(2, Math.max(1, typeof devicePixelRatio === "number" ? devicePixelRatio : 1));
  return Math.min(MAX_TARGET_PX, Math.max(1, Math.round(cssPx * dpr)));
}

/**
 * 请求一张「按目标显示盒降采样后」的封面位图（命中本地缓存时 0 网络）。
 * 返回 `null` 表示这条路不可用（内核不支持 / 图床不给 CORS / 超时），调用方改用 `<img>`。
 * 拿到的 ImageBitmap **用完必须 close()**。
 */
export function decodeCover(url: string, boxW: number, boxH: number): Promise<ImageBitmap | null> {
  // blob:/data: 也走这条路：离线缓存的封面就是 blob URL，虽然省不了网络，
  // 但「解到显示尺寸 + 不在主线程解码」这两条照样成立。
  if (!url || !/^(https?|blob|data):/i.test(url)) return Promise.resolve(null);
  return enqueue({ url, width: targetPx(boxW), height: targetPx(boxH), warm: false })
    .then((reply) => (reply && reply.bitmap ? reply.bitmap : null));
}

/**
 * 预热：只把封面字节取回来**落进持久缓存**，不解码、不回传位图。
 * 列表翻页/预取用 —— 真正滚到那张时就是缓存命中，0 网络。
 * 返回是否成功（false = 这条路不通，调用方可以退回 `<img>` 预取）。
 */
export function warmCover(url: string, boxW = 120, boxH = 160): Promise<boolean> {
  if (!url || !/^(https?|blob|data):/i.test(url)) return Promise.resolve(false);
  return enqueue({ url, width: targetPx(boxW), height: targetPx(boxH), warm: true })
    .then((reply) => !!reply);
}

/**
 * 把位图按 `object-fit: cover` 的语义画进 canvas（居中裁切，绝不拉变形）。
 * 与 `<img class="thumb">` 的观感逐像素一致 —— 只是像素来源是 worker 解出来的小图。
 */
export function drawCover(canvas: HTMLCanvasElement, bmp: ImageBitmap): void {
  const cw = canvas.width;
  const ch = canvas.height;
  if (!cw || !ch || !bmp.width || !bmp.height) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const scale = Math.max(cw / bmp.width, ch / bmp.height);
  const sw = cw / scale;
  const sh = ch / scale;
  const sx = (bmp.width - sw) / 2;
  const sy = (bmp.height - sh) / 2;
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, cw, ch);
}

/** 卸载时收工（避免残留线程） */
export function shutdownCoverWorker(): void {
  if (worker) dispose("主动关闭");
  worker = undefined;
}
