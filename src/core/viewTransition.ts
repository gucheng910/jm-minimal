// 页面推拉转场（列表 ↔ 详情）：优先用 View Transitions API（Chromium 111+），
// 不支持 / 用户开了「减少动态效果」/ 已在转场中 时静默降级为瞬时切换（保持既有行为）。
import { flushSync } from "react-dom";

export type NavDir = "push" | "pop";

interface VT { ready: Promise<void>; finished: Promise<void>; skipTransition(): void }
type VTDocument = Document & { startViewTransition?: (cb: () => void) => VT };

let running = false;

/**
 * 更新回调的看门狗（ms）。
 *
 * 为什么必须有它：`update()` 只在 startViewTransition 的**更新回调**里被调用，
 * 而返回的 Promise 等的是 `resolveApplied()`。一旦浏览器始终不调用那个回调，
 * 就同时坏掉两件事 —— 页面不切换、Promise 永不落定 —— 表现为
 * **「点卡片什么都不发生、也不发请求、控制台 errs 还是空的」**，用户只能重开。
 *
 * 这不是假想：2026-10-11 用 CDP 给 `document.startViewTransition` 装探针，
 * 在 headless Chromium（不出帧）下实测到 `vtCalls: ["SVT-called"]` ——
 * **回调从未进入**，也没有抛错，而 `finished` 的 1200ms 兜底照样解锁了 `running`，
 * 于是下一个动作继续卡在同一处。
 *
 * 取值依据：正常回调是**亚帧级**（下一个渲染帧内，≤ 32ms），
 * 所以 600ms 已经远超正常延迟、不可能误伤；同时早于下面 1200ms 的 running 解锁，
 * 保证卡死只影响这一次导航，不会连带把后续导航也拖住。
 */
const UPDATE_CALLBACK_WATCHDOG_MS = 600;

/** 诊断计数（真机 CDP 验证用）：window.__jmVT */
function mark(dir: NavDir) {
  try {
    const w = window as unknown as { __jmVT?: { count: number; last: string; at: number } };
    const cur = w.__jmVT || { count: 0, last: "", at: 0 };
    w.__jmVT = { count: cur.count + 1, last: dir, at: Date.now() };
  } catch { /* ignore */ }
}

/**
 * 返回的 Promise 在「更新函数真正执行完」后 resolve。
 * 调用方若在转场之后还要做异步工作（例如拉详情数据后覆盖乐观快照），
 * 必须 await 它，否则可能出现「异步结果先落地、转场回调后执行」把新数据覆盖掉的竞态。
 */
export function navTransition(dir: NavDir, update: () => void): Promise<void> {
  const doc = document as VTDocument;
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let resolveApplied: () => void = () => { /* 赋值于下方 */ };
  const applied = new Promise<void>((res) => { resolveApplied = res; });
  if (!doc.startViewTransition || running || reduce || document.visibilityState !== "visible") {
    update();
    resolveApplied();
    return applied;
  }
  running = true;
  const root = document.documentElement;
  root.dataset.nav = dir;
  let called = false;
  /**
   * `called` 是"只执行一次"的唯一闸门：
   * 回调先到就用带 flushSync 的那次，看门狗先到就用这一次 —— 谁先谁生效，另一个变成空操作。
   */
  const run = () => { if (!called) { called = true; update(); } resolveApplied(); };
  try {
    const t = doc.startViewTransition(() => { flushSync(run); });
    const done = () => {
      running = false;
      delete root.dataset.nav;
    };
    // finished 在动画被跳过 / 页面隐藏等情况下可能一直不落定，加兜底解锁，避免后续导航全部失去动画
    t.finished.then(done, done);
    window.setTimeout(done, 1200);
    /**
     * 看门狗：回调到点还没进就自己把 update() 跑掉。
     *
     * 注意这里**不**包 flushSync —— 与上面那条"浏览器不支持 VT 时"的降级路径
     * （直接 `update(); resolveApplied();`）保持完全一致的调用方式，
     * 那条路径在真机上已经跑了很久，是已知安全的。
     *
     * 副作用（可接受）：万一回调只是**迟到**、看门狗抢跑了，这次转场的"变化前快照"
     * 里已经含了新状态，动画会退化成"看起来没动"。这比永久卡死好得多，
     * 而且 600ms 的余量让正常路径根本碰不到这个分支。
     */
    window.setTimeout(() => {
      if (!called) run();
    }, UPDATE_CALLBACK_WATCHDOG_MS);
    mark(dir);
  } catch {
    running = false;
    delete root.dataset.nav;
    run();
  }
  return applied;
}
