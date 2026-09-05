// PWA：仅在纯 Web（https/localhost）注册 Service Worker；原生壳（Capacitor）跳过
export function registerPwa() {
  if (!("serviceWorker" in navigator)) return;
  // Electron 桌面壳内跳过（本地服务缓存无意义）
  if ((window as unknown as { __jmDesktop?: boolean }).__jmDesktop) return;
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform()) return;
  } catch { /* ignore */ }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => { /* 静默 */ });
  });
}