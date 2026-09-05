// 冷启动就绪信号：18+ 确认页等待自动测速完成后再进入主界面
export interface StartupInfo { speedOk: boolean }

let resolveStartup: ((info: StartupInfo) => void) | null = null;
export const startupReady: Promise<StartupInfo> = new Promise<StartupInfo>((resolve) => {
  resolveStartup = resolve;
});
export function announceStartupReady(info: StartupInfo): void {
  if (resolveStartup) {
    resolveStartup(info);
    resolveStartup = null;
  }
}

// 18+ 门放行信号：点击确认后才启动测速与首页加载（避免“后台提前跑完导致秒进”）
let resolveGate: (() => void) | null = null;
export const gatePassed: Promise<void> = new Promise<void>((resolve) => {
  resolveGate = resolve;
});
export function openGate(): void {
  if (resolveGate) {
    resolveGate();
    resolveGate = null;
  }
}
