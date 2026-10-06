// 平台判定（单一入口，别在各处手写 Capacitor.getPlatform()）
//
// 为什么需要集中：本项目一套代码跑四个宿主，而它们的**能力差异**是按平台分叉的 ——
//   · android：有硬件返回键 + 应用内自更新（AppUpdater 原生插件）
//   · ios    ：无返回键、且 @capacitor/app **没有 backButton 事件**（注册即 UNIMPLEMENTED）、
//              不能自己装 ipa（无越狱），Cache API 在 capacitor:// 下是否可用未定
//   · web    ：PWA，唯一支持 Service Worker 的宿主
//   · electron（桌面，见 dnsClean.isDesktop）：内置 DoH 清洗 + electron-updater
//
// 判定必须**保守**：拿不准时不要走"原生专属"分支，否则表现就是静默失效或红条报错
// （1.7.2 之后 main.tsx 的全局兜底会把未捕获拒绝渲染成页面底部红条）。
import { Capacitor } from "@capacitor/core";

/** 'android' | 'ios' | 'web'（Capacitor 的 getPlatform 只返回这三种） */
export type Platform = "android" | "ios" | "web";

/**
 * Capacitor 运行时只在原生壳里注入 webkit.messageHandlers / androidBridge，
 * 因此 jsdom / SSR 下会安全地返回 "web"。取不到时一律当 web 处理。
 */
export function getPlatform(): Platform {
  try {
    const p = Capacitor.getPlatform();
    return p === "android" || p === "ios" ? p : "web";
  } catch {
    return "web";
  }
}

export const isIos = (): boolean => getPlatform() === "ios";
export const isAndroid = (): boolean => getPlatform() === "android";

/**
 * 原生壳（Android/iOS）。注意：**不要**用它代替 isIos()/isAndroid() 做能力判断 ——
 * 返回键、自更新、离线后端这几处的分叉点都是具体平台，不是"是否原生"。
 */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** 插件在当前平台是否有实现（找不到实现的插件调用会抛 UNIMPLEMENTED） */
export function hasPlugin(name: string): boolean {
  try {
    return Capacitor.isPluginAvailable(name);
  } catch {
    return false;
  }
}

/**
 * 本项目仓库的发布页。
 * iOS 侧只在"Release 里找不到 ipa"时兜底用（正常路径是 ipa 直链交给浏览器，见 UpdateSection）。
 */
export const RELEASES_URL = "https://github.com/gucheng910/jm-minimal/releases/latest";

// ---------------------------------------------------------------- 左缘侧滑返回

/**
 * 侧滑返回的判定参数。**故意让四个平台共用同一份**：
 * iOS 没有硬件返回键，必须自己实现；Android 有硬件返回键，但它上面的 WebView 手势本来也会
 * 发触摸事件 —— 用同一套规则，可以少一条"只在 iOS 生效"的分叉（分叉越多越容易出不一致的 bug）。
 */
export const BACK_GESTURE = {
  /** 必须在左缘这么多像素以内起手（再往里就是列表拖动/翻页了） */
  edgePx: 24,
  /** 水平位移至少这么多像素才算返回 */
  minDx: 60,
  /** 水平位移必须显著大于垂直位移，避免和上下滚动抢事件 */
  slopeRatio: 1.5
} as const;

export interface TouchPoint {
  clientX: number;
  clientY: number;
}

/**
 * 侧滑返回判定：给定「起手点 + 抬手点」，返回是否应触发返回。
 *
 * 抽成纯函数是为了能单测 —— 这段逻辑原来是内联在 App.tsx 的 touch 监听里的
 * （只在 iOS 生效、真机才跑得到），是这次 iOS 改造里最难验证的一块。
 * 参数不合法（NaN / 非有限数）一律返回 false，宁可"这次侧滑没反应"也不要误触发返回。
 */
export function isBackSwipe(
  start: TouchPoint | null | undefined,
  end: TouchPoint | null | undefined,
  cfg: { edgePx: number; minDx: number; slopeRatio: number } = BACK_GESTURE
): boolean {
  if (!start || !end) return false;
  const { clientX: x0, clientY: y0 } = start;
  const { clientX: x1, clientY: y1 } = end;
  if (![x0, y0, x1, y1].every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  // 起手必须在左缘内侧
  if (x0 > cfg.edgePx) return false;
  const dx = x1 - x0;
  const dy = Math.abs(y1 - y0);
  return dx > cfg.minDx && dx > dy * cfg.slopeRatio;
}

/**
 * 网络失败时的「去配 DNS」提示。
 *
 * 为什么必须分平台：桌面有内置 DoH 清洗、Android 有系统级「私人 DNS」，而 **iOS 没有系统级
 * DoT/DoH 开关**（设置里根本没有这个入口）——给 iPhone 用户抄 Android 的步骤等于给了条死路。
 * 桌面用不上这条文案（DesktopUpdate 有自己的提示），这里只分 android / ios。
 */
export const DNS_HINT =
  getPlatform() === "ios"
    ? "请先在会员页「DNS 加速」查看 iOS 配置指引（装 DNS 描述文件或用第三方 DNS/代理 App），配置后彻底退出 App 再重进使设置生效，然后重试；若仍失败可尝试切换线路或代理"
    : "请先到会员页「DNS 加速」按指引配置 DoT 公共 DNS，配置后需删除后台重新进入 App 使设置生效，再重试（若仍失败可尝试切换线路）";

