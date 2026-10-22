/**
 * 把「切块重排 + 去条纹」搬到 Worker 的主线程客户端。
 *
 * 分工：
 *   · 本文件（主线程）：建/管 Worker、**两条 lane 排队**、把回来的 ImageBitmap 贴进页面上那张 canvas；
 *   · core/scrambleWorker.ts（Worker）：纯像素计算；
 *   · core/seamPixels.ts：两边共用的算法本体。
 *
 * ── 为什么是「两条 lane」而不是一条队列 ────────────────────────────────
 * 两类请求的优先级完全不同：
 *   · `draw`（拼回切块）：**用户在等它**，没画好这一页就是黑的/看不清；
 *   · `repair`（去条纹）：纯画质优化，晚几十毫秒没人看得出来，但单页最坏 191ms。
 * 只做优先级队列是不够的：正在 Worker 里跑的那一趟**无法抢占**，一个 191ms 的 repair
 * 照样会把后面 4 页的 draw 全堵住。所以给 repair 单开一条 lane（= 第二个 Worker 线程）：
 * 它跑它的，draw 那条永远不受影响。
 *
 * `repair` lane 是**惰性创建**的 —— 低配机默认关去条纹（`deseaOn()` 恒 false），
 * 那条线程压根不会被创建，也就不会有第二个线程的内存/耗电开销。
 *
 * **降级**：没有 Worker / OffscreenCanvas / createImageBitmap 的内核（老 WebView、兼容包）
 * 自动落回主线程同步路径，行为与改造前一致。降级是同步的，所以调用方不需要区分两条路。
 */
import { ctx2d, drawSlices, smoothSeams } from "./seamPixels";
import type { SeamFixInfo } from "./seamPixels";
import type { ScrambleJob, ScrambleReply } from "./scrambleWorker";

/** 单趟任务的超时：Worker 卡死/崩掉时不能把页面永远挂在"黑框"上 */
const JOB_TIMEOUT_MS = 8000;

export interface PaintOptions {
  /** 切块数（由主线程按 md5 推导，Worker 不碰 md5） */
  parts: number;
  /** 是否顺带做接缝修复（第二遍、进视口之后才为 true） */
  repair: boolean;
  threshold?: number;
}

export interface PaintResult {
  ok: boolean;
  /** 实际保留的修复遍数（未修复时为 0） */
  fixed: number;
  /** 每条边界的修复细节（日志用） */
  bands: SeamFixInfo[];
  /** 这一趟是不是真的在 Worker 里跑的（诊断/测试用） */
  offloaded: boolean;
}

type JobKind = "draw" | "repair";

interface Queued {
  /** 除 id 之外的请求体（id 在真正投递时分配） */
  job: Omit<ScrambleJob, "id">;
  resolve: (reply: ScrambleReply | null) => void;
}

interface Lane {
  kind: JobKind;
  /** undefined = 还没创建；null = 建不起来（这条 lane 整体降级） */
  worker: Worker | null | undefined;
  queue: Queued[];
  /** 当前正在这条 lane 里跑的那一趟（同一时刻最多一趟） */
  inFlight: (Queued & { id: number }) | null;
  timer: number;
}

function mkLane(kind: JobKind): Lane {
  return { kind, worker: undefined, queue: [], inFlight: null, timer: 0 };
}

let seq = 0;
const lanes: Record<JobKind, Lane> = { draw: mkLane("draw"), repair: mkLane("repair") };

/** 有没有 Worker 通道可用（同步判定，决定画布要不要 CPU 侧） */
export function offloadAvailable(): boolean {
  return typeof Worker !== "undefined"
    && typeof OffscreenCanvas !== "undefined"
    && typeof createImageBitmap === "function";
}

/** 已跑过多少趟 Worker 任务（e2e/诊断用：能证明不是悄悄降级到主线程） */
function bumpStat(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __jmScrambleJobs?: number };
  w.__jmScrambleJobs = (w.__jmScrambleJobs || 0) + 1;
}

/** 把这条 lane 排队的请求全部回绝（= 让调用方走降级路径） */
function flushLane(lane: Lane): void {
  const all = lane.queue;
  lane.queue = [];
  for (const q of all) q.resolve(null);
}

/** 这条 lane 作废：拒绝在途与排队的请求，之后所有调用走降级路径 */
function disposeLane(lane: Lane, reason: string): void {
  const w = lane.worker;
  lane.worker = null;
  if (lane.timer) { window.clearTimeout(lane.timer); lane.timer = 0; }
  const cur = lane.inFlight;
  lane.inFlight = null;
  try { w?.terminate(); } catch { /* ignore */ }
  cur?.resolve(null);
  flushLane(lane);
  if (typeof console !== "undefined") console.log("[jmd] worker lane(" + lane.kind + ") 关闭：" + reason);
}

