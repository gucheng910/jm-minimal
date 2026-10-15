// 「自定义 UI」v3.2 **外壳**验证（独立 CDP 脚本）：画廊屏 / 缩略图 / 返回键分层 / 宽屏预览。
//
// 为什么又单独一个脚本（和 slot-layout.mjs 同理）：
//   ① `driver.js` 跑在**页面里**（Runtime.evaluate），改不了视口 —— 而「宽屏预览」的全部意义
//      就是**窄视口**下也能看见并排（≤399px 时窄屏降级会把并排压成堆叠）。用默认视口跑，
//      开不开开关一模一样，断言会变成"永远通过"的绿灯发生器。
//   ② 外壳是**屏与屏之间**的契约（画廊↔编辑↔关闭），driver.js 只覆盖编辑屏内部。
//
// 用例：
//   ① 进入编辑器 → 停在**画廊屏**：顶栏标题=自定义 UI、**四张**卡片、**没有** .ed-bar（哑控件已删）、
//      还不在编辑屏（没有 .ed-canvas）
//   ② 缩略图：**当前最前的那张**必须 `data-ready=1`（v3.13 起四页，懒挂载 ⇒ 没进视口的不渲染，
//      （"所见即所得"的前提：算错就只露一角或被裁一半）
//   ③ 点「详情页」卡片 → 进编辑屏：.ed-canvas 出现、.ed-gallery 消失、标题变成**页名**
//   ④ 「‹ 返回」→ 回画廊（**编辑器没被关掉**：.ed-page 还在）
//   ⑤ 再返回 → 编辑器关闭（.ed-page 消失）
//   ⑥ **系统返回键分层**（jm:back）：编辑屏 → 回画廊；画廊 → 关闭（单一处理函数，不靠注册顺序）
//   ⑦ **「宽屏预览」的几何证明**：两块设 1/2 → 窄视口(380) 默认**堆叠** → 打开开关 → **并排**
//      → 关掉 → 又堆叠（这正是替换掉的那个哑控件「窄/标准/宽」做不到的事）
//
// 用法（**用 pwsh 跑**，git-bash 里起不来浏览器；先自己起好 server）：
//   node node_modules/vite/bin/vite.js --port 5199 --strictPort      # 另开一个
//   TEST_URL=http://127.0.0.1:5199/ node tools/e2e/editor-gallery.mjs
//   注：dev server 会被并发写文件搞崩（chokidar EBUSY），可改用无监听的
//       `npx vite build --outDir dist-gallery` + `npx vite preview --outDir dist-gallery`。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.TEST_URL || "http://127.0.0.1:5199/";
const PORT = Number(process.env.E2E_PORT || 9338);
const PROFILE = path.join(os.tmpdir(), "jm-e2e-profile-gallery");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!EDGE) { console.error("找不到 Edge，请用 EDGE_PATH 指定"); process.exit(2); }

// 残留 profile 会带着上一轮的配置进来 → 从干净的开始
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

/** 视口：窄视口要带 mobile/hasTouch，否则媒体查询与触摸路径都不成立 */
const setViewport = (width, height) => send("Emulation.setDeviceMetricsOverride", {
  width, height, deviceScaleFactor: 1, mobile: width < 500, hasTouch: width < 500
});

