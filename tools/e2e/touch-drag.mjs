// 「自定义 UI」画布拖拽的**真机触摸**验证（CDP Input.dispatchTouchEvent）。
//
// 为什么必须单独一个脚本、而不能塞进 driver.js：
//   driver.js 跑在页面里（Runtime.evaluate），只能用合成事件。而**合成事件不经过
//   浏览器的原生手势仲裁** —— 它永远不会把"长按后还在动"判成滚动、也就永远不会
//   发 pointercancel。所以旧版在真机上"拖不动"，driver.js 却是全绿（假安全）。
//   本脚本走 CDP 的原生输入管线（同 tools/e2e/ptr.mjs 的下拉刷新专项），
//   并在页面里加装探针，把"我们真的把 touchmove 抢下来了"变成可读数字。
//
// 判据的**判别力**怎么复核（negative control，2026-10-13 实测做过一次）：
//   本脚本必须能证明"修之前会失败"，否则它只是绿灯发生器。做法：
//     ① 把 src/hooks/useCanvasDrag.ts 里非被动 touchmove 的 `e.preventDefault()`
//        临时改成 `if (false && ...)`；
//     ② 重新构建后跑本脚本 → **必须失败**（实测：用例 A 报 `drag=0` +
//        `pointercancel:1, lostcapture:1`，即浏览器真把手势收走去滚动了）；
//     ③ 恢复代码、重跑 → 必须重新全绿（实测：`tmPrevented:4`、`pointercancel:0`）。
//   所以用例 A 的 `tmPrevented > 0` 断言是这套验证的**锚点**：它证明"是我们挡下来的"，
//   而不是"浏览器本来就不会抢"。
//
// 用法（**用 pwsh 跑**，git-bash 里起不来浏览器；先自己起好 server）：
//   node node_modules/vite/bin/vite.js --port 5199 --strictPort      # 另开一个
//   TEST_URL=http://127.0.0.1:5199/ node tools/e2e/touch-drag.mjs
//   注：若 dev server 会被别的进程写文件搞崩（chokidar EBUSY），改用
//       `npx vite build --outDir dist-audit` + `npx vite preview --outDir dist-audit`
//       （preview 没有文件监听，不受并发写影响），再指向它。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.TEST_URL || "http://127.0.0.1:5199/";
const PORT = Number(process.env.E2E_PORT || 9336);
const PROFILE = path.join(os.tmpdir(), "jm-e2e-profile-touchdrag");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!EDGE) { console.error("找不到 Edge，请用 EDGE_PATH 指定"); process.exit(2); }

// 残留 profile 会让 localStorage 带着上一轮的编辑态进来 → 从干净的开始
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ }

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=" + PROFILE, "--remote-debugging-port=" + PORT, "about:blank"
], { stdio: "ignore" });

let ws = null, msgId = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
};

/** 原生触摸：一次一根手指 */
const touch = (type, x, y) => send("Input.dispatchTouchEvent", {
  type,
  touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1 }]
});

/** 画布探针：把"浏览器到底投递了什么、我们抢下没有"变成可读数字。
 *  取消类事件用**捕获阶段**挂（不管落到哪个节点都记下）。 */
