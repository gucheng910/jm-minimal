import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerPwa } from "./pwa";
import { initDnsClean } from "./core/dnsClean";
import { applyLowFx, isLowFx } from "./core/lowfx";
import { LOCAL_VERSION } from "./core/constants";
import { ErrorBoundary } from "./ui/ErrorBoundary";

// 低配模式（老内核）必须在首帧前判定：动效/阴影/磨砂在这里整体降级
applyLowFx();
// 禁止浏览器自动滚动恢复（SPA 内部手动管理）
try { history.scrollRestoration = "manual"; } catch { /* ignore */ }
registerPwa();
// 桌面端：按偏好启用内置 DNS 清洗（Web/Android 无桥自动跳过）
initDnsClean();
// 诊断日志（logcat: adb logcat -s Capacitor/Console | findstr jmd）
console.log("[jmd] app start version=" + LOCAL_VERSION + " lowfx=" + (isLowFx() ? 1 : 0) + " ua=" + navigator.userAgent.slice(0, 70));

/**
 * 全局错误兜底（不依赖 React）：脚本异常/未捕获 Promise 直接贴在屏幕底部，
 * 点一下可关闭。白屏时也能看到原因，便于真机定位。
 */
function showFatal(msg: string) {
  try {
    console.error("[jmd] fatal:", msg);
    let el = document.getElementById("jm-fatal");
    if (!el) {
      el = document.createElement("div");
      el.id = "jm-fatal";
      el.setAttribute(
        "style",
        "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#d92d20;color:#fff;" +
        "font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:8px 12px;white-space:pre-wrap;" +
        "max-height:45vh;overflow:auto;pointer-events:auto"
      );
      el.addEventListener("click", () => { el?.remove(); });
      document.body.appendChild(el);
    }
    if ((el.textContent || "").length < 1200) el.textContent = (el.textContent ? el.textContent + "\n" : "") + msg;
  } catch { /* ignore */ }
}
/**
 * 良性告警白名单：浏览器会把 ResizeObserver 的「本轮通知没送完」当作 script error 抛出来，
 * 它无害（浏览器下一帧会重发，页面不受影响），但以前会把底部红条刷出来吓人一跳。
 * 已知来源：底栏 --nav-h 尺寸观察、Collapse 高度观察（两处都已改成推迟一帧写入，这里是第二道保险）。
 * 只忽略这一条，其余错误照旧贴红条。
 */
const BENIGN_JS_ERROR = /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i;
window.addEventListener("error", (e) => {
  const msg = e.message || String(e.error);
  if (BENIGN_JS_ERROR.test(msg)) {
    console.debug("[jmd] 已忽略良性告警:", msg);
    return;
  }
  const src = String(e.filename || "").split("/").pop() || "";
  showFatal("JS错误: " + msg + (src ? " @" + src + ":" + e.lineno : ""));
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason as { message?: string } | undefined;
  showFatal("Promise错误: " + (r && (r.message || String(r)) || "unknown"));
});

// App 级兜底：抽屉/会员页等外壳里的渲染异常此前会把整个界面打空（1.7.2 前的抽屉崩溃就是这样）
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary label="应用" fullPage>
    <App />
  </ErrorBoundary>
);