/** 画廊屏 + 外壳的观测（一次拿全，省得反复求值） */
const SHELL = `(() => {
  const T = (el) => (el ? (el.textContent || '').trim() : null);
  const cards = Array.from(document.querySelectorAll('.ed-gallery .ed-card'));
  const page = document.querySelector('.ed-page');
  const h2 = document.querySelector('.ed-top h2');
  return {
    screen: page ? page.getAttribute('data-screen') : null,
    title: T(h2),
    hasBar: !!document.querySelector('.ed-bar'),
    hasGallery: !!document.querySelector('.ed-gallery'),
    hasCanvas: !!document.querySelector('.ed-canvas'),
    /** v3.6：peek 模式下**页名在轨道上方的分段控件里**（旧版挂在卡片下方、会被裁成半截） */
    mode: (() => { const g = document.querySelector('.ed-gallery'); return g ? g.getAttribute('data-mode') : null; })(),
    tabs: Array.from(document.querySelectorAll('.ed-galtabs > button')).map((t) => ({
      name: T(t),
      active: t.getAttribute('data-active'),
      changed: !!t.querySelector('.dl-dot'),
      def: !!t.querySelector('.ed-carddefault')
    })),
    cards: cards.map((c) => {
      const outer = c.querySelector('.ed-thumb');
      const inner = c.querySelector('.ed-thumb-inner');
      /**
       * ⚠️ 用 offsetWidth / offsetHeight（**布局值**）而不是 getBoundingClientRect()。
       * v3.6 起卡片是"单轨 peek 轮播"：位置由外层 translate3d 驱动、尺寸不变，
       * 但缩略图内部仍是 transform: scale()，rect 返回的是**视觉**宽度，拿它去比
       * k = 卡宽/390 会得出"缩略图算小了"的错误结论 —— 这正是 PageThumb 实现里
       * 改掉的那个"双重缩放"坑，断言必须与实现同源，否则测的不是真实契约。
       * （本段在模板字符串里，所以注释内不能出现反引号。）
       */
      const ow = outer ? outer.offsetWidth : 0;
      const oh = outer ? outer.offsetHeight : 0;
      const rectW = outer ? Math.round(outer.getBoundingClientRect().width) : 0;
      let scale = null;
      if (inner) {
        const m = getComputedStyle(inner).transform;
        const mm = m && m.match(/matrix\\(([^,]+)/);
        scale = mm ? Number(mm[1]) : null;
      }
      return {
        page: c.getAttribute('data-page'),
        name: T(c.querySelector('.ed-cardname')),
        changed: !!c.querySelector('.ed-cardname .dl-dot'),
        def: !!c.querySelector('.ed-carddefault'),
        /** v3.13：四张卡里只有**轮到前面**的才在视口内 —— PageThumb 是懒挂载（IntersectionObserver），
         *  所以"ready=1"只对 data-front="1" 的那一张是必须的。 */
        front: c.getAttribute('data-front'),
        ready: outer ? outer.getAttribute('data-ready') : null,
        w: Math.round(ow), h: Math.round(oh), rectW: rectW, scale: scale,
        hasPage: !!(inner && inner.children.length > 0)
      };
    })
  };
})()`;

/** 画布上两个块的几何（与 slot-layout.mjs 同一判据，便于横向对照） */
const GEO = `(() => {
  const card = document.querySelector('.ed-canvas .detail-card');
  const blk = (id) => document.querySelector('.ed-canvas .ed-blk[data-blk="' + id + '"]');
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { top: Math.round(b.top), left: Math.round(b.left), w: Math.round(b.width) }; };
  const a = blk('actors'), t = blk('tags');
  return {
    slotted: card ? card.getAttribute('data-slots') : null,
    widePreview: !!document.querySelector('.ed-canvas.ed-preview-wide'),
    chipOn: (() => { const c = document.querySelector('.ed-top .ed-widechip'); return c ? c.getAttribute('aria-pressed') : null; })(),
    card: box(card), actors: box(a), tags: box(t)
  };
})()`;

/** 点选某块 → 在检查器的「宽度」一行点某个档位（真用户路径） */
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

const sideBySide = (g) => {
  if (!g.actors || !g.tags) return false;
  const sameRow = Math.abs(g.actors.top - g.tags.top) <= 3;
  const diffCol = Math.abs(g.actors.left - g.tags.left) > 40;
  const halfish = g.actors.w < g.card.w * 0.62 && g.tags.w < g.card.w * 0.62;
  return sameRow && diffCol && halfish;
};
/** v3.3：`stacked()` 判据**已随窄屏降级一起删除**（任何视口下都必须是并排）。 */

