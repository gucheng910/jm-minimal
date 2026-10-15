// @vitest-environment node
/**
 * 加密原语的**已知向量**测试。
 *
 * 为什么需要它：`core/crypto.ts` 从伞形入口（`import CryptoJS from "crypto-js"`）改成了
 * 按需引入 5 个子模块（省 46 KB）。这个改动有一个**静默失败**的失效模式：
 * crypto-js 的 ECB 模式与 Pkcs7 填充**不在 cipher-core 里**（实测 `cipher-core.js` 里
 * "ECB" 出现 0 次），必须显式 require 才注册到 `CryptoJS.mode` / `CryptoJS.pad` 上。
 * 若哪天有人删掉/替换其中一行，`AES.decrypt` 会抛"未定义的模式"或解出乱码 ——
 * 而**气泡解密失败 = 线路不可用**（core/host），是启动级故障。
 *
 * 向量来源：改造**前**用全量库（`require("crypto-js")`）实算出来的固定值，
 * 不是拿改造后的实现自证 —— 所以它能真正钉住"两种引入方式等价"。
 */
import { describe, expect, it } from "vitest";
import { aesEcbDecrypt, md5Hex } from "./crypto";

describe("md5Hex", () => {
  it("ASCII 已知向量", () => {
    expect(md5Hex("hello")).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("空串已知向量", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });

  it("非 ASCII 走 UTF-8（中文不能被按 UTF-16 编）", () => {
    // 这把 md5 用在 core/scramble 的切块数推导上（hash = md5(idStr + pageName)），
    // 页面名带中文时若编码不一致，取到的切块数会错 → 正文拼错。
    expect(md5Hex("JM极简版")).toBe("7395190cc4e0b79f2d0b17cf3c9376d3");
  });

  it("输出恒为 32 位小写 hex", () => {
    for (const s of ["a", "JMClient", "第1话", "001", "x".repeat(200)]) {
      expect(md5Hex(s)).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe("aesEcbDecrypt", () => {
  // 密钥 = md5Hex("jm-minimal-test-key")，与 core/host 的用法同构：
  // md5 的 32 位 hex 字符串再按 UTF-8 解析成 32 字节 → AES-256。
  const KEY_HEX = "cd2540e730e855e3665ec31ef19778ce";

  it("解密已知密文（钉住 ECB + Pkcs7 + Utf8 三件套都注册上了）", () => {
    const plain = "JM极简版 · 正文页测试 plaintext 0123456789";
    const cipher =
      "6MBwzJtntjMPZwibuL+T+vzUk0FNXLr4djbFaaBLC6gBn5KPBzNRZTpOKQAKPiwlXtgjOxHl6ObTiQO9qUh5Ng==";
    expect(aesEcbDecrypt(cipher, KEY_HEX)).toBe(plain);
  });

  it("跨多个块 + 整块填充（明文长度正好是 16 的倍数时 Pkcs7 会补一个整块）", () => {
    const plain = "0123456789abcdef0123456789abcdef0123456789abcdef"; // 48 字节 = 3 块
    const cipher =
      "5NvW/pvpnHkut+WovCtGkeTb1v6b6Zx5LrflqLwrRpHk29b+m+mceS635ai8K0aR6/Lc042IehSannTM+KLBpg==";
    expect(aesEcbDecrypt(cipher, KEY_HEX)).toBe(plain);
  });

  it("负对照：换一把密钥就解不出原文（防止这条测试恒真）", () => {
    const cipher =
      "6MBwzJtntjMPZwibuL+T+vzUk0FNXLr4djbFaaBLC6gBn5KPBzNRZTpOKQAKPiwlXtgjOxHl6ObTiQO9qUh5Ng==";
    const wrongKey = md5Hex("another-key");
    expect(wrongKey).not.toBe(KEY_HEX);
    expect(aesEcbDecrypt(cipher, wrongKey)).not.toBe("JM极简版 · 正文页测试 plaintext 0123456789");
  });
});
