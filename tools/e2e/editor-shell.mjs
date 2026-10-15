// 「自定义 UI」v3.2 **美化**验证（独立 CDP 脚本）：抓手热区 / 块名 chip / 描边 / sheet / 胶囊 /
// 画布观感 / 「⋯」次级菜单 / 跟手镜像的 transform-origin。
//
// 为什么又单独一个脚本：
//   ① 这些东西大半是**计算样式**（outline-style、border-radius、box-shadow、transform-origin），
//      driver.js 里那些 `qa()/T()` 只能数节点与文案，读不到它们；
//   ② 本波最该被钉住的一条是**几何**：起拖瞬间镜像左上角必须与被抓块左上角重合
//      （审计 L-1：`.ed-ghost` 漏设 transform-origin，默认 50% 50% 会让 scale(1.03)
//       绕中心放大 → 视觉漂 ~5.7px，像"抓偏了"）。这条必须先有断言，改属性才有意义。
//   ③ 顺带产出**截图** —— 用户抱怨的是"不美观"，文字描述没有说服力。
//
// 用法（**用 pwsh 跑**；git-bash 里起不来浏览器。先自己起好 server）：
//   node node_modules/vite/bin/vite.js --port 5199 --strictPort      # 另开一个
//   TEST_URL=http://127.0.0.1:5199/ node tools/e2e/editor-shell.mjs
//   截图写到 SHOTS 目录（默认 <工作台>\jm-v3-shots，可用 SHOTS_DIR 覆盖）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.TEST_URL || "http://127.0.0.1:5199/";
const PORT = Number(process.env.E2E_PORT || 9339);
const PROFILE = path.join(os.tmpdir(), "jm-e2e-profile-shell");
const SHOTS = process.env.SHOTS_DIR || path.join(os.homedir(), "Desktop", "deepseek工作台", "jm-v3-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!EDGE) { console.error("找不到 Edge，请用 EDGE_PATH 指定"); process.exit(2); }

try { fs.mkdirSync(SHOTS, { recursive: true }); } catch { /* 已存在 */ }
// 残留 profile 会带着上一轮的配置进来 → 从干净的开始（与其它驱动同一纪律）
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

let pass = 0;
const fail = [];
const check = (cond, msg) => { if (cond) { pass++; console.log("  ✓ " + msg); } else { console.log("  ✗ " + msg); fail.push(msg); } };

/** 视口：窄视口要带 mobile/hasTouch（与 editor-gallery.mjs 同一套） */
const setViewport = (width, height) => send("Emulation.setDeviceMetricsOverride", {
  width, height, deviceScaleFactor: 1, mobile: width < 500, hasTouch: width < 500
});

/** 截图（真无头浏览器产出；只信 CDP 回给我们的 base64，不用旧图） */
const shots = [];
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(r.data, "base64");
  const p = path.join(SHOTS, name + ".png");
  fs.writeFileSync(p, buf);
  shots.push({ name: name + ".png", bytes: buf.length });
  console.log("  · 截图 " + name + ".png  " + buf.length + " B");
}

/** 一次拿全：**块上不再有任何常驻装饰**（v3.3） / 描边 / sheet / 顶栏 / 画布观感 */
const LOOK = `(() => {
  const T = (el) => (el ? (el.textContent || '').trim() : null);
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const blks = Array.from(document.querySelectorAll('.ed-canvas .ed-blk'));
  const plain = blks.find((b) => !b.className.match(/ed-sel|ed-drag/)) || blks[0] || null;
  const insp = document.querySelector('.ed-inspector');
  const top = document.querySelector('.ed-top');
  const stage = document.querySelector('.ed-stage');
  const canvas = document.querySelector('.ed-canvas');
  return {
    blocks: blks.length,
    // v3.3：抓手 + 块名 chip + 序号角标**全部删除**（用户第 5 条"碍眼"）→ 这三个计数必须是 0
    grips: document.querySelectorAll('.ed-canvas .ed-grip').length,
    namechips: document.querySelectorAll('.ed-canvas .ed-namechip').length,
    badges: document.querySelectorAll('.ed-canvas .ed-badge').length,
    oldGlyph: document.body.textContent.indexOf('\\u2833') >= 0,
    plainOutline: plain ? cs(plain).outlineStyle + ' ' + cs(plain).outlineWidth : null,
    inspRadius: insp ? cs(insp).borderTopLeftRadius : null,
    inspShadow: insp ? cs(insp).boxShadow : null,
    inspMaxH: insp ? cs(insp).maxHeight : null,
    inspBarBg: insp ? cs(insp, '::before').backgroundColor : null,
    topRadius: top ? cs(top).borderRadius : null,
    topShadow: top ? cs(top).boxShadow : null,
    stageImage: stage ? cs(stage).backgroundImage.slice(0, 60) : null,
    canvasBorder: canvas ? cs(canvas).borderTopWidth + ' ' + cs(canvas).borderTopStyle : null,
    canvasRadius: canvas ? cs(canvas).borderTopLeftRadius : null
  };
})()`;

/**
 * v3.3：块上**一个常驻装饰都没有**（抓手 / 块名 chip / 序号角标全删）。
 *
 * 这条替换了 v3.2 的 CHIPFIT（那是在量"骑缝 chip 有没有压住正文"）——
 * 元素都不存在了，"压不压正文"这个问题随之消失。但仍然要证明**没有东西浮在正文上**：
 * 所以顺带量一下每个块**内容顶边**相对块顶边的偏移（应当 ≥ 0，且没有子元素是绝对定位的装饰）。
 */
const NOCHROME = `(() => {
  const rows = [];
  let worstTop = 999;
  Array.from(document.querySelectorAll('.ed-canvas .ed-blk')).forEach((b) => {
    const content = Array.from(b.children).find((c) => !/ed-gap/.test(c.className || ''));
    if (!content) return;
    const bt = b.getBoundingClientRect().top, ct = content.getBoundingClientRect().top;
    const over = Math.round(bt - ct);   // >0 表示内容被顶下去了（有东西在上面）
    if (over < worstTop) worstTop = over;
    rows.push(b.getAttribute('data-blk') + ':' + over);
  });
  return JSON.stringify({
    grips: document.querySelectorAll('.ed-canvas .ed-grip').length,
    namechips: document.querySelectorAll('.ed-canvas .ed-namechip').length,
    badges: document.querySelectorAll('.ed-canvas .ed-badge').length,
    oldGlyph: document.body.textContent.indexOf('\\u2833') >= 0,
    worstTop,
    rows
  });
})()`;

/** 选中一块后再读一次（选中态描边 + sheet 展开） */
const SELECTED = `(() => {
  const T = (el) => (el ? (el.textContent || '').trim() : null);
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const sel = document.querySelector('.ed-canvas .ed-blk.ed-sel');
  const insp = document.querySelector('.ed-inspector');
  return {
    selOutline: sel ? cs(sel).outlineStyle + ' ' + cs(sel).outlineWidth : null,
    selOutlineColor: sel ? cs(sel).outlineColor : null,
    module: !!document.querySelector('.ed-inspector .ed-module'),
    moduleName: T(document.querySelector('.ed-inspector .ed-module .grpname')),
    /** v3.3：区块配置栏右上角必须有「完成」（用户第 9 条） */
    hasDone: !!document.querySelector('.ed-inspector .ed-module .ed-paneldone'),
    /** v3.3：显隐开关必须在配置栏**最上面**（用户第 5 条）——它在 .ed-module 的第 1 个子行里 */
    firstRowIsShow: (() => {
      const mod = document.querySelector('.ed-inspector .ed-module');
      if (!mod) return null;
      const first = mod.querySelector('.dl-rows');
      return !!first && first.className.indexOf('ed-showrow') >= 0;
    })(),
    /** v3.3：▲▼ 已删（位置靠长按拖动） */
    hasStepArrows: document.querySelectorAll('.ed-inspector .ed-module .dl-step').length,
    inspH: insp ? Math.round(insp.getBoundingClientRect().height) : 0,
    inspRadius: insp ? cs(insp).borderTopLeftRadius : null
  };
})()`;

/** 点顶栏「⋯」→ 菜单项文案 */
const OPEN_MENU = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const more = document.querySelector('.ed-top .ed-more');
  if (!more) return 'no-more';
  more.click(); await sleep(320);
  const items = Array.from(document.querySelectorAll('.ed-menu .ed-menuitem'));
  return JSON.stringify({ hasScrim: !!document.querySelector('.ed-scrim'), items: items.map(x => (x.textContent || '').trim().split('疏密')[0].split('顺序')[0].split('结构')[0]) });
})()`;

/**
 * 点菜单里的某一项 → 读「页面设置」是不是**独立一屏**（v3.3，用户第 8 条）。
 *
 * 旧实现把面板渲染在检查器里，会把画布顶上去；新实现是覆盖层 `.ed-sheetpage`。
 * 所以这里除了"开出来了"，还量**画布位置有没有被推动**（canvasTop / canvasH 前后对照）。
 */
const CLICK_MENU = (kw) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const canvasEl = document.querySelector('.ed-canvas');
  const before = canvasEl ? canvasEl.getBoundingClientRect() : null;
  if (!document.querySelector('.ed-menu')) {
    const more = document.querySelector('.ed-top .ed-more');
    if (!more) return 'no-more';
    more.click(); await sleep(320);
  }
  const it = Array.from(document.querySelectorAll('.ed-menu .ed-menuitem')).find(x => /${kw}/.test(x.textContent || ''));
  if (!it) return 'no-item';
  it.click(); await sleep(500);
  const after = canvasEl ? canvasEl.getBoundingClientRect() : null;
  const sheet = document.querySelector('.ed-sheetpage');
  return JSON.stringify({
    menuGone: !document.querySelector('.ed-menu'),
    sheetPage: !!sheet,
    sheetPanel: sheet ? sheet.getAttribute('data-panel') : null,
    sheetHasDone: !!document.querySelector('.ed-sheetpage .ed-paneldone'),
    hasStyleSheet: !!document.querySelector('.ed-sheetpage .dl-style'),
    // 画布**没有被推**：顶部与高度都不该因为"唤出了页面设置"而变化
    canvasTopSame: !!before && !!after && Math.abs(before.top - after.top) <= 1,
    canvasHSame: !!before && !!after && Math.abs(before.height - after.height) <= 1,
    /** 已删除的「排布总表」不该留下任何痕迹 */
    orderRowsGone: document.querySelectorAll('.ed-inspector [data-drag-list] .ditem').length === 0,
    panelsGone: !document.querySelector('.ed-inspector .ed-panels')
  });
})()`;

/**
 * 起拖（v3.3：**长按块本体**——抓手已删除，这是唯一的拖动入口）→ 读镜像几何。
 *
 * 为什么仍要"零位移"：本用例量的是**起拖那一刻的对齐**（审计 L-1）。长按到点时手指
 * 还没有位移，`startGhost` 的镜像目标恰好就是被抓块自己，于是"镜像左上角 == 被抓块左上角"
 * 仍是一条干净的断言；若用位移触发，位移本身就会把镜像目标挪开几像素，
 * 断言会变成"在测缓动"而不是"在测 origin"。
 *
 * 事件用 MouseEvent + defineProperty 造（与 slot-layout.mjs 同一套手法）：
 * 合成指针不需要真手势仲裁 —— 手势那条路由 touch-drag.mjs 的 CDP 原生触摸覆盖。
 */
