// @vitest-environment jsdom
/**
 * 更新流程的策略层（v3.16）。
 *
 * 只测**纯函数 + 存储策略**：真去 `check()` 会打网络、还要 mock 两个平台后端，
 * 测出来的会是 mock 的行为而不是策略的行为。真正的"进去弹不弹、点了会怎样"
 * 由 e2e（`driver-update.js`）在真实页面上验。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  opensBrowserFor,
  phaseOfDesktop,
  phaseOfNative,
  primaryLabel,
  shouldPrompt,
  statusText,
  updateFlow
} from "./updateFlow";
import type { UpdSnapshot } from "./updateFlow";
import { isSkipped } from "./appVersion";
// 抽屉里那个按钮读的是**原生链路自己的**快照，所以断言必须能拿到它（见「静默失败」那一组）
import { nativeUpdate } from "./updateAndroid";
import { UI_KEYS } from "./constants";

afterEach(() => { localStorage.clear(); updateFlow.__reset(); });

const snap = (patch: Partial<UpdSnapshot>): UpdSnapshot => ({
  kind: "native", phase: "available", currentVersion: "2.2.7", latestVersion: "9.9.9", notes: "",
  percent: -1, transferred: 0, total: 0, channel: "", error: "",
  canSelfInstall: true, opensBrowser: false, ...patch
});

describe("阶段映射（两端的阶段名各自映射到本层，不靠字符串巧合）", () => {
  it("桌面 IPC 阶段", () => {
    expect(phaseOfDesktop("available")).toBe("available");
    expect(phaseOfDesktop("downloading")).toBe("downloading");
    expect(phaseOfDesktop("downloaded")).toBe("downloaded");
    expect(phaseOfDesktop("checking")).toBe("checking");
    expect(phaseOfDesktop("latest")).toBe("latest");
    expect(phaseOfDesktop("error")).toBe("error");
    expect(phaseOfDesktop("idle")).toBe("idle");
  });

  it("原生链路阶段：ready → downloaded（它的「下完了」与本层的名字不同）", () => {
    expect(phaseOfNative("ready")).toBe("downloaded");
    expect(phaseOfNative("installing")).toBe("installing");
    expect(phaseOfNative("available")).toBe("available");
  });
});

describe("主按钮文案（出处：BiliPai AppUpdateDialogHost.kt 的状态机）", () => {
  it("下载完成 → 立即安装（不能自己装时 → 前往安装）", () => {
    expect(primaryLabel(snap({ phase: "downloaded" }))).toBe("立即安装");
    expect(primaryLabel(snap({ phase: "downloaded", canSelfInstall: false }))).toBe("前往安装");
  });

  it("★ 便携版 / iOS：按钮必须是「前往下载」而不是「立即更新」", () => {
    expect(primaryLabel(snap({ phase: "available" }))).toBe("立即更新");
    expect(primaryLabel(snap({ phase: "available", opensBrowser: true, kind: "desktop" }))).toBe("前往下载");
  });

  it("下载中带百分比；安卓没有百分比时不显示假数字", () => {
    expect(primaryLabel(snap({ phase: "downloading", percent: 42 }))).toBe("下载中 42%");
    expect(primaryLabel(snap({ phase: "downloading", percent: -1 }))).toBe("下载中…");
  });
});

describe("状态行", () => {
  it("下载中带上通道名（安卓的「直连 / 镜像 1」就靠它可见）", () => {
    expect(statusText(snap({ phase: "downloading", percent: 30, channel: "镜像 1" })))
      .toBe("正在下载 · 30%（镜像 1）");
    expect(statusText(snap({ phase: "downloading", percent: -1 }))).toBe("正在下载 · 下载中");
  });

  it("下载完成 / 安装中 / 可更新的措辞", () => {
    expect(statusText(snap({ phase: "downloaded" }))).toBe("下载完成，可以安装");
    expect(statusText(snap({ phase: "installing" }))).toBe("正在交给系统安装…");
    expect(statusText(snap({ phase: "available" }))).toContain("稍后再说");
  });
});

describe("该不该弹「发现新版本」", () => {
  it("可更新 / 已下完 → 弹；其它阶段不弹", () => {
    expect(shouldPrompt(snap({ phase: "available" }))).toBe(true);
    expect(shouldPrompt(snap({ phase: "downloaded" }))).toBe(true);
    for (const p of ["idle", "checking", "latest", "downloading", "installing", "error"] as const) {
      expect(shouldPrompt(snap({ phase: p }))).toBe(false);
    }
  });

  it("没有版本号不弹（半截状态别弹空壳）", () => {
    expect(shouldPrompt(snap({ latestVersion: "" }))).toBe(false);
  });

  it("★ 被「不再提醒」跳过的版本不弹，但更高版本照弹", () => {
    expect(shouldPrompt(snap({}), "9.9.9")).toBe(false);
    expect(shouldPrompt(snap({}), "9.9.10")).toBe(true);
  });
});

describe("「不再提醒」与「下次再说」的区别（一个落盘、一个不落）", () => {
  it("不再提醒：写下这一个版本号", () => {
    updateFlow.__setForTest({ phase: "available", latestVersion: "9.9.9" });
    expect(updateFlow.ignoreVersion()).toBe("9.9.9");
    expect(localStorage.getItem(UI_KEYS.updateSkip)).toBe("9.9.9");
    expect(isSkipped("9.9.9")).toBe(true);
    expect(updateFlow.snapshot().phase).toBe("idle");
  });

  it("下次再说：**不写任何东西**（下次启动照样提示）", () => {
    updateFlow.__setForTest({ phase: "available", latestVersion: "9.9.9" });
    updateFlow.preferLater();
    expect(localStorage.getItem(UI_KEYS.updateSkip)).toBeNull();
    expect(updateFlow.snapshot().phase).toBe("idle");
  });
});

describe("哪些平台是「交给浏览器」", () => {
  it("便携版 / iOS / 纯 web 是；桌面安装版与安卓不是", () => {
    expect(opensBrowserFor("portable")).toBe(true);
    expect(opensBrowserFor("ios")).toBe(true);
    expect(opensBrowserFor("web")).toBe(true);
    expect(opensBrowserFor("nsis")).toBe(false);
    expect(opensBrowserFor("android")).toBe(false);
  });
});

describe("静默失败", () => {
  it("★ 检查失败时不留任何错误文案（silent）", async () => {
    // 让原生链路必然失败：把 fetch 换成 reject（这条链路 check 的第一步就是它）
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const s = await updateFlow.check(true);
    expect(s.error).toBe("");                       // ← 静默在**本层**的含义
    expect(s.phase).toBe("idle");
    /**
     * ⚠️ **下面两行才是真正的回归网**（v3.17 补）。
     *
     * 上面那句 `expect(s.error).toBe("")` 只验了 `updateFlow` 这一份快照 ——
     * 而设置页抽屉里那个按钮（`ui/UpdateSection`）读的是 **`nativeUpdate` 自己的**快照
     * （它 `nativeUpdate.subscribe`，从不碰 updateFlow）。
     * 于是 2026-10 出现了这样一幕：规格"静默失败"**实现了、也写了测试、而且一直是绿的**，
     * 但界面上长期显示「检查更新（上次失败，重试）」—— 因为断言的是一个
     * **用户看不见的状态副本**。在 GitHub 不通的网络下那就是默认态。
     *
     * 所以这里直接断言**两份快照**：谁把 silent 从原生链路那层拿掉，这两行就红。
     */
    expect(nativeUpdate.get().error).toBe("");
    expect(nativeUpdate.get().phase).toBe("idle");
    spy.mockRestore();
  });

  it("非静默时错误可见（设置页那个手动按钮要能看见原因）——两份快照都要有", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const s = await updateFlow.check(false);
    expect(s.error).toContain("boom");
    // 同上：抽屉按钮读的是原生那份，它也必须拿到原因
    expect(nativeUpdate.get().error).toContain("boom");
    spy.mockRestore();
  });
});
