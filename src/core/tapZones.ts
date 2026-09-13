import { UI_KEYS } from "./constants";

/**
 * 阅读器点击分区。
 *
 * 参考 [mihonapp/mihon](https://github.com/mihonapp/mihon) 的
 * `app/src/main/java/eu/kanade/tachiyomi/ui/reader/viewer/ViewerNavigation.kt`：
 *   · 区域用 **0..1 归一化坐标**定义 —— 与屏幕尺寸/分辨率解耦，改机型不用重算像素；
 *   · 每个区域的动作是**数据**而不是写死的 if；
 *   · 支持整体左右反转（左手用户 / 日漫右起翻页），Mihon 里叫 TappingInvertMode；
 *   · 顶部一小条恒定唤出菜单（Mihon 的 constantMenuRegion）。
 *
 * 改之前只有 `ratio < 1/3 / > 2/3` 两段横向判断写在 onReaderTap 里：
 * 不能反转、没有顶部固定区、也没法单独调中间区的宽度。
 */

export type TapAction = "prev" | "next" | "menu" | "none";

export interface TapZone {
  /** 左边界（0..1，含） */
  x0: number;
  /** 右边界（0..1，不含） */
  x1: number;
  /** 上边界（0..1，含） */
  y0: number;
  /** 下边界（0..1，不含） */
  y1: number;
  action: TapAction;
}

/** 顶部这条恒定唤出控制条（横幅广告式的误触高发区也在这里被"收编"成菜单，不会翻页） */
export const TOP_MENU_BAND = 0.05;

const TOP_MENU: TapZone = { x0: 0, x1: 1, y0: 0, y1: TOP_MENU_BAND, action: "menu" };

/** 单页模式：左 1/3 上一页 / 中间唤出控件 / 右 1/3 下一页 */
export const TAP_ZONES_SINGLE: TapZone[] = [
  TOP_MENU,
  { x0: 0, x1: 1 / 3, y0: TOP_MENU_BAND, y1: 1, action: "prev" },
  { x0: 1 / 3, x1: 2 / 3, y0: TOP_MENU_BAND, y1: 1, action: "menu" },
  { x0: 2 / 3, x1: 1, y0: TOP_MENU_BAND, y1: 1, action: "next" }
];

/** 连续滚动模式：点哪里都是唤出控件（滚动手势不受影响） */
export const TAP_ZONES_CONTINUOUS: TapZone[] = [
  { x0: 0, x1: 1, y0: 0, y1: 1, action: "menu" }
];

/**
 * 命中判定。
 * @param x 横向比例 0..1（左→右）
 * @param y 纵向比例 0..1（上→下）
 * @param invert 左右反转（左手 / 右起翻页）
 */
export function resolveTapAction(zones: TapZone[], x: number, y: number, invert = false): TapAction {
  const cx = invert ? 1 - x : x;
  for (const z of zones) {
    if (cx >= z.x0 && cx < z.x1 && y >= z.y0 && y < z.y1) return z.action;
  }
  return "none";
}

// ---- 持久化（与阅读模式同级的本地偏好） ----

export function loadTapInvert(): boolean {
  try { return localStorage.getItem(UI_KEYS.tapInvert) === "1"; } catch { return false; }
}

export function saveTapInvert(on: boolean): void {
  try { localStorage.setItem(UI_KEYS.tapInvert, on ? "1" : "0"); } catch { /* ignore */ }
}
