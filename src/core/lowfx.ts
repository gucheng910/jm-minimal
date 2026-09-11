/**
 * 低配模式（老安卓 / 鸿蒙老内核适配）。
 *
 * 判据：flex gap（Chrome 84）、inset（87）、aspect-ratio（88）三种特性全不支持 ——
 * 命中说明内核老到 WebView 57 这一档。这类机器上"高级功能"是净负担：
 *   · 动效：30 张封面淡入 + 骨架扫光 + 各处 transition 会把主线程堵住；
 *   · 去条纹（接缝修复）：每张正文图都要 canvas 重排，内存与耗时都吃不住。
 * 命中后往 <html> 打 data-lowfx="1"（样式降级见 index.css 末尾），去条纹默认关闭见 scramble.ts。
 *
 * 用户可以在抽屉里手动覆盖（设置 → 低配模式）：手动值一旦写入就优先于自动判定，
 * 方便在旧机上自己试"动效开不开"。
 */
const LS_MANUAL = "jmclient.lowfx.manual";

let cached: boolean | null = null;

/** 手动覆盖：true 强制低配 / false 强制高配 / null 跟随自动判定 */
export function lowFxManual(): boolean | null {
  try {
    const v = localStorage.getItem(LS_MANUAL);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

function detect(): boolean {
  try {
    const supports = typeof CSS !== "undefined" && typeof CSS.supports === "function" ? CSS.supports.bind(CSS) : null;
    if (!supports) return false;
    return !supports("gap", "1px") || !supports("inset", "0");
  } catch {
    return false;
  }
}

export function isLowFx(): boolean {
  const manual = lowFxManual();
  if (manual !== null) return manual;
  if (cached === null) cached = detect();
  return cached;
}

function applyAttr(on: boolean): void {
  try {
    if (on) document.documentElement.setAttribute("data-lowfx", "1");
    else document.documentElement.removeAttribute("data-lowfx");
  } catch { /* ignore */ }
}

/** 应用低配模式标记（在首帧之前调用，避免先按高配渲染一帧再跳变） */
export function applyLowFx(): boolean {
  const on = isLowFx();
  applyAttr(on);
  return on;
}

/** 手动切换低配模式（写入覆盖值并立即生效） */
export function setLowFxManual(on: boolean): void {
  cached = on;
  try { localStorage.setItem(LS_MANUAL, on ? "1" : "0"); } catch { /* ignore */ }
  applyAttr(on);
}
