import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.jmclient.app",
  appName: "JMClient",
  // 默认现代包；出兼容包时设 JM_WEB_DIR=dist-compat（tools/release.mjs 会先 copy 再 gradle）
  webDir: process.env.JM_WEB_DIR || "dist",
  android: {
    allowMixedContent: false,
    // 诊断版：把 WebView console 转发到 logcat（release 包默认关闭，值为 production 时开启）
    loggingBehavior: "production",
    // 仅诊断构建开启：JM_WEBVIEW_DEBUG=1 时允许 adb forward 到 WebView DevTools（release 默认关闭）
    webContentsDebuggingEnabled: process.env.JM_WEBVIEW_DEBUG === "1",
    // 只有老内核构建关掉：Capacitor 的 Bridge 在开启时会调用 android.webkit.ServiceWorkerController，
    // 而那个类 **API 24 才有** —— 在 Android 6（API 23）上直接 NoClassDefFoundError 崩在启动。
    // 本项目 App 内不需要 Service Worker 代理（PWA 才用），所以老内核包关掉即可。
    resolveServiceWorkerRequests: process.env.JM_NO_SW !== "1"
  }
};

export default config;
