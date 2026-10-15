// 外链打开工具：原生环境用 Capacitor Browser 打开系统浏览器（WebView 内 window.open 不可靠），Web 环境回退到 window.open
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";

export async function openExternal(url: string): Promise<void> {
  if (!url) return;
  if (Capacitor.isNativePlatform()) {
    /**
     * 这里**刻意不 await** `Browser.open`。
     *
     * 它是原生插件调用：原生侧不回话时这个 Promise **永不落定**，于是下面的 window.open
     * 兜底永远走不到 —— 表现为「点了外链没反应」，且不报错、控制台为空（与 core/viewTransition.ts
     * 那次故障同一类）。改成后台发起 + 明确失败才兜底，两个好处：
     *   · 本函数立刻返回，调用方不可能被它挂住（原来任何 await openExternal() 都会挂）；
     *   · 只在**明确失败**时才退回 window.open，不会出现「两个都开了」。
     */
    void Browser.open({ url }).catch(() => {
      try { window.open(url, "_blank"); } catch { /* 无窗口环境：忽略 */ }
    });
    return;
  }
  window.open(url, "_blank");
}
