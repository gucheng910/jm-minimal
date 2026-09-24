// 专项：手快/连点时的转场健壮性（2026-09-24 真机"多次快速点击后还是偶现动效问题"）
//
// 判据：动画是连续的，硬跳是速度突变。以 ~20ms 采样关键元素位置，算**速度**（px/ms）：
// 缓动 cubic-bezier(0.2,0.9,0.25,1) 起步很陡，420px/320ms 的理论峰值约 6px/ms，
// 采样间隔抖动时"每采样位移"会失真（会误报），所以用速度并留足余量：>12px/ms 才算硬跳
// （真正的瞬间归位是 300~420px 在一个采样间隔内完成 = 15~21px/ms）。
(async () => {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const waitFor = async (sel, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const el = q(sel); if (el) return el; await sleep(50); }
    throw new Error("waitFor timeout: " + sel);
  };
  const back = () => window.dispatchEvent(new CustomEvent("jm:back", { detail: { consumed: false } }));
  const where = () => (q(".sr-layer.open") ? "search" : q(".page-push") ? "detail" : "list");
  const srTopLeft = () => { const a = qa(".sr-layer"); const t = a.length ? a[a.length - 1] : null; return t ? Math.round(t.getBoundingClientRect().left) : null; };
  const detailLeft = () => { const d = q(".page-push"); return d ? Math.round(d.getBoundingClientRect().left) : null; };

  // 采样并找出最大瞬时速度（SNAP 检测）
  // 只统计**可见**位移：搜索层在关闭态是 visibility:hidden、且位置在屏幕外，
  // 此时"瞬间摆位"（从右侧关闭位跳到左侧关闭位）是设计使然、读者看不到，不能算硬跳。
  const track = async (ms, tag) => {
    const s = [];
    // 用 rAF 采样（而不是 setTimeout）：帧间隔稳定在 ~16.7ms，
    // 速度判据才不会被定时器抖动放大（setTimeout 曾把平滑缓动算成 10.4px/ms，逼近阈值）。
    await new Promise((res) => {
      const t0 = performance.now();
      const tick = () => {
        const t = performance.now() - t0;
        const a = qa(".sr-layer");
        const top = a.length ? a[a.length - 1] : null;
        s.push({
          t: Math.round(t),
          sr: top ? Math.round(top.getBoundingClientRect().left) : null,
          srVis: top ? getComputedStyle(top).visibility : "hidden",
          dl: detailLeft(),
          nav: document.documentElement.dataset.nav || "",
          w: where()
        });
        if (t < ms) requestAnimationFrame(tick); else res();
      };
      requestAnimationFrame(tick);
    });
    // 只按 visibility 过滤：摆位相位（transition:none）会把元素瞬间从一侧关闭位换到另一侧，
    // 此时它必然是 hidden、读者看不到。**不能**再用"位置是否在屏内"当条件 ——
    // 关闭位正好等于 ±屏宽，会把"落回关闭位"这一跳的终点判成屏外而漏检（实测漏掉过 335px 的硬跳）。
    const visible = (x) => x.srVis !== "hidden" && x.sr !== null;
    let maxSpeed = 0, at = null, idx = -1, prev = null, navSeen = false;
    for (let i = 0; i < s.length; i++) {
      const x = s[i];
      if (x.nav) navSeen = true;
      if (prev) {
        const dt = Math.max(1, x.t - prev.t);
        const a = x.sr !== null && prev.sr !== null && visible(x) && visible(prev) ? Math.abs(x.sr - prev.sr) : 0;
        const b = x.dl !== null && prev.dl !== null ? Math.abs(x.dl - prev.dl) : 0;
        const sp = Math.max(a, b) / dt;
        if (sp > maxSpeed) { maxSpeed = sp; at = x.t; idx = i; }
      }
      prev = x;
    }
    return {
      tag, maxSpeed: Math.round(maxSpeed * 10) / 10, speedAtMs: at, navSeen,
      samples: s.length, endWhere: where(),
      ctx: idx >= 0 ? s.slice(Math.max(0, idx - 3), idx + 3) : []
    };
  };

  const MAX_SPEED = 12; // px/ms
  let failed = false;
  const assertSmooth = (r, hint) => {
    log.push({ tag: r.tag, maxSpeed: r.maxSpeed, speedAtMs: r.speedAtMs, navSeen: r.navSeen, endWhere: r.endWhere, trace: r.ctx });
    if (r.maxSpeed > MAX_SPEED) {
      failed = true;
      log.push({ step: "SNAP", where: hint, maxSpeed: r.maxSpeed + "px/ms", atMs: r.speedAtMs, ctx: JSON.stringify(r.ctx) });
    }
  };

  (await waitFor(".age-confirm")).click();
  await waitFor(".list-item");
  await sleep(800);

  // 回到列表（每段用例都从列表出发；搜索层/详情层都靠返回键退出）
  const ensureList = async () => {
    for (let i = 0; i < 4 && where() !== "list"; i++) { back(); await sleep(900); }
    if (where() !== "list") throw new Error("无法回到列表，停在 " + where());
    if (!q(".list-item")) throw new Error("列表里没有卡片");
  };

  try {
    // ---- S1：进入详情后 80ms 就按返回（进入 VT 还没播完就打断）----
    await ensureList();
    const t1 = track(1000, "S1");
    q(".list-item").click();
    await sleep(80);
    back();
    const r1 = await t1;
    assertSmooth(r1, "S1 详情进/出被快速连按");
    await sleep(600);
    log.push({ step: "S1-end", where: where() });

    // ---- S2：详情 → 标签搜索层，80ms 后立刻返回（CSS 导航被 VT 的 data-nav 压掉？）----
    await ensureList();
    q(".list-item").click();
    await waitFor(".page-push .card h2"); await sleep(700);
    const t2 = track(1000, "S2");
    qa(".page-push .link").find((l) => l.textContent === "巨乳").click();
    await sleep(80);
    back();
    const r2 = await t2;
    assertSmooth(r2, "S2 打开搜索层后立刻返回");
    await sleep(600);
    log.push({ step: "S2-end", where: where() });

    // ---- S3：搜索层里连点两张卡片（连点锁）+ 连按两次返回 ----
    await ensureList();
    q(".list-item").click();
    await waitFor(".page-push .card h2"); await sleep(700);
    qa(".page-push .link").find((l) => l.textContent === "巨乳").click();
    await waitFor(".sr-layer.open"); await sleep(800);
    const cards = qa(".sr-layer.open .sr-body .list-item");
    if (cards.length < 2) throw new Error("搜索层卡片不足 2 张");
    const t3 = track(1200, "S3");
    cards[0].click();
    await sleep(60);
    cards[1].click();
    await sleep(400);
    back();
    await sleep(90);
    back();
    const r3 = await t3;
    assertSmooth(r3, "S3 连点卡片 + 连按返回");
    await sleep(700);
    log.push({ step: "S3-end", where: where(), layers: qa(".sr-layer").length });
  } catch (e) {
    failed = true;
    log.push({ step: "DRIVER-ERROR", message: String((e && e.message) || e) });
  }

  log.push({ step: "vt", vt: window.__jmVT || null, errs: (window.__errs || []).slice(0, 5) });
  if (failed) {
    const bad = log.filter((x) => x.step === "SNAP" || x.step === "DRIVER-ERROR")
      .map((x) => JSON.stringify(x)).join(" | ");
    throw new Error("快速交互下仍有硬跳或异常 => " + bad);
  }
  return log;
})()
