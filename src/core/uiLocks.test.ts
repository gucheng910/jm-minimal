import { describe, it, expect, beforeEach } from "vitest";
import { hasOpenSheet, popSheetLock, pushSheetLock, resetSheetLocks } from "./uiLocks";

beforeEach(() => resetSheetLocks());

describe("浮层锁计数", () => {
  it("开/关成对计数", () => {
    expect(hasOpenSheet()).toBe(false);
    pushSheetLock();
    expect(hasOpenSheet()).toBe(true);
    popSheetLock();
    expect(hasOpenSheet()).toBe(false);
  });
  it("多余 pop 不会变成负数", () => {
    popSheetLock();
    expect(hasOpenSheet()).toBe(false);
    pushSheetLock();
    expect(hasOpenSheet()).toBe(true);
  });
  it("多个浮层叠加", () => {
    pushSheetLock();
    pushSheetLock();
    popSheetLock();
    expect(hasOpenSheet()).toBe(true);
    popSheetLock();
    expect(hasOpenSheet()).toBe(false);
  });
});