const DRAG_PROBE = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const blk = document.querySelector('.ed-canvas .ed-blk[data-blk="hero"]');
  if (!blk) return JSON.stringify({ err: 'no-block' });
  const pt = (type, cx, cy) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy });
    Object.defineProperty(ev, 'pointerType', { value: 'touch' });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    return ev;
  };
  const b0 = blk.getBoundingClientRect();
  const sx = Math.round(b0.left + 12), sy = Math.round(b0.top + 12);
  blk.dispatchEvent(pt('pointerdown', sx, sy));
  await sleep(380);   // 跨过长按阈值（LONG_PRESS_MS = 280）
  const g = document.querySelector('.ed-ghost');
  if (!g) { window.dispatchEvent(pt('pointerup', sx, sy)); return JSON.stringify({ ghost: false }); }
  const gc = getComputedStyle(g);
  const gr = g.getBoundingClientRect();
  const out = {
    ghost: true,
    origin: gc.transformOrigin,
    transform: gc.transform,
    ghostW: Math.round(gr.width), ghostH: Math.round(gr.height),
    blkW: Math.round(b0.width), blkH: Math.round(b0.height),
    dx: Math.round(gr.left - b0.left), dy: Math.round(gr.top - b0.top)
  };
  window.dispatchEvent(pt('pointerup', sx, sy));
  await sleep(300);
  out.cleaned = !document.querySelector('.ed-ghost');
  return JSON.stringify(out);
})()`;

/** 真拖一下（用于截图：坑 + 镜像 + 插入缝同框）—— v3.3 同样走长按块本体 */
const DRAG_FOR_SHOT = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const blk = document.querySelector('.ed-canvas .ed-blk[data-blk="hero"]');
  if (!blk) return 'no-block';
  const pt = (type, cx, cy) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy });
    Object.defineProperty(ev, 'pointerType', { value: 'touch' });
    Object.defineProperty(ev, 'pointerId', { value: 2 });
    return ev;
  };
  const b0 = blk.getBoundingClientRect();
  const sx = Math.round(b0.left + 12), sy = Math.round(b0.top + 12);
  blk.dispatchEvent(pt('pointerdown', sx, sy));
  await sleep(380);   // 长按起拖
  // 分几步往下移，走到越过相邻块判定框 → 坑让位 + 插入缝出现
  for (const dy of [10, 40, 80, 120]) {
    window.dispatchEvent(pt('pointermove', sx, sy + dy));
    await sleep(90);
  }
  await sleep(220);
  const out = {
    ghost: !!document.querySelector('.ed-ghost'),
    gaps: document.querySelectorAll('.ed-canvas .ed-gap').length,
    drag: document.querySelectorAll('.ed-canvas .ed-blk.ed-drag').length
  };
  return JSON.stringify(out);
})()`;

/** 收尾（截图之后再松手，免得带着拖拽态拍别的图） */
const DROP = `(() => {
  const ev = new MouseEvent('pointerup', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
  Object.defineProperty(ev, 'pointerId', { value: 2 });
  window.dispatchEvent(ev);
  return true;
})()`;

