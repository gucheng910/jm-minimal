// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pickLiveLine } from "./host";

/**
 * 探活选线路（`pickLiveLine`）—— 修的是"约 1/4 冷启动挑到死线路，登录永远网络连接失败"。
 *
 * 三条判据（每条都对应一个真实故障形态）：
 *   1. **403/500 也算活**：jm 各线路对 `GET /` 就是返回 403，看 `resp.ok` 会把所有线路都判死；
 *   2. **谁先应答谁赢**：死线路会一直等到超时，用 `Promise.all` 等于把首屏交给最慢的那条；
 *   3. **全不通返回空串**：调用方据此退回原来的随机选择，行为不能比改造前更差。
 */
function stubFetch(impl: (url: string) => Promise<Response>) {
  const spy = vi.fn((u: string | URL | Request) => impl(String(u)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const resp = (status: number) => new Response("x", { status });

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("pickLiveLine：并行探活挑线路", () => {
  it("返回应答的那条线路；403 也算活（不能看 resp.ok）", async () => {
    stubFetch(async (u) => {
      if (u.includes("dead.test")) throw new TypeError("[network] fetch failed");
      return resp(403);
    });
    await expect(pickLiveLine(["dead.test", "live.test"])).resolves.toBe("live.test");
  });

  it("全部不通时返回空串（调用方退回随机选择）", async () => {
    stubFetch(async () => { throw new TypeError("[network] fetch failed"); });
    await expect(pickLiveLine(["a.test", "b.test"])).resolves.toBe("");
  });

  it("没有候选时立刻返回空串，不发请求", async () => {
    const spy = stubFetch(async () => resp(200));
    await expect(pickLiveLine([])).resolves.toBe("");
    expect(spy).not.toHaveBeenCalled();
  });

  it("重复的候选只探一次", async () => {
    const spy = stubFetch(async () => resp(403));
    await expect(pickLiveLine(["a.test", "a.test"])).resolves.toBe("a.test");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("慢线路不拖住结果：快的那条先应答就直接返回（不等超时）", async () => {
    const seen: string[] = [];
    stubFetch((u) => {
      seen.push(u);
      // slow.test 永远不成功（模拟建不起连接的线路），fast.test 立刻应答
      if (u.includes("slow.test")) return new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000));
      return Promise.resolve(resp(403));
    });
    const t0 = Date.now();
    const winner = await pickLiveLine(["slow.test", "fast.test"], 4000);
    expect(winner).toBe("fast.test");
    expect(Date.now() - t0).toBeLessThan(1000); // 明显小于 slow 的 5s
    expect(seen.length).toBe(2);
  });
});
