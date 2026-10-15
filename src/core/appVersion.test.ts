// @vitest-environment jsdom
/**
 * 版本记账层（v3.16）。这四条是**策略**，不是实现细节 —— 它们错了用户会直接感受到：
 *   · 「不再提醒」只跳一个版本（用户拍板的语义）；
 *   · 更新日志"看过的版本 ≠ 当前版本"才弹；
 *   · 静默检查有节流（否则一天开十次 = 查十次，GitHub 未认证额度 60 次/小时会被打光）；
 *   · storage 里的东西坏了一律当"没记过"，不抛。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  UPDATE_AUTOCHECK_GAP_MS,
  changelogDecision,
  hasPriorUsage,
  isSkipped,
  loadLastCheckAt,
  loadSkipVersion,
  loadVersionSeen,
  markCheckedAt,
  markVersionSeen,
  needsChangelog,
  shouldAutoCheck,
  skipVersion
} from "./appVersion";
import { UI_KEYS } from "./constants";

afterEach(() => { localStorage.clear(); });

describe("看过哪个版本（更新日志的触发键）", () => {
  it("★ 三态：全新安装 = seed（只记账不弹）/ 版本变了 = show / 看过了 = none", () => {
    expect(changelogDecision("2.2.7")).toBe("seed");            // 没记录 = 全新安装
    expect(needsChangelog("2.2.7")).toBe(false);                // ← 新装用户不该被糊一脸日志
    markVersionSeen("2.2.7", 1234);
    expect(changelogDecision("2.2.7")).toBe("none");
    expect(changelogDecision("2.3.0")).toBe("show");            // 升级了 → 该弹
    expect(needsChangelog("2.3.0")).toBe(true);
    expect(loadVersionSeen()).toEqual({ version: "2.2.7", at: 1234 });
  });

  it("空版本号一律不弹（构建期注入失败时不要拿日志去挡用户）", () => {
    expect(changelogDecision("")).toBe("none");
    expect(changelogDecision("   ")).toBe("none");
  });

  it("坏数据当成没记过（不抛）", () => {
    localStorage.setItem(UI_KEYS.versionSeen, "{ 不是 JSON");
    expect(loadVersionSeen()).toBeNull();
    // 坏数据 = 当"没记过" → 全新安装那一档（seed），不弹
    expect(changelogDecision("2.2.7")).toBe("seed");
    localStorage.setItem(UI_KEYS.versionSeen, JSON.stringify({ at: 5 }));   // 缺 version
    expect(loadVersionSeen()).toBeNull();
  });
});

/**
 * ★ v2.3.1：**老用户升级**与**真·全新安装**必须分开（用户实测回归）。
 *
 * 背景：2.3.0 首次进首页没弹日志。根因是 `version.seen` 这套记账机制本身是 v3.16 才引入的，
 * 更早的版本从没写过它 → 老用户 `seen` 为 null → 被三态里的 `seed`（全新安装）吃掉、
 * 只记账不弹。判据不能再只看"有没有记录"，要看"这台设备有没有被用过"。
 */
describe("★ v2.3.1 老用户升级要弹（无 seen 记录 + 有使用痕迹）", () => {
  it("【实测回归】改过自定义 UI 的老用户 → show（就是 2.3.0 首次进首页没弹那个 bug）", () => {
    localStorage.setItem(UI_KEYS.detailLayout, JSON.stringify({ blocks: [] }));
    expect(loadVersionSeen()).toBeNull();          // 老版本从不写 seen
    expect(hasPriorUsage()).toBe(true);
    expect(changelogDecision("2.3.0")).toBe("show");
    expect(needsChangelog("2.3.0")).toBe(true);
  });

  it("五套自定义 UI 的配置键**任意一个**都算痕迹", () => {
    for (const k of [UI_KEYS.detailStyle, UI_KEYS.listLayout, UI_KEYS.chromeLayout, UI_KEYS.readerStyle]) {
      localStorage.clear();
      expect(hasPriorUsage()).toBe(false);         // 前置：清空后确实没痕迹
      localStorage.setItem(k, "{}");
      expect(hasPriorUsage()).toBe(true);
      expect(changelogDecision("2.3.0")).toBe("show");
    }
  });

  it("【负对照】真·全新安装（无 seen、无痕迹）→ 仍是 seed，不弹（新装用户不该被糊一脸）", () => {
    expect(hasPriorUsage()).toBe(false);
    expect(changelogDecision("2.3.0")).toBe("seed");
    expect(needsChangelog("2.3.0")).toBe(false);
  });

  it("【负对照】stub 写的那些键**不算**痕迹 —— 否则 14 支老驱动一进首页就多一层遮罩（真出过的事故）", () => {
    for (const k of ["jmclient.hostcfg.v1", "jmclient.autoSelect.v1", "jmclient.tosAccepted.v1", "jmclient.theme"]) {
      localStorage.setItem(k, "1");
    }
    expect(hasPriorUsage()).toBe(false);
    expect(changelogDecision("2.3.0")).toBe("seed");
  });

  it("有 seen 记录时真值优先：痕迹不改变判定（看过 = none，版本变了 = show）", () => {
    localStorage.setItem(UI_KEYS.detailLayout, "{}");
    markVersionSeen("2.2.7", 1);
    expect(changelogDecision("2.2.7")).toBe("none");
    expect(changelogDecision("2.3.0")).toBe("show");
  });
});

describe("「不再提醒」= 只跳过这一个版本", () => {
  it("跳过 9.9.9 后：同版本不再提示，更高版本照样提示", () => {
    expect(isSkipped("9.9.9")).toBe(false);
    skipVersion("9.9.9");
    expect(loadSkipVersion()).toBe("9.9.9");
    expect(isSkipped("9.9.9")).toBe(true);
    expect(isSkipped("9.9.10")).toBe(false);        // ← 这条就是"只跳一个版本"的全部含义
    expect(isSkipped("")).toBe(false);              // 空版本号不匹配任何东西
  });

  it("不写空版本号（点了「不再提醒」但没拿到版本时不该误伤）", () => {
    skipVersion("");
    skipVersion("   ");
    expect(loadSkipVersion()).toBe("");
  });
});

describe("静默检查的节流", () => {
  it("首次启动要查；本次会话查过就不再查", () => {
    expect(shouldAutoCheck(1000, 0, false)).toBe(true);
    expect(shouldAutoCheck(1000, 0, true)).toBe(false);   // 同一次会话只查一次
  });

  it("距上次检查不足 6 小时不查，到了才查", () => {
    const now = 10 * UPDATE_AUTOCHECK_GAP_MS;
    expect(shouldAutoCheck(now, now - 1000, false)).toBe(false);
    expect(shouldAutoCheck(now, now - UPDATE_AUTOCHECK_GAP_MS + 1, false)).toBe(false);
    expect(shouldAutoCheck(now, now - UPDATE_AUTOCHECK_GAP_MS, false)).toBe(true);
  });

  it("时间戳往返：写了读得回来；坏值当 0（= 从没查过）", () => {
    markCheckedAt(777);
    expect(loadLastCheckAt()).toBe(777);
    localStorage.setItem(UI_KEYS.updateCheckedAt, "不是数字");
    expect(loadLastCheckAt()).toBe(0);
    localStorage.setItem(UI_KEYS.updateCheckedAt, "-5");
    expect(loadLastCheckAt()).toBe(0);
  });
});
