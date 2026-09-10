// 全局「浮层已打开」计数：让返回键先交给浮层（阅读器内的图源/换话/缓存弹窗），
// 而不是被父级（ContentView / 缓存中心）直接消费掉。
// 为什么需要：jm:back 按监听器注册顺序派发，父级先注册就会先消费；
// 子组件一旦因状态变化重新注册（useEffect 依赖变化），顺序又会反转，靠注册顺序不可靠。
let openSheets = 0;

export function pushSheetLock(): void { openSheets += 1; }
export function popSheetLock(): void { openSheets = Math.max(0, openSheets - 1); }
export function hasOpenSheet(): boolean { return openSheets > 0; }
/** 仅测试用 */
export function resetSheetLocks(): void { openSheets = 0; }

/**
 * body 滚动锁（可重入）：整屏浮层（缓存中心 / 侧边抽屉 / 底部抽屉 / 搜索层）打开时锁住底层页面，
 * 否则内层滚到底会带着外层一起滚，浮层关掉后外层已经移位。
 * 用计数而不是布尔：浮层可能嵌套（缓存中心里再开搜索层），谁先关都不会把锁提前放掉。
 */
let scrollLocks = 0;

export function lockBodyScroll(): void {
  scrollLocks += 1;
  try { document.body.classList.add("jm-scroll-lock"); } catch { /* SSR / 测试环境 */ }
}

export function unlockBodyScroll(): void {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks > 0) return;
  try { document.body.classList.remove("jm-scroll-lock"); } catch { /* ignore */ }
}

/** 仅测试用 */
export function resetBodyScrollLocks(): void {
  scrollLocks = 0;
  try { document.body.classList.remove("jm-scroll-lock"); } catch { /* ignore */ }
}
