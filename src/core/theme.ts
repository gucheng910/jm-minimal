import { UI_KEYS } from "./constants";

/**
 * 深色模式的初始判定。
 *
 * 原来只读 localStorage，读不到就一律浅色 —— 手机处于深色模式时，
 * 第一次打开这个 App 是一整屏纯白（审查发现的 UI 问题）。
 *
 * 约定：**用户显式选过就永远听用户的，没选过才跟随系统**。
 * index.html 里的内联脚本必须用同一套判定（否则首帧会先闪一下白）。
 */
export function prefersDark(): boolean {
  try {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function initialDark(): boolean {
  let saved: string | null = null;
  try { saved = localStorage.getItem(UI_KEYS.theme); } catch { saved = null; }
  if (saved === "dark") return true;
  if (saved === "light") return false;
  return prefersDark();
}
