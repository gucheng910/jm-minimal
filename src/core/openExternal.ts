// 外链打开工具：原生环境用 Capacitor Browser 打开系统浏览器（WebView 内 window.open 不可靠），Web 环境回退到 window.open
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";

export async function openExternal(url: string): Promise<void> {
  if (!url) return;
  if (Capacitor.isNativePlatform()) {
    try {
      await Browser.open({ url });
      return;
    } catch { /* 回退到 window.open */ }
  }
  window.open(url, "_blank");
}