function finishInFlight(lane: Lane, reply: ScrambleReply | null): void {
  const cur = lane.inFlight;
  lane.inFlight = null;
  if (lane.timer) { window.clearTimeout(lane.timer); lane.timer = 0; }
  cur?.resolve(reply);
  pump(lane);
}

function ensureWorker(lane: Lane): Worker | null {
  if (lane.worker !== undefined) return lane.worker;
  if (!offloadAvailable()) { lane.worker = null; return null; }
  try {
    // Vite 会把这里编译成同一个独立 worker chunk（两条 lane 各起一个线程，代码是同一份）
    const w = new Worker(new URL("./scrambleWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<ScrambleReply>) => {
      const reply = e.data;
      if (!lane.inFlight || lane.inFlight.id !== reply.id) return; // 超时后被丢掉的那一条
      finishInFlight(lane, reply);
    };
    w.onerror = () => { disposeLane(lane, "worker onerror"); };
    w.onmessageerror = () => { disposeLane(lane, "worker onmessageerror"); };
    lane.worker = w;
    return w;
  } catch (err) {
    lane.worker = null;
    if (typeof console !== "undefined") console.log("[jmd] worker(" + lane.kind + ") 建不起来，走主线程：" + String(err).slice(0, 80));
    return null;
  }
}

/** 投递这条 lane 的下一趟 */
function pump(lane: Lane): void {
  if (lane.inFlight) return;
  const w = ensureWorker(lane);
  if (!w) { flushLane(lane); return; }
  const next = lane.queue.shift();
  if (!next) return;
  const id = ++seq;
  lane.inFlight = { ...next, id };
  bumpStat();
  lane.timer = window.setTimeout(() => {
    finishInFlight(lane, null);
    disposeLane(lane, "任务超时 " + JOB_TIMEOUT_MS + "ms");
  }, JOB_TIMEOUT_MS);
  try {
    w.postMessage({ ...next.job, id }, [next.job.bitmap]);
  } catch (err) {
    finishInFlight(lane, null);
    disposeLane(lane, "postMessage 失败：" + String(err).slice(0, 60));
  }
}

function enqueue(kind: JobKind, job: Omit<ScrambleJob, "id">): Promise<ScrambleReply | null> {
  const lane = lanes[kind];
  return new Promise((resolve) => {
    lane.queue.push({ job, resolve });
    pump(lane);
  });
}

/**
 * 重排（可选顺带修复）这一页，并把结果画进 `canvas`。
 *
 * 有 Worker：位图在 Worker 里拼、可选在 Worker 里修，回传一张 ImageBitmap，主线程只贴一次。
 * 没 Worker：`drawSlices` + `smoothSeams` 就地同步跑（降级）。
 */
export async function paintScrambled(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  opts: PaintOptions
): Promise<PaintResult> {
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h || opts.parts < 2) return { ok: false, fixed: 0, bands: [], offloaded: false };

  if (offloadAvailable()) {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(img);
    } catch {
      bitmap = null; // 老内核/异常：直接降级
    }
    if (bitmap) {
      const reply = await enqueue(opts.repair ? "repair" : "draw", {
        bitmap, w, h, parts: opts.parts, repair: opts.repair, threshold: opts.threshold
      });
      if (reply && reply.ok && reply.bitmap) {
        const ctx = ctx2d(canvas);
        if (ctx) {
          ctx.drawImage(reply.bitmap, 0, 0, w, h, 0, 0, w, h);
          try { reply.bitmap.close(); } catch { /* ignore */ }
          return { ok: true, fixed: reply.fixed, bands: reply.bands, offloaded: true };
        }
        try { reply.bitmap.close(); } catch { /* ignore */ }
      }
      // 走到这里说明这一趟不可用（超时/异常）：下面用同步路径补一次
    }
  }

  // —— 降级：主线程同步路径（与改造前逐字一致的行为） ——
  const ctx = ctx2d(canvas, { willReadFrequently: true });
  if (!ctx) return { ok: false, fixed: 0, bands: [], offloaded: false };
  drawSlices(ctx, img, w, h, opts.parts);
  const bands: SeamFixInfo[] = [];
  let fixed = 0;
  if (opts.repair) {
    fixed = smoothSeams(canvas, opts.parts, opts.threshold, (info) => { bands.push(info); });
  }
  return { ok: true, fixed, bands, offloaded: false };
}

/** 卸载阅读器时收工（避免残留 Worker 线程）；下次进阅读器会按需重建 */
export function shutdownScrambleWorker(): void {
  for (const kind of ["draw", "repair"] as JobKind[]) {
    const lane = lanes[kind];
    if (lane.worker) disposeLane(lane, "主动关闭");
    lane.worker = undefined;
  }
}
