// 下拉刷新专项：必须用 CDP 原生触摸（合成 DOM TouchEvent 在无触摸环境下 React 不挂监听）
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const RUN_DIR = path.join(ROOT, "_archive/e2e");
const URL_ = process.env.TEST_URL || "http://127.0.0.1:5199/";
const PORT = Number(process.env.E2E_PORT || 9334);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/microsoft-edge", "/usr/bin/chromium", "/usr/bin/google-chrome"
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => p.includes("/") ? fs.existsSync(p) : true);
if (!EDGE) { console.error("找不到浏览器，请用 EDGE_PATH 指定"); process.exit(2); }

fs.mkdirSync(RUN_DIR, { recursive: true });
const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=" + path.join(os.tmpdir(), "jm-e2e-profile-ptr"), "--remote-debugging-port=" + PORT, "about:blank"], { stdio: "ignore" });

let ws = null, msgId = 0;
const pending = new Map();
const send = (method, params = {}) => { const id = ++msgId; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })); };
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 200) };
  return r.result && r.result.value;
};

async function main() {
  let list = [];
  for (let i = 0; i < 60; i++) {
    try { list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json(); if (list.some((t) => t.type === "page")) break; } catch (e) { /* 等启动 */ }
    await sleep(300);
  }
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有拿到页面 target");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
  await send("Network.setBypassServiceWorker", { bypass: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 2, mobile: true, hasTouch: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: fs.readFileSync(path.join(HERE, "stub.js"), "utf8") });
  await send("Page.navigate", { url: URL_ });
  await sleep(3000);

  await evalJs("(async () => { const g = document.querySelector('.age-confirm'); if (g) g.click(); const t0 = Date.now(); while (Date.now() - t0 < 30000) { if (document.querySelectorAll('.list-item').length > 2) break; await new Promise(r => setTimeout(r, 200)); } await new Promise(r => setTimeout(r, 1200)); return true; })()");

  const before = await evalJs("(window.__reqs||[]).filter(r=>r.path==='random_recommend').length");
  const touch = (type, y) => send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: 200, y, radiusX: 8, radiusY: 8, force: 1 }] });
  await touch("touchStart", 300);
  for (const y of [330, 380, 440, 500, 560]) { await touch("touchMove", y); await sleep(70); }
  const mid = await evalJs("(() => { const w = document.querySelector('.ptr-wrap'); const i = document.querySelector('.ptr-indicator'); return { wrap: w ? w.style.transform : 'none', ind: i ? i.style.opacity : 'none', label: i ? i.textContent : '' }; })()");
  await touch("touchEnd", 560);
  await sleep(3500);
  const after = await evalJs("(window.__reqs||[]).filter(r=>r.path==='random_recommend').length");
  const state = await evalJs("(() => { const w = document.querySelector('.ptr-wrap'); const i = document.querySelector('.ptr-indicator'); return { cards: document.querySelectorAll('.list-item').length, wrap: w ? w.style.transform : 'none', ind: i ? i.style.opacity : 'none', fatal: (document.getElementById('jm-fatal')||{}).textContent || '', errs: (window.__errs||[]).slice(0,3) }; })()");

  console.log("下拉中指示器: " + JSON.stringify(mid));
  console.log("结束状态: " + JSON.stringify(state));
  const ok = after > before;
  console.log("下拉刷新: random_recommend " + before + " -> " + after + (ok ? "  ✓" : "  ✗ 未触发"));
  if (!ok) process.exitCode = 1;
}

main().catch((e) => { console.log("FAIL:", e.message); process.exitCode = 1; }).finally(() => {
  try { ws && ws.close(); } catch (e) { /* 忽略 */ }
  setTimeout(() => { try { edge.kill(); } catch (e) { /* 忽略 */ } process.exit(process.exitCode || 0); }, 400);
});