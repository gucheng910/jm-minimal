// @vitest-environment jsdom
// 平台层的分支覆盖。
//
// 为什么值得单独测：这次 iOS 改造引入的**每一个分叉**都从这里取判定
// （返回键走不走原生、更新按钮是下载还是跳发布页、DNS 文案、离线后端选哪个）。
// 分叉本身就是 bug 的温床，所以这里对 iOS / Android / Web **逐一断言两边的取值**，
// 而不是只测"能跑"。
//
// ⚠ platform.ts 顶层导出了 DNS_HINT 这类**模块求值期**算好的常量，
// 所以每个平台都要 `vi.resetModules()` 之后重新 import，否则拿到的是上一个平台的值。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Capacitor } from "@capacitor/core";

const PLATFORMS = ["android", "ios", "web"] as const;
type P = (typeof PLATFORMS)[number];

function mockPlatform(p: P) {
  vi.spyOn(Capacitor, "getPlatform").mockReturnValue(p);
  vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(p !== "web");
}

async function load() {
  return await import("./platform");
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); });

describe.each(PLATFORMS)("platform（%s）", (p) => {
  beforeEach(() => { mockPlatform(p); });

  it("getPlatform 原样返回三平台", async () => {
    const m = await load();
    expect(m.getPlatform()).toBe(p);
  });

  it("isIos / isAndroid 互斥，且与平台一致", async () => {
    const m = await load();
    expect(m.isIos()).toBe(p === "ios");
    expect(m.isAndroid()).toBe(p === "android");
    expect([m.isIos(), m.isAndroid()].filter(Boolean)).toHaveLength(p === "web" ? 0 : 1);
  });

  it("isNativeApp 只在原生壳为真", async () => {
    const m = await load();
    expect(m.isNativeApp()).toBe(p !== "web");
  });

  it("DNS_HINT 只在 iOS 用 iOS 版文案（iPhone 上抄 Android 的「私人 DNS」是死路）", async () => {
    const m = await load();
    if (p === "ios") {
      expect(m.DNS_HINT).toContain("iOS");
      expect(m.DNS_HINT).not.toContain("DoT 公共 DNS");
    } else {
      expect(m.DNS_HINT).toContain("DoT 公共 DNS");
      expect(m.DNS_HINT).not.toContain("iOS 配置指引");
    }
  });
});

describe("取不到 Capacitor 运行时时一律当 web（保守降级）", () => {
  it("getPlatform 抛异常 → web，且不把异常抛出去", async () => {
    vi.spyOn(Capacitor, "getPlatform").mockImplementation(() => { throw new Error("no bridge"); });
    const m = await load();
    expect(m.getPlatform()).toBe("web");
    expect(m.isIos()).toBe(false);
    expect(m.isAndroid()).toBe(false);
  });

  it("getPlatform 返回不认识的值 → web", async () => {
    vi.spyOn(Capacitor, "getPlatform").mockReturnValue("electron");
    const m = await load();
    expect(m.getPlatform()).toBe("web");
  });

  it("hasPlugin 抛异常 → false（宁可少走原生分支，也不要抛到全局兜底变成红条）", async () => {
    vi.spyOn(Capacitor, "isPluginAvailable").mockImplementation(() => { throw new Error("boom"); });
    const m = await load();
    expect(m.hasPlugin("App")).toBe(false);
  });

  it("isNativeApp 抛异常 → false", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockImplementation(() => { throw new Error("boom"); });
    const m = await load();
    expect(m.isNativeApp()).toBe(false);
  });
});

// 侧滑返回：iOS 上唯一的返回手段，判错了用户就卡在页面里出不来；
// 判松了会和阅读器翻页/列表拖动抢事件。所以逐档钉死阈值。
describe("isBackSwipe（侧滑返回判定，iOS/Android 共用同一份规则）", () => {
  const pt = (clientX: number, clientY: number) => ({ clientX, clientY });

  it("左缘起手 + 明显右滑 → 触发", async () => {
    const m = await load();
    expect(m.isBackSwipe(pt(5, 300), pt(120, 305))).toBe(true);
    expect(m.isBackSwipe(pt(24, 300), pt(200, 300))).toBe(true); // 边界值：正好 24px 算内侧
  });

  it("起手不在左缘 → 不触发（列表拖动/阅读器手势要留给业务）", async () => {
    const m = await load();
    expect(m.isBackSwipe(pt(25, 300), pt(400, 300))).toBe(false);
    expect(m.isBackSwipe(pt(200, 300), pt(600, 300))).toBe(false);
  });

  it("位移不够 → 不触发（边界：正好 60px 不算，必须 >60）", async () => {
    const m = await load();
    expect(m.isBackSwipe(pt(0, 300), pt(60, 300))).toBe(false);
    expect(m.isBackSwipe(pt(0, 300), pt(61, 300))).toBe(true);
  });

  it("垂直分量太大 → 不触发（别和上下滚动抢）", async () => {
    const m = await load();
    // 规则：dx > 60 且 dx > dy*1.5
    expect(m.isBackSwipe(pt(0, 300), pt(100, 0))).toBe(false);   // dx=100, dy=300 → 100 > 450 假
    expect(m.isBackSwipe(pt(0, 300), pt(61, 300))).toBe(true);   // dy=0 → 真（对照组）
  });

  it("垂直分量在阈值内 → 仍然触发（手指不可能走直线）", async () => {
    const m = await load();
    // dx=120, dy=40 → 120 > 60 ✓
    expect(m.isBackSwipe(pt(0, 300), pt(120, 340))).toBe(true);
    // dx=100, dy=40 → 100 > 60 ✓（这是"斜着滑但可接受"的那一档）
    expect(m.isBackSwipe(pt(0, 300), pt(100, 340))).toBe(true);
    // dx=90, dy=60 → 90 > 90 为假，正好卡在斜率边界上 → 不触发
    expect(m.isBackSwipe(pt(0, 300), pt(90, 360))).toBe(false);
  });

  it("往左滑 / 原地抬手 → 不触发", async () => {
    const m = await load();
    expect(m.isBackSwipe(pt(20, 300), pt(0, 300))).toBe(false);
    expect(m.isBackSwipe(pt(10, 300), pt(10, 300))).toBe(false);
  });

  it("坐标缺失或非法 → 不触发（宁可不响应，也不要误触发返回把用户弹走）", async () => {
    const m = await load();
    expect(m.isBackSwipe(null, pt(300, 300))).toBe(false);
    expect(m.isBackSwipe(pt(0, 300), null)).toBe(false);
    expect(m.isBackSwipe(undefined, undefined)).toBe(false);
    expect(m.isBackSwipe(pt(NaN, 300), pt(300, 300))).toBe(false);
    expect(m.isBackSwipe(pt(0, 300), pt(Infinity, 300))).toBe(false);
  });

  it("阈值可注入（将来要按屏幕宽度调参时不用改调用方）", async () => {
    const m = await load();
    const cfg = { edgePx: 60, minDx: 200, slopeRatio: 3 };
    expect(m.isBackSwipe(pt(50, 100), pt(300, 100), cfg)).toBe(true);  // 起手 50<=60 ✓，dx=250>200 ✓
    expect(m.isBackSwipe(pt(70, 100), pt(400, 100), cfg)).toBe(false); // 起手 70>60 ✗
    expect(m.isBackSwipe(pt(10, 100), pt(150, 100), cfg)).toBe(false); // dx=140 < 200 ✗
    expect(m.isBackSwipe(pt(10, 100), pt(300, 400), cfg)).toBe(false); // dx=290>200 但 dy=300 → 290 > 900 假 ✗
  });
});
