// E2E 入口：起 dev server → 跑导航回归 → 跑下拉刷新专项 → 关 server
//   npm run e2e                        # 默认自己起 dev server（端口 5199）
//   E2E_URL=http://127.0.0.1:5199/ npm run e2e   # 复用已在跑的 server
//   E2E_SKIP_PTR=1 npm run e2e         # 只跑导航回归
//   E2E_PORT=9333 可改 CDP 调试端口
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const PORT = process.env.E2E_PORT || "9333";
const APP_PORT = process.env.E2E_APP_PORT || "5199";
const URL_ = process.env.E2E_URL || "http://127.0.0.1:" + APP_PORT + "/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runNode(file, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, file)], {
      cwd: ROOT,
      env: { ...process.env, TEST_URL: URL_, E2E_PORT: PORT, ...extraEnv },
      stdio: "inherit"
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function waitForServer(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(URL_, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await sleep(500);
  }
  return false;
}

async function main() {
  let server = null;
  if (!process.env.E2E_URL) {
    console.log("启动 dev server: vite --port " + APP_PORT);
    // 直接起 vite：杀 npm.cmd 包装进程不会杀掉它的子进程，会留下占着端口的僵尸 vite
    server = spawn(process.execPath,
      [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", APP_PORT, "--strictPort"],
      { cwd: ROOT, stdio: "ignore" });
  }
  try {
    if (!(await waitForServer())) throw new Error("dev server 没起来：" + URL_);
    console.log("\n==== 导航 / 页面栈回归 ====");
    const nav = await runNode("harness.mjs");

    console.log("\n==== 登录态一致性（会员页 vs 详情页）====");
    const auth = await runNode("harness.mjs", {
      DRIVER: "driver-auth.js",
      TEST_URL: URL_ + (URL_.includes("?") ? "&" : "?") + "e2eauth=1"
    });

    console.log("\n==== 缓存中心 / 离线详情页 ====");
    const cache = await runNode("harness.mjs", {
      DRIVER: "driver-cache.js",
      TEST_URL: URL_ + (URL_.includes("?") ? "&" : "?") + "e2ecache=1",
      E2E_PORT: String(Number(PORT) + 2)
    });

    console.log("\n==== 连载详情 + 足迹合并 ====");
    const hist = await runNode("harness.mjs", {
      DRIVER: "driver-history.js",
      E2E_PORT: String(Number(PORT) + 3)
    });

    console.log("\n==== 阅读器内弹窗（图源/换话/选话缓存）====");
    const reader = await runNode("harness.mjs", {
      DRIVER: "driver-reader.js",
      E2E_PORT: String(Number(PORT) + 4)
    });

    let ptrCode = 0;
    if (!process.env.E2E_SKIP_PTR) {
      console.log("\n==== 下拉刷新（CDP 原生触摸）====");
      ptrCode = await runNode("ptr.mjs", { E2E_PORT: String(Number(PORT) + 1) });
    }
    if (nav || auth || cache || hist || reader || ptrCode) process.exitCode = 1;
    console.log("\n结果: 导航回归 " + (nav ? "✗" : "✓") + "，登录态一致性 " + (auth ? "✗" : "✓") + "，缓存/离线详情 " + (cache ? "✗" : "✓") + "，连载/足迹 " + (hist ? "✗" : "✓") + "，阅读器弹窗 " + (reader ? "✗" : "✓") + "，下拉刷新 " + (ptrCode ? "✗" : "✓"));
  } finally {
    if (server) { try { server.kill(); } catch (e) { /* 忽略 */ } }
  }
}

main().catch((e) => { console.log("FAIL:", e.message); process.exitCode = 1; });
