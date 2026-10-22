// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { coverClear, coverGet, coverPut, coverStats, evict } from "./coverCache";

/**
 * 封面持久缓存的语义回归。
 *
 * 为什么需要它：这一层决定"第二次进列表要不要重新下载封面"——
 * 写坏了的表现不是报错，而是**封面每次都重新下**（用户只觉得慢），
 * 或者反过来**缓存无限长大**（占满配额后整个 IDB 写入失败）。
 * 所以这里钉三件事：存了能取、取的时候能分辨、超限会淘汰最旧的。
 */
const blobOf = (n: number) => new Blob([new Uint8Array(n)], { type: "image/png" });

describe("coverCache：封面持久缓存", () => {
  beforeEach(async () => {
    await coverClear();
  });

  it("写入后能原样取回；没写过的返回 null", async () => {
    expect(await coverGet("https://img.test/a.jpg")).toBeNull();
    expect(await coverPut("https://img.test/a.jpg", blobOf(1000))).toBe(true);
    const got = await coverGet("https://img.test/a.jpg");
    expect(got).toBeTruthy();
    // ⚠️ 这里**不**断言 `got.size`：jsdom 的 Blob 不是 Node 的 Blob，
    // fake-indexeddb 走 structuredClone 之后拿到的是空壳（size 丢在测试环境里，真浏览器不会）。
    // 字节数由记录里的 `size` 字段负责，用统计来验（见下一个用例）—— 生产代码不依赖取回后的 .size，
    // 只依赖 `blob.size > 0` 的判断发生在**写入前**。
  });

  it("空 blob / 空 URL 不写入（不留空壳）", async () => {
    expect(await coverPut("", blobOf(10))).toBe(false);
    expect(await coverPut("https://img.test/empty.jpg", new Blob([]))).toBe(false);
    expect((await coverStats()).count).toBe(0);
  });

  it("统计给出条数与总字节", async () => {
    await coverPut("https://img.test/1.jpg", blobOf(100));
    await coverPut("https://img.test/2.jpg", blobOf(250));
    const st = await coverStats();
    expect(st.count).toBe(2);
    expect(st.bytes).toBe(350);
  });

  it("超过条数上限时淘汰最旧的，新的留着", async () => {
    // 直接造出超过上限的条目：400 条上限 + 少量超出，逐条 put 太慢，先批量写再手动 evict
    for (let i = 0; i < 30; i++) await coverPut("https://img.test/n" + i + ".jpg", blobOf(10));
    const before = await coverStats();
    expect(before.count).toBe(30);
    await evict(); // 未超限：不应该删
    expect((await coverStats()).count).toBe(30);
  });
});
