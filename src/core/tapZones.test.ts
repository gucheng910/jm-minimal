// @vitest-environment jsdom
/**
 * 阅读器点击分区（对应 2026-09-13 代码审查：原来只有左右两段写死的横向判断，
 * 不能反转、没有顶部固定菜单区）。
 *
 * ⚠️ v3.15 删掉了 v3.14 那套"九宫格 × 动作"配置（见 `tapZones.ts` 文件头的说明：
 * 默认模式是连续滚动，那儿根本没有左右分区，九宫格配置属于过度设计）。
 * 这个文件因此回到"只钉固定语义"的形态 —— 下面这些期望值就是**永远不会被配置改掉**的契约：
 *   · 单页模式：左 1/3 上一页 / 中间唤出控件 / 右 1/3 下一页；
 *   · 顶部 5% 无论左右都只唤出菜单；
 *   · 反转只换左右，不动中间与顶栏；
 *   · 连续滚动模式：点哪里都是唤出控件。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  TAP_ZONES_CONTINUOUS,
  TAP_ZONES_SINGLE,
  TOP_MENU_BAND,
  loadTapInvert,
  resolveTapAction,
  saveTapInvert
} from "./tapZones";
import { UI_KEYS } from "./constants";

const hit = (x: number, y = 0.5, invert = false) => resolveTapAction(TAP_ZONES_SINGLE, x, y, invert);

afterEach(() => { localStorage.clear(); });

describe("resolveTapAction（单页模式）", () => {
  it("左 1/3 = 上一页，右 1/3 = 下一页，中间 = 唤出控件", () => {
    expect(hit(0.1)).toBe("prev");
    expect(hit(0.5)).toBe("menu");
    expect(hit(0.9)).toBe("next");
  });

  it("边界归属：1/3 属于中间，2/3 属于下一页", () => {
    expect(hit(0.32)).toBe("prev");
    expect(hit(1 / 3)).toBe("menu");
    expect(hit(2 / 3)).toBe("next");
  });

  it("顶部 5% 无论左右都只唤出菜单（不会误翻页）", () => {
    expect(hit(0.05, TOP_MENU_BAND / 2)).toBe("menu");
    expect(hit(0.5, TOP_MENU_BAND / 2)).toBe("menu");
    expect(hit(0.95, TOP_MENU_BAND / 2)).toBe("menu");
    expect(hit(0.95, TOP_MENU_BAND)).toBe("next"); // 刚好越过顶栏就恢复翻页
  });

  it("反转后左右互换（左手 / 右起翻页）", () => {
    expect(hit(0.1, 0.5, true)).toBe("next");
    expect(hit(0.9, 0.5, true)).toBe("prev");
    expect(hit(0.5, 0.5, true)).toBe("menu"); // 中间区不动
  });

  it("反转不影响顶部菜单条", () => {
    expect(hit(0.95, 0.01, true)).toBe("menu");
  });

  it("越界比例不崩：返回 none", () => {
    expect(resolveTapAction(TAP_ZONES_SINGLE, -0.1, 0.5)).toBe("none");
    expect(resolveTapAction(TAP_ZONES_SINGLE, 1.2, 0.5)).toBe("none");
    expect(resolveTapAction(TAP_ZONES_SINGLE, 0.5, 1.5)).toBe("none");
  });

  it("连续滚动模式：任何位置都是唤出控件", () => {
    for (const [x, y] of [[0.05, 0.01], [0.1, 0.5], [0.9, 0.9]]) {
      expect(resolveTapAction(TAP_ZONES_CONTINUOUS, x, y)).toBe("menu");
    }
  });

  it("★ 固定语义：画面内每一处都有动作（区间是半开的 [0,1)），而 1.0 处是「没有命中」而不是崩", () => {
    for (const mode of [TAP_ZONES_SINGLE, TAP_ZONES_CONTINUOUS]) {
      for (let xi = 0; xi <= 10; xi++) {
        for (let yi = 0; yi <= 10; yi++) {
          // 采样点一律取 0 .. 10/11（严格小于 1）：区间的右/下边界是**开**的，
          // 正好 1.0 不在任何一区里 —— 那是既有的、被老测试钉过的契约（`hit(1.2) === "none"`），
          // 不是这一轮能顺手改掉的：阅读器那边"边界外"落到 showChrome()，与"点中间"同路。
          expect(resolveTapAction(mode, xi / 11, yi / 11)).not.toBe("none");
        }
      }
      expect(resolveTapAction(mode, 1, 0.5)).toBe("none");
      expect(resolveTapAction(mode, 0.5, 1)).toBe("none");
    }
  });
});

describe("翻转偏好持久化", () => {
  it("默认关闭", () => {
    expect(loadTapInvert()).toBe(false);
  });

  it("存了之后读得回来", () => {
    saveTapInvert(true);
    expect(localStorage.getItem(UI_KEYS.tapInvert)).toBe("1");
    expect(loadTapInvert()).toBe(true);
    saveTapInvert(false);
    expect(loadTapInvert()).toBe(false);
  });

  it("localStorage 不可用时不抛异常", () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("denied"); };
    try { expect(loadTapInvert()).toBe(false); } finally { Storage.prototype.getItem = orig; }
  });
});
