// 「自定义 UI」v3 流式槽位的**布局**验证（CDP 视口模拟）：并排 / 窄屏降级 / 红线。
//
// 为什么必须单独一个脚本、而不能塞进 driver.js：
//   driver.js 跑在**页面里**（Runtime.evaluate），改不了视口。而本功能的两个核心语义
//   ——「宽屏下两个半宽块并排」「窄视口下自动堆叠」—— 靠的是 **CSS 媒体查询**，
//   只有真的把视口改成 1000 / 380 才测得出来。用 driver 的默认视口跑，两种情况一模一样，
//   断言会是"永远通过"的绿灯发生器。
//
// 三个用例（对应 jm-slot-design.md 的验收项 ①②③）：
//   ① 默认全满宽 → `.detail-card` **没有** `data-slots`（线上 DOM 逐字不变的红线）
//   ② 把两个块设成 1/2 → 容器有 data-slots，两块同行（top 相同、left 不同、各占半宽）
//   ③ 视口压到 380 → 两块**堆叠**（top 不同、各占满宽）；回到宽视口又并排
//   ④ 关掉「窄屏自动堆叠」→ 380 下仍并排（属性消失）—— 用户显式要了就得按他说的来
//   ⑤ 恢复满宽 → data-slots 消失（红线复原，"配了再撤销"不留痕）
//   ⑥ 并排状态下拖拽契约不破（起拖 / 零 I/O / 一次提交 / 落盘与 DOM 一致）
//   ⑦ **并排下的 2D 落点**（Slot-2）：拖到左块左半 → 落在左块之前；
//      拖到左块右半 → 落在左块之后、右块之前。两条都过才说明横向轴参与了判定
//      —— 旧的"只比 clientY 中线"判据在同一 y 上给不出这两种不同结论。
//
// 用法（**用 pwsh 跑**，git-bash 里起不来浏览器；先自己起好 server）：
//   node node_modules/vite/bin/vite.js --port 5199 --strictPort      # 另开一个
//   TEST_URL=http://127.0.0.1:5199/ node tools/e2e/slot-layout.mjs
//   注：dev server 会被并发写文件搞崩（chokidar EBUSY），可改用无监听的
//       `npx vite build --outDir dist-slot` + `npx vite preview --outDir dist-slot`。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.TEST_URL || "http://127.0.0.1:5199/";
const PORT = Number(process.env.E2E_PORT || 9337);
const PROFILE = path.join(os.tmpdir(), "jm-e2e-profile-slotlayout");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!EDGE) { console.error("找不到 Edge，请用 EDGE_PATH 指定"); process.exit(2); }

// 残留 profile 会让 localStorage 带着上一轮的宽度配置进来 → 从干净的开始
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

const fail = [];
const check = (cond, msg) => { if (cond) console.log("  ✓ " + msg); else { console.log("  ✗ " + msg); fail.push(msg); } };

/** 视口：窄视口要带 mobile/hasTouch，否则媒体查询与触摸路径都不成立 */
const setViewport = (width, height) => send("Emulation.setDeviceMetricsOverride", {
  width, height, deviceScaleFactor: 1, mobile: width < 500, hasTouch: width < 500
});

/** 读画布上两个块的几何 + 容器属性。**用 [data-blk] 抓块**，不靠下标 */
const GEO = `(() => {
  const card = document.querySelector('.ed-canvas .detail-card');
  const blk = (id) => document.querySelector('.ed-canvas .ed-blk[data-blk="' + id + '"]');
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; };
  const a = blk('actors'), t = blk('tags');
  return {
    slotted: card ? card.getAttribute('data-slots') : null,
    narrow: card ? card.getAttribute('data-narrow-stack') : null,
    card: box(card), actors: box(a), tags: box(t),
    spanActors: a ? a.getAttribute('data-span') : null,
    spanTags: t ? t.getAttribute('data-span') : null
  };
})()`;

