// 「自定义 UI」画布拖拽的**手感测量探针**（不是关卡，是一把尺子）。
//
// 与 touch-drag.mjs 的分工：
//   touch-drag.mjs  问"拖拽能不能活下来"（pass/fail）。
//   本脚本       问"拖起来手感到底差多少"——把四个可观测的量变成数字：
//     ① 跟手滞后：每一帧 `期望镜像位置（指针 − 抓取偏移）` 与 `实际镜像位置` 之差（px）；
//     ② 抖动：相邻帧镜像位移的噪声（零位移帧数、反向帧数、标准差）；
//     ③ 换向成本：往一个方向连拖若干格后反向，**手指要走多少像素**才换来第一格；
//     ④ 坑（.ed-drag）是连续移动还是瞬移/补间（每帧位移序列 + 停住帧数）。
//
// 为什么要"在页面里"采样而不是从 Node 每步读一次：CDP 往返有 20~40ms 抖动，
// 逐帧读会把测量噪声混进被测对象。做法是页面内 rAF 循环把每帧状态压进数组，
// 拖动结束后一次性取回，在 Node 侧分析。
//
// 用法（**用 pwsh 跑**；先起好 server，推荐 preview 无文件监听）：
//   npx vite build --outDir dist-feel
//   npx vite preview --outDir dist-feel --port 5199 --strictPort
//   TEST_URL=http://127.0.0.1:5199/ node tools/e2e/feel-probe.mjs
// 输出：JSON（`result`）+ 一张人读的摘要表。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.TEST_URL || "http://127.0.0.1:5199/";
const PORT = Number(process.env.E2E_PORT || 9341);
const PROFILE = path.join(os.tmpdir(), "jm-e2e-profile-feelprobe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每一步的位移（px）与步间等待（ms）—— 决定"拖动速度"这一自变量 */
const STEP = Number(process.env.FEEL_STEP || 8);
const STEP_WAIT = Number(process.env.FEEL_WAIT || 16);
/** 第一阶段往一个方向走多少步（要够跨 2~3 个块） */
const UP_STEPS = Number(process.env.FEEL_UP || 45);
/** 第二阶段反向走多少步（测换向成本） */
const DOWN_STEPS = Number(process.env.FEEL_DOWN || 60);

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!EDGE) { console.error("找不到 Edge，请用 EDGE_PATH 指定"); process.exit(2); }

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
  if (r.exceptionDetails) throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result && r.result.value;
};
const touch = (type, x, y) => send("Input.dispatchTouchEvent", {
  type,
  touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1 }]
});

/** 页面内探针：记录真实指针坐标 + 事件计数 + 每帧镜像/坑/顺序快照 */
const FEEL_HOOK = `(() => {
  if (window.__feelHooked) return true;
  window.__feelHooked = 1;
  window.__pt = { x: 0, y: 0, t: 0 };
  window.__tm = 0;   // touchmove 计数
  window.__pmc = 0;  // pointermove 计数（触摸路径上两者可能都在推进我们的状态）
  document.addEventListener('touchmove', (e) => {
    const t = e.touches && e.touches[0];
    if (t) window.__pt = { x: t.clientX, y: t.clientY, t: performance.now() };
    window.__tm++;
  }, { passive: true, capture: true });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') { window.__pmc++; }
    window.__pt = { x: e.clientX, y: e.clientY, t: performance.now() };
  }, { passive: true, capture: true });
  window.__feelStart = (grab) => {
    window.__feel = { t0: 0, grab, samples: [] };
    const t0 = performance.now();
    window.__feel.t0 = t0;
    let frames = 0;
    const rec = () => {
      const g = document.querySelector('.ed-canvas .ed-ghost');
      const m = g ? /translate\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px\\)/.exec(g.style.transform || '') : null;
      const hole = document.querySelector('.ed-canvas .ed-blk.ed-drag');
      const s = window.__feel.samples;
      // 坑的几何只在偶数帧读一次：读 offsetTop/rect 会强制布局，测太勤会把被测对象拖慢
      const wantHole = frames % 2 === 0;
      s.push({
        t: Math.round(performance.now() - t0),
        gx: m ? +m[1] : null,
        gy: m ? +m[2] : null,
        px: Math.round(window.__pt.x),
        py: Math.round(window.__pt.y),
        pt: Math.round(window.__pt.t - t0),
        tm: window.__tm,
        pmc: window.__pmc,
        // 布局位置（不含 transform）：换位时会**瞬移**，这是"坑跳了多少格"
        holeTop: (wantHole && hole) ? Math.round(hole.offsetTop) : null,
        // **视觉**位置（含 FLIP 在飞的 transform）：用来判断动画有没有被打断
        //   —— 瞬移到终点 = 单帧位移 ≈ 整个格位差；平滑 = 分十来帧走完
        holeVisTop: (wantHole && hole) ? Math.round(hole.getBoundingClientRect().top * 10) / 10 : null,
        // 换位瞬间有多少个 transform 过渡在同时播（FLIP 每次换位会给"坑以下所有块"各挂一段）
        anims: wantHole && document.getAnimations ? document.getAnimations().length : null,
        drag: hole ? 1 : 0,
        order: Array.from(document.querySelectorAll('.ed-canvas .ed-blk'))
          .map((e) => e.getAttribute('data-blk')).join('|')
      });
      frames++;
      if (s.length < 2000) requestAnimationFrame(rec);
    };
    requestAnimationFrame(rec);
  };
  window.__feelRead = () => window.__feel;
  // 长任务（>50ms 的主线程阻塞）：桌面 CPU 上出现的每一毫秒，在中端安卓上都要放大。
  // 换位会重渲染整棵详情树 + FLIP 全量测量，所以这是"抖动/掉帧"最直接的可观测量。
  window.__long = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__long.push({ t: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* 老内核没有 longtask，忽略 */ }
  return true;
})()`;