const PROBE_ON = `(() => {
  if (!window.__evHooked) {
    window.__evHooked = 1;
    window.__ev = {};
    window.__evReset = () => { window.__ev = { touchmove: 0, tmPrevented: 0, touchcancel: 0, pointercancel: 0, lostcapture: 0, scroll: 0, lastPid: null, lastTarget: "" }; };
    // 记下驱动拖拽的指针 id（用例 C 要**主动**释放它的捕获，确定性复现真机那条路径：
    // 节点被移动 → 捕获丢失 → 事件改投"手指下方当前的元素"）。
    document.addEventListener("pointerdown", (e) => { window.__ev.lastPid = e.pointerId; }, true);
    window.__evReset();
    document.addEventListener("touchmove", (e) => {
      window.__ev.touchmove++;
      // 事件到底落在哪个元素上（用户实测：12 个 move 只有 3 个命中被拖块，
      // 其余落在 d-title / d-hero-info —— 这条记录就是那个现象的探针）
      window.__ev.lastTarget = (e.target && e.target.className) ? String(e.target.className) : "";
      // 我们的非被动监听器挂在块上（目标阶段），先于 document 冒泡跑；
      // 它 preventDefault 过的话，这里读到的 defaultPrevented 就是 true。
      if (e.defaultPrevented) window.__ev.tmPrevented++;
    }, { passive: true });
    document.addEventListener("touchcancel", () => { window.__ev.touchcancel++; }, true);
    document.addEventListener("pointercancel", () => { window.__ev.pointercancel++; }, true);
    document.addEventListener("lostpointercapture", () => { window.__ev.lostcapture++; }, true);
    document.addEventListener("scroll", () => { window.__ev.scroll++; }, true);
  }
  window.__evReset();
  return true;
})()`;
const PROBE_RESET = `(() => { window.__evReset();
  const s = document.querySelector('.ed-stage'); return { scrollTop: s ? Math.round(s.scrollTop) : null }; })()`;
const PROBE_READ = `(() => {
  const s = document.querySelector('.ed-stage');
  const g = document.querySelector('.ed-canvas .ed-ghost');
  return {
    ev: window.__ev,
    scrollTop: s ? Math.round(s.scrollTop) : null,
    drag: document.querySelectorAll('.ed-canvas .ed-blk.ed-drag').length,
    ghost: document.querySelectorAll('.ed-canvas .ed-ghost').length,
    gap: document.querySelectorAll('.ed-canvas .ed-gap').length,
    ghostTf: g ? (g.style.transform || '') : null
  };
})()`;

/**
 * 用来做手势试验的**顶层块**（先把画布滚回顶部，坐标才可预期）。
 *
 * ⚠️ 为什么不用 `.ed-blk[0]`：拖动会改变顺序，于是"第一个块"在不同用例之间
 * **不是同一个块**。v3.4 实测踩到：某次跑完前面的用例后 `[0]` 变成了主视觉，
 * 而主视觉的**正中央正好压着四宫格**（`.ed-slot`）—— 手指落在内嵌槽位上，
 * v3 的内嵌可拖就会把这次手势**正确地**抢走，于是 `.ed-blk.ed-drag` 计数为 0，
 * 用例 C 的第二拖被误判成"拖不起来"。那是产品的正常行为，不是缺陷。
 * 所以固定挑一个**没有内嵌槽位**的块：简介（`desc`），退化时用动作区，再退化才用 [0]。
 */
const GEO = `(() => {
  const s = document.querySelector('.ed-stage'); if (s) s.scrollTop = 0;
  const blk = document.querySelector('.ed-canvas .ed-blk[data-blk="desc"]')
    || document.querySelector('.ed-canvas .ed-blk[data-blk="action"]')
    || document.querySelectorAll('.ed-canvas .ed-blk')[0];
  if (!blk) return null;
  const r = blk.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
           h: Math.round(r.height), top: Math.round(r.top), name: blk.getAttribute('data-blk'),
           overNested: !!((document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)) || {}).closest?.('.ed-slot')) };
})()`;

const result = { steps: [] };
const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); };