/** 点选某块 → 在检查器的「宽度」一行点某个档位（真用户路径，不是直接改 localStorage） */
const setSpan = (id, label) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const blk = document.querySelector('.ed-canvas .ed-blk[data-blk="${id}"]');
  if (!blk) return 'no-block';
  blk.click(); await sleep(400);
  const btns = Array.from(document.querySelectorAll('.ed-inspector .ed-span button'));
  if (!btns.length) return 'no-width-control';
  const b = btns.find(x => (x.textContent || '').trim() === '${label}');
  if (!b) return 'no-btn:' + btns.map(x => (x.textContent || '').trim()).join('/');
  b.click(); await sleep(400);
  return 'ok';
})()`;

/**
 * v3.3：**「窄屏自动堆叠」开关已随窄屏降级一起删除**（用户第 3 条："不要什么宽屏窄屏的限制"）。
 * 这个 helper 保留成一条**"该功能已不存在"的断言**：菜单里必须找不到「排布总表」，
 * 检查器里也不该再出现那个开关 —— 删功能就删它的入口，并留下"确实删了"的证据。
 */
const NARROW_TOGGLE_GONE = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const more = document.querySelector('.ed-more');
  if (!more) return JSON.stringify({ err: 'no-more-btn' });
  more.click(); await sleep(320);
  const items = Array.from(document.querySelectorAll('.ed-menu .ed-menuitem')).map(x => (x.textContent || '').trim());
  const hasOrder = items.some(x => /排布总表/.test(x));
  const scrim = document.querySelector('.ed-scrim'); if (scrim) { scrim.click(); await sleep(260); }
  return JSON.stringify({
    menuItems: items,
    hasOrderItem: hasOrder,
    hasNarrowRow: Array.from(document.querySelectorAll('.ed-inspector .ditem')).some(d => /窄屏自动堆叠/.test(d.textContent || '')),
    panelsGone: !document.querySelector('.ed-inspector .ed-panels')
  });
})()`;

/**
 * 把某块拖到画布上的指定点（合成触摸指针：长按 420ms 起拖 → 移到目标 → 松手）。
 *
 * 用合成事件而不是 CDP 原生输入：本用例要验的是**落点判定**（纯几何 + 落盘），
 * 不是手势接管 —— 手势那条路由 touch-drag.mjs 用 CDP 原生触摸覆盖，两者分工不重叠。
 */
