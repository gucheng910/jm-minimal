import { UI_KEYS } from "./constants";

/**
 * 阅读器点击分区（**固定语义**）。
 *
 * 参考 [mihonapp/mihon](https://github.com/mihonapp/mihon) 的
 * `app/src/main/java/eu/kanade/tachiyomi/ui/reader/viewer/ViewerNavigation.kt`：
 *   · 区域用 **0..1 归一化坐标**定义 —— 与屏幕尺寸/分辨率解耦，改机型不用重算像素；
 *   · 顶部一小条恒定唤出菜单（Mihon 的 constantMenuRegion），把横幅式误触收编成菜单；
 *   · 支持整体左右反转（左手用户 / 日漫右起翻页），Mihon 里叫 TappingInvertMode。
 *
 * 改之前只有 `ratio < 1/3 / > 2/3` 两段横向判断写在 onReaderTap 里；
 * 现在抽成下面的区间表（本文件的唯一职责）。
 *
 * ── 为什么这里**没有**"九宫格 × 动作"的配置（v3.15 删掉的）────────────
 * v3.14 曾经把这张表抬成可配置：九宫格 × 8 个动作 × 两种模式 + 顶部条 + 长按。
 * 实测下来是**过度设计**：
 *   · 本项目的默认模式是**连续滚动**（上下滚），那种模式下"左右分区"根本不存在 ——
 *     九宫格里 6 个格子永远是同一件事（唤出控制条），用户看到的是 9 格 × 8 个选项的迷宫；
 *   · 真正常用的只有两件：**点画面 → 显示/收起控制条**、**单页模式下点左右翻页**，
 *     这两件的语义本来就该是固定的（各家阅读器都一样），给它们做配置只会让人眼花。
 *   · 长按在连续滚动下与滚动手势抢事件，默认还必须绑成"什么都不做"才有意义 —— 更不像个功能。
 * 所以配置层（含编辑器、持久化、总线事件、画布上的九宫格浮层）整体删除，
 * 只留这里的固定表；"左右反转"仍留在**阅读器自己的设置抽屉**里（它只对单页模式有意义）。
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
