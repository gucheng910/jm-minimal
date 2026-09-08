import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerPwa } from "./pwa";
import { initDnsClean } from "./core/dnsClean";
import { LOCAL_VERSION } from "./core/constants";

// 禁止浏览器自动滚动恢复（SPA 内部手动管理）
try { history.scrollRestoration = "manual"; } catch { /* ignore */ }
registerPwa();
// 桌面端：按偏好启用内置 DNS 清洗（Web/Android 无桥自动跳过）
initDnsClean();
// 诊断日志（logcat: adb logcat -s Capacitor/Console | findstr jmd）
console.log("[jmd] app start version=" + LOCAL_VERSION + " ua=" + navigator.userAgent.slice(0, 70));
createRoot(document.getElementById("root")!).render(<App />);