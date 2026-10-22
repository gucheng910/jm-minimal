// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  canTrust, HOST_TRUST_TTL_MS, isCoolingDown, orderHosts, pickHost, recordFailure, recordSuccess,
  resetHostHealth, scoreOf, snapshot
} from "./hostHealth";

/**
 * 图床健康评分：**这套打分的唯一目的是"别再给刚坏过的图床发请求"**。
 *
 * 所以用例都围绕行为，而不是内部常数：
 *   · 第 1 次失败只降分、不冷却（可能只是抖动）；
 *   · 第 2 次起冷却，且退避逐次翻倍、封顶 5 分钟；
 *   · 成功即清冷却（网络切换后能自己回来）；
 *   · 平均延迟用 EWMA（α=1/8，慢的会慢慢被扣分，但一次慢不会立刻打死）；
 *   · 选源时冷却中的一律不选，其余按分数从高到低。
 */
const H = "cdn-msp.jmapiproxy1.cc";
const now0 = 1_700_000_000_000;

beforeEach(() => resetHostHealth());

describe("hostHealth：失败冷却与退避", () => {
  it("第 1 次失败只降分，不进入冷却", () => {
    recordFailure(H, "timeout", now0);
    expect(isCoolingDown(H, now0)).toBe(false);
    expect(scoreOf(H, now0)).toBeLessThan(100);
  });

  it("第 2 次失败起进入冷却，退避按 1s/2s/4s… 翻倍", () => {
    recordFailure(H, "e1", now0);
    recordFailure(H, "e2", now0);
    expect(isCoolingDown(H, now0)).toBe(true);
    expect(isCoolingDown(H, now0 + 900)).toBe(true);
    expect(isCoolingDown(H, now0 + 1100)).toBe(false); // 1s 后自动解除

    recordFailure(H, "e3", now0 + 2000); // 连续第 3 次 → 2s
    expect(isCoolingDown(H, now0 + 2000 + 1900)).toBe(true);
    expect(isCoolingDown(H, now0 + 2000 + 2100)).toBe(false);

    recordFailure(H, "e4", now0 + 5000); // 连续第 4 次 → 4s
    expect(isCoolingDown(H, now0 + 5000 + 3900)).toBe(true);
    expect(isCoolingDown(H, now0 + 5000 + 4100)).toBe(false);
  });

  it("连续失败够多时退避封顶 5 分钟（不会无限增长）", () => {
    for (let i = 0; i < 30; i++) recordFailure(H, "e" + i, now0);
    expect(isCoolingDown(H, now0 + 300_000 - 100)).toBe(true);
    expect(isCoolingDown(H, now0 + 300_000 + 100)).toBe(false);
  });

  it("成功会清掉冷却与失败计数（网络恢复后能自己回来）", () => {
    recordFailure(H, "e1", now0);
    recordFailure(H, "e2", now0);
    expect(isCoolingDown(H, now0)).toBe(true);
    recordSuccess(H, 120, now0 + 500);
    expect(isCoolingDown(H, now0 + 500)).toBe(false);
    const st = snapshot().find((h) => h.host === H)!;
    expect(st.consecutiveFailures).toBe(0);
    expect(st.failureCount).toBe(0);
    expect(scoreOf(H, now0 + 500)).toBeGreaterThan(100); // 成功加分
  });
});

describe("hostHealth：延迟与选源", () => {
  it("平均延迟是 EWMA（α=1/8）：一次慢只拉高一点", () => {
    recordSuccess(H, 100, now0);
    recordSuccess(H, 900, now0 + 1);
    const st = snapshot().find((h) => h.host === H)!;
    expect(st.lastLatencyMs).toBe(900);
    expect(st.avgLatencyMs).toBe(Math.round((900 + 100 * 7) / 8)); // 200
  });

  it("延迟越高分数越低（同样的成功次数）", () => {
    recordSuccess("fast.test", 50, now0);
    recordSuccess("slow.test", 5000, now0);
    expect(scoreOf("fast.test", now0)).toBeGreaterThan(scoreOf("slow.test", now0));
  });

  it("pickHost 跳过冷却中的，其余按分数取最高", () => {
    recordSuccess("good.test", 80, now0);
    recordFailure("bad.test", "e1", now0);
    recordFailure("bad.test", "e2", now0); // → 冷却
    expect(pickHost(["bad.test", "good.test"], now0)).toBe("good.test");
  });

  it("全都在冷却里时返回 null（交给页级重试）", () => {
    for (const h of ["a.test", "b.test"]) {
      recordFailure(h, "e1", now0);
      recordFailure(h, "e2", now0);
    }
    expect(pickHost(["a.test", "b.test"], now0)).toBeNull();
  });

  it("orderHosts 把好的排前面，且不重复", () => {
    recordSuccess("ok.test", 100, now0);
    recordFailure("worse.test", "e1", now0);
    const order = orderHosts(["worse.test", "ok.test", "ok.test", "new.test"], now0);
    expect(order[0]).toBe("ok.test");
    expect(order).toContain("new.test");
    expect(order.length).toBe(3);
  });
});

describe("hostHealth：信任窗口（省掉一次 HEAD）", () => {
  it("没成功过 → 不能信任；成功过且在窗口内 → 能信任", () => {
    expect(canTrust(H, now0)).toBe(false);
    recordSuccess(H, 90, now0);
    expect(canTrust(H, now0 + 1000)).toBe(true);
    expect(canTrust(H, now0 + HOST_TRUST_TTL_MS + 1)).toBe(false);
  });

  it("在冷却期时即使成功过也不信任", () => {
    recordSuccess(H, 90, now0);
    recordFailure(H, "e1", now0 + 10);
    recordFailure(H, "e2", now0 + 20);
    expect(canTrust(H, now0 + 30)).toBe(false);
  });
});
