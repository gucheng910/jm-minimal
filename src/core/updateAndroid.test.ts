// @vitest-environment jsdom
/**
 * 原生更新链路（Android / iOS）的两处「文案与静默」回归。
 *
 * 这一组测试盯的是两个真实缺陷（都是 2026-10 走查时发现的）：
 *   ① **静默检查会留痕**：进软件 1.5s 后的那次静默检查若失败，`nativeUpdate` 自己会把
 *      error 写进快照，而设置页那个按钮读的正是**这份**快照（不是 `updateFlow` 的），
 *      于是抽屉里长期显示「检查更新（上次失败，重试）」—— 在 GitHub 不通的网络下
 *      （这个 App 的大量用户）那就是**默认态**。修法不是"再清一次 error"，而是把
 *      `silent` 传进这一层：**静默检查不留痕**。
 *   ② **安装失败后文案不变**：`ready` 阶段原来不显示 error（后缀只认 `idle`），
 *      所以「安装失败：…」之后按钮仍写着「下载完成，点击安装」，界面像什么都没发生。
 *      文案因此从组件搬成了纯函数 `nativeLabel`，这两条就都能被测。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeLabel, nativeUpdate } from "./updateAndroid";
import type { NativeUpdSnapshot } from "./updateAndroid";

function snap(patch: Partial<NativeUpdSnapshot> = {}): NativeUpdSnapshot {
  return {
    phase: "idle", version: "", notes: "", pageUrl: "", assetUrl: "", ipaUrl: "",
    channel: "", percent: -1, fileSize: 0, error: "",
    ...patch
  };
}

describe("nativeLabel：阶段 → 按钮文案（纯函数）", () => {
  it("idle：没有 error 就是「检查更新」，有 error 才加「（失败，重试）」", () => {
    expect(nativeLabel(snap(), false)).toBe("检查更新");
    expect(nativeLabel(snap({ error: "http 404" }), false)).toBe("检查更新（失败，重试）");
  });

  it("【关键】ready + error：必须说「安装失败，点击重试」，不能还说「下载完成，点击安装」", () => {
    expect(nativeLabel(snap({ phase: "ready" }), false)).toBe("下载完成，点击安装");
    expect(nativeLabel(snap({ phase: "ready", error: "安装失败：xx" }), false)).toBe("安装失败，点击重试");
  });

  it("downloading 带上通道名（原来这个后缀写在组件里，搬进来后行为不变）", () => {
    expect(nativeLabel(snap({ phase: "downloading" }), false)).toBe("下载中…");
    expect(nativeLabel(snap({ phase: "downloading", channel: "镜像 1" }), false)).toBe("下载中…（镜像 1）");
  });

  it("iOS 的 available 必须写「下载 ipa」——它不是自己下载安装", () => {
    expect(nativeLabel(snap({ phase: "available" }), false)).toBe("发现新版本，点击更新");
    expect(nativeLabel(snap({ phase: "available" }), true)).toBe("发现新版本，下载 ipa");
  });

  it("其余阶段逐一对齐（checking / latest / installing）", () => {
    expect(nativeLabel(snap({ phase: "checking" }), false)).toBe("检查中…");
    expect(nativeLabel(snap({ phase: "latest" }), false)).toBe("已是最新版本");
    expect(nativeLabel(snap({ phase: "installing" }), false)).toBe("正在安装…");
  });

  it("所有阶段都有文案（不能让 Record 漏键导致按钮空白）", () => {
    const phases: NativeUpdSnapshot["phase"][] = ["idle", "checking", "latest", "available", "downloading", "ready", "installing"];
    for (const p of phases) {
      expect(nativeLabel(snap({ phase: p }), false).length).toBeGreaterThan(0);
      expect(nativeLabel(snap({ phase: p }), true).length).toBeGreaterThan(0);
    }
  });
});

describe("check({ silent })：静默检查不留痕", () => {
  beforeEach(() => { nativeUpdate.forget(); });
  afterEach(() => { vi.unstubAllGlobals(); nativeUpdate.forget(); });

  it("静默失败：error 保持空（抽屉里那个按钮读的就是这份快照）", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
    const s = await nativeUpdate.check({ silent: true });
    expect(s.phase).toBe("idle");
    expect(s.error).toBe("");
    expect(nativeLabel(s, false)).toBe("检查更新");
  });

  it("负对照：不传 silent 的失败**必须**留下 error（否则这条测试恒真）", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));
    const s = await nativeUpdate.check();
    expect(s.phase).toBe("idle");
    expect(s.error).not.toBe("");
    expect(nativeLabel(s, false)).toBe("检查更新（失败，重试）");
  });

  it("HTTP 非 2xx 也按失败处理，且静默时不落痕", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 404 }));
    const silent = await nativeUpdate.check({ silent: true });
    expect(silent.error).toBe("");
    const loud = await nativeUpdate.check();
    expect(loud.error).toContain("404");
  });
});
