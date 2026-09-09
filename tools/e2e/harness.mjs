// 端到端回归：无头 Edge + CDP 驱动页面里的 driver.js
// 用法：node tools/e2e/harness.mjs   （通常经 npm run e2e 调用）
// 环境变量：TEST_URL / DRIVER / EDGE_PATH / E2E_PORT
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const RUN_DIR = path.join(ROOT, "_archive/e2e");
const URL_ = process.env.TEST_URL || "http://127.0.0.1:5199/";
const PORT = Number(process.env.E2E_PORT || 9333);
const DRIVER = process.env.DRIVER || "driver.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome"
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => p.includes("/") ? fs.existsSync(p) : true);
if (!EDGE) { console.error("找不到浏览器，请用 EDGE_PATH 指定（Edge/Chromium 均可）"); process.exit(2); }

fs.mkdirSync(RUN_DIR, { recursive: true });
const PROFILE = path.join(os.tmpdir(), "jm-e2e-profile-" + DRIVER.replace(/\W/g, ""));

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=" + PROFILE, "--remote-debugging-port=" + PORT, "about:blank"
], { stdio: "ignore" });

let ws = null, msgId = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

async function main() {
  let list = [];
  for (let i = 0; i < 60; i++) {
    try {
      list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      if (list.some((t) => t.type === "page")) break;
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有拿到页面 target（浏览器没起来？）");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Network.clearBrowserCache");
  // PWA 的 Service Worker 会缓存 dev server 的 /src/*.ts（虽然 1.7.1 起 dev 不再注册，仍兜底）
  await send("Network.setBypassServiceWorker", { bypass: true });
  try { await send("Storage.clearDataForOrigin", { origin: new URL(URL_).origin, storageTypes: "all" }); } catch (e) { /* 忽略 */ }
  // hasTouch 必须开：否则 ontouchstart 不存在，React 不会挂触摸监听
  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 2, mobile: true, hasTouch: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: fs.readFileSync(path.join(HERE, "stub.js"), "utf8") });
  await send("Page.navigate", { url: URL_ });
  await sleep(2500);

  const out = await send("Runtime.evaluate", {
    expression: fs.readFileSync(path.join(HERE, DRIVER), "utf8"),
    awaitPromise: true, returnByValue: true
  });
  if (out.exceptionDetails) {
    console.log("PAGE ERROR:", JSON.stringify(out.exceptionDetails).slice(0, 1200));
    process.exitCode = 1;
  }
  console.log(JSON.stringify(out.result && out.result.value, null, 1));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(RUN_DIR, "last-run.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("截图: " + path.relative(ROOT, shotPath));
}

main().catch((e) => { console.log("FAIL:", e.message); process.exitCode = 1; }).finally(() => {
  try { ws && ws.close(); } catch (e) { /* 忽略 */ }
  setTimeout(() => { try { edge.kill(); } catch (e) { /* 忽略 */ } process.exit(process.exitCode || 0); }, 400);
});