/**
 * 60Hz rAF 仿真（`FEEL_RAF60=1` 打开）。
 *
 * 为什么必须有它：headless（`--headless=new --disable-gpu`）里 **rAF 不被 vsync 节流**，
 * 实测跑出 100~200fps。而本实现的跟手是"**每帧**逼近 35%"的缓动，帧越多收敛越快 ——
 * 于是无头环境下"跟手滞后"被测成 1~3px，与真机 60Hz 的观感**没有关系**。
 * 这就是"e2e 全绿但用户说发飘"的结构性原因（同类坑：合成事件不过手势仲裁）。
 *
 * 这里把 rAF 换成"每次至少隔 16.7ms 才派发"的等价实现，模拟 60Hz 设备的帧节奏。
 * 它不改被测代码，只改**帧率**这一个自变量的环境。
 */
const RAF60 = `(() => {
  if (window.__raf60) return true;
  window.__raf60 = 1;
  const LOOP = 1000 / 60;
  const q = [];
  let n = 0, ticking = false;
  const tick = (now) => {
    ticking = false;
    const due = q.splice(0, q.length);
    for (const it of due) { try { it.cb(now); } catch (e) { /* 别让一个回调打断整帧 */ } }
    if (q.length) schedule();
  };
  const schedule = () => { if (ticking) return; ticking = true; setTimeout(() => tick(performance.now()), LOOP); };
  window.requestAnimationFrame = (cb) => { const id = ++n; q.push({ id, cb }); schedule(); return id; };
  window.cancelAnimationFrame = (id) => { const i = q.findIndex((x) => x.id === id); if (i >= 0) q.splice(i, 1); };
  return true;
})()`;

/** 挑一个**在可视区内、且中心不压内嵌槽位**的顶层块（滚回顶部后挑） */
const GEO = `(() => {
  const s = document.querySelector('.ed-stage');
  if (s) s.scrollTop = 0;
  const stage = s ? s.getBoundingClientRect() : null;
  const all = Array.from(document.querySelectorAll('.ed-canvas .ed-blk'));
  const visible = all.filter((el) => {
    const r = el.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    return stage && cy > stage.top + 4 && cy < stage.bottom - 4;
  });
  const prefer = ['desc', 'action', 'actors', 'tags', 'detail'];
  let blk = null;
  for (const id of prefer) { const f = visible.find((e) => e.getAttribute('data-blk') === id); if (f) { blk = f; break; } }
  if (!blk) blk = visible[0] || all[0];
  if (!blk) return null;
  const r = blk.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return {
    x: cx, y: cy,
    left: Math.round(r.left), top: Math.round(r.top),
    w: Math.round(r.width), h: Math.round(r.height),
    name: blk.getAttribute('data-blk'),
    overNested: !!((hit || {}).closest && hit.closest('.ed-slot')),
    visibleCount: visible.length, total: all.length
  };
})()`;