/** 系统返回键：与各 driver 同一套派发方式（bus.emit 就是 window.dispatchEvent） */
const pressBack = `(() => { window.dispatchEvent(new CustomEvent('jm:back', { detail: { consumed: false } })); return true; })()`;

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
  await setViewport(420, 900);
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

  const result = {};

  // 打开「自定义 UI」
  // ⚠️ v3.13：抽屉里那条入口已按用户要求删除 —— 现在唯一入口在**设置页最上方**
  //    （设置那张 section 一直渲染着，非设置 tab 时挂 `view-hidden`；这里刻意**不切 tab**，
  //     免得把首页那个 ContentView 卸载重挂。真实用户路径由 driver-chrome ⑦ 那条驱动钉。）
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

  // ── 用例 ① 画廊屏：进入后停在"选择页面"，而不是直接进编辑 ──────────────
  const s0 = await evalJs(SHELL);
  result.gallery = s0;
  check(s0.screen === "gallery", "进入自定义 UI 后应停在画廊屏（data-screen=gallery）：" + s0.screen);
  check(s0.title === "自定义 UI", "画廊屏顶栏标题应是「自定义 UI」：" + s0.title);
  check(s0.hasGallery && !s0.hasCanvas, "画廊屏应有 .ed-gallery 且尚未进编辑屏：gallery=" + s0.hasGallery + " canvas=" + s0.hasCanvas);
  check(!s0.hasBar, "那条哑控件控制条（.ed-bar）应已删除：" + s0.hasBar);
  check(s0.cards.length === 4, "应有四张页面卡片（v3.13 从两个扩到四个）：" + s0.cards.length);
  check(JSON.stringify(s0.cards.map((c) => c.page)) === JSON.stringify(["list", "detail", "chrome", "reader"]),
    "卡片应覆盖 列表页/详情页/顶栏和底栏/阅读器：" + JSON.stringify(s0.cards.map((c) => c.page)));
  // v3.6：页名从"卡片下方"搬到"轨道上方的分段控件" —— 因为 peek 模式下后卡只露 48px，
  // 挂在卡下的名字会被裁成半截（旧版截图里就是「默认」孤零零露在外面）。
  // 这两条是**新增判据**：不滑动时两页名字都可见 + 当前页高亮。
  check(s0.tabs.length === 4 && /列表页/.test(s0.tabs[0].name) && /阅读器/.test(s0.tabs[3].name),
    "【v3.6】四页名字**不滑动时就都可见**（分段控件）：" + JSON.stringify(s0.tabs.map((t) => t.name)));
  check(s0.tabs[0].active === "1" && s0.tabs[1].active === "",
    "【v3.6】当前页在分段控件里高亮：" + JSON.stringify(s0.tabs.map((t) => t.active)));
  check(s0.mode === "peek", "【v3.6】手机视口下画廊是 peek 轮播（宽屏才切两栏）：mode=" + s0.mode);

  // ── 用例 ② 缩略图：真实渲染已接管 + 比例盒 + 缩放比 ────────────────────
  const n0 = await sleep(900); // 懒挂载/量宽完成后才置 data-ready
  void n0;
  const s1 = await evalJs(SHELL);
  result.thumbs = s1.cards;
  /**
   * ⚠️ v3.13：页面从 2 张变 4 张，而缩略图是**懒挂载**的（进视口才 `data-ready=1`）。
   * peek 轮播一次只在视口里放两张（前卡 + 露边的后卡），所以"每张都必须 ready"这条
   * 从"产品契约"变成了"要求没进视口的卡也渲染" —— 那是错的断言（会逼着我们关掉懒挂载）。
   * 改成：**当前在最前的那张必须 ready**（它一定在视口内），并至少两张已接管。
   */
  const frontCards = s1.cards.filter((c) => c.front === "1");
  const readyCards = s1.cards.filter((c) => c.ready === "1" && c.hasPage);
  check(frontCards.length > 0 && frontCards.every((c) => c.ready === "1" && c.hasPage),
    "当前最前的那张缩略图必须由真实渲染接管：" + JSON.stringify(frontCards.map((c) => [c.page, c.ready, c.hasPage])));
  check(readyCards.length >= 2, "至少两张缩略图已真实渲染（懒挂载的视口内那两张）：" + readyCards.length);
  for (const c of s1.cards) {
    check(Math.abs(c.h / c.w - 1.5) <= 0.06, "「" + c.page + "」缩略图比例盒应为 1.5（高度≈宽度×1.5，WebView 57 没有 aspect-ratio）：" + c.h + "x" + c.w);
    if (c.ready !== "1") continue;   // 还没进视口的卡没有 scale 可言（懒挂载期间渲染的是骨架）
    check(c.scale !== null && Math.abs(c.scale - Math.min(1, c.w / 390)) <= 0.03,
      "「" + c.page + "」缩放比应≈卡片**布局宽**/390（设计宽 390，上限 1）：scale=" + c.scale +
      " 期望≈" + Math.min(1, c.w / 390).toFixed(3) + "（布局宽 " + c.w + " / 视觉宽 " + c.rectW + "）");
  }

  // ── 用例 ③ 点卡片 → 进编辑屏 ─────────────────────────────────────────
  await evalJs(`document.querySelector(".ed-gallery .ed-card[data-page='detail']").click()`);
  await sleep(800);
  const s2 = await evalJs(SHELL);
  result.editor = s2;
  check(s2.screen === "editor" && s2.hasCanvas && !s2.hasGallery, "点「详情页」卡片应进入编辑屏：screen=" + s2.screen);
  check(s2.title === "详情页", "编辑屏标题应变成当前页名：「详情页」，实际=" + s2.title);

  // ── 用例 ④/⑤ 返回分层：编辑屏 → 画廊（编辑器没关）→ 关闭 ──────────────
  await evalJs(`document.querySelector('.ed-back').click()`);
  await sleep(600);
  const s3 = await evalJs(SHELL);
  result.backToGallery = { screen: s3.screen, title: s3.title, stillOpen: !!s3.screen };
  check(s3.screen === "gallery", "编辑屏点返回应回到画廊（而不是关掉编辑器）：" + s3.screen);
  check(s3.title === "自定义 UI", "回画廊后标题应还原成「自定义 UI」：" + s3.title);

  await evalJs(`document.querySelector('.ed-back').click()`);
  await sleep(700);
  const closed = await evalJs(`!document.querySelector('.ed-page')`);
  check(closed === true, "画廊屏点返回才关闭编辑器（.ed-page 消失）");

  // ── 用例 ⑥ 系统返回键分层（jm:back）──────────────────────────────────
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s); const qa = (s) => Array.from(document.querySelectorAll(s));
    qa('.settings-page .grow').find((b) => /自定义 UI/.test(b.textContent || '')).click(); await sleep(1400);
    return !!q('.ed-gallery');
  })()`);
  await evalJs(`document.querySelector(".ed-gallery .ed-card[data-page='detail']").click()`);
  await sleep(700);
  check(await evalJs(`!!document.querySelector('.ed-canvas')`) === true, "系统返回键用例前置：已在编辑屏");
  await evalJs(pressBack);
  await sleep(600);
  const b1 = await evalJs(`(function(){ var p = document.querySelector('.ed-page'); return { open: !!p, screen: p ? p.getAttribute('data-screen') : null }; })()`);
  result.backKey1 = b1;
  check(b1.open && b1.screen === "gallery", "系统返回键在编辑屏 → 回画廊（编辑器仍开着）：" + JSON.stringify(b1));
  await evalJs(pressBack);
  await sleep(700);
  check(await evalJs(`!document.querySelector('.ed-page')`) === true, "系统返回键在画廊 → 关闭编辑器");

  // ── 用例 ⑦（v3.3 反转）窄视口下**仍然并排** + 「宽屏」开关已删除 ──────
  //
  //    v3.2 这里验的是"窄视口默认堆叠 → 开「宽屏预览」才并排"。
  //    v3.3 用户否掉了整套宽窄屏概念（第 3 条：「不要什么宽屏窄屏的限制了，
  //    直接默认认为都是宽屏」），降级链路与那个开关一起删除 —— 所以现在
  //    **任何视口下都并排**，且顶栏不该再有「宽屏」按钮。判据反转，不是放宽。
  await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s); const qa = (s) => Array.from(document.querySelectorAll(s));
    qa('.settings-page .grow').find((b) => /自定义 UI/.test(b.textContent || '')).click(); await sleep(1400);
    q(".ed-gallery .ed-card[data-page='detail']").click(); await sleep(800);
    return true;
  })()`);
  await sleep(500);
  const sp1 = await evalJs(setSpan("actors", "1/2"));
  const sp2 = await evalJs(setSpan("tags", "1/2"));
  check(sp1 === "ok" && sp2 === "ok", "把两块设成 1/2（走检查器控件）：" + sp1 + "/" + sp2);
  await sleep(400);

  await setViewport(380, 760);
  await sleep(700);
  const g1 = await evalJs(GEO);
  result.narrowSideBySide = g1;
  check(g1.slotted === "1", "设了半宽 → 容器应有 data-slots=1：" + g1.slotted);
  check(g1.widePreview === false && g1.chipOn === null,
    "顶栏的「宽屏」按钮已删除（chip 读数为 null）：class=" + g1.widePreview + " chip=" + g1.chipOn);
  check(sideBySide(g1), "窄视口(380)下两块**直接并排**（不再需要任何开关，降级已取消）：" + JSON.stringify(g1));

  // 回到宽视口 → 仍是并排（两种视口同一个答案：这正是"取消宽窄屏限制"的含义）
  await setViewport(1000, 800);
  await sleep(700);
  const g2 = await evalJs(GEO);
  result.wideViewport = g2;
  check(sideBySide(g2), "宽视口下同样并排：" + JSON.stringify(g2));

  // 红线：窄屏降级用的门控属性不该再出现在任何详情页元素上
  const leak = await evalJs(`document.querySelectorAll('[data-narrow-stack], .ed-preview-wide').length`);
  check(leak === 0, "data-narrow-stack / .ed-preview-wide 都已从渲染里彻底消失：" + leak);

  // ── 用例 ⑧ 页面设置：独立一屏 + 开/关它**不丢画布状态**（用户第 8 条 / v3.3 F-5）──
  //
  //    为什么不放在 editor-shell 里就够：那一条验的是 DOM 结构（覆盖层存在、画布 top 不变），
  //    而"滚动位置与选中态不丢"需要一个能**真的滚动画布**并读回 scrollTop 的驱动 ——
  //    这正是本脚本（可改视口）存在的意义。旧实现把面板渲染进检查器里，一唤出就把画布顶上去，
  //    这两条断言在旧实现下必红（负控制成立）。
  const selNow = `(() => { const e = document.querySelector('.ed-canvas .ed-blk.ed-sel, .ed-canvas .ed-slot.ed-sel'); return e ? e.getAttribute('data-blk') : null; })()`;
  const sheet = await evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const stage = document.querySelector('.ed-stage');
    const canvas = document.querySelector('.ed-canvas');
    const sel = ${selNow};
    stage.scrollTop = 60;                       // 先滚一段，才能验"开关面板不重置滚动"
    await sleep(260);
    const before = { top: Math.round(canvas.getBoundingClientRect().top), scroll: Math.round(stage.scrollTop), sel };
    document.querySelector('.ed-more').click(); await sleep(340);
    const item = Array.from(document.querySelectorAll('.ed-menu .ed-menuitem')).find(x => /页面设置/.test(x.textContent || ''));
    if (!item) return JSON.stringify({ err: 'no-item' });
    item.click(); await sleep(460);
    const page = document.querySelector('.ed-sheetpage');
    const pr = page ? page.getBoundingClientRect() : null;
    const mid = {
      sheet: !!page,
      panel: page ? page.getAttribute('data-panel') : null,
      hasDone: !!document.querySelector('.ed-sheetpage .ed-paneldone'),
      coversW: pr ? Math.round(pr.width) : 0,
      coversH: pr ? Math.round(pr.height) : 0,
      canvasTop: Math.round(canvas.getBoundingClientRect().top)
    };
    const done = document.querySelector('.ed-sheetpage .ed-paneldone');
    if (done) { done.click(); await sleep(360); }
    const after = {
      sheet: !!document.querySelector('.ed-sheetpage'),
      top: Math.round(canvas.getBoundingClientRect().top),
      scroll: Math.round(stage.scrollTop),
      sel: ${selNow},
      inspector: !!document.querySelector('.ed-inspector')
    };
    return JSON.stringify({ before, mid, after });
  })()`);
  const pageSheet = JSON.parse(sheet);
  result.pageSheet = pageSheet;
  check(pageSheet.mid && pageSheet.mid.sheet === true && pageSheet.mid.panel === "style" && pageSheet.mid.hasDone === true &&
        pageSheet.mid.canvasTop === pageSheet.before.top,
    "页面设置是**独立一屏**（.ed-sheetpage 自带「完成」）且**没有把画布顶上去**：" + JSON.stringify(pageSheet.mid));
  check(pageSheet.after && pageSheet.after.sheet === false && pageSheet.after.scroll === pageSheet.before.scroll &&
        pageSheet.after.sel === pageSheet.before.sel && pageSheet.after.inspector === true,
    "关掉页面设置后，画布的**滚动位置与选中态都没丢**（不换 screen 的收益）：" + JSON.stringify(pageSheet.after));

  console.log(JSON.stringify(result, null, 1));
  if (fail.length) { console.log("\n失败项："); for (const f of fail) console.log("  ✗ " + f); process.exitCode = 1; }
  else console.log("\n✓ 外壳验证全部通过（" + pass + " 项）：画廊屏 / 缩略图 / 两层返回 / 宽屏预览几何");
}

main().catch((e) => { console.log("FAIL:", e.message); process.exitCode = 1; }).finally(() => {
  try { if (ws) ws.close(); } catch { /* 忽略 */ }
  // 只杀自己起的这棵树（两条纪律见 slot-layout.mjs：先核对 PID 现在还是不是 msedge；
  // 兜底只按**本次专属 profile 路径**匹配，绝不按镜像名杀浏览器）
  try {
    if (edge.pid) {
      const who = spawnSync("powershell", ["-NoProfile", "-Command",
        "(Get-Process -Id " + edge.pid + " -ErrorAction SilentlyContinue).ProcessName"], { encoding: "utf8" });
      if (String(who.stdout || "").trim().toLowerCase() === "msedge") {
        spawnSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
      }
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
