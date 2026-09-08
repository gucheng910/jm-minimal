// 页面推拉转场（列表 ↔ 详情）：优先用 View Transitions API（Chromium 111+），
// 不支持 / 用户开了「减少动态效果」/ 已在转场中 时静默降级为瞬时切换（保持既有行为）。
import { flushSync } from "react-dom";

export type NavDir = "push" | "pop";

interface VT { ready: Promise<void>; finished: Promise<void>; skipTransition(): void }
type VTDocument = Document & { startViewTransition?: (cb: () => void) => VT };

let running = false;

/** 诊断计数（真机 CDP 验证用）：window.__jmVT */
function mark(dir: NavDir) {
  try {
    const w = window as unknown as { __jmVT?: { count: number; last: string; at: number } };
    const cur = w.__jmVT || { count: 0, last: "", at: 0 };
    w.__jmVT = { count: cur.count + 1, last: dir, at: Date.now() };
  } catch { /* ignore */ }
}

export function navTransition(dir: NavDir, update: () => void) {
  const doc = document as VTDocument;
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || running || reduce || document.visibilityState !== "visible") {
    update();
    return;
  }
  running = true;
  const root = document.documentElement;
  root.dataset.nav = dir;
  let called = false;
  const run = () => { if (!called) { called = true; update(); } };
  try {
    const t = doc.startViewTransition(() => { flushSync(run); });
    const done = () => {
      running = false;
      delete root.dataset.nav;
    };
    // finished 在动画被跳过 / 页面隐藏等情况下可能一直不落定，加兜底解锁，避免后续导航全部失去动画
    t.finished.then(done, done);
    window.setTimeout(done, 1200);
    mark(dir);
  } catch {
    running = false;
    delete root.dataset.nav;
    run();
  }
}