const READ = `(() => ({
  drag: document.querySelectorAll('.ed-canvas .ed-blk.ed-drag').length,
  ghost: document.querySelectorAll('.ed-canvas .ed-ghost').length,
  order: Array.from(document.querySelectorAll('.ed-canvas .ed-blk')).map((e) => e.getAttribute('data-blk')).join('|')
}))()`;

const result = { config: { STEP, STEP_WAIT, UP_STEPS, DOWN_STEPS } };

function stats(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    min: +s[0].toFixed(2),
    p50: +q(0.5).toFixed(2),
    p90: +q(0.9).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    mean: +mean.toFixed(2)
  };
}

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
  // 390×700 = 用户实机（390 宽）的量级；hasTouch 必须开，否则 React 不挂触摸监听
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 700, deviceScaleFactor: 2, mobile: true, hasTouch: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: fs.readFileSync(path.join(HERE, "stub.js"), "utf8") });
  const raf60 = process.env.FEEL_RAF60 === "1";
  if (raf60) await send("Page.addScriptToEvaluateOnNewDocument", { source: RAF60 });
  result.raf60 = raf60;
  await send("Page.navigate", { url: URL_ });
  await sleep(2600);

  /**
   * `FEEL_FLIP_MS=<ms>`：**运行期**覆盖让位动画时长（只改探针、不动产品代码）。
   * 为什么能覆盖：产品把 transition 写成**内联**样式（`CustomUiPage.tsx` 每轮写
   * `"transform 150ms ease-out"`），而样式表里的 `!important` 声明**优先于**非重要的内联声明。
   * 用途：把"改门槛（批次 C）"与"改动画时长"两条杠杆分开量，别混为一谈。
   */
  const flipOverrideMs = Number(process.env.FEEL_FLIP_MS || 0);
  if (flipOverrideMs > 0) {
    await evalJs(`(() => {
      const s = document.createElement('style');
      s.id = 'feel-flip';
      s.textContent = '.ed-canvas .ed-blk, .ed-canvas .ed-slot { transition-duration: ${flipOverrideMs}ms !important; }';
      document.head.appendChild(s);
      return true;
    })()`);
  }
  result.flipOverrideMs = flipOverrideMs || null;

  await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const g = document.querySelector('.age-confirm'); if (g) g.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) { if (document.querySelectorAll('.list-item').length > 2) break; await sleep(200); }
    await sleep(600); return true;
  })()`);

  const opened = await evalJs(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const q = (s) => document.querySelector(s); const qa = (s) => Array.from(document.querySelectorAll(s));
    q('.menu-btn').click(); await sleep(700);
    const entry = qa('.ditem').find((b) => /自定义 UI/.test(b.textContent || ''));
    if (!entry) return 'no-entry';
    entry.click(); await sleep(1300);
    if (!q('.ed-gallery')) return 'no-gallery';
    q(".ed-gallery .ed-card[data-page='detail']").click(); await sleep(900);
    return q('.ed-canvas') ? 'ok' : 'no-canvas';
  })()`);
  result.openEditor = opened;
  if (opened !== "ok") throw new Error("打不开编辑器：" + opened);
  await sleep(600);
  await evalJs(FEEL_HOOK);

  const geo = await evalJs(GEO);
  if (!geo) throw new Error("画布上一个 .ed-blk 都没有");
  result.geo = geo;
  // 每块的真实尺寸 → 死区表 = max(24, 0.5×该轴尺寸)：这张表直接回答"要拖多远界面才动"
  result.blockGeom = await evalJs(`(() => {
    const s = document.querySelector('.ed-stage'); if (s) s.scrollTop = 0;
    return Array.from(document.querySelectorAll('.ed-canvas .ed-blk')).map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.getAttribute('data-blk'), w: Math.round(r.width), h: Math.round(r.height),
               deadZoneY: Math.max(24, Math.round(r.height / 2)) };
    });
  })()`);
  if (geo.overNested) console.error("⚠️ 选中的块中心压在 .ed-slot 上（手势可能被内嵌槽位抢走）");

  // 长按起拖
  await touch("touchStart", geo.x, geo.y);
  await sleep(400);
  const held = await evalJs(READ);
  result.held = held;
  if (held.drag !== 1) throw new Error("长按 400ms 没能起拖：" + JSON.stringify(held));

  // 采样的"期望镜像位置" = 指针 − 抓取偏移（与 useCanvasDrag 的 grabRef 同一口径）
  const grab = { grabX: geo.x - geo.left, grabY: geo.y - geo.top };
  await evalJs(`window.__feelStart(${JSON.stringify(grab)})`);

  // ⚠️ 每一步**不等 CDP 应答**（只 sleep）：逐 await 会让实际速度被往返延迟压到
  // ~120px/s（第一版实测），而真手指是 300~2000px/s、事件率 ≥60Hz —— 那样测出来的
  // "跟手很好"是假象（稀疏事件给了缓动足够的收敛时间）。应答在阶段末统一收。
  let afterUp, afterDown;
  const inflight = [];
  // 阶段 1：固定方向连续拖（要够跨 2~3 格）
  for (let i = 1; i <= UP_STEPS; i++) {
    inflight.push(touch("touchMove", geo.x, geo.y - STEP * i));
    await sleep(STEP_WAIT);
  }
  await Promise.all(inflight.splice(0));
  afterUp = await evalJs(READ);
  // 阶段 2：**不松手**反向拖（用户第 1 条：换向迟钝）
  for (let i = 1; i <= DOWN_STEPS; i++) {
    inflight.push(touch("touchMove", geo.x, geo.y - STEP * UP_STEPS + STEP * i));
    await sleep(STEP_WAIT);
  }
  await Promise.all(inflight.splice(0));
  afterDown = await evalJs(READ);
  // 阶段 3：停手，看镜像多久收敛（松手前的"追平"）
  await sleep(500);
  await touch("touchEnd", geo.x, geo.y - STEP * UP_STEPS + STEP * DOWN_STEPS);
  await sleep(300);
  const ended = await evalJs(READ);

  const feel = await evalJs("window.__feelRead()");
  result.afterUp = afterUp;
  result.afterDown = afterDown;
  result.ended = ended;

  // ── 分析 ──────────────────────────────────────────────────────
  // ⚠️ 丢掉"还没有任何指针样本"的帧：探针初始化时 `__pt` 是 {0,0}，不过滤会把
  // (0,0) 当成手指坐标，滞后统计与换向点判定一起报废（第一版实测 max 518px、
  // 换向点被判到 y=0 —— 都是这个污染）。
  const all = (feel && feel.samples) || [];
  const S = all.filter((s) => s.pt > 0);
  result.sampleCount = S.length;
  result.droppedSamples = all.length - S.length;
  const withGhost = S.filter((s) => s.gx !== null && s.drag === 1);
  const lags = [], lagX = [], lagY = [];
  for (const s of withGhost) {
    const ex = s.px - grab.grabX, ey = s.py - grab.grabY;
    lagX.push(Math.abs(ex - s.gx));
    lagY.push(Math.abs(ey - s.gy));
    lags.push(Math.hypot(ex - s.gx, ey - s.gy));
  }
  result.lag = { total: stats(lags), x: stats(lagX), y: stats(lagY) };

  // 指针速度（px/s）与"每帧事件数"—— 缓动实现是**按帧**逼近，事件频率一变手感就变
  const vel = [];
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1], b = S[i];
    const dt = b.pt - a.pt;
    if (dt > 0 && dt < 120) vel.push(Math.hypot(b.px - a.px, b.py - a.py) / dt * 1000);
  }
  result.pointerSpeedPxPerSec = stats(vel);
  const evPerFrame = [];
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1], b = S[i];
    evPerFrame.push((b.tm - a.tm) + (b.pmc - a.pmc));
  }
  result.eventsPerFrame = stats(evPerFrame);
  result.evSeries = evPerFrame.slice(0, 90);
  result.eventTotals = { tm: S.length ? S[S.length - 1].tm : null, pmc: S.length ? S[S.length - 1].pmc : null };
  result.evPerFrameHistogram = (() => {
    const h = {};
    for (const v of evPerFrame) h[v] = (h[v] || 0) + 1;
    return h;
  })();
  // 帧间隔：真机上"换位那一帧掉帧"应该在这里露头（无头桌面 CPU 上通常看不出来，
  // 所以它同时也是一个**测量能力**的自我评估：这里都看不出停顿，就别声称测过真机掉帧）
  const frameGaps = [];
  for (let i = 1; i < S.length; i++) frameGaps.push(S[i].t - S[i - 1].t);
  result.frameGapsMs = stats(frameGaps);
  const longtasks = await evalJs("window.__long || []");
  result.longTasks = { count: longtasks.length, list: longtasks.slice(0, 20), maxMs: longtasks.reduce((m, x) => Math.max(m, x.dur), 0) };
  // 原始轨迹（每 3 帧一条）：任何时候怀疑聚合数字，都从这里复核
  result.rawSamples = S.filter((_, i) => i % 3 === 0);

  // 抖动：镜像逐帧位移的噪声（同一方向连续运动时，位移应当近似恒定）
  const deltas = [];
  for (let i = 1; i < withGhost.length; i++) {
    const a = withGhost[i - 1], b = withGhost[i];
    if (b.gy === null || a.gy === null) continue;
    deltas.push(b.gy - a.gy);
  }
  const zeroFrames = deltas.filter((d) => d === 0).length;
  let reversals = 0;
  for (let i = 1; i < deltas.length; i++) {
    if (deltas[i] !== 0 && deltas[i - 1] !== 0 && Math.sign(deltas[i]) !== Math.sign(deltas[i - 1])) reversals++;
  }
  result.jitter = {
    framesMeasured: deltas.length,
    zeroDeltaFrames: zeroFrames,
    signReversals: reversals,
    absStep: stats(deltas.map((d) => Math.abs(d)))
  };

  // 顺序变化（换位事件）：时刻 + 指针位置 —— 换算成"手指走了多少像素换来一格"
  const swaps = [];
  for (let i = 1; i < S.length; i++) {
    if (S[i].order !== S[i - 1].order) swaps.push({ t: S[i].t, py: S[i].py, order: S[i].order, i });
  }
  result.swaps = swaps;
  /**
   * 每次换位前后的**原始轨迹**（布局位置 vs 视觉位置）—— "跳格"的唯一可信证据。
   * 判读：换位那一帧 `lay` 会跳一格（上百 px）；此时
   *   · `vis` 几乎不动、随后十来帧逐步走完 = 反相位移 + 补间在正常工作
   *   · `vis` 与 `lay` **同步跳**（差 <20%）        = 元素被瞬移（动画被打断/没跑）
   */
  result.swapTraces = swaps.slice(0, 5).map((sw) => ({
    swapAtT: sw.t,
    frames: S.slice(Math.max(0, sw.i - 1), sw.i + 11).map((s) => ({ t: s.t, lay: s.holeTop, vis: s.holeVisTop }))
  }));
  /** 同一帧里"布局跳了多少 / 视觉跳了多少"：视觉 << 布局 = 动画在工作 */
  const div = [];
  let pa = null, pb = null;   // ⚠️ 必须结转：holeTop/holeVisTop 是隔帧采样的，逐帧配对本就恒空
  for (const s of S) {
    if (s.drag !== 1) { pa = pb = null; continue; }
    if (s.holeTop === null || s.holeVisTop === null) continue;
    if (pa !== null && pb !== null) {
      const layD = Math.abs(s.holeTop - pa);
      const visD = Math.abs(s.holeVisTop - pb);
      if (layD > 60) div.push({ layD: Math.round(layD), visD: Math.round(visD), ratio: +(visD / layD).toFixed(2) });
    }
    pa = s.holeTop; pb = s.holeVisTop;
  }
  result.layoutVsVisual = { bigLayoutJumps: div.length, samples: div.slice(0, 8),
    /** 视觉跳幅 ≥ 布局跳幅 60% 的帧数 = **瞬移**（动画没接住）；0 才是健康的 */
    teleport: div.filter((d) => d.ratio >= 0.6).length };
  // 阶段划分：以指针最小 y（往上拖的终点）为换向点
  let minY = Infinity, turnIdx = 0;
  for (let i = 0; i < S.length; i++) if (S[i].py < minY) { minY = S[i].py; turnIdx = i; }
  const upSwaps = swaps.filter((s) => s.t <= S[turnIdx].t);
  const downSwaps = swaps.filter((s) => s.t > S[turnIdx].t);
  const firstUp = upSwaps[0];
  const firstDown = downSwaps[0];
  result.reversal = {
    turnT: S[turnIdx] ? S[turnIdx].t : null,
    turnPy: minY,
    upSwapCount: upSwaps.length,
    downSwapCount: downSwaps.length,
    firstUpSwap: firstUp || null,
    firstDownSwap: firstDown || null,
    /** 起拖点到第一次换位：手指纵向走了多少 px（"第一格门槛"） */
    firstUpTravelPx: firstUp ? Math.abs(firstUp.py - geo.y) : null,
    /** 换向点到第一格回退：手指纵向走了多少 px（用户说的"迟钝卡手"） */
    reverseTravelPx: firstDown ? Math.abs(firstDown.py - minY) : null,
    /** 理论影子带 = max(24, 0.5 × 块高) */
    shadowBandPx: Math.max(24, 0.5 * geo.h)
  };

  // 每次换位之间手指走了多少 px —— 直接暴露"门槛不一致"：
  // 第一次换位受死区门控，之后的换位只受"候选是否翻转"门控（判断分支不同）。
  const travels = [];
  let prevPy = geo.y;
  for (const sw of swaps) { travels.push(Math.abs(sw.py - prevPy)); prevPy = sw.py; }
  const deadZone = Math.max(24, 0.5 * geo.h);
  const after = travels.slice(1);
  result.swapTravelsPx = travels;
  /**
   * ── 换位**间隔（ms）**与"动画被打断"的比例（v3.5.3 新增读数）──────────────
   * 这是"拖动中抖 / 抽搐 / 跳格"那条症状的**直接读数**：让位动画 150ms，
   * 两次换位若间隔小于它，动画就在跑完之前被下一次换位打断（并重新设基线）。
   * 换位间隔 = 换位次数 × 单次行程；它由**门槛模型**决定（批次 C），不是定时器的锅。
   * `FEEL_FLIP_MS` 可以在**运行期**覆盖动画时长（注入 !important 规则），
   * 用来做"改门槛 vs 改动画时长"的对照实验 —— 产品代码一个字都不用动。
   */
  const flipMs = Number(process.env.FEEL_FLIP_MS || 150);
  const ivs = [];
  for (let i = 1; i < swaps.length; i++) ivs.push(swaps[i].t - swaps[i - 1].t);
  const ivsSorted = ivs.slice().sort((a, b) => a - b);
  const flipShort = ivs.filter((v) => v < flipMs).length;
  result.swapIntervalsMs = {
    flipMs,
    n: ivs.length,
    median: ivsSorted.length ? ivsSorted[Math.floor(ivsSorted.length / 2)] : null,
    min: ivsSorted.length ? ivsSorted[0] : null,
    underFlip: flipShort,
    all: ivs
  };
  result.swapTravelStats = {
    deadZonePx: deadZone,
    firstSwapTravelPx: travels.length ? travels[0] : null,
    afterFirstMedianPx: after.length ? stats(after).p50 : null,
    /** 第一次之后的换位里，有多少次只走了不到"死区一半"就换了 —— "太灵敏"的量化 */
    cheapSwaps: after.filter((d) => d < deadZone * 0.5).length,
    afterFirstCount: after.length
  };

  // 坑（.ed-drag）是连续移动还是瞬移/补间
  const holes = S.filter((s) => s.holeTop !== null);
  const holeDeltas = [];
  for (let i = 1; i < holes.length; i++) holeDeltas.push(holes[i].holeTop - holes[i - 1].holeTop);
  result.hole = {
    samples: holes.length,
    staticFrames: holeDeltas.filter((d) => d === 0).length,
    movingFrames: holeDeltas.filter((d) => d !== 0).length,
    absStep: stats(holeDeltas.map((d) => Math.abs(d)))
  };
  // 每次换位同时在补间的元素个数（FLIP 的"噪声面"）
  const anims = S.filter((s) => s.anims !== null).map((s) => s.anims);
  result.flipAnimations = { samples: anims.length, maxConcurrent: anims.length ? Math.max(...anims) : null,
                            nonZeroFrames: anims.filter((a) => a > 0).length, series: anims.slice(-40) };

  /**
   * 坑的**视觉**轨迹（含 FLIP 在飞的 transform）—— 这是"跳格"的唯一直接观测量：
   *   · 单帧位移 ≈ 格位差（上百 px）→ 动画被**打断/瞬移**（旧的 200ms 定时器 bug）
   *   · 单帧位移 ≈ 格位差 / 10（150ms ÷ 16.7ms ≈ 9 帧）→ 补间正常在跑
   */
  const vis = S.filter((s) => s.holeVisTop !== null && s.drag === 1);
  const visD = [];
  for (let i = 1; i < vis.length; i++) visD.push(vis[i].holeVisTop - vis[i - 1].holeVisTop);
  result.holeVisual = {
    samples: vis.length,
    staticFrames: visD.filter((d) => d === 0).length,
    movingFrames: visD.filter((d) => d !== 0).length,
    absStep: stats(visD.map((d) => Math.abs(d))),
    /** 单帧视觉位移 > 60px 的帧数：出现就说明"瞬移"（而不是补间） */
    teleportFrames: visD.filter((d) => Math.abs(d) > 60).length
  };

  // 「不跟手」到底发生在哪一层：把**手指位移**、**镜像位移**、**坑的布局位移**三者对上。
  //   镜像 ≈ 手指 → 跟手没问题，问题在落位层（坑不动 / 瞬移）
  //   镜像 << 手指 → 问题在缓动层
  const travel = { finger: 0, ghost: 0, hole: 0, n: 0 };
  let lastHole = null;
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1], b = S[i];
    if (a.gy === null || b.gy === null || a.drag !== 1 || b.drag !== 1) continue;
    travel.finger += Math.abs(b.py - a.py);
    travel.ghost += Math.abs(b.gy - a.gy);
    travel.n++;
  }
  // ⚠️ 坑的几何每 3 帧才采一次（见探针里的 wantHole），所以这里必须**结转上一个有效值**，
  //    逐帧配对求和会恒为 0（第一版就是这么骗过自己的：坑明明动了 192px，报 0）。
  for (const s of S) {
    if (s.drag !== 1) { lastHole = null; continue; }
    if (s.holeTop === null) continue;
    if (lastHole !== null) travel.hole += Math.abs(s.holeTop - lastHole);
    lastHole = s.holeTop;
  }
  result.travelVsFinger = {
    frames: travel.n,
    fingerPx: travel.finger,
    ghostPx: travel.ghost,
    holePx: travel.hole,
    ghostRatio: travel.finger > 0 ? +(travel.ghost / travel.finger).toFixed(3) : null,
    holeRatio: travel.finger > 0 ? +(travel.hole / travel.finger).toFixed(3) : null
  };

  // 收敛：停手之后镜像还差多少、多久追上
  const tail = S.filter((s) => s.drag === 1).slice(-30);
  if (tail.length) {
    const last = tail[tail.length - 1];
    result.settle = {
      lastLagPx: +Math.hypot((last.px - grab.grabX) - last.gx, (last.py - grab.grabY) - last.gy).toFixed(2),
      tailLagPx: tail.map((s) => +Math.hypot((s.px - grab.grabX) - s.gx, (s.py - grab.grabY) - s.gy).toFixed(1))
    };
  }

  console.log(JSON.stringify(result, null, 1));

  // 人读摘要
  const L = (k) => (result.lag[k] ? result.lag[k].p50 + " / p90 " + result.lag[k].p90 + " / max " + result.lag[k].max : "n/a");
  console.log("\n════ 手感读数 ════");
  const spanMs = S.length ? S[S.length - 1].t - S[0].t : 0;
  const fps = spanMs > 0 ? +(S.length / (spanMs / 1000)).toFixed(0) : null;
  console.log("帧率/事件率   : rAF " + fps + "fps（" + (result.raf60 ? "已开 60Hz 仿真" : "**无头原生帧率，不代表真机**") +
    "）｜ 事件/帧 p50 " + (result.eventsPerFrame ? result.eventsPerFrame.p50 : "n/a"));
  console.log("被拖块        : " + geo.name + "  " + geo.w + "×" + geo.h + "px");
  console.log("指针速度      : " + (result.pointerSpeedPxPerSec ? result.pointerSpeedPxPerSec.p50 + " px/s (p90 " + result.pointerSpeedPxPerSec.p90 + ")" : "n/a"));
  console.log("事件/帧       : " + (result.eventsPerFrame ? result.eventsPerFrame.p50 : "n/a") + "（touchmove+pointermove）");
  console.log("跟手滞后 px   : 合成 " + L("total") + "  ｜ X " + L("x") + "  ｜ Y " + L("y"));
  console.log("抖动          : " + result.jitter.zeroDeltaFrames + "/" + result.jitter.framesMeasured + " 帧位移=0，反向 " +
    result.jitter.signReversals + " 次，|Δy| p50 " + (result.jitter.absStep ? result.jitter.absStep.p50 : "n/a"));
  console.log("换位次数      : 上行 " + result.reversal.upSwapCount + " 次，下行 " + result.reversal.downSwapCount + " 次");
  console.log("第一格门槛    : " + result.reversal.firstUpTravelPx + "px（死区 " + result.swapTravelStats.deadZonePx + "px）");
  console.log("换位间距 px   : 首次 " + result.swapTravelStats.firstSwapTravelPx + "，之后中位数 " +
    result.swapTravelStats.afterFirstMedianPx + "（其中 " + result.swapTravelStats.cheapSwaps + "/" +
    result.swapTravelStats.afterFirstCount + " 次不到死区的一半）");
  console.log("换位间隔 ms   : FLIP=" + result.swapIntervalsMs.flipMs + "ms ｜ 中位 " +
    result.swapIntervalsMs.median + "ms（最小 " + result.swapIntervalsMs.min + "）｜ **动画被打断 " +
    result.swapIntervalsMs.underFlip + "/" + result.swapIntervalsMs.n + " 次** = " +
    (result.swapIntervalsMs.n ? Math.round(100 * result.swapIntervalsMs.underFlip / result.swapIntervalsMs.n) : 0) + "%");
  console.log("  间隔明细 ms : " + result.swapIntervalsMs.all.join(", "));
  console.log("换向回退成本  : " + result.reversal.reverseTravelPx + "px 的手指位移换来第一格");
  console.log("坑（.ed-drag）: 布局静止 " + result.hole.staticFrames + " 帧 / 移动 " + result.hole.movingFrames + " 帧，单帧最大 " +
    (result.hole.absStep ? result.hole.absStep.max : "n/a") + "px");
  console.log("坑的视觉轨迹  : 单帧最大 " + (result.holeVisual.absStep ? result.holeVisual.absStep.max : "n/a") +
    "px ｜ 瞬移帧(>60px) " + result.holeVisual.teleportFrames + " 个 ｜ 有位移帧 " + result.holeVisual.movingFrames + "/" + result.holeVisual.samples);
  const lv = result.layoutVsVisual;
  console.log("布局跳 vs 视觉: 大跳 " + lv.bigLayoutJumps + " 次 ｜ **瞬移 " + lv.teleport + " 次**（视觉跳幅 ≥ 布局跳幅 60% = 动画没接住）");
  console.log("  样本(lay/vis/ratio): " + (lv.samples.map((d) => d.layD + "/" + d.visD + "/" + d.ratio).join("  ") || "—"));
  for (const tr of result.swapTraces.slice(0, 2)) {
    console.log("  ↔ 换位于 t=" + tr.swapAtT + "ms，前后轨迹 (t: 布局/视觉): " +
      tr.frames.map((f) => f.t + ": " + (f.lay ?? "-") + "/" + (f.vis ?? "-")).join("  "));
  }
  console.log("帧间隔        : p50 " + (result.frameGapsMs ? result.frameGapsMs.p50 : "n/a") + "ms / max " +
    (result.frameGapsMs ? result.frameGapsMs.max : "n/a") + "ms  ｜ 长任务 " + result.longTasks.count +
    " 个（最长 " + result.longTasks.maxMs + "ms）");
  console.log("松手前最后一帧: 镜像仍差 " + (result.settle ? result.settle.lastLagPx : "n/a") + "px");
  const tv = result.travelVsFinger;
  console.log("位移三对账    : 手指 " + tv.fingerPx + "px ｜ 镜像 " + tv.ghostPx + "px（比 " + tv.ghostRatio +
    "）｜ 坑位 " + tv.holePx + "px（比 " + tv.holeRatio + "）");
  console.log("════════════════\n");

  try { edge.kill(); } catch { /* 忽略 */ }
  process.exit(0);
}

main().catch((e) => { console.error("探针失败：" + (e && e.stack ? e.stack : e)); try { edge.kill(); } catch { /* 忽略 */ } process.exit(1); });
