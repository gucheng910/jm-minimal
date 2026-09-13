// @vitest-environment jsdom
/**
 * 重试语义回归测试（对应 2026-09-13 代码审查 Critical #1）。
 *
 * 背景：request() 的 for 循环原本对**任何**错误都继续下一轮，
 * 于是一个返回业务错误码的 POST 会被原样重发 3 次（实测 POST,POST,POST）。
 * 写接口（收藏 / 购买 / 签到 / 发评论 / 兑换）重复执行是真实损失，必须锁死。
 *
 * 这里的断言就是行为契约：
 *   - 服务端已答复（code !== 200）→ 只发一次，GET 也一样
 *   - 非幂等（默认所有非 GET）网络失败 → 只发一次
 *   - 幂等（默认 GET / 显式 idempotent）网络失败 → 才允许重发
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "./api";

const realFetch = globalThis.fetch;
let calls: string[] = [];

function stubJson(code: number, msg = "boom") {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(init?.method || "GET"));
    return new Response(JSON.stringify({ code, msg }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
}

function stubNetworkFail() {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(init?.method || "GET"));
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  client.selectLine("probe.example.com");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("request 重试语义", () => {
  it("POST 遇到业务错误码：只发一次", async () => {
    stubJson(500);
    await client.postForm("favorite", { aid: 1 }).catch(() => null);
    expect(calls).toEqual(["POST"]);
  });

  it("GET 遇到业务错误码：也只发一次（服务端已答复，重发没有意义）", async () => {
    stubJson(500);
    await client.request("latest", {}).catch(() => null);
    expect(calls).toEqual(["GET"]);
  });

  it("POST 遇到网络错误：不自动重发（响应丢失时服务端可能已经执行过）", async () => {
    stubNetworkFail();
    await client.postForm("favorite", { aid: 1 }).catch(() => null);
    expect(calls).toEqual(["POST"]);
  });

  it("GET 遇到网络错误：仍按预算重发", async () => {
    stubNetworkFail();
    await client.request("latest", {}, { retries: 2 }).catch(() => null);
    expect(calls).toEqual(["GET", "GET"]);
  });

  it("POST 显式声明幂等后，网络错误才允许重发", async () => {
    stubNetworkFail();
    await client.postForm("login", {}, { retries: 2, idempotent: true }).catch(() => null);
    expect(calls).toEqual(["POST", "POST"]);
  });

  it("幂等 POST 遇到业务错误码仍然只发一次", async () => {
    stubJson(400, "bad params");
    await client.postForm("login", {}, { idempotent: true }).catch(() => null);
    expect(calls).toEqual(["POST"]);
  });

  it("业务错误的文案保持不变（UI 直接展示 String(err)）", async () => {
    stubJson(500, "server busy");
    const err = await client.postForm("favorite", { aid: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toBe("Error: api error code=500：server busy");
  });

  it("网络错误的文案保持 [network] 前缀（friendlyError 依赖它）", async () => {
    stubNetworkFail();
    const err = await client.request("latest", {}, { retries: 1 }).catch((e: unknown) => e);
    expect(String(err)).toContain("[network]");
  });
});
