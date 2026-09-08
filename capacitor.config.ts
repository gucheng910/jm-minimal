import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.jmclient.app",
  appName: "JMClient",
  webDir: "dist",
  android: {
    allowMixedContent: false,
    // 诊断版：把 WebView console 转发到 logcat（release 包默认关闭，值为 production 时开启）
    loggingBehavior: "production"
  }
};

export default config;