async function main() {
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
  await setViewport(390, 844); // 手机视口（用户的场景）
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

  console.log("\n== v3.2 美化（editor-shell）==");

  // 打开「自定义 UI」
  // ⚠️ v3.13：抽屉里那条入口已按用户要求删除 —— 现在唯一入口在**设置页最上方**。
  //    （不切 tab：设置那张 section 一直渲染着，只是挂着 `view-hidden`。真实用户路径由
  //     driver-chrome ⑦ 钉。）
  const opened = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s); const qa = (s) => Array.from(document.querySelectorAll(s));
    const entry = qa('.settings-page .grow').find((b) => /自定义 UI/.test(b.textContent || ''));
    if (!entry) return 'no-entry';
    entry.click(); await sleep(1400);
    return q('.ed-page') ? 'ok' : 'no-editor';
  })()`);
  if (opened !== "ok") throw new Error("打不开「自定义 UI」编辑器：" + opened);
  await sleep(700);

  // ── 画廊屏截图 + 进编辑屏 ────────────────────────────────────────────────
  await shot("gallery-390");

  // ⑥ v3.6 画廊形态：**单轨 peek 轮播**（手机）。
  //
  //    用户第 5 条「画廊的交互和展示依然一塌糊涂」→ 隐喻整个换掉：
  //    Android Recents / M3 Carousel 都**不叠卡**，它们是**单轨 pager + 间距**，
  //    邻居卡尺寸不变、被**视口边缘**裁切（AOSP: 最少露 50dp、页间距 16dp）。
  //    旧版把后卡缩到 0.704 再在**屏幕中间**裁 → 露出的是被切掉的标题与**半个黑按钮**
  //    （父代理看图列的 6 条缺陷之一）。所以这一组断言把"相叠量 / 拉开量"整组**反转**成：
  //      · 两卡**不重叠**、按 `卡宽 + 间距` 排开（裁切只发生在视口边缘）；
  //      · 邻居露出 ∈[40,56] 且 ≤0.17×卡宽，且 **offsetWidth === 卡宽（没有缩放）**；
  //      · 底边齐（旧版靠 SINK 逐卡下沉 → 差 5~20px）；
  //      · 页名**不滑动就能看见**（分段控件）—— 旧版后卡的名字被前卡压住，只剩「默认」。
  //    **这不是放宽**：旧判据的前提（"相叠↔拉开两态插值"）已被推翻，新判据是几何等式级的。
  const GP = JSON.parse(await evalJs(`(() => {
    const g = document.querySelector('.ed-gallery');
    const st = document.querySelector('.ed-stack');
    const cards = Array.from(document.querySelectorAll('.ed-gallery .ed-card'));
    const tabs = Array.from(document.querySelectorAll('.ed-galtabs > button'));
    if (!g || !st || cards.length < 2) return JSON.stringify({ ok: false, n: cards.length });
    const sr = st.getBoundingClientRect();
    const r = cards.map((c) => c.getBoundingClientRect());
    const clip = (x) => Math.max(0, Math.min(x.right, sr.right) - Math.max(x.left, sr.left));
    return JSON.stringify({
      ok: true,
      n: cards.length,
      mode: g.getAttribute('data-mode'),
      index: st.getAttribute('data-index'),
      stageW: Math.round(sr.width),
      left: r.map((x) => Math.round(x.left)),
      right: r.map((x) => Math.round(x.right)),
      top: r.map((x) => Math.round(x.top)),
      bottom: r.map((x) => Math.round(x.bottom)),
      w: r.map((x) => Math.round(x.width)),
      ow: cards.map((c) => c.offsetWidth),
      vis: r.map((x) => Math.round(clip(x))),
      overflowX: g.scrollWidth - g.clientWidth,
      names: tabs.map((t) => t.textContent.replace(/\\s+/g, ' ').trim()),
      active: tabs.map((t) => t.getAttribute('data-active')),
      cardNames: document.querySelectorAll('.ed-gallery .ed-cardname').length
    });
  })()`));
  console.log("  · 画廊（390 手机，peek 态）：" + JSON.stringify(GP));
  check(GP.ok === true && GP.n === 4, "手机端画廊能取到四张卡片（v3.13 从两个扩到四个）：" + GP.n);
  check(GP.mode === "peek", "手机走 peek 轮播（而不是宽屏两栏）：mode=" + GP.mode);
  // 【自检等式】卡宽 + 间距 + 露出 === 轨道宽。
  // 调研报告曾把这条算错（内边距减了两次：268+46+12+32 ≠ 390），所以它是可执行的断言。
  check(Math.abs(GP.ow[0] + 12 + GP.vis[1] - GP.stageW) <= 1,
    "【自检】卡宽+间距+露出 === 轨道宽：" + GP.ow[0] + "+12+" + GP.vis[1] + " vs " + GP.stageW);
  check(GP.vis[1] >= 40 && GP.vis[1] <= 56 && GP.vis[1] <= 0.17 * GP.ow[0] + 1,
    "邻居卡只露一条边（40~56px 且 ≤17% 卡宽）：露出=" + GP.vis[1] + " 卡宽=" + GP.ow[0]);
  check(GP.ow[0] === GP.ow[1] && Math.abs(GP.w[0] - GP.ow[0]) <= 1 && Math.abs(GP.w[1] - GP.ow[1]) <= 1,
    "两卡**尺寸相同且都没有缩放**（旧版后卡缩到 0.704）：offsetW=" + GP.ow.join("/") + " rectW=" + GP.w.join("/"));
  const overlap0 = Math.min(GP.right[0], GP.right[1]) - Math.max(GP.left[0], GP.left[1]);
  check(overlap0 <= 0, "两卡**不重叠**（裁切只发生在视口边缘，不再在屏幕中间切内容）：重叠=" + overlap0 + "px");
  check(Math.abs(GP.top[0] - GP.top[1]) <= 1 && Math.abs(GP.bottom[0] - GP.bottom[1]) <= 1,
    "两卡顶边与**底边都齐**（旧版 SINK 逐卡下沉 → 差 5~20px）：top=" + GP.top.join("/") + " bottom=" + GP.bottom.join("/"));
  check(GP.overflowX <= 1, "peek 态无横向溢出：scrollWidth-clientWidth=" + GP.overflowX);
  check(GP.names.length === 4 && /列表页/.test(GP.names[0]) && /阅读器/.test(GP.names[3]),
    "四页名字**不滑动时就都可见**（分段控件；旧版后卡名字被前卡压住）：" + JSON.stringify(GP.names));
  check(GP.active[0] === "1" && GP.active[1] === "", "当前页在分段控件里高亮：" + JSON.stringify(GP.active));
  check(GP.cardNames === 0, "peek 模式下不再往卡片下面挂卡名（挂上去会被裁成半截字）：" + GP.cardNames);
  // 用户点名的第 ② 件事：**不要真实作品**（画廊缩略图与画布都只给"失败回退"式文字占位）
  const GPH = JSON.parse(await evalJs(`(() => {
    const g = document.querySelector('.ed-gallery');
    return JSON.stringify({
      imgs: g ? g.querySelectorAll('img').length : -1,
      ph: g ? g.querySelectorAll('.thumb-fallback').length : -1,
      coverPh: g ? g.querySelectorAll('.d-cover-ph').length : -1
    });
  })()`));
  console.log("  · 画廊占位渲染：" + JSON.stringify(GPH));
  check(GPH.imgs === 0, "画廊缩略图里**没有任何真实图片**（用户要求「不要用真实作品」）：img=" + GPH.imgs);
  check(GPH.ph >= 4, "列表页缩略图用「示例作品 N」文字占位（失败回退表现）：占位块=" + GPH.ph);
  check(GPH.coverPh >= 1, "详情页缩略图的封面同样是文字占位：.d-cover-ph=" + GPH.coverPh);

  /** 合成一次横向拖动：steps = [[累计位移, 采样后等待毫秒], …]（最后一击决定松手时的速度） */
  const swipe = async (steps) => JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = document.querySelector('.ed-stack');
    const r = st.getBoundingClientRect();
    const y = Math.round(r.top + 60);
    const x0 = Math.round(r.left + 180);
    const mk = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: Math.round(x), clientY: y, pointerId: 21, pointerType: 'mouse', isPrimary: true, buttons: type === 'pointerup' ? 0 : 1 });
    const steps = ${JSON.stringify(steps)};
    st.dispatchEvent(mk('pointerdown', x0));
    await sleep(30);
    for (const s of steps) { window.dispatchEvent(mk('pointermove', x0 + s[0])); if (s[1]) await sleep(s[1]); }
    window.dispatchEvent(mk('pointerup', x0 + steps[steps.length - 1][0]));
    await sleep(450);
    return JSON.stringify({ index: st.getAttribute('data-index'), t: document.querySelector('.ed-card[data-i="0"]').style.transform });
  })()`));

  // ⑥′ 定轴：**先横移 6px 再纵向拖 60px** —— 本次手势判为竖向 → 让给浏览器，轨道一动不动。
  //     旧实现只看 |dx|≥6 不看 |dy| → 第 6px 就被"拉开"抢走（竖滚被劫持）。
  const AX = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = document.querySelector('.ed-stack');
    const r = st.getBoundingClientRect();
    const y = Math.round(r.top + 60);
    const x0 = Math.round(r.left + 120);
    const mk = (type, x, yy) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: Math.round(x), clientY: Math.round(yy), pointerId: 31, pointerType: 'mouse', isPrimary: true, buttons: type === 'pointerup' ? 0 : 1 });
    const before = document.querySelector('.ed-card[data-i="0"]').style.transform;
    st.dispatchEvent(mk('pointerdown', x0, y));
    await sleep(30);
    window.dispatchEvent(mk('pointermove', x0 + 6, y));            // 6px：不够定轴
    await sleep(30);
    window.dispatchEvent(mk('pointermove', x0 + 6, y + 60));       // 竖位移主导 → 本次手势永不接管
    await sleep(30);
    window.dispatchEvent(mk('pointerup', x0 + 6, y + 60));
    await sleep(450);
    return JSON.stringify({ before, after: document.querySelector('.ed-card[data-i="0"]').style.transform, index: st.getAttribute('data-index') });
  })()`));
  console.log("  · 定轴（6px 横 + 60px 竖）：" + JSON.stringify(AX));
  check(AX.before === AX.after && AX.index === "0",
    "横移 6px 后转竖向 → 手势让给浏览器，轨道位移**恒 0**：before=" + AX.before + " after=" + AX.after);

  // ⑥″ 吸附 = **距离过半 或 速度 ≥0.3px/ms**。
  //     半步 = 卡宽 − 露出 ≈ 125px，所以 40px 只能靠**速度**提交 —— 旧实现没有速度通道，
  //     40px 一律回弹（"拉了没反应"）。这一条就是判据里最容易假绿的地方，所以给了负对照。
  //     ⚠️ 方向：**向左划（负 dx）才是去下一页**（dx 向右 = 回上一页）——
  //     第一版这组用例把方向写反了，于是"快划"测的其实是边界（下面 B1/B2 才是边界）。
  const F1 = await swipe([[-10, 20], [-40, 0]]);
  console.log("  · 快划 40px（向左）：" + JSON.stringify(F1));
  check(F1.index === "1", "快划 40px（末次采样 ≈1.5px/ms ≥ 0.3）→ **必须翻页**：index=" + F1.index);
  await shot("gallery-page2-390");

  // ⑥‴ 分段控件：点它跳页（不靠手势也能换页）
  const TABJ = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tabs = Array.from(document.querySelectorAll('.ed-galtabs > button'));
    tabs[0].click(); await sleep(450);
    const st = document.querySelector('.ed-stack');
    return JSON.stringify({ index: st.getAttribute('data-index'), active: Array.from(document.querySelectorAll('.ed-galtabs > button')).map((t) => t.getAttribute('data-active')) });
  })()`));
  console.log("  · 分段控件跳页：" + JSON.stringify(TABJ));
  check(TABJ.index === "0" && TABJ.active[0] === "1", "点分段控件能跳回第一页并更新高亮：" + JSON.stringify(TABJ));

  // 慢拖：末次采样间隔 200ms → 速度**归零**（手指停住就不该甩），于是完全由距离决定。
  // 这一对是"距离过半"的判别用例：0.4×步长必须回弹、0.55×步长必须翻页。
  //
  // ⚠️ v3.13：这两个位移**原来写死成 -88 / -128px**（按两页时的中点 -122px 校准的）。
  //    页面从 2 张变 4 张之后，静息中点从 `(0 + (轨道宽−卡宽))/2` 变成了 `−步长/2`
  //    （第一页不再是"倒数第二页"，不再有贴右那一套）—— 实测 -128 只到中点的 0.85 倍，
  //    于是"应当翻页"那条变成了"回弹"，红的却是**测试的标定**、不是产品。
  //    所以改成**从真实卡宽推步长**（pitch = 卡宽 + 间距），页数再怎么变都不会再错位。
  const PITCH = await evalJs(`(() => { const c = document.querySelector('.ed-card'); return c ? c.offsetWidth + 12 : 0; })()`);
  check(PITCH > 100, "量不到卡片步长（画廊卡没渲染？）：" + PITCH);
  const slow = (ratio) => {
    const d = Math.round(PITCH * ratio);
    return [[-12, 60], [-d, 200], [-d - 5, 0]];
  };
  const S1 = await swipe(slow(0.4));
  console.log("  · 慢拖 40% 步长（步长 " + PITCH + "px → -" + Math.round(PITCH * 0.4) + "px）：" + JSON.stringify(S1));
  check(S1.index === "0", "慢拖 ≈0.4×步长（末次采样 5px/200ms → 速度归零）→ **回弹**，不翻页：index=" + S1.index);
  const S2 = await swipe(slow(0.55));
  console.log("  · 慢拖 55% 步长（-" + Math.round(PITCH * 0.55) + "px）：" + JSON.stringify(S2));
  check(S2.index === "1", "慢拖 ≈0.55×步长 → 越过静息中点，**翻页**：index=" + S2.index);

  // ⑥⁗ 边界：两端都必须"顶不住"（有阻尼、不越界、不留白）。
  //      先**跳到最后一页**再向左快划 = 真的顶到边界。
  //      （旧版这组用例方向写反，测的是普通翻页；v3.13 页数从 2 变 4 之后
  //        "划两下就到末尾"也不成立了 —— 所以改成按页数点最后一格，页数无关。）
  const LAST = await evalJs(`(() => { const t = document.querySelectorAll('.ed-galtabs > button'); t[t.length - 1].click(); return t.length - 1; })()`);
  await sleep(450);
  const B1 = await swipe([[-10, 20], [-40, 0]]);
  console.log("  · 边界（已在最后一页 " + LAST + "，继续向左快划）：" + JSON.stringify(B1));
  check(B1.index === String(LAST), "最后一页再向左快划 → 停在最后一页（不越界）：index=" + B1.index);
  await evalJs(`(() => { document.querySelectorAll('.ed-galtabs > button')[0].click(); return 'ok'; })()`);
  await sleep(450);
  const B2 = await swipe([[10, 20], [40, 0]]);
  console.log("  · 边界（已在第一页，继续向右快划）：" + JSON.stringify(B2));
  check(B2.index === "0", "第一页再向右快划 → 停在第一页（不越界）：index=" + B2.index);
  // 拖到一半的阻尼态留证：手指**按住不放**时轨道被压缩（不是硬顶）。
  // ⚠️ 截图必须在"按住"那一刻拍 —— 松手后再拍拍到的只是静息态，图里没有要证明的东西
  //    （J1 那轮就踩过"断言全绿但截图里根本没有那三行"的坑）。
  const RBHOLD = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = document.querySelector('.ed-stack');
    const r = st.getBoundingClientRect();
    const y = Math.round(r.top + 60);
    const x0 = Math.round(r.left + 180);
    const mk = (type, x) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: Math.round(x), clientY: y, pointerId: 41, pointerType: 'mouse', isPrimary: true, buttons: 1 });
    st.dispatchEvent(mk('pointerdown', x0));
    await sleep(30);
    window.dispatchEvent(mk('pointermove', x0 + 20));
    await sleep(30);
    window.dispatchEvent(mk('pointermove', x0 + 200));   // 超出边界 200px
    await sleep(150);
    const t = document.querySelector('.ed-card[data-i="0"]').style.transform;
    const m = /translate3d\\((-?[0-9.]+)px/.exec(t);
    window.__rbHeld = { x0: x0, y: y, id: 41 };
    return JSON.stringify({ held: t, dx: m ? Number(m[1]) : null });
  })()`));
  console.log("  · 边界阻尼（按住不放）：" + JSON.stringify(RBHOLD));
  // pow(200, 0.7) ≈ 41px —— 远小于手指走过的 200px，这就是"顶不住"的量化含义
  check(RBHOLD.dx > 0 && RBHOLD.dx < 80, "越界时轨道被**阻尼压缩**（走了 200px，轨道只跟 " + RBHOLD.dx + "px）：" + RBHOLD.held);
  await shot("gallery-rubber-390");
  const RBREL = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const h = window.__rbHeld; delete window.__rbHeld;
    if (h) {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: h.x0 + 200, clientY: h.y, pointerId: h.id, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
    }
    await sleep(450);
    return JSON.stringify({ index: document.querySelector('.ed-stack').getAttribute('data-index') });
  })()`));
  check(RBREL.index === "0", "松手后回到第一页（阻尼不是「粘住」）：index=" + RBREL.index);
  const entered = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s); const qa = (s) => Array.from(document.querySelectorAll(s));
    const card = qa('.ed-gallery .ed-card').find((c) => c.getAttribute('data-page') === 'detail');
    if (!card) return 'no-card';
    card.click(); await sleep(1200);
    return q('.ed-canvas') ? 'ok' : 'no-canvas';
  })()`);
  if (entered !== "ok") throw new Error("从画廊进不了编辑屏：" + entered);
  await sleep(500);

  // ① 观感总览：块上装饰（应为 0） / 描边 / sheet / 胶囊 / 点阵 / 纸张
  const L = await evalJs(LOOK);
  console.log("  · 观感：" + JSON.stringify(L));
  // v3.3（用户第 5 条）：抓手 / 块名 chip / 序号角标**全部删除** —— 这三条从
  // "抓手有 8 个、热区 ≥44px、chip 显示块名"（v3.2 的断言）反转为"一个都不该有"。
  // 这不是放宽：判据换了方向，而且更严（0 是最强的计数断言）。
  check(L.grips === 0, "块上不再有抓手（v3.2 是 8 个）——改由长按块本体拖动：" + L.grips);
  check(L.namechips === 0, "块名 chip 已删除：" + L.namechips);
  check(L.badges === 0, "纯数字角标 .ed-badge 已删除：" + L.badges);
  check(!L.oldGlyph, "画布上不再出现旧的 ⠿ 字符抓手");
  check(/solid/.test(L.plainOutline || ""), "未选中块的描边是实线（原来是虚线，读起来像「没做完」）：" + L.plainOutline);
  check(L.inspRadius === "16px", "检查器是底部 sheet（顶部圆角 16px）：" + L.inspRadius);
  check(L.inspShadow && L.inspShadow !== "none", "检查器有上投影（sheet 的「从底下拉出来」感）");
  check(L.topRadius === "28px", "顶栏是浮动胶囊（圆角 28，抄 m3e 的 Pill）：" + L.topRadius);
  check(L.topShadow && L.topShadow !== "none", "浮动胶囊带 m3e 的双层阴影配方");
  check(/radial-gradient/.test(L.stageImage || ""), "画布舞台铺了极淡点阵：" + L.stageImage);
  check(/^1px solid$/.test(L.canvasBorder || ""), "页面有「纸张感」（1px 实边）：" + L.canvasBorder);
  check(L.canvasRadius === "10px", "页面圆角 10px：" + L.canvasRadius);

  // ①″ v3.5 用户点名的第 ② 件事（画布侧）：**不要真实作品** + **收藏按钮必须在**
  const PH = JSON.parse(await evalJs(`(() => {
    const cv = document.querySelector('.ed-canvas');
    const fav = cv ? cv.querySelector('.actrow .btn.fav') : null;
    const coverPh = cv ? cv.querySelector('.d-cover-ph') : null;
    return JSON.stringify({
      imgs: cv ? cv.querySelectorAll('img').length : -1,
      hasFav: !!fav,
      favText: fav ? (fav.textContent || '').trim() : null,
      hasRead: cv ? !!cv.querySelector('.actrow .btn.primary') : false,
      coverPh: coverPh ? (coverPh.textContent || '').trim().slice(0, 10) : null
    });
  })()`));
  console.log("  · 画布占位渲染 / 动作行：" + JSON.stringify(PH));
  check(PH.imgs === 0, "画布里**没有任何真实图片**（原来样例 id 会真的拉取别的作品封面）：img=" + PH.imgs);
  check(PH.coverPh !== null && PH.coverPh.length > 0,
    "详情页封面走「失败回退」式文字占位：.d-cover-ph=「" + PH.coverPh + "」");
  check(PH.hasRead && PH.hasFav,
    "动作行「阅读 + 收藏」两个按钮都在（此前画布传 logged:false，把收藏按钮整条藏掉了）：" +
    "read=" + PH.hasRead + " fav=" + PH.hasFav + " 收藏文案=「" + PH.favText + "」");

  // ①′ v3.3：块上**一个常驻装饰都没有**（抓手 / 块名 chip / 序号角标全删 —— 用户第 5 条"碍眼"）
  //     这条替换了 v3.2 的 CHIPFIT：元素不存在了，"chip 压不压正文"的问题随之消失；
  //     但仍要证明**没有东西浮在正文上**（worstTop ≥ 0 = 内容没被顶下去）。
  const CF = JSON.parse(await evalJs(NOCHROME));
  console.log("  · 块上装饰：" + JSON.stringify(CF));
  check(CF.grips === 0 && CF.namechips === 0 && CF.badges === 0,
    "块上没有任何常驻装饰（抓手 " + CF.grips + " / 块名 chip " + CF.namechips + " / 序号角标 " + CF.badges + "，都应为 0）");
  check(CF.oldGlyph === false, "页面上不再出现 ⠿ 那个字符");
  check(CF.worstTop >= 0, "没有装饰浮在正文上（内容顶边相对块顶边 " + CF.worstTop + "px，≥0 即没有东西压在上面）：" + JSON.stringify(CF.rows));

  await shot("editor-390");

  // ①‴ v3.5（用户第 1、2 条）：**死区 + 拖动时收起配置栏**的证据图与断言
  //
  // 一次连续手势分四段拍：起拖（配置栏应当收起来）→ 死区内（落点不许动）→ 越过死区
  // （换位）→ 松手。文字说"手感好了"没有说服力，这四张图 + 几何断言才是证据。
  await setViewport(390, 844);
  const DZ0 = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const order = () => qa('.ed-canvas .ed-blk').map(b => b.getAttribute('data-blk')).join(',');
    const geom = () => qa('.ed-canvas .ed-blk').map(b => b.getAttribute('data-blk') + ':' + b.offsetLeft + ',' + b.offsetTop).join('|');
    q('.ed-canvas .ed-blk[data-blk="tags"]').click();   // 先把配置栏唤起来（用户第 2 条的前置）
    await sleep(380);
    const before = { inspector: !!q('.ed-inspector .ed-module'), order: order(), geom: geom(),
                     scrollTop: q('.ed-stage') ? q('.ed-stage').scrollTop : 0 };
    const blk = q('.ed-canvas .ed-blk[data-blk="hero"]');
    const r = blk.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y0 = Math.round(r.top + r.height / 2);
    const pt = (type, y) => { const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperty(ev, 'pointerType', { value: 'touch' });
      Object.defineProperty(ev, 'pointerId', { value: 1 }); return ev; };
    window.__dz = { blk, pt, y0 };
    blk.dispatchEvent(pt('pointerdown', y0));
    await sleep(440);   // 过长按阈值 → 起拖（onDragStart 在这一帧触发）
    const started = { inspector: !!q('.ed-inspector .ed-module'), order: order(), geom: geom(),
                      scrollTop: q('.ed-stage') ? q('.ed-stage').scrollTop : 0,
                      ghosts: qa('.ed-ghost').length };
    return JSON.stringify({ before, started, blockH: Math.round(r.height),
                            deadZone: Math.round(Math.max(24, 0.5 * r.height)) });
  })()`));
  console.log("  · 死区 / 收起配置栏：" + JSON.stringify(DZ0));
  check(DZ0.before.inspector === true, "前置：点区块后配置栏被唤起（否则这条没有判别力）");
  check(DZ0.started.inspector === false, "【用户第 2 条】拖动开始的同一帧，配置栏被收起");
  check(DZ0.started.geom === DZ0.before.geom, "拖动开始时**块的布局位置一个都没动**（收起不该引起重排）");
  check(DZ0.started.scrollTop === DZ0.before.scrollTop, "拖动开始时画布滚动位置没变（" + DZ0.before.scrollTop + "）");
  check(DZ0.started.ghosts === 1, "起拖后有且只有一个跟手镜像：" + DZ0.started.ghosts);
  await shot("editor-drag-start-390");

  // ① 死区的**绝对下限**：推 12px（< 下限 24px）→ 落点必须一动不动
  const DZ1 = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const { blk, pt, y0 } = window.__dz;
    blk.dispatchEvent(pt('pointermove', y0 + 12));
    await sleep(240);
    return JSON.stringify({ order: qa('.ed-canvas .ed-blk').map(b => b.getAttribute('data-blk')).join(','),
                            ghosts: qa('.ed-ghost').length });
  })()`));
  console.log("  · 下限内 12px：" + JSON.stringify(DZ1));
  check(DZ1.order === DZ0.before.order,
    "推 12px（< 绝对下限 24px）→ 落点**一动不动**：" + DZ1.order);
  await shot("editor-drag-deadzone-390");

  /**
   * ①′ v3.5.3 **判据反转**：门槛从"被拖块自己的尺寸"改成"**朝行进方向最近那一块**的尺寸"。
   *
   * hero 高 139：旧口径门槛 `0.5×139 ≈ 70px`，所以旧断言是"推 40px 一动不动"。
   * 新口径看**目标**（下面那块 `tags` 高 28）→ `max(24, 14) = 24px` ⇒ **推 40px 就该换位**。
   * 这条在 v3.6 的产物上必须**反过来**（推 40px 不动）—— 依据见调研报告 §3.2 的相关性表：
   * 旧口径与"被拖块尺寸" r=0.98（"拖大块永远木"），与目标 r=−0.14。
   */
  const DZ1b = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const { blk, pt, y0 } = window.__dz;
    blk.dispatchEvent(pt('pointermove', y0 + 40));
    await sleep(280);
    return JSON.stringify({ order: qa('.ed-canvas .ed-blk').map(b => b.getAttribute('data-blk')).join(','),
                            ghosts: qa('.ed-ghost').length });
  })()`));
  console.log("  · 按目标算的门槛（推 40px）：" + JSON.stringify(DZ1b));
  check(DZ1b.order !== DZ0.before.order,
    "【v3.5.3 判据反转】门槛按**目标**算：hero（" + DZ0.blockH + " 高）推 40px 就换位（旧口径要 " +
    DZ0.deadZone + "px 才动）：" + DZ1b.order);
  check(DZ1b.ghosts === 1, "换位后镜像仍在：" + DZ1b.ghosts);

  // 越过死区：推到 130px → 换位
  const DZ2 = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const { blk, pt, y0 } = window.__dz;
    blk.dispatchEvent(pt('pointermove', y0 + 130));
    await sleep(300);
    return JSON.stringify({ order: qa('.ed-canvas .ed-blk').map(b => b.getAttribute('data-blk')).join(','),
                            ghosts: qa('.ed-ghost').length });
  })()`));
  console.log("  · 越过死区 130px：" + JSON.stringify(DZ2));
  check(DZ2.order !== DZ0.before.order,
    "越过死区之后**真的换位了**（不是把换位整个挡掉）：" + DZ2.order);
  check(DZ2.ghosts === 1, "拖动中镜像仍在（换位没有把它丢掉）：" + DZ2.ghosts);
  await shot("editor-drag-swapped-390");

  // 松手：提交 + 镜像撤走
  const DZ3 = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const { blk, pt, y0 } = window.__dz;
    blk.dispatchEvent(pt('pointerup', y0 + 130));
    await sleep(400);
    return JSON.stringify({ order: qa('.ed-canvas .ed-blk').map(b => b.getAttribute('data-blk')).join(','),
                            ghosts: qa('.ed-ghost').length,
                            saved: (JSON.parse(localStorage.getItem('jmclient.detailLayout.v1') || '{}').blocks || []).join(',') });
  })()`));
  console.log("  · 松手后：" + JSON.stringify(DZ3));
  check(DZ3.ghosts === 0, "松手后跟手镜像撤走：" + DZ3.ghosts);
  check(DZ3.order === DZ2.order, "松手后顺序保持（换位已提交）：" + DZ3.order);
  check(DZ3.saved === DZ3.order, "落盘顺序与 DOM 一致：saved=" + DZ3.saved + " dom=" + DZ3.order);
  await shot("editor-drag-landed-390");

  // ② 选中一块：chip 提亮 + 检查器展开成 sheet + 块名层级
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const blk = document.querySelector('.ed-canvas .ed-blk[data-blk="hero"]');
    blk.click(); await sleep(500); return true;
  })()`);
  const S = await evalJs(SELECTED);
  console.log("  · 选中态：" + JSON.stringify(S));
  check(/solid 2px/.test(S.selOutline || ""), "选中块是 2px 实线描边（不是虚线）：" + S.selOutline);
  // v3.3（用户第 5 / 9 条）：配置栏里 ① 显示开关在最上面 ② ▲▼ 已删（位置靠长按拖）③ 右上角有「完成」
  check(S.firstRowIsShow === true, "「显示 / 隐藏」在区块配置栏的最上面一条：" + S.firstRowIsShow);
  check(S.hasStepArrows === 0, "区块配置栏里已没有 ▲▼（位置只靠长按拖动；实际 " + S.hasStepArrows + " 个）");
  check(S.hasDone === true, "区块配置栏右上角有「完成」（用户第 9 条）：" + S.hasDone);
  check(S.module && /主视觉/.test(S.moduleName || ""), "检查器里显示该块的名字与位置：" + S.moduleName);
  check(S.inspRadius === "16px", "选中展开后仍是 sheet 形态：" + S.inspRadius);
  await shot("editor-selected-390");

  // ③ 起拖对齐 + transform-origin（审计 L-1）→ 再拖一次拍「坑 + 镜像 + 缝」同框
  const D = JSON.parse(await evalJs(DRAG_PROBE));
  console.log("  · 起拖探针：" + JSON.stringify(D));
  check(D.ghost === true, "起拖后出现跟手镜像 .ed-ghost");
  check(D.origin === "0px 0px", "镜像 transform-origin 是 0 0（默认 50% 50% 会让 scale(1.03) 绕中心放大、起拖时视觉漂 ~5.7px）：" + D.origin);
  check(Math.abs(D.dx) <= 2 && Math.abs(D.dy) <= 2, "起拖瞬间镜像左上角与被抓块左上角对齐（偏差 ≤2px）：dx=" + D.dx + " dy=" + D.dy);
  check(D.ghostW >= D.blkW && D.ghostW <= Math.round(D.blkW * 1.06) && D.ghostH >= D.blkH && D.ghostH <= Math.round(D.blkH * 1.06),
    "镜像是整块 × 1.03 抬起（不是一根手柄）：" + D.ghostW + "×" + D.ghostH + " vs 块 " + D.blkW + "×" + D.blkH);
  check(D.cleaned === true, "松手后镜像被清理（不留孤儿）");

  const SH = JSON.parse(await evalJs(DRAG_FOR_SHOT));
  console.log("  · 拖动态：" + JSON.stringify(SH));
  check(SH.ghost === true && SH.gaps === 1 && SH.drag === 1, "拖动态三件套同框（跟手镜像 + 插入缝 + 坑）：" + JSON.stringify(SH));
  await shot("editor-drag-390");
  await evalJs(DROP);
  await sleep(400);

  // ④ 「⋯」次级菜单（v3.3：**「排布总表」已删除**，只剩页面设置 / 恢复默认）
  const M = JSON.parse(await evalJs(OPEN_MENU));
  console.log("  · ⋯ 菜单：" + JSON.stringify(M));
  check(M.items.length === 2, "「⋯」菜单只剩 2 项（页面设置 / 恢复默认）——「排布总表」已按用户第 3 条删除：" + JSON.stringify(M.items));
  check(M.items.join("|").indexOf("页面设置") >= 0 && M.items.join("|").indexOf("恢复全部默认") >= 0,
    "两项文案齐备：" + JSON.stringify(M.items));
  check(M.items.join("|").indexOf("排布总表") < 0, "菜单里不再有「排布总表」入口：" + JSON.stringify(M.items));
  check(M.hasScrim, "菜单带遮罩（点空白能关）");

  // ④′ 页面设置：**独立一屏**（覆盖层），且**不许把画布顶上去**（用户第 8 条）
  const P2 = JSON.parse(await evalJs(CLICK_MENU("页面设置")));
  console.log("  · 页面设置：" + JSON.stringify(P2));
  check(P2.menuGone === true, "点完菜单项后菜单收起");
  check(P2.sheetPage === true && P2.sheetPanel === "style", "页面设置以**独立一屏**（.ed-sheetpage）出现，而不是挤在检查器里：" + P2.sheetPanel);
  check(P2.sheetHasDone === true, "这一屏有自己的「完成」：" + P2.sheetHasDone);
  check(P2.canvasTopSame === true && P2.canvasHSame === true,
    "唤出页面设置**没有把画布顶上去**（位置与高度都不变）：topSame=" + P2.canvasTopSame + " hSame=" + P2.canvasHSame);
  check(P2.panelsGone === true && P2.orderRowsGone === true,
    "检查器里不再有折叠面板 / 排布总表的行（旧形态的残留为 0）：panels=" + P2.panelsGone + " rows=" + P2.orderRowsGone);
  await shot("editor-panels-390");

  // ⑤ v3.3（用户第 3 条）：**取消窄屏降级** —— 窄视口下两个 1/2 的块必须仍然**并排**。
  //
  //    这一条**反转**了 v3.2 的两条断言（"窄视口默认应堆叠" + "开宽屏预览才并排"）：
  //    降级链路（@media(max-width:399px) + data-narrow-stack）和「宽屏」按钮都被删了，
  //    所以现在只有一种行为 —— 手机上就是你配的并排。判据换了方向，不是放宽。
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const done = document.querySelector('.ed-sheetpage .ed-paneldone') || document.querySelector('.ed-paneldone');
    if (done) { done.click(); await sleep(300); }
    const setSpan = async (id, label) => {
      const blk = document.querySelector('.ed-canvas .ed-blk[data-blk="' + id + '"]');
      blk.click(); await sleep(400);
      const b = Array.from(document.querySelectorAll('.ed-inspector .ed-span button')).find(x => (x.textContent || '').trim() === label);
      if (b) { b.click(); await sleep(400); }
      return !!b;
    };
    await setSpan('actors', '1/2');
    await setSpan('tags', '1/2');
    return true;
  })()`);
  const narrow = JSON.parse(await evalJs(`(() => {
    const box = (id) => { const e = document.querySelector('.ed-canvas .ed-blk[data-blk="' + id + '"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width) }; };
    const card = document.querySelector('.detail-card');
    const canvas = document.querySelector('.ed-canvas');
    return JSON.stringify({
      a: box('actors'), t: box('tags'),
      narrowAttr: card ? card.hasAttribute('data-narrow-stack') : null,
      previewWide: /ed-preview-wide/.test((canvas || {}).className || ''),
      wideChip: !!document.querySelector('.ed-top .ed-widechip')
    });
  })()`));
  console.log("  · 窄视口并排（降级已取消）：" + JSON.stringify(narrow));
  const sideBySide = narrow.a && narrow.t &&
    Math.abs(narrow.a.top - narrow.t.top) <= 3 && Math.abs(narrow.a.left - narrow.t.left) > 40;
  check(sideBySide, "窄视口(390)下两个 1/2 的块仍然**并排**（窄屏降级已按用户要求取消）：" + JSON.stringify([narrow.a, narrow.t]));
  check(narrow.narrowAttr === false, "容器不再输出 data-narrow-stack（降级链路的门控属性已删干净）：" + narrow.narrowAttr);
  check(narrow.previewWide === false && narrow.wideChip === false,
    "「宽屏」按钮与 .ed-preview-wide 都已删除（不再需要压过降级）：chip=" + narrow.wideChip);
  await shot("narrow-side-390");

  // ⑥ 桌面视口 + 深色主题各来一张（同一份状态，只换视口/主题）
  await setViewport(1280, 800);
  await sleep(600);
  await shot("editor-1280");
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const b = document.querySelector('.ed-top .ed-back'); if (b) { b.click(); await sleep(900); }
    return true;
  })()`);
  await sleep(600);
  await shot("gallery-1280");

  // ⑦ v3.3 布局收尾 + v3.4 份量感（桌面）：卡片宽度**有上限也有下界**、不再横向溢出、缩略图不再被放大
  const GD = JSON.parse(await evalJs(`(() => {
    const g = document.querySelector('.ed-gallery');
    const cards = Array.from(document.querySelectorAll('.ed-gallery .ed-card'));
    const inner = document.querySelector('.ed-gallery-inner');
    return JSON.stringify({
      n: cards.length,
      mode: g ? g.getAttribute('data-mode') : null,
      w: cards.map((c) => Math.round(c.getBoundingClientRect().width)),
      left: cards.map((c) => Math.round(c.getBoundingClientRect().left)),
      right: cards.map((c) => Math.round(c.getBoundingClientRect().right)),
      bottom: cards.map((c) => Math.round(c.getBoundingClientRect().bottom)),
      innerW: inner ? Math.round(inner.getBoundingClientRect().width) : 0,
      overflowX: g ? g.scrollWidth - g.clientWidth : -1,
      scales: Array.from(document.querySelectorAll('.ed-gallery .ed-thumb-inner')).map((t) => t.style.transform)
    });
  })()`));
  console.log("  · 画廊（1280）：" + JSON.stringify(GD));
  // 尺寸两端都有物理含义（v3.6 按"单轨 peek / 宽屏两栏"重算）：
  //   上界 390 = **缩略图设计宽** —— 卡比它更宽时 `k = min(1, 卡内宽/390)` 被夹在 1，
  //   缩略图只有 390 宽、填不满卡片、右侧留白（也是当初"被放大 1.59 倍"那条 bug 的另一面）；
  //   下界 200 = 不能退回 v3.3 那种 218px 的"小卡浮在空旷里"。
  //   桌面（内宽 768）走**静态两列网格**：(768−12)/2 = 378 ∈ [200,390] ✓
  //   ⚠️ v3.13：页数从 2 变 4 之后这里**只该数 4 张卡**，宽度判据完全不变 ——
  //   因为宽屏已改成"固定两列 + 换行"（四张挤一行会把每张压到 183px，正是这条判据抓出来的）。
  check(GD.n === 4 && GD.w.every((w) => w >= 200 && w <= 390),
    "桌面卡片宽度落在 [200,390]（≤390 保证缩略图 k≤1 且填满；≥200 不退回「小卡浮在空旷里」）：" + GD.w.join("/"));
  check(GD.mode === "wide", "桌面切到**静态两列**（所有页完整可见，不是 peek）：mode=" + GD.mode);
  const dOverlap = Math.min(GD.right[0], GD.right[1]) - Math.max(GD.left[0], GD.left[1]);
  check(dOverlap <= 0, "两栏**不重叠**：" + dOverlap + "px");
  check(Math.abs(GD.bottom[0] - GD.bottom[1]) <= 1, "两栏底边齐（旧版 SINK 逐卡下沉导致差 5~20px）：" + GD.bottom.join("/"));
  check(GD.overflowX <= 1, "画廊无横向溢出（第二张卡不再被视口切掉）：scrollWidth-clientWidth=" + GD.overflowX);
  check(GD.scales.length > 0 && GD.scales.every((s) => {
    const m = /scale\(([\d.]+)\)/.exec(s || "");
    return m ? parseFloat(m[1]) <= 1 : false;
  }), "缩略图只缩小不放大（第一版 k≈1.59 把页面放大到比真机还大）：" + JSON.stringify(GD.scales));
  // 【v3.6 新增】缩略图必须**填满卡片**：k == 卡宽/390（上限 1）。
  // 只验「k ≤ 1」会漏掉"卡宽变了但缩略图没重算"：实测就是这样 —— 首次挂载用的是兜底宽
  // （peek 卡宽 298 → k=0.764），量到轨道宽后切成两栏（卡宽 378），缩略图仍停在 0.764
  // → **卡片右侧留白**，而「k ≤ 1」依然为真（典型假绿）。这条拿卡宽反算 k 才对应真实契约。
  check(GD.scales.length === GD.w.length && GD.scales.every((s, i) => {
    const m = /scale\(([\d.]+)\)/.exec(s || "");
    return m ? Math.abs(parseFloat(m[1]) - Math.min(1, GD.w[i] / 390)) <= 0.03 : false;
  }), "缩略图缩放比 == 卡宽/390（**填满卡片**，不只是「≤1」）：scales=" + JSON.stringify(GD.scales) + " 卡宽=" + GD.w.join("/"));

  // ⑧ 矮视口：内容必然溢出 → scrollTop=0 时首卡必须仍在可视区
  //     （这是「用 margin:auto 居中」而不是 justify-content:center 的原因：
  //      center 会把首行顶出滚动区，用户就永远滚不回顶部）
  await setViewport(390, 300);
  await sleep(500);
  const GS = JSON.parse(await evalJs(`(() => {
    const g = document.querySelector('.ed-gallery');
    const first = document.querySelector('.ed-gallery .ed-card');
    const tabs = document.querySelector('.ed-galtabs');
    if (!g || !first) return JSON.stringify({ ok: false });
    g.scrollTop = 0;
    const gr = g.getBoundingClientRect(), fr = first.getBoundingClientRect();
    const tr = tabs ? tabs.getBoundingClientRect() : null;
    return JSON.stringify({
      over: g.scrollHeight - g.clientHeight,
      firstTop: Math.round(fr.top - gr.top),
      tabTop: tr ? Math.round(tr.top - gr.top) : null,
      viewH: Math.round(gr.height),
      scrollTop: g.scrollTop
    });
  })()`));
  console.log("  · 画廊（矮视口 390×300）：" + JSON.stringify(GS));
  check(GS.over > 0, "矮视口下画廊确实溢出（用例有效，不是空跑）：over=" + GS.over);
  // ⚠️ v3.6 起卡片区上方多了一行**页名分段控件**，所以"第一张卡的 top ≤ 40"这条旧界
  //    不再成立（那是"卡片紧贴 16px 内边距"时代的数字）。判据换成两条**如实**的性质：
  //      ① 页名行就在顶部内边距处（说明内容是从头开始排的，没被"居中"顶出滚动区）；
  //      ② 第一张卡的 top 仍在可视区内（这才是要守的性质：滚到顶能看见第一张卡）。
  check(GS.tabTop !== null && GS.tabTop >= 0 && GS.tabTop <= 40,
    "滚到顶部时页名行紧贴内边距（内容没有被居中顶出滚动区）：tabTop=" + GS.tabTop);
  check(GS.firstTop > 0 && GS.firstTop < GS.viewH,
    "滚到顶部时第一张卡在可视区内：firstTop=" + GS.firstTop + " 可视高=" + GS.viewH);
  await shot("gallery-scroll-390");
  await setViewport(390, 844);
  await sleep(300);
  // 深色：项目用 [data-theme="dark"]（挂在 html 上）—— 这里直接切属性取一张。
  // ⚠️ 先把视口调回**手机**：上一步为了拍宽屏把它改成了 1280×800，
  //    漏掉这一步就会得到一张名叫 -390 实为 1280 的图（第一版就是这么错的）。
  await setViewport(390, 844);
  await sleep(400);
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.documentElement.setAttribute('data-theme', 'dark');
    const card = Array.from(document.querySelectorAll('.ed-gallery .ed-card')).find(c => c.getAttribute('data-page') === 'detail');
    if (card) { card.click(); await sleep(1000); }
    return true;
  })()`);
  await sleep(700);
  await shot("editor-dark-390");
  await evalJs(`(() => { document.documentElement.removeAttribute('data-theme'); return true; })()`);

  // ⑨ v3.4 宽度 3/4 档 + 行内位置（用户第 7 条）—— 编辑器里的**视觉证据**
  //    这两张图是给人看的：3/4 与 1/2 的实宽差异、以及 1/2 居中后两侧的空占位格。
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const setSpan = async (id, label) => {
      const blk = document.querySelector('.ed-canvas .ed-blk[data-blk="' + id + '"]');
      if (!blk) return false;
      blk.click(); await sleep(400);
      const b = Array.from(document.querySelectorAll('.ed-inspector .ed-span button')).find(x => (x.textContent || '').trim() === label);
      if (!b) return false;
      b.click(); await sleep(450);
      return true;
    };
    await setSpan('tags', '3/4');
    return true;
  })()`);
  await sleep(400);
  const W34 = JSON.parse(await evalJs(`(() => {
    const box = (id) => { const e = document.querySelector('.ed-canvas .ed-blk[data-blk="' + id + '"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { left: Math.round(r.left), w: Math.round(r.width) }; };
    const t = document.querySelector('.ed-canvas .ed-blk[data-blk="tags"]');
    return JSON.stringify({ tags: box('tags'), actors: box('actors'), span: t ? t.getAttribute('data-span') : null });
  })()`));
  console.log("  · 3/4 档（tags）：" + JSON.stringify(W34));
  check(W34.span === "9" && W34.actors && W34.tags && W34.tags.w > W34.actors.w + 40,
    "3/4（9 列）比 1/2（6 列）明显更宽，且两个块同处一行：" + JSON.stringify(W34));
  await shot("editor-span-34-390");

  // 1/2 + 「中」→ 两侧各一个空占位格（用户第 7 条要的"可以停在行中间"）
  //
  // ⚠️ 前置：这一行必须**只有它一块**，否则偏移会被"光标已经越过它"这条规则正确忽略
  //    （6+6 本来就占满一行，把第二块往后推没有意义）。所以先把 actors 恢复满宽。
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const span = async (id, label) => {
      const blk = document.querySelector('.ed-canvas .ed-blk[data-blk="' + id + '"]');
      if (!blk) return false;
      blk.click(); await sleep(400);
      const b = Array.from(document.querySelectorAll('.ed-inspector .ed-span button')).find(x => (x.textContent || '').trim() === label);
      if (!b) return false;
      b.click(); await sleep(450);
      return true;
    };
    await span('actors', '满宽');   // 让 tags 独占一行
    await span('tags', '1/2');
    const mid = Array.from(document.querySelectorAll('.ed-inspector .ed-offsetseg button')).find(x => (x.textContent || '').trim() === '中');
    if (mid) { mid.click(); await sleep(500); }
    return true;
  })()`);
  await sleep(500);
  const WCT = JSON.parse(await evalJs(`(() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return { left: Math.round(r.left), w: Math.round(r.width) }; };
    const t = document.querySelector('.ed-canvas .ed-blk[data-blk="tags"]');
    const pg = t && t.previousElementSibling, ng = t && t.nextElementSibling;
    return JSON.stringify({
      tags: t ? box(t) : null,
      prevGap: pg && pg.classList.contains('d-gap') ? box(pg) : null,
      nextGap: ng && ng.classList.contains('d-gap') ? box(ng) : null,
      gaps: document.querySelectorAll('.ed-canvas .d-gap').length
    });
  })()`));
  console.log("  · 1/2 居中（tags）：" + JSON.stringify(WCT));
  check(WCT.tags && WCT.prevGap && WCT.nextGap && Math.abs(WCT.prevGap.w - WCT.nextGap.w) <= 2 && WCT.prevGap.w > 20,
    "1/2 居中后左右各一个**等宽**空占位格（真的占住 3 列）：" + JSON.stringify(WCT));
  await shot("editor-offset-center-390");

  // ── v3.5.2 判别性负对照：**抓左缘起拖、手指不动 → 列不许变** ──────────────
  // 旧实现用"指针的绝对位置"算列，并拿**被拖块自己的左缘**当行起点
  // （`rel = (pointerX − dragged.left)/step`，`col = floor(rel − span/2 + 0.5)`）：
  //   块已在 col 3（本用例前置）→ 抓左缘时 rel = 3 → col = floor(0.5) = 0
  //   ⇒ **手指还没动，居中的块先掉回最左**（两格位置差 ≈ 2 列）。
  //   新实现吃"块心"（对抓取点不敏感）→ 起拖前后必须逐像素一致。
  // 这条断言在交付版 v3.5 的产物上**必须是红的**（判别力自证；实测已核对）。
  // 注：抓右缘在**旧实现**下恰好也落在当前列（`floor(c+s−s/2+0.5) = c`），所以抓右缘没有判别力。
  const grabPt = JSON.parse(await evalJs(`(() => {
    const t = document.querySelector('.ed-canvas .ed-blk[data-blk="tags"]');
    if (!t) return JSON.stringify({ ok: false });
    const r = t.getBoundingClientRect();
    /* 诊断：行内落位用到的每个几何量都打出来（列距/行左缘到底是多少，别靠算） */
    const list = t.parentElement && t.parentElement.closest('[data-drag-list]');
    const lr = list ? list.getBoundingClientRect() : null;
    const cs = list ? getComputedStyle(list) : null;
    const cv = document.querySelector('.ed-canvas');
    const cr = cv.getBoundingClientRect();
    return JSON.stringify({
      ok: true, x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2),
      diag: {
        tagsLeft: Math.round(r.left), tagsW: Math.round(r.width),
        canvasLeft: Math.round(cr.left), canvasW: cv.offsetWidth,
        listLeft: lr ? Math.round(lr.left) : null, listW: lr ? Math.round(lr.width) : null,
        listClientW: list ? list.clientWidth : null,
        padL: cs ? cs.paddingLeft : null, padR: cs ? cs.paddingRight : null,
        gap: cs ? cs.columnGap : null,
        listCls: list ? list.className : null
      }
    });
  })()`));
  console.log("  · 行内落位几何诊断：" + JSON.stringify(grabPt.diag));
  check(grabPt.ok, "前置：找得到 1/2 的 tags 块（抓右缘用例，否则本条没有判别力）");
  const GR = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const qa = (s) => Array.from(document.querySelectorAll(s));
    const t = document.querySelector('.ed-canvas .ed-blk[data-blk="tags"]');
    const snap = () => {
      const r = t.getBoundingClientRect();
      return { left: Math.round(r.left), w: Math.round(r.width),
               gaps: qa('.ed-canvas .d-gap').map(g => Math.round(g.getBoundingClientRect().width)).join(',') };
    };
    const ev = (type, x, y) => { const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperty(e, 'pointerType', { value: 'touch' }); Object.defineProperty(e, 'pointerId', { value: 7 }); return e; };
    const before = snap();
    t.dispatchEvent(ev('pointerdown', ${grabPt.x}, ${grabPt.y}));
    await sleep(440);                       // 过长按阈值 → 起拖；全程**不发任何 pointermove**
    const holding = snap();
    const out = { dragged: qa('.ed-canvas .ed-blk.ed-drag').length,
                  ghost: qa('.ed-canvas .ed-ghost').length,
                  arrowNone: qa('.ed-inspector').length };
    t.dispatchEvent(ev('pointerup', ${grabPt.x}, ${grabPt.y}));
    await sleep(300);
    return JSON.stringify({ before, holding, ...out });
  })()`));
  console.log("  · 抓左缘起拖（手指不动）：" + JSON.stringify(GR));
  check(GR.dragged === 1, "抓左缘长按**能正常起拖**（前置）：" + GR.dragged);
  check(GR.holding.left === GR.before.left,
    "【v3.5.2 修正】抓左缘起拖后**块没有跳列**（旧实现立刻掉回最左）：left " + GR.before.left + " → " + GR.holding.left);
  check(GR.holding.gaps === GR.before.gaps,
    "【v3.5.2 修正】空占位格宽度没变（= 列没变）：" + GR.before.gaps + " → " + GR.holding.gaps);

  // 复原：tags 回满宽（不把这份改动留给后面的用例）
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const blk = document.querySelector('.ed-canvas .ed-blk[data-blk="tags"]');
    blk.click(); await sleep(400);
    const full = Array.from(document.querySelectorAll('.ed-inspector .ed-span button')).find(x => (x.textContent || '').trim() === '满宽');
    if (full) { full.click(); await sleep(450); }
    return true;
  })()`);
  await sleep(300);

  // ⑨‴ v3.8 形态第一批（调研 TOP8 第 3 / 5 条）：标签「横滑一行」· 信息区「紧凑两列表」· **形态按宽度过滤**
  //
  // 这一节要同时钉住三件相反的事：
  //   ① **没选形态时一个字都不许变**（默认态容器类必须还是 `d-tags` / 没有 `d-facts-table`）；
  //   ② **选了必须真的变**（画布容器的类跟着换）；回到默认档必须**干净地去掉**（不留空类名）；
  //   ③ **轴冲突①（宽度 × 形态）**：`hero` 的「紧凑两列表」在 1/4 宽下必须从面板**消失**，
  //      宽度改回去又要**自己回来**（读时回落、不改写配置值 —— 见 core/detailLayout 的说明）。
  {
    const FM0 = JSON.parse(await evalJs(`(() => {
      const cls = (s) => { const e = document.querySelector(s); return e ? e.className : null; };
      return JSON.stringify({ tags: cls('.ed-canvas .d-tags'), facts: cls('.ed-canvas .d-facts') });
    })()`));
    console.log("  · 形态默认态：" + JSON.stringify(FM0));
    check(FM0.tags === "d-tags", "【红线】默认形态下标签容器没有多任何类：" + FM0.tags);
    check(String(FM0.facts).indexOf("d-facts-table") < 0, "【红线】默认形态下信息区没有 d-facts-table：" + FM0.facts);

    const TF = JSON.parse(await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const qa = (s) => Array.from(document.querySelectorAll(s));
      const seg = () => qa('.ed-inspector .ed-form[data-form-key="tags"] .ed-formseg button');
      const btn = (name) => seg().find(b => (b.textContent || '').indexOf(name) >= 0);
      const blk = q('.ed-canvas .ed-blk[data-blk="tags"]');
      if (!blk) return JSON.stringify({ ok: false, why: 'no-tags' });
      blk.click(); await sleep(430);
      const labels = seg().map(b => (b.textContent || '').trim());
      const s = btn('横滑'); if (!s) return JSON.stringify({ ok: false, labels });
      s.click(); await sleep(430);
      const scrollCls = (q('.ed-canvas .d-tags') || {}).className || '';
      const hint = ((q('.ed-inspector .ed-formhint') || {}).textContent || '').trim();
      const w = btn('折行'); if (w) { w.click(); await sleep(430); }
      const wrapCls = (q('.ed-canvas .d-tags') || {}).className || '';
      return JSON.stringify({ ok: true, labels, scrollCls, wrapCls, hint });
    })()`));
    console.log("  · 标签形态：" + JSON.stringify(TF));
    check(TF.ok === true && TF.labels.length === 2, "选中「标签」后形态行有两档（折行 / 横滑一行）：" + JSON.stringify(TF.labels));
    check(TF.scrollCls === "d-tags d-tags-scroll", "选「横滑一行」→ 画布容器真的换类：" + TF.scrollCls);
    check(TF.wrapCls === "d-tags", "回到「折行」→ 类干净去掉（不留空类名、也不叠加）：" + TF.wrapCls);

    const HF = JSON.parse(await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const qa = (s) => Array.from(document.querySelectorAll(s));
      const forms = () => qa('.ed-inspector .ed-form[data-form-key="hero"] .ed-formseg button').map(b => (b.textContent || '').trim());
      const spanBtn = (name) => qa('.ed-inspector .ed-span button').find(b => (b.textContent || '').trim() === name);
      const blk = q('.ed-canvas .ed-blk[data-blk="hero"]');
      if (!blk) return JSON.stringify({ ok: false, why: 'no-hero' });
      blk.click(); await sleep(430);
      const atFull = forms();
      const quarter = spanBtn('1/4');
      if (!quarter) return JSON.stringify({ ok: false, why: 'no-span-btn', atFull });
      quarter.click(); await sleep(500);
      const atQuarter = forms();
      const quarterStill = ((q('.ed-canvas .ed-blk[data-blk="hero"]') || {}).getAttribute('data-span')) || null;
      const half = spanBtn('1/2');
      if (half) { half.click(); await sleep(500); }
      const back = forms();
      const full = spanBtn('满宽');
      if (full) { full.click(); await sleep(500); }
      return JSON.stringify({ ok: true, atFull, atQuarter, back, quarterStill });
    })()`));
    console.log("  · 信息区形态 / 宽度过滤：" + JSON.stringify(HF));
    check(HF.ok === true && HF.atFull.length === 2, "满宽下「主视觉」的信息区形态有两档：" + JSON.stringify(HF.atFull));
    check(HF.atQuarter.length === 0, "★ 1/4 宽下「紧凑两列表」被过滤掉、且**整行都不再渲染**（只剩一档 = 哑控件，按既有规则整行不画）：" + JSON.stringify(HF.atQuarter));
    check(HF.back.length === 2, "回到 1/2 宽 → 两档又回来了（宽度改回去，选择不丢）：" + JSON.stringify(HF.back));
  }

  // ⑨⁗ v3.8 目录排法（chapLayout）：**面板接线** —— 选中「目录」块时出现「目录排法」两个档位，点了配置真的落盘。
  //     注意这里验的是接线与落盘，**不是画布外观**：`data-dl-chap` 作用于真页的 `.detail-card`，
  //     编辑器画布不预览任何样式轴（`目录字号 / 标签大小 / 疏密` 等既有项也一样）——
  //     真页上的渲染由 `driver-forms.js` 用计算样式与几何验证。
  {
    const CL = JSON.parse(await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const qa = (s) => Array.from(document.querySelectorAll(s));
      const seg = '.ed-inspector .dl-style[data-style-key="chapLayout"] .seg-choice button';
      const blk = q('.ed-canvas .ed-blk[data-blk="detail"]');
      if (!blk) return JSON.stringify({ ok: false, why: 'no-detail-block' });
      blk.click(); await sleep(460);
      const labels = qa(seg).map((b) => (b.textContent || '').trim());
      const gridBtn = qa(seg).find((b) => /两列/.test(b.textContent || ''));
      if (!gridBtn) return JSON.stringify({ ok: false, labels });
      gridBtn.click(); await sleep(460);
      const saved = (JSON.parse(localStorage.getItem('jmclient.detailStyle.v1') || '{}').chapLayout) || null;
      const onNow = qa(seg).filter((b) => (b.className || '').indexOf('on') >= 0).map((b) => (b.textContent || '').trim());
      const listBtn = qa(seg).find((b) => /单列/.test(b.textContent || ''));
      if (listBtn) { listBtn.click(); await sleep(460); }
      const savedAfter = (JSON.parse(localStorage.getItem('jmclient.detailStyle.v1') || '{}').chapLayout) || null;
      return JSON.stringify({ ok: true, labels, saved, onNow, savedAfter });
    })()`));
    console.log("  · 目录排法面板：" + JSON.stringify(CL));
    check(CL.ok === true && CL.labels.join(",") === "单列,两列", "选中「目录」块时出现「目录排法」两个档位：" + JSON.stringify(CL.labels));
    check(CL.saved === "grid2", "点「两列」→ 配置真的落盘（chapLayout=grid2）：" + CL.saved);
    check(CL.onNow.length === 1, "档位按钮的选中态跟着走（恰好一个 on）：" + JSON.stringify(CL.onNow));
    check(CL.savedAfter === "list", "点回「单列」→ 落盘值回到 list（默认不写这条不变量作用在**属性层**，有单测钉着）：" + CL.savedAfter);

    // v3.9 又给目录加了**顺序**与**筛选**两条轴（同为块级档位）—— 三行都必须在面板上出现
    const CL2 = JSON.parse(await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const qa = (s) => Array.from(document.querySelectorAll(s));
      const blk = q('.ed-canvas .ed-blk[data-blk="detail"]');
      if (!blk) return JSON.stringify({ ok: false, why: 'no-detail-block' });
      blk.click(); await sleep(460);
      const row = (key) => {
        const seg = q('.ed-inspector .dl-style[data-style-key="' + key + '"] .seg-choice');
        return seg ? qa('.ed-inspector .dl-style[data-style-key="' + key + '"] .seg-choice button').map((b) => (b.textContent || '').trim()) : null;
      };
      const desc = row('chapOrder');
      const filt = row('chapFilter');
      // 点「倒序」看落盘
      const d = qa('.ed-inspector .dl-style[data-style-key="chapOrder"] .seg-choice button').find((b) => /倒序/.test(b.textContent || ''));
      if (d) { d.click(); await sleep(460); }
      const savedOrder = (JSON.parse(localStorage.getItem('jmclient.detailStyle.v1') || '{}').chapOrder) || null;
      const asc = qa('.ed-inspector .dl-style[data-style-key="chapOrder"] .seg-choice button').find((b) => /正序/.test(b.textContent || ''));
      if (asc) { asc.click(); await sleep(400); }
      return JSON.stringify({ ok: true, desc, filt, savedOrder });
    })()`));
    console.log("  · 目录顺序/筛选面板：" + JSON.stringify(CL2));
    check(CL2.ok === true && JSON.stringify(CL2.desc) === JSON.stringify(["正序", "倒序"]),
      "「目录顺序」两个档位（正序 / 倒序）：" + JSON.stringify(CL2.desc));
    check(JSON.stringify(CL2.filt) === JSON.stringify(["全部", "只看已缓存"]),
      "「目录筛选」两个档位（全部 / 只看已缓存）：" + JSON.stringify(CL2.filt));
    check(CL2.savedOrder === "desc", "点「倒序」→ 配置真的落盘（chapOrder=desc）：" + CL2.savedOrder);

    // v3.10：主视觉多了「封面排布」（左图右文 / 封面居中）—— 选中「主视觉」时这一行必须在
    const HL = JSON.parse(await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const qa = (s) => Array.from(document.querySelectorAll(s));
      const blk = q('.ed-canvas .ed-blk[data-blk="hero"]');
      if (!blk) return JSON.stringify({ ok: false, why: 'no-hero-block' });
      blk.click(); await sleep(460);
      const seg = '.ed-inspector .dl-style[data-style-key="heroLayout"] .seg-choice button';
      const labels = qa(seg).map((b) => (b.textContent || '').trim());
      const center = qa(seg).find((b) => /居中/.test(b.textContent || ''));
      if (center) { center.click(); await sleep(460); }
      const saved = (JSON.parse(localStorage.getItem('jmclient.detailStyle.v1') || '{}').heroLayout) || null;
      const left = qa(seg).find((b) => /左图右文/.test(b.textContent || ''));
      if (left) { left.click(); await sleep(400); }
      return JSON.stringify({ ok: true, labels, saved });
    })()`));
    console.log("  · 封面排布面板：" + JSON.stringify(HL));
    check(HL.ok === true && JSON.stringify(HL.labels) === JSON.stringify(["左图右文", "封面居中"]),
      "选中「主视觉」时出现「封面排布」两档：" + JSON.stringify(HL.labels));
    check(HL.saved === "center", "点「封面居中」→ 配置真的落盘（heroLayout=center）：" + HL.saved);
  }

  // ⑩ v3.5（用户第 4 条）：`detail` 的**形态**（标签页 / 折叠三行）与三个面板的**各自隐藏**。
  //    这里必须有两张**分开**的图，因为它们证明的是两件相反的事：
  //      · 编辑态：折叠行是死的（点它 = 选中区块），画布上看到的就是"折叠的三行"；
  //      · 预览态：点一下真的展开。
  //    文字描述说不清"同一个界面两种点击语义"，所以两张图 + 一条对照断言。
  const FE = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const T = (el) => (el ? (el.textContent || '').trim() : null);
    const qAll = (s) => Array.from(document.querySelectorAll(s));
    const detailBlk = () => qAll('.ed-canvas .ed-blk').find((b) => b.getAttribute('data-blk') === 'detail');
    const formBtn = (label) => qAll('.ed-inspector .ed-formseg button').find((b) => T(b) === label);
    detailBlk().click(); await sleep(400);
    const formRow = !!document.querySelector('.ed-inspector .ed-formseg');
    const formBtns = qAll('.ed-inspector .ed-formseg button').map(T);
    if (!formBtn('折叠三行')) return JSON.stringify({ error: '没有「折叠三行」档位', formBtns });
    formBtn('折叠三行').click(); await sleep(520);
    // 编辑态点一行：应当**只选中**，不展开
    qAll('.ed-canvas .ed-blk')[0].click(); await sleep(260);
    document.querySelector('.ed-canvas .d-fold-head').click(); await sleep(380);
    const sel = document.querySelector('.ed-canvas .ed-blk.ed-sel');
    return JSON.stringify({
      formRow, formBtns,
      rows: qAll('.ed-canvas .d-fold .d-fold-item').length,
      names: qAll('.ed-canvas .d-fold-name').map(T),
      tabsGone: !document.querySelector('.ed-canvas .d-tabs'),
      headTags: qAll('.ed-canvas .d-fold-head').map((h) => h.tagName),
      editClick: { selected: sel ? sel.getAttribute('data-blk') : null, bodies: qAll('.ed-canvas .d-fold-body').length },
      saved: (JSON.parse(localStorage.getItem('jmclient.detailLayout.v1') || '{}').forms) || {}
    });
  })()`));
  console.log("  · 折叠形态（编辑态）：" + JSON.stringify(FE));
  check(FE.formRow && FE.formBtns && FE.formBtns.join("|") === "标签页|折叠三行",
    "「形态」档位是注册表驱动的一行两个档（标签页 / 折叠三行）：" + JSON.stringify(FE.formBtns));
  check(FE.rows === 3 && FE.names && FE.names.join("|") === "目录 3 话|评论|相关漫画",
    "折叠形态：三行都在，且计数文字对（目录带话数；评论/相关没数据就不写数字）：" + JSON.stringify(FE.names));
  check(FE.tabsGone === true, "折叠形态下不再渲染横栏：" + FE.tabsGone);
  check(FE.headTags && FE.headTags.every((t) => t === "DIV"),
    "【编辑态】折叠行是静态 div（没有可点的东西，就不会和「选中区块」抢手势）：" + JSON.stringify(FE.headTags));
  check(FE.editClick.selected === "detail" && FE.editClick.bodies === 0,
    "【编辑态点击语义】点折叠行 → **选中该区块**、内容不展开：" + JSON.stringify(FE.editClick));
  check(FE.saved.detail === "folded", "折叠形态已落盘（forms.detail）：" + JSON.stringify(FE.saved));
  // 截图前把画布滚到这一块上 —— 否则 390×844 里检查器占了下半屏，
  // 拍到的是"形态档位"，**拍不到那三行本身**（第一版就是这样，图等于没拍）。
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const stage = document.querySelector('.ed-stage');
    const fold = document.querySelector('.ed-canvas .d-fold');
    if (stage && fold) {
      const st = stage.getBoundingClientRect(), ft = fold.getBoundingClientRect();
      stage.scrollTop = stage.scrollTop + (ft.top - st.top) - 16;   // 让三行贴到画布顶部
      await sleep(300);
    }
    return true;
  })()`);
  await sleep(250);
  await shot("editor-fold-edit-390");

  const FP = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const T = (el) => (el ? (el.textContent || '').trim() : null);
    const qAll = (s) => Array.from(document.querySelectorAll(s));
    const modeBtn = (label) => qAll('.ed-modeswitch button').find((b) => T(b) === label);
    modeBtn('预览').click(); await sleep(700);
    const before = qAll('.ed-canvas .d-fold-body').length;
    const headsClickable = qAll('.ed-canvas .d-fold-head').every((h) => h.tagName === 'BUTTON');
    document.querySelector('.ed-canvas .d-fold-head').click(); await sleep(480);
    const caret = document.querySelector('.ed-canvas .d-fold-caret.on');
    return JSON.stringify({
      before, headsClickable,
      open: {
        bodies: qAll('.ed-canvas .d-fold-body').length,
        dir: !!document.querySelector('.ed-canvas .d-fold-body .chap-list'),
        firstName: T(document.querySelector('.ed-canvas .d-fold-body .chap-name')),
        caretTransform: caret ? getComputedStyle(caret).transform : null
      }
    });
  })()`));
  console.log("  · 折叠形态（预览态）：" + JSON.stringify(FP));
  check(FP.headsClickable === true, "【预览态】折叠行是 button（可交互）：" + FP.headsClickable);
  check(FP.before === 0 && FP.open.bodies === 1 && FP.open.dir === true,
    "【预览态点击语义】点第一行 → 展开目录（与编辑态那条**故意相反**，这正是本功能的要点）：" + JSON.stringify(FP.open));
  check(FP.open.caretTransform && FP.open.caretTransform !== "none",
    "展开后箭头旋转（只动 transform，老内核安全）：" + FP.open.caretTransform);
  // ⚠️ 截图必须在"第一行展开"这个状态下拍 —— 下一段会点第二行来验"一次只展开一个"，
  //    先拍的话图里就是"评论展开"，读者看不到用户要的"目录那一行展开"。
  await shot("editor-fold-open-390");

  const FS = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const qAll = (s) => Array.from(document.querySelectorAll(s));
    qAll('.ed-canvas .d-fold-head')[1].click(); await sleep(420);
    return JSON.stringify({
      bodies: qAll('.ed-canvas .d-fold-body').length,
      dir: !!document.querySelector('.ed-canvas .d-fold-body .chap-list')
    });
  })()`));
  console.log("  · 折叠形态（换行展开）：" + JSON.stringify(FS));
  check(FS.bodies === 1 && FS.dir === false,
    "点第二行 → 第一行自动收起（同一时刻只展开一个）：" + JSON.stringify(FS));

  // ⑩′ 三个面板**各自可隐藏** + 只剩一个时**横栏消失**（用户第 4 条前半）
  const PN = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const T = (el) => (el ? (el.textContent || '').trim() : null);
    const qAll = (s) => Array.from(document.querySelectorAll(s));
    const modeBtn = (label) => qAll('.ed-modeswitch button').find((b) => T(b) === label);
    // 回编辑态 + 形态复位成默认（后面的用例还要用默认版面）
    modeBtn('编辑').click(); await sleep(650);
    const detailBlk = () => qAll('.ed-canvas .ed-blk').find((b) => b.getAttribute('data-blk') === 'detail');
    detailBlk().click(); await sleep(400);
    const tabsBtn = qAll('.ed-inspector .ed-formseg button').find((b) => T(b) === '标签页');
    if (tabsBtn) { tabsBtn.click(); await sleep(520); }
    const sw = (id) => {
      const r = qAll('.ed-inspector .ed-nodelist .ditem').find((d) => d.getAttribute('data-node') === id);
      return r ? r.querySelector('button.switch') : null;
    };
    sw('rel').click(); await sleep(380);
    sw('cmt').click(); await sleep(380);
    const cfg1 = JSON.parse(localStorage.getItem('jmclient.detailLayout.v1') || '{}');
    const only = {
      tabBar: !!document.querySelector('.ed-canvas .d-tabs'),
      dirBody: !!document.querySelector('.ed-canvas .chap-list'),
      hidden: cfg1.hidden
    };
    // 点最后一个（目录）→ 必须**被拒绝**，并且**给出一行说明**
    sw('dir').click(); await sleep(380);
    const refuseEl = document.querySelector('.ed-inspector .ed-refuse');
    const cfg2 = JSON.parse(localStorage.getItem('jmclient.detailLayout.v1') || '{}');
    const refuse = { hiddenAfter: cfg2.hidden, text: T(refuseEl) };
    return JSON.stringify({ only, refuse, formsAfterReset: cfg2.forms });
  })()`));
  console.log("  · 面板显隐：" + JSON.stringify(PN));
  check(PN.formsAfterReset && !PN.formsAfterReset.detail, "形态已复位成默认（不把这份改动留给后面的用例）：" + JSON.stringify(PN.formsAfterReset));
  check(PN.only.tabBar === false && PN.only.dirBody === true,
    "隐藏「评论 + 相关漫画」后：只剩目录、**横栏消失**（一个标签的横栏白占一行）：" + JSON.stringify(PN.only));
  check(PN.refuse.hiddenAfter && PN.refuse.hiddenAfter.indexOf("dir") < 0 && PN.refuse.text,
    "【至少留一个】点最后一个面板被拒（配置没变）**并且给出一行说明**（不是静默吞掉）：" + JSON.stringify(PN.refuse));
  // 同样要滚到这一块上：这一张图要证明的是"**横栏没了**、目录面板照常"，
  // 拍不到画布就等于什么都没证明（第一版就是这个问题）。
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const stage = document.querySelector('.ed-stage');
    const dir = document.querySelector('.ed-canvas .chap-list');
    if (stage && dir) {
      const st = stage.getBoundingClientRect(), dt = dir.getBoundingClientRect();
      stage.scrollTop = stage.scrollTop + (dt.top - st.top) - 16;
      await sleep(300);
    }
    return true;
  })()`);
  await sleep(250);
  await shot("editor-panel-only-dir-390");

  // 复原：三个面板都打开
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const qAll = (s) => Array.from(document.querySelectorAll(s));
    const sw = (id) => {
      const r = qAll('.ed-inspector .ed-nodelist .ditem').find((d) => d.getAttribute('data-node') === id);
      return r ? r.querySelector('button.switch') : null;
    };
    const a = sw('cmt'); if (a) { a.click(); await sleep(350); }
    const b = sw('rel'); if (b) { b.click(); await sleep(400); }
    return true;
  })()`);
  await sleep(300);

  // ⑩ 拖动中（两框刚咬住）—— 用户第 6 条的手感证据：坑已经跟着手动了一格，镜像浮着
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const s = document.querySelector('.ed-stage'); if (s) s.scrollTop = 0;
    const blk = document.querySelector('.ed-canvas .ed-blk[data-blk="desc"]') || document.querySelectorAll('.ed-canvas .ed-blk')[0];
    const r = blk.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const pt = (type, y) => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: y });
      Object.defineProperty(ev, 'pointerType', { value: 'touch' });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      blk.dispatchEvent(ev);
    };
    pt('pointerdown', cy);
    await sleep(420);                 // 过长按阈值
    pt('pointermove', cy + 40);       // 往下推 —— 咬住下面那块
    await sleep(260);
    window.__dragHeld = { pt: pt, cy: cy };
    return true;
  })()`);
  await sleep(200);
  await shot("editor-drag-contact-390");
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const h = window.__dragHeld;
    if (h) { h.pt('pointerup', h.cy + 40); delete window.__dragHeld; }
    await sleep(400);
    return true;
  })()`);

  // ⑨ v3.6：**「改过」圆点搬到了页名分段控件上**（旧版挂在卡片下方，peek 模式下会被裁掉）。
  //    做法：把列表页配置写成非默认、同时把详情页**清回默认** → 关掉编辑器 → 重新进画廊
  //    → 圆点必须只出现在改过的那一格。**两页都要有对照**才算判别性用例：
  //    这一轮前面已经把详情页改得面目全非，如果不清回默认，两格都会是圆点 —— 那就分不出
  //    "圆点跟着改过走"和"圆点永远亮着"（第一次跑就是这样，一条假绿差点混过去）。
  await evalJs(`(() => {
    localStorage.setItem('jmclient.listLayout.v1', JSON.stringify({ version: 1, fields: ['author', 'sub', 'category'], hidden: [], columns: '2' }));
    localStorage.removeItem('jmclient.detailLayout.v1');
    localStorage.removeItem('jmclient.detailStyle.v1');
    return 'ok';
  })()`);
  const DOT = JSON.parse(await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s); const qa = (s) => Array.from(document.querySelectorAll(s));
    for (let k = 0; k < 2; k++) { const b = q('.ed-top .ed-back'); if (b) { b.click(); await sleep(800); } }
    if (q('.ed-page')) return JSON.stringify({ ok: false, why: 'editor-still-open' });
    q('.menu-btn').click(); await sleep(700);
    // v3.13：抽屉里那条入口已删除 —— 唯一入口在设置页（那张 section 一直渲染着）
    const entry = qa('.settings-page .grow').find((b) => /自定义 UI/.test(b.textContent || ''));
    if (!entry) return JSON.stringify({ ok: false, why: 'no-entry' });
    entry.click(); await sleep(1400);
    const tabs = qa('.ed-galtabs > button');
    return JSON.stringify({
      ok: !!q('.ed-gallery'),
      dots: tabs.map((t) => !!t.querySelector('.dl-dot')),
      defs: tabs.map((t) => !!t.querySelector('.ed-carddefault')),
      /** 圆点与胶囊的**实际颜色**：7px 的圆点若与深色胶囊同色，肉眼看不见而"元素在"照样为真 */
      dotBg: tabs.map((t) => { const d = t.querySelector('.dl-dot'); return d ? getComputedStyle(d).backgroundColor : null; }),
      tabBg: tabs.map((t) => getComputedStyle(t).backgroundColor),
      names: tabs.map((t) => t.textContent.replace(/\\s+/g, ' ').trim())
    });
  })()`));
  console.log("  · 改过标记（分段控件上的圆点）：" + JSON.stringify(DOT));
  check(DOT.ok === true, "改过列表页配置后能重新进画廊：" + JSON.stringify(DOT));
  check(DOT.dots[0] === true && DOT.dots[1] === false && DOT.defs[0] === false && DOT.defs[1] === true,
    "**改过的那页带圆点、没改的没有**（v3.6：圆点跟着页名走，不再挂在会被裁掉的卡名下）：dots=" + JSON.stringify(DOT.dots) + " defs=" + JSON.stringify(DOT.defs));
  check(!!DOT.dotBg[0] && DOT.dotBg[0] !== DOT.tabBg[0],
    "活动页上的圆点与深色胶囊**不同色**（同色＝在深底上看不见，只有看图才发现）：dot=" + DOT.dotBg[0] + " pill=" + DOT.tabBg[0]);
  await shot("gallery-changed-390");

  console.log("\n== 截图产出 ==");
  for (const s of shots) console.log("  " + s.name + "  " + s.bytes + " B");
  console.log("  目录：" + SHOTS);
  console.log("\n== 小结 ==");
  console.log("  通过 " + pass + " 项，失败 " + fail.length + " 项");
  for (const f of fail) console.log("  ✗ " + f);
  try { ws.close(); } catch { /* 忽略 */ }
  try { edge.kill(); } catch { /* 忽略 */ }
  process.exit(fail.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("驱动异常: " + (e && e.message ? e.message : e));
  try { edge.kill(); } catch { /* 忽略 */ }
  process.exit(1);
});
