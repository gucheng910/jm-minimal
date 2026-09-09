// PWA：仅在纯 Web（https/localhost）注册 Service Worker；原生壳（Capacitor）跳过
export function registerPwa() {
  if (!("serviceWorker" in navigator)) return;
  // 开发服务器下禁用：sw.js 对同源 GET 走「缓存优先」，会把 /src/*.ts 也缓存住，
  // 导致 npm run dev 里改了代码却一直看到旧实现（排查起来极隐蔽）
  if (import.meta.env.DEV) return;
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