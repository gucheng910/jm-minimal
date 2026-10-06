import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.jmclient.app",
  // iOS 桌面图标下显示的名字（Xcode 侧由 Info.plist 的 CFBundleDisplayName 决定，
  // tools/gen-ios-icons.mjs 之外的同步见 .github/workflows/build-ipa.yml）
  appName: "JM极简版",
  // 默认现代包；出兼容包时设 JM_WEB_DIR=dist-compat（tools/release.mjs 会先 copy 再 gradle）
  webDir: process.env.JM_WEB_DIR || "dist",
  ios: {
    // 保持 Capacitor 默认的 capacitor://localhost —— 本项目没有任何"读取同源资源"的代码，
    // 换成 http/https 方案只会把 origin 搅乱，没有收益（见 docs 里的 iOS 移植评估）。
    // 注意由此带来的两个后果：
    //   1) capacitor:// 不是 http/https ⇒ **Service Worker 无法注册**（pwa.ts 已按原生壳跳过）；
    //   2) Cache API 在该 scheme 下的可用性未经实测 ⇒ 离线库在 iOS 走 Filesystem 后端
    //      （src/core/offline.ts 的 nativeBackend），不再依赖 CacheStorage。
    //
    // contentInset 必须保持 never：本项目 UI 是自绘安全区（index.html 的 viewport-fit=cover +
    // index.css 里 12+ 处 env(safe-area-inset-*)）。设成 always/automatic 会由系统再缩一次，
    // 结果就是「顶部多一条空白 + 底部导航被顶起来」，env() 的取值也不再与实际一致。
    contentInset: "never",
    backgroundColor: "#f4f5f7",
    // 最低 iOS 16：由 ios/App/App.xcodeproj 的 IPHONEOS_DEPLOYMENT_TARGET 决定
    // （cap add ios 时用 `--target` 或生成后改工程；见 BUILDING.md 的 iOS 节），这里没有对应字段。
  },
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
