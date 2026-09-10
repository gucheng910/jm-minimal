// 整屏浮层打开时锁住底层页面滚动（可重入，见 core/uiLocks 的 lockBodyScroll）
import { useEffect } from "react";
import { lockBodyScroll, unlockBodyScroll } from "../core/uiLocks";

export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    lockBodyScroll();
    return () => unlockBodyScroll();
  }, [active]);
}
