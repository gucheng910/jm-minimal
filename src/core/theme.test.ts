// @vitest-environment jsdom
/**
 * 深色模式初始判定（审查发现：原来只读 localStorage，读不到就一律浅色
 * —— 深色手机上第一次打开是一整屏纯白）。
 *
 * 约定：用户显式选过就永远听用户的，没选过才跟随系统。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialDark, prefersDark } from "./theme";
import { UI_KEYS } from "./constants";

function mockSystemDark(dark: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-color-scheme: dark") ? dark : false,
    media: query,
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    addListener() { /* noop */ },
    removeListener() { /* noop */ },
    onchange: null,
    dispatchEvent: () => false
  }));
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("initialDark", () => {
  it("没有存过 + 系统深色 → 深色（这是修掉的那条）", () => {
    mockSystemDark(true);
    expect(initialDark()).toBe(true);
  });

  it("没有存过 + 系统浅色 → 浅色", () => {
    mockSystemDark(false);
    expect(initialDark()).toBe(false);
  });

  it("存过 light：即使系统是深色也听用户的", () => {
    mockSystemDark(true);
    localStorage.setItem(UI_KEYS.theme, "light");
    expect(initialDark()).toBe(false);
  });

  it("存过 dark：即使系统是浅色也听用户的", () => {
    mockSystemDark(false);
    localStorage.setItem(UI_KEYS.theme, "dark");
    expect(initialDark()).toBe(true);
  });

  it("matchMedia 不存在（老内核）时不抛异常，退化为浅色", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersDark()).toBe(false);
    expect(initialDark()).toBe(false);
  });

  it("localStorage 抛异常（隐私模式）时不抛出来", () => {
    mockSystemDark(true);
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(initialDark()).toBe(true); // 读不到 ≠ 出错：按"没存过"处理，跟随系统
    spy.mockRestore();
  });
});