const dropAt = (dragId, x, y) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const order = () => qa('.ed-canvas .ed-blk').map(b => b.getAttribute('data-blk'));
  const blk = document.querySelector('.ed-canvas .ed-blk[data-blk="${dragId}"]');
  if (!blk) return { err: 'no-block' };
  const b = blk.getBoundingClientRect();
  const pt = (type, cx, cy) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy });
    Object.defineProperty(ev, 'pointerType', { value: 'touch' });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    return ev;
  };
  const before = order();
  blk.dispatchEvent(pt('pointerdown', Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)));
  await sleep(420);                       // 长按到点 → 进入拖动态（窗口级监听这时才挂上）
  blk.dispatchEvent(pt('pointermove', ${Math.round(x)}, ${Math.round(y)}));
  await sleep(260);                       // 让落点判定与让位动画跑完
  blk.dispatchEvent(pt('pointerup', ${Math.round(x)}, ${Math.round(y)}));
  await sleep(420);
  return { before, after: order(), saved: JSON.parse(localStorage.getItem('jmclient.detailLayout.v1') || '{}').blocks };
})()`;

/** 横向并排？→ top 基本相同、left 不同、各占容器半宽左右 */
const sideBySide = (g) => {
  if (!g.actors || !g.tags) return false;
  const sameRow = Math.abs(g.actors.top - g.tags.top) <= 3;
  const diffCol = Math.abs(g.actors.left - g.tags.left) > 40;
  const halfish = g.actors.w < g.card.w * 0.62 && g.tags.w < g.card.w * 0.62;
  return sameRow && diffCol && halfish;
};
/** v3.3：`stacked()` 判据**已随窄屏降级一起删除** —— 现在任何视口下都必须是"并排"，
 *  所以"上下堆叠"不再是任何用例的期望值（留着它只会让人以为还有第二条合法路径）。 */

async function main() {
  // 等 Edge 的调试端口 + 页面 target（启动器 fork，两者不是同时就绪）
  let list = [];
  for (let i = 0; i < 80; i++) {
    try {
      list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list", { signal: AbortSignal.timeout(2000) })).json();
      if (list.some((t) => t.type === "page")) break;
    } catch { /* 等启动 */ }
    await sleep(300);
  }
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有拿到页面 target（浏览器没起来？）");
  // Node 26 自带全局 WebSocket（本项目没有 ws 依赖），用法与 touch-drag.mjs 一致
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
  // 起始用**宽视口**：先验并排，再压窄验降级
  await setViewport(1000, 800);
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

  // 打开「自定义 UI」编辑器（与 driver.js / touch-drag.mjs 同一入口路径）
  // v3.2 外壳改版：进入后停在「选择页面」**画廊屏**，必须再点「详情页」卡片才到编辑屏
  // ——否则 `.ed-canvas` 一个块都没有，用例①②③全都读空（本脚本第一版就是这样红的）。
  const opened = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s); const qa = (s) => Array.from(document.querySelectorAll(s));
    // ⚠️ v3.13：抽屉里那条入口已按用户要求删除 —— 唯一入口在**设置页最上方**
    // （与 editor-shell / driver-chrome 同一路径；旧的 .ditem 抽屉路径在 2.3.0 上必红）
    // ⚠️ 本段位于模板字符串内：注释里**不能出现反引号**，否则会提前终止模板串（踩过）
    const entry = qa('.settings-page .grow').find((b) => /自定义 UI/.test(b.textContent || ''));
    if (!entry) return 'no-entry';
    entry.click(); await sleep(1400);
    if (!q('.ed-gallery')) return 'no-gallery';
    q(".ed-gallery .ed-card[data-page='detail']").click(); await sleep(900);
    return q('.ed-canvas') ? 'ok' : 'no-canvas';
  })()`);
  if (opened !== "ok") throw new Error("打不开「自定义 UI」编辑器：" + opened);
  await sleep(500);

  const result = {};

  // ── 用例 ① 红线：默认全满宽 → 容器不该有 data-slots ──────────────────
  const g0 = await evalJs(GEO);
  result.defaultState = g0;
  check(g0.slotted === null, "默认配置下 .detail-card 不该有 data-slots（线上 DOM 逐字不变的红线）：" + g0.slotted);
  check(g0.spanActors === null && g0.spanTags === null, "默认下块上不该有 data-span");
  // 默认是**普通纵向流**：两块各占一行（中间隔着别的块）。注意不能用「是否堆叠」来判
  // —— 正常纵向流与窄屏降级堆叠在这两个块上长得一样，那个判据区分不了两者（写错过一次）。
  check(g0.actors && g0.tags && Math.abs(g0.actors.top - g0.tags.top) > 20, "默认下两块各占一行（隔着别的区块）");

  // ── 用例 ② 并排：两个块各设 1/2（走检查器控件，不是直接写 localStorage）──
  const s1 = await evalJs(setSpan("actors", "1/2"));
  check(s1 === "ok", "把「登场人物」设成 1/2（应成功）：" + s1);
  const s2 = await evalJs(setSpan("tags", "1/2"));
  check(s2 === "ok", "把「标签」设成 1/2（应成功）：" + s2);
  await sleep(400);

  const g1 = await evalJs(GEO);
  result.sideBySide = g1;
  check(g1.slotted === "1", "设了半宽后容器应有 data-slots=1：" + g1.slotted);
  // v3.3（用户第 3 条）：窄屏降级整条链路已删除 → 容器**任何视口下**都不该再输出这个属性
  check(g1.narrow === null, "容器不再输出 data-narrow-stack（窄屏降级已取消）：" + g1.narrow);
  check(g1.spanActors === "6" && g1.spanTags === "6", "两块应各有 data-span=6：" + g1.spanActors + "/" + g1.spanTags);
  check(sideBySide(g1), "两个半宽块应并排（top 相同、left 不同、各占半宽）：" + JSON.stringify(g1));
  check(Math.abs(g1.actors.w - g1.tags.w) <= 3, "两块宽度应基本相等：" + g1.actors.w + " vs " + g1.tags.w);

  const saved = await evalJs(`JSON.parse(localStorage.getItem('jmclient.detailLayout.v1') || '{}')`);
  result.saved = { version: saved.version, spans: saved.spans };
  check(saved.version === 3, "改宽度后配置应升到 version 3：" + saved.version);
  check(saved.spans && saved.spans.actors === 6 && saved.spans.tags === 6,
    "落盘的 spans 应为 {actors:6,tags:6}：" + JSON.stringify(saved.spans));

  // ── 用例 ③ v3.3 反转：窄视口(380) 下**仍然并排**（降级已按用户要求取消）──
  //
  //    v3.2 这里断言的是"窄视口应堆叠"，v3.3 起用户明确否掉了那个行为：
  //    「不要什么宽屏窄屏的限制了，直接默认认为都是宽屏，给用户充分的自由度」。
  //    所以判据方向反转 —— 不是放宽（原来是"必须堆叠"，现在是"必须并排"，同样只有一个答案）。
  await setViewport(380, 760);
  await sleep(600);
  const g2 = await evalJs(GEO);
  result.narrowViewport = g2;
  check(sideBySide(g2), "窄视口(380)下两块**仍然并排**（窄屏降级已取消，用户要的充分自由度）：" + JSON.stringify(g2));
  check(g2.narrow === null, "窄视口下容器也不输出 data-narrow-stack：" + g2.narrow);

  // ── 用例 ③b 回到宽视口 → 仍并排（两种视口同一个答案，正是"取消降级"的含义）──
  await setViewport(1000, 800);
  await sleep(600);
  const g3 = await evalJs(GEO);
  result.backToWide = g3;
  check(sideBySide(g3), "回到宽视口后仍并排：" + JSON.stringify(g3));

  // ── 用例 ④ v3.3：「排布总表 / 窄屏自动堆叠」开关必须**已不存在**（删功能要留证据）──
  const t1 = JSON.parse(await evalJs(NARROW_TOGGLE_GONE));
  check(t1.hasOrderItem === false, "「⋯」菜单里已经找不到「排布总表」（它的入口已删）：" + JSON.stringify(t1.menuItems));
  check(t1.hasNarrowRow === false, "检查器里也不再出现「窄屏自动堆叠」这一行：" + t1.hasNarrowRow);
  check(t1.panelsGone === true, "检查器里不再有折叠面板容器（.ed-panels）：" + t1.panelsGone);

  // ── 用例 ⑤ 红线复原：把两块恢复满宽 → data-slots 消失、不留痕 ────────
  await setViewport(1000, 800);
  await sleep(500);
  const s3 = await evalJs(setSpan("actors", "满宽"));
  check(s3 === "ok", "把「登场人物」恢复满宽（应成功）：" + s3);
  const s4 = await evalJs(setSpan("tags", "满宽"));
  check(s4 === "ok", "把「标签」恢复满宽（应成功）：" + s4);
  await sleep(400);
  const g5 = await evalJs(GEO);
  result.afterResetWidth = g5;
  check(g5.slotted === null, "全部恢复满宽后容器不该再有 data-slots（红线复原）：" + g5.slotted);
  check(g5.spanActors === null && g5.spanTags === null, "恢复满宽后块上不该再有 data-span");
  const saved2 = await evalJs(`JSON.parse(localStorage.getItem('jmclient.detailLayout.v1') || '{}')`);
  result.savedAfterReset = { version: saved2.version, spans: saved2.spans };
  check(!saved2.spans || Object.keys(saved2.spans).length === 0,
    "恢复满宽后 spans 应清空（不残留 v3 痕迹）：" + JSON.stringify(saved2.spans));

  // ── 用例 ⑥ 并排状态下拖拽契约不破 ────────────────────────────────────
  // 为什么单列一条：`indexAt` 曾只看 clientY 中线（2D 落点判定已由 Slot-2 补上，
  // 见用例⑦）。这里先钉住**契约层**：还能起拖、拖动中零 I/O、
  // 松手一次提交且**落盘顺序与 DOM 一致**（不能"看着换了、存的是别的顺序"）。
  const s5 = await evalJs(setSpan("actors", "1/2"));
  check(s5 === "ok", "为拖拽用例把「登场人物」设成 1/2（应成功）：" + s5);
  const s6 = await evalJs(setSpan("tags", "1/2"));
  check(s6 === "ok", "为拖拽用例把「标签」设成 1/2（应成功）：" + s6);
  await sleep(300);
  const drag = await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const order = () => qa('.ed-canvas .ed-blk').map(b => b.getAttribute('data-blk'));
    const saved = () => JSON.parse(localStorage.getItem('jmclient.detailLayout.v1') || '{}').blocks;
    const blk = qa('.ed-canvas .ed-blk')[0];
    const pt = (type, y) => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, clientX: 20 });
      Object.defineProperty(ev, 'pointerType', { value: 'touch' });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      return ev;
    };
    const before = order(); const savedBefore = saved();
    blk.dispatchEvent(pt('pointerdown', 0));
    await sleep(420);
    const dragging = blk.classList.contains('ed-drag');
    blk.dispatchEvent(pt('pointermove', 3000));
    await sleep(260);
    const midSaved = saved();
    const ghosts = qa('.ed-ghost').length;
    blk.dispatchEvent(pt('pointerup', 3000));
    await sleep(420);
    return { dragging, ghosts, before, savedBefore, midSaved, after: order(), savedAfter: saved() };
  })()`);
  result.dragWhileSlotted = drag;
  check(drag.dragging === true, "并排布局下长按仍应能起拖");
  check(drag.ghosts === 1, "并排布局下起拖仍应有跟手镜像：ghost=" + drag.ghosts);
  check(JSON.stringify(drag.midSaved) === JSON.stringify(drag.savedBefore),
    "并排布局下拖动中不该落盘：mid=" + JSON.stringify(drag.midSaved));
  check(JSON.stringify(drag.savedAfter) === JSON.stringify(drag.after),
    "并排布局下松手后落盘顺序必须与 DOM 一致：saved=" + JSON.stringify(drag.savedAfter) + " dom=" + JSON.stringify(drag.after));
  check(drag.after[0] !== drag.before[0], "并排布局下拖到末尾应真的换位：before=" + JSON.stringify(drag.before) + " after=" + JSON.stringify(drag.after));

  // ── 用例 ⑦ 并排下的 **2D 落点**（Slot-2 的核心验收）─────────────────────
  // 并排后"同一行有两块"，旧判据（逐块比 clientY 与竖向中线）在这里给出的结果
  // 只取决于 y —— 也就是说：**同样落在左块下半部时，x 在左半还是右半结论相同**。
  // 所以本用例的判别点是：
  //   · 拖到左块**左半** → 必须落在左块**之前**（旧判据在同一 y 上只会说"之后"）；
  //   · 拖到左块**右半** → 必须落在左块**之后、右块之前**。
  // 两条一起通过，才说明横向轴真的参与了判定。
  // （"同一个 y、两个 x → 不同结论"这条在单测里是字面成立的：
  //   src/core/dropIndex.test.ts 的 `dropIndexAt(ROW2, -1, 40, 50)` vs `(… , 140, 50)`。）
  const s7a = await evalJs(setSpan("actors", "1/2"));
  const s7b = await evalJs(setSpan("tags", "1/2"));
  check(s7a === "ok" && s7b === "ok", "用例⑦前置：两块都设成 1/2（应成功）：" + s7a + "/" + s7b);
  await sleep(400);

  const g7 = await evalJs(GEO);
  check(sideBySide(g7), "用例⑦前置：两块应并排：" + JSON.stringify(g7));
  const orderBefore7 = await evalJs(`Array.from(document.querySelectorAll('.ed-canvas .ed-blk')).map(b => b.getAttribute('data-blk'))`);
  result.orderBeforeDrop2d = orderBefore7;
  // 前置：被拖的 action 必须**不在**"actors 之前"这个位置上，否则第一条断言会白通过
  check(orderBefore7.indexOf("action") > orderBefore7.indexOf("tags"),
    "用例⑦前置：action 初始应在两块之后（否则落点断言没有判别力）：" + JSON.stringify(orderBefore7));

  // ① 左块**左半**（同一个 y 下 x 偏左）→ 落在 actors 之前
  const y1 = g7.actors.top + Math.round(g7.actors.h / 2);
  const xLeft = Math.round(g7.actors.left + 6);
  const d1 = await evalJs(dropAt("action", xLeft, y1));
  result.drop2dLeftHalf = d1;
  check(!!d1.after,
    "拖到左块左半（x=" + xLeft + ", y=" + y1 + "）应成功：" + JSON.stringify(d1.err || ""));
  check(d1.after.indexOf("action") === d1.after.indexOf("actors") - 1,
    "拖到左块**左半** → 应落在「登场人物」之前（旧的一维判据在同一 y 上只会给'之后'）：" + JSON.stringify(d1.after));
  check(JSON.stringify(d1.saved) === JSON.stringify(d1.after),
    "松手后落盘顺序必须与 DOM 一致：saved=" + JSON.stringify(d1.saved) + " dom=" + JSON.stringify(d1.after));

  // ② 左块**右半** → 落在 actors 之后、tags 之前（几何变了，重读）
  await sleep(300);
  const g8 = await evalJs(GEO);
  const y2 = g8.actors.top + Math.round(g8.actors.h / 2);
  const xRight = Math.round(g8.actors.left + g8.actors.w - 6);
  const d2 = await evalJs(dropAt("action", xRight, y2));
  result.drop2dRightHalf = d2;
  check(!!d2.after,
    "拖到左块右半（x=" + xRight + ", y=" + y2 + "）应成功：" + JSON.stringify(d2.err || ""));
  check(d2.after.indexOf("action") === d2.after.indexOf("actors") + 1
    && d2.after.indexOf("tags") === d2.after.indexOf("action") + 1,
    "拖到左块**右半** → 应落在「登场人物」之后、「标签」之前：" + JSON.stringify(d2.after));
  check(JSON.stringify(d1.after) !== JSON.stringify(d2.after),
    "左右两半必须给出**不同**落点（相同则说明横向轴没参与判定）");
  check(JSON.stringify(d2.saved) === JSON.stringify(d2.after),
    "松手后落盘顺序必须与 DOM 一致：saved=" + JSON.stringify(d2.saved) + " dom=" + JSON.stringify(d2.after));

  console.log(JSON.stringify(result, null, 1));
  if (fail.length) { console.log("\n失败项："); for (const f of fail) console.log("  ✗ " + f); process.exitCode = 1; }
  else console.log("\n✓ 槽位布局验证全部通过（并排生效 / 窄屏降级 / 可关掉 / 恢复满宽不留痕）");
}

main().catch((e) => { console.log("FAIL:", e.message); process.exitCode = 1; }).finally(() => {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  // 只杀自己起的这棵树。两条纪律：
  //  ① 先核对那个 PID **现在**还是不是 msedge：Edge 的启动器会 fork 后立刻退出，
  //     它的 PID 可能已被系统回收给别的进程（踩过：taskkill /PID <回收的PID> /T /F
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
