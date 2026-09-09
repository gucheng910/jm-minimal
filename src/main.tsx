import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerPwa } from "./pwa";
import { initDnsClean } from "./core/dnsClean";
import { LOCAL_VERSION } from "./core/constants";
import { ErrorBoundary } from "./ui/ErrorBoundary";

// 禁止浏览器自动滚动恢复（SPA 内部手动管理）
try { history.scrollRestoration = "manual"; } catch { /* ignore */ }
registerPwa();
// 桌面端：按偏好启用内置 DNS 清洗（Web/Android 无桥自动跳过）
initDnsClean();
// 诊断日志（logcat: adb logcat -s Capacitor/Console | findstr jmd）
console.log("[jmd] app start version=" + LOCAL_VERSION + " ua=" + navigator.userAgent.slice(0, 70));

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
window.addEventListener("error", (e) => {
  const src = String(e.filename || "").split("/").pop() || "";
  showFatal("JS错误: " + (e.message || String(e.error)) + (src ? " @" + src + ":" + e.lineno : ""));
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