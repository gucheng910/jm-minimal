// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    expect(sessionStore.isLoggedIn()).toBe(true);          // ← 设置页与详情页必须一致
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

/**
 * 存储不可用时的降级。
 *
 * 为什么这条必须有：这些访问器在**渲染期**被读（App.tsx 的
 * `useState(() => sessionStore.apiUrl)`），而 `localStorage.getItem` 自己会抛
 * （隐私模式 / 企业策略禁用存储 / 配额超限）。以前 `safeParse` 只包了 `JSON.parse`，
 * **包不住 getItem 抛** —— 一次抛出 = 首次渲染抛 = 整页落进 ErrorBoundary。
 * 这里把原型上的三个方法都改成抛异常，断言访问器仍然返回默认值而不是把异常漏出去。
 */
describe("localStorage 不可用时的降级（存储被禁用 / 隐私模式）", () => {
  const boom = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
  let g: ReturnType<typeof vi.spyOn>, s: ReturnType<typeof vi.spyOn>, r: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    g = vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    s = vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    r = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(boom);
  });
  afterEach(() => { g.mockRestore(); s.mockRestore(); r.mockRestore(); });

  it("读：返回默认值，不抛", () => {
    expect(() => sessionStore.apiUrl).not.toThrow();
    expect(sessionStore.apiUrl).toBe("");
    expect(sessionStore.token).toBe("");
    expect(sessionStore.memberInfo).toBeNull();
    expect(sessionStore.authExpiry).toBe(0);
    expect(sessionStore.account).toBeNull();
    expect(sessionStore.lang).toBe("CN");
  });

  it("写：静默丢弃，不抛", () => {
    expect(() => { sessionStore.apiUrl = "http://x"; }).not.toThrow();
    expect(() => { sessionStore.token = "tok"; }).not.toThrow();
    expect(() => { sessionStore.memberInfo = { uid: 1 }; }).not.toThrow();
    expect(() => { sessionStore.account = { username: "u", password: "p" }; }).not.toThrow();
    expect(() => { sessionStore.account = null; }).not.toThrow();
  });

  it("saveAuth / clearAuth 仍然广播（登录流程不会因为存不下就静默断链）", () => {
    const seen = vi.fn();
    const off = on("jm:authChanged", seen);
    expect(() => sessionStore.saveAuth("tok", { uid: 1 })).not.toThrow();
    expect(() => sessionStore.clearAuth()).not.toThrow();
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });

  it("副作用最小：存储不可用时 isLoggedIn 为 false（不会假装已登录）", () => {
    expect(sessionStore.isLoggedIn()).toBe(false);
  });
});
