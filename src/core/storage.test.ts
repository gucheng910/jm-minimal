// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { sessionStore } from "./storage";
import { on } from "./bus";

describe("登录态判据（唯一来源）", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStore.token = "";
    sessionStore.memberInfo = null;
    sessionStore.authExpiry = 0;
    sessionStore.account = null;
  });

  it("只有 token 就算已登录（不要求会员资料或有效期）", () => {
    sessionStore.token = "tok";
    expect(sessionStore.isLoggedIn()).toBe(true);
    expect(sessionStore.memberInfo).toBeNull();
    expect(sessionStore.authExpiry).toBe(0);
  });

  it("没有 token 就是未登录", () => {
    expect(sessionStore.isLoggedIn()).toBe(false);
  });

  it("token 在但本地有效期已过：仍算已登录，但提示需要刷新资料", () => {
    sessionStore.token = "tok";
    sessionStore.memberInfo = { uid: 1, username: "tester" };
    sessionStore.authExpiry = Date.now() - 1000;
    expect(sessionStore.isLoggedIn()).toBe(true);          // ← 会员页与详情页必须一致
    expect(sessionStore.needsMemberRefresh()).toBe(true);
    expect(sessionStore.hasValidSession()).toBe(false);    // 旧判据（不再用于 UI）
  });

  it("token 在但资料缺失：需要刷新资料", () => {
    sessionStore.token = "tok";
    expect(sessionStore.needsMemberRefresh()).toBe(true);
  });

  it("资料新鲜时不需要刷新", () => {
    sessionStore.token = "tok";
    sessionStore.memberInfo = { uid: 1 };
    sessionStore.authExpiry = Date.now() + 60_000;
    expect(sessionStore.needsMemberRefresh()).toBe(false);
  });

  it("saveAuth / clearAuth 都会广播 jm:authChanged", () => {
    const seen = vi.fn();
    const off = on("jm:authChanged", seen);
    sessionStore.saveAuth("tok2", { uid: 2, username: "u" });
    expect(sessionStore.isLoggedIn()).toBe(true);
    sessionStore.clearAuth();
    expect(sessionStore.isLoggedIn()).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });
});
