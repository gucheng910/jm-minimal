// @vitest-environment jsdom
/**
 * 阅读器点击分区（对应 2026-09-13 代码审查：原来只有左右两段写死的横向判断，
 * 不能反转、没有顶部固定菜单区）。
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
