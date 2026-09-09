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