async function main() {
  let list = [];
  for (let i = 0; i < 60; i++) {
    try {
      list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list", { signal: AbortSignal.timeout(2000) })).json();
      if (list.some((t) => t.type === "page")) break;
    } catch { /* 等启动 */ }
    await sleep(300);
  }
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有拿到页面 target（浏览器没起来？）");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Network.setBypassServiceWorker", { bypass: true });
  try { await send("Storage.clearDataForOrigin", { origin: new URL(URL_).origin, storageTypes: "all" }); } catch { /* 忽略 */ }
  // hasTouch 必须开：否则 ontouchstart 不存在，React 不会挂触摸监听。
  // ⚠️ 视口高度故意压到 560：**必须让 .ed-stage 真的能滚**，否则
  //   用例 A 的"scrollTop 保持 0"与用例 B 的"该滚滚"都是**空断言**
  //   （900 高的视口下实测 scrollHeight === clientHeight === 684，根本无滚动空间）。
  await send("Emulation.setDeviceMetricsOverride", { width: 420, height: 560, deviceScaleFactor: 2, mobile: true, hasTouch: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: fs.readFileSync(path.join(HERE, "stub.js"), "utf8") });
  await send("Page.navigate", { url: URL_ });
  await sleep(2600);

  // 过 18+ 门 → 等首页
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const g = document.querySelector('.age-confirm'); if (g) g.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) { if (document.querySelectorAll('.list-item').length > 2) break; await sleep(200); }
    await sleep(600); return true;
  })()`);

  // 打开「自定义 UI」编辑器（⚠️ v3.13 起入口在**设置页最上方**，抽屉里那条已删除）
  // v3.2 外壳改版：进入后停在「选择页面」**画廊屏**，必须再点「详情页」卡片才到编辑屏 ——
  // 少了这一步，后面所有 `.ed-canvas .ed-blk` 的查询都会读空（本用例第一版就是这样红的）。
  const opened = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s); const qa = (s) => Array.from(document.querySelectorAll(s));
    const entry = qa('.settings-page .grow').find((b) => /自定义 UI/.test(b.textContent || ''));
    if (!entry) return 'no-entry';
    entry.click(); await sleep(1300);
    if (!q('.ed-gallery')) return 'no-gallery';
    q(".ed-gallery .ed-card[data-page='detail']").click(); await sleep(900);
    return q('.ed-canvas') ? 'ok' : 'no-canvas';
  })()`);
  result.openEditor = opened;
  if (opened !== "ok") throw new Error("打不开「自定义 UI」编辑器：" + opened);

  await sleep(600);
  await evalJs(PROBE_ON);

  // ────────────────────────────────────────────────────────────
  // 用例 A：长按 380ms 之后再移动 —— 真机上这里以前会被判成滚动（拖拽当场死）
  // ────────────────────────────────────────────────────────────
  const geo = await evalJs(GEO);
  if (!geo) throw new Error("画布上一个 .ed-blk 都没有");
  await evalJs(PROBE_RESET);

  // 前置条件（S-3 修补假安全）：画布必须**真的能滚**，否则下面"scrollTop 保持 0"
  // 与用例 B 的"该滚滚"都是空通过 —— 一个从没滚动过的东西，证明不了任何事。
  const scrollMetrics = await evalJs(`(() => { const s = document.querySelector('.ed-stage');
    return s ? { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight } : null; })()`);
  check(!!scrollMetrics && scrollMetrics.scrollHeight > scrollMetrics.clientHeight + 50,
    "画布没有滚动空间（scrollHeight=" + (scrollMetrics && scrollMetrics.scrollHeight) +
    " clientHeight=" + (scrollMetrics && scrollMetrics.clientHeight) +
    "）：本脚本的滚动类断言会是空通过，测试失去意义");

  await touch("touchStart", geo.x, geo.y);
  await sleep(380);                                   // 过长按阈值（280ms）
  const afterHold = await evalJs(PROBE_READ);

  // 抓起后**大幅**移动：一路 160px 上去 —— 远超浏览器的滚动slop。
  // 手势一旦被浏览器判成滚动，这里会立刻看到 pointercancel / drag 归零 / scrollTop 变大。
  for (const dy of [20, 60, 110, 160]) {
    await touch("touchMove", geo.x, geo.y - dy);
    await sleep(70);
  }
  const afterMove = await evalJs(PROBE_READ);

  await touch("touchEnd", geo.x, geo.y - 160);
  await sleep(350);
  const afterEnd = await evalJs(PROBE_READ);

  result.longPress = { geo, afterHold, afterMove, afterEnd };
  check(afterHold.drag === 1, "长按 380ms 后没有进入拖动态（真机触摸没被当成手势起拖）：drag=" + afterHold.drag);
  check(afterHold.ghost === 1, "起拖后没有跟手镜像：ghost=" + afterHold.ghost);
  // ↓↓↓ 这两条就是本波的全部意义：抓起之后手指再大幅移动，浏览器不许把手势收回去
  check(afterMove.drag === 1,
    "抓起后大幅移动被中断了（浏览器把手势判给了滚动）：drag=" + afterMove.drag + " ev=" + JSON.stringify(afterMove.ev));
  check(afterMove.ev.pointercancel === 0 && afterMove.ev.touchcancel === 0,
    "手势被浏览器取消了（pointercancel/touchcancel 一来，拖拽就断）：" + JSON.stringify(afterMove.ev));
  check(afterMove.scrollTop === 0,
    "拖动中画布被滚动了（scrollTop=" + afterMove.scrollTop + "，应保持 0）");
  // 锚点断言（S-3）：上面"没被取消"必须**归功于我们挡下了 touchmove**，
  // 而不是"浏览器本来就不会抢"。配合头注释里的 negative control 一起成立。
  check(afterMove.ev.tmPrevented > 0,
    "拖动中一个 touchmove 都没被我们 preventDefault：'没被取消'就证明不了是修复的功劳：" + JSON.stringify(afterMove.ev));
  check(afterEnd.drag === 0 && afterEnd.ghost === 0, "松手后拖动态/镜像没撤干净：" + JSON.stringify(afterEnd));

  // ────────────────────────────────────────────────────────────
  // 用例 B：快速滑动（没长按）= 滚动，绝不许起拖  —— "该滚滚、该拖拖"
  //
  // 判据说明（重要）：headless 合成触摸下"实际滚了多少像素"是**环境敏感**的观测量
  // （同一份代码两次跑出过 85 和 0），所以这里的硬断言是**我们自己的契约**：
  //   ① 一个 preventDefault 都没发 → 手势完全还给浏览器（它要滚就能滚）；
  //   ② 没进拖动态 → 滚动没被劫持。
  // scrollTop / 浏览器是否接管手势只作诊断记录，不当判据（真机滚动由人手上手验）。
  // ────────────────────────────────────────────────────────────
  const geoB = await evalJs(GEO);
  await evalJs(PROBE_RESET);
  const metrics = await evalJs(`(() => { const s = document.querySelector('.ed-stage');
    return s ? { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, scrollTop: Math.round(s.scrollTop) } : null; })()`);
  await touch("touchStart", geoB.x, geoB.y);
  for (const dy of [8, 20, 40, 70, 100, 130]) { await touch("touchMove", geoB.x, geoB.y - dy); await sleep(50); }
  const midB = await evalJs(PROBE_READ);
  await sleep(300);                        // 滚动是异步的：等一拍再读一次
  const afterB = await evalJs(PROBE_READ);
  await touch("touchEnd", geoB.x, geoB.y - 130);
  await sleep(300);
  const endB = await evalJs(PROBE_READ);

  result.quickSwipe = { geoB, metrics, midB, afterB, endB };
  check(midB.drag === 0, "快速滑动居然起拖了（滚动会被劫持）：drag=" + midB.drag);
  check(midB.ev.tmPrevented === 0,
    "快速滑动时 touchmove 被 preventDefault 了（滚动会被卡住）：" + JSON.stringify(midB.ev));
  // S-3：把"我们没挡"升级成"手势真的滚动起来了"。前置条件已断言画布可滚
  // （scrollHeight > clientHeight + 50），所以这条不是空断言。
  // 若将来在某个环境里滚动量恒为 0，这条会红 —— 那时要查的是环境而非产品：
  // 该情况下请把本行降级为诊断记录，并在报告里写明"'该滚滚'不构成证明"。
  check(afterB.scrollTop > 0 || endB.scrollTop > 0,
    "快速滑动后画布没滚（scrollTop 始终 0）：'该滚滚'没被证明 —— afterB=" + afterB.scrollTop + " endB=" + endB.scrollTop);

  // ────────────────────────────────────────────────────────────
  // 用例 C：**指针捕获丢失**之后，拖拽必须继续、且必须能正常收尾
  //
  // 这是用户实测"拖拽卡死"的护栏。真机因果链（实测证据）：
  //   拖动中换位 → React 用 insertBefore **移动 DOM 节点** → 节点一移动，
  //   指针捕获被释放（`lostcapture: 1`）→ 此后事件不再投递给被拖块，而是投给
  //   **手指下方当前的元素**（实测：12 个 move 只有 3 个命中被拖块，其余落在
  //   `d-title` / `d-hero-info`；`pointerup` 也落在 `d-title`）。于是：
  //     ① 镜像不再跟手 → 用户说「组件悬着动不了」
  //     ② 收尾函数从未被调用 → 用户说「黑框还在原地」
  //     ③ globalDragOwner 永不释放 → 用户说「拖拽失效了」
  //
  // 修法：起拖后 move/up/cancel 挂到 **window**（对捕获丢失免疫），元素级处理器
  // 只负责起拖。本用例**主动**调用 releasePointerCapture 来确定性制造捕获丢失
  // （headless 里换位不一定真丢捕获，不主动制造的话本用例会退化成绿灯发生器），
  // 然后断言：跟手继续、收尾干净、且紧接着能再拖第二次。
  // ────────────────────────────────────────────────────────────
  const geoC = await evalJs(GEO);
  await evalJs(PROBE_RESET);
  await touch("touchStart", geoC.x, geoC.y);
  await sleep(380);
  const cHold = await evalJs(PROBE_READ);

  // 找另一个块的**内部元素**（优先 .d-title / .d-hero-info —— 实测事件正是落在这里）
  const cTarget = await evalJs(`(() => {
    const s = document.querySelector('.ed-stage'); if (s) s.scrollTop = 0;
    const el = document.querySelector('.ed-canvas .d-title') || document.querySelector('.ed-canvas .d-hero-info');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), cls: String(el.className) };
  })()`);
  if (!cTarget) throw new Error("用例C：找不到 .d-title / .d-hero-info 这类内部元素");

  // 主动制造"捕获丢失"（真机上由换位移动节点导致）
  const released = await evalJs(`(() => {
    const el = document.querySelector('.ed-canvas .ed-blk.ed-drag');
    const pid = window.__ev.lastPid;
    if (!el || pid == null) return 'no-target';
    try { el.releasePointerCapture(pid); return 'released:' + pid; } catch (err) { return 'throw:' + pid; }
  })()`);

  // 把手指移到**另一个块的内部元素**上，并在那里松手
  await touch("touchMove", cTarget.x, cTarget.y);
  await sleep(80);
  const cOut = await evalJs(PROBE_READ);
  await sleep(160);
  const cOut2 = await evalJs(PROBE_READ);
  await touch("touchEnd", cTarget.x, cTarget.y);
  await sleep(350);
  const cEnd = await evalJs(PROBE_READ);

  // 紧接着再拖第二次 —— 直接验 globalDragOwner 有没有被锁死
  const geoC2 = await evalJs(GEO);
  await touch("touchStart", geoC2.x, geoC2.y);
  await sleep(380);
  const cSecond = await evalJs(PROBE_READ);
  await touch("touchEnd", geoC2.x, geoC2.y);
  await sleep(300);
  const cSecondEnd = await evalJs(PROBE_READ);

  result.captureLoss = { geoC, cHold, cTarget, released, cOut, cOut2, cEnd, cSecond, cSecondEnd };
  check(cHold.drag === 1 && cHold.ghost === 1,
    "用例C：长按后没能起拖：" + JSON.stringify({ drag: cHold.drag, ghost: cHold.ghost }));
  check(String(released).indexOf("released:") === 0,
    "用例C：没能制造捕获丢失（前置条件不成立，本用例失去判别力）：released=" + released);
  check(cOut.drag === 1 && cOut.ghost === 1,
    "用例C：手指移出被拖块后拖动态/镜像丢了：" + JSON.stringify(cOut));
  // 镜像必须**继续跟随**：手指已经移到别的元素上，镜像的 transform 必须相应改变
  check(cOut.ghostTf !== cHold.ghostTf || cOut2.ghostTf !== cHold.ghostTf,
    "用例C：捕获丢失后镜像不再跟随（用户报的「组件悬着动不了」）：hold=" + cHold.ghostTf +
    " out=" + cOut.ghostTf + " out2=" + cOut2.ghostTf);
  check(cOut.scrollTop === 0, "用例C：拖动中画布被滚动了：scrollTop=" + cOut.scrollTop);
  // 在**被拖块之外**松手，收尾仍必须跑完
  check(cEnd.drag === 0 && cEnd.ghost === 0 && cEnd.gap === 0,
    "用例C：在被拖块之外松手后没收干净（用户报的「黑框还在原地」）：" + JSON.stringify(cEnd));
  // 最后一次拖拽必须能起来（用户报的「拖拽失效了」）
  check(cSecond.drag === 1,
    "用例C：紧接着第二次拖不起来（globalDragOwner 被锁死 = 用户报的「拖拽失效了」）：" + JSON.stringify(cSecond));
  // 前置：这次手势必须落在**顶层块**上（落在内嵌槽位上会被内嵌可拖正确接管 → 计数当然是 0）
  check(geoC2 && geoC2.overNested === false,
    "用例C：第二拖的落点压在内嵌槽位上（前置不成立，本用例失去判别力）：" + JSON.stringify(geoC2));
  check(cSecondEnd.drag === 0 && cSecondEnd.ghost === 0,
    "用例C：第二次拖拽收尾不干净：" + JSON.stringify(cSecondEnd));

  console.log(JSON.stringify(result, null, 1));
  if (fail.length) { console.log("\n失败项："); for (const f of fail) console.log("  ✗ " + f); process.exitCode = 1; }
  else console.log("\n✓ 原生触摸验证全部通过（长按能拖、快速滑动能滚）");
}

main().catch((e) => { console.log("FAIL:", e.message); process.exitCode = 1; }).finally(() => {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  // 只杀自己起的这棵树。两条纪律：
  //  ① 先核对那个 PID **现在**还是不是 msedge：Edge 的启动器会 fork 后立刻退出，
  //     它的 PID 可能已被系统回收给别的进程（踩过：`taskkill /PID <回收的PID> /T /F`
  //     把无关的 node/vite 打死了）。名字不对就不碰。
  //  ② 兜底按**本次专属 profile 路径**匹配（绝不按镜像名杀浏览器）。
  try {
    if (edge.pid) {
      const who = spawnSync("powershell", ["-NoProfile", "-Command",
        "(Get-Process -Id " + edge.pid + " -ErrorAction SilentlyContinue).ProcessName"], { encoding: "utf8" });
      const name = String(who.stdout || "").trim().toLowerCase();
      if (name === "msedge") spawnSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
    }
  } catch { /* 忽略 */ }
  const esc = PROFILE.replace(/'/g, "''");
  try {
    spawnSync("powershell", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | " +
      "Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + esc + "') } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ], { stdio: "ignore" });
  } catch { /* 忽略 */ }
  setTimeout(() => process.exit(process.exitCode || 0), 400);
});
