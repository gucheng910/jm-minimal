// @vitest-environment jsdom
/**
 * 冷启动就绪信号（core/startup.ts）的契约。
 *
 * 为什么专门给这几个函数写测试：`startupReady` / `gatePassed` 是**延迟落定**的完成信号，
 * 全靠别处显式调用 `announceStartupReady` / `openGate` 才会落定。任何一条出口漏发，
 * 等待方就永久停住，且不报错。
 *
 * 这不是假想 —— 2026-10-13 扫描（tools/scan-hang-risks.mjs）在 ContentView 里查到一次：
 * `announceStartupReady` 只写在 `pageMode === "home" && !aid` 那一条分支里，
 * 于是**深链冷启动 `?aid=xxx`**、以及分类 / 搜索 tab 的冷启动，全都漏发信号，
 * `App.confirmGate` 只能等满 35 秒的兜底超时才放行 —— 表现为「点确认一直转圈」。
 *
 * 本文件锁住**修复所依赖**的两条语义：
 *   ① 发一次就落定；
 *   ② **重复发是空操作** —— ContentView 现在用 finally 兜住所有出口，
 *      正常路径上会「提前发一次 + finally 再发一次」，若不幂等就会二次触发。
 */
import { describe, expect, it, vi } from "vitest";

/** startup.ts 的信号是模块级单例，要拿"干净"的一份只能重置模块再导入 */
async function fresh() {
  vi.resetModules();
  return import("./startup");
}

/** 让已落定的 then 回调跑完 */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("冷启动就绪信号", () => {
  it("announceStartupReady 会落定 startupReady，并带上测速结果", async () => {
    const s = await fresh();
    const got: unknown[] = [];
    void s.startupReady.then((i) => got.push(i));
    s.announceStartupReady({ speedOk: true });
    await tick();
    expect(got).toEqual([{ speedOk: true }]);
  });

  it("重复 announce 是空操作（ContentView 的 finally 兜底依赖这一条）", async () => {
    const s = await fresh();
    const got: unknown[] = [];
    void s.startupReady.then((i) => got.push(i));
    s.announceStartupReady({ speedOk: true });
    s.announceStartupReady({ speedOk: false }); // 兜底那一次必须是空操作
    await tick();
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ speedOk: true });
  });

  it("没发信号之前 startupReady 不落定 —— 这正是漏发会卡住的原因", async () => {
    const s = await fresh();
    let settled = false;
    void s.startupReady.then(() => { settled = true; });
    await tick();
    await tick();
    expect(settled).toBe(false);
  });

  it("openGate 会落定 gatePassed，且重复调用是空操作", async () => {
    const s = await fresh();
    let n = 0;
    void s.gatePassed.then(() => { n += 1; });
    s.openGate();
    s.openGate();
    await tick();
    expect(n).toBe(1);
  });

  it("没 openGate 之前 gatePassed 不落定", async () => {
    const s = await fresh();
    let settled = false;
    void s.gatePassed.then(() => { settled = true; });
    await tick();
    await tick();
    expect(settled).toBe(false);
  });
});
