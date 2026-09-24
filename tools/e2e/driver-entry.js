// 专项：进入详情页的转场（2026-09-24 真机反馈"不丝滑、点多了错乱"）
//   A 帧耗时：列表 → 详情
//   B 一致性：搜索层 → 详情时，搜索层与详情页必须在 VT 期间"瞬间到位"（否则 VT 新快照抓到中间态 → 不丝滑）
//   B 帧耗时：搜索层 → 详情
//   C 连点：在搜索层连点两张卡片 → 只按一次返回，必须回到搜索层（而不是退回上一部漫画）
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

  const srTopLeft = () => {
    const srs = qa(".sr-layer");
    const top = srs.length ? srs[srs.length - 1] : null;
    return top ? Math.round(top.getBoundingClientRect().left) : null;
  };
  const detailLeft = () => { const d = q(".page-push"); return d ? Math.round(d.getBoundingClientRect().left) : null; };

  // 帧耗时：统计 rAF 间隔（>32ms 记为一帧掉帧）
  const frameStats = async (ms) => {
    const ts = [];
    let stop = false;
    const tick = (t) => { ts.push(t); if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    await sleep(ms);
    stop = true;
    const d = ts.slice(1).map((t, i) => Math.round(t - ts[i]));
    if (!d.length) return { frames: 0 };
    return {
      frames: ts.length,
      maxMs: Math.max(...d),
      over32: d.filter((x) => x > 32).length,
      first8: d.slice(0, 8)
    };
  };

  (await waitFor(".age-confirm")).click();
  await waitFor(".list-item");
  await sleep(800);

  try {
    // ---- A：列表 → 详情（只有 root VT 一个动画）----
    const fa = frameStats(700);
    q(".list-item").click();
    const statsA = await fa;
    await waitFor(".page-push .card h2"); await sleep(500);
    log.push({ step: "A-list-to-detail", stats: statsA, vt: window.__jmVT ? window.__jmVT.count : 0, where: where() });
    back(); await sleep(900);

    // ---- B：搜索层 → 详情（曾经的毛病：三个动画抢一个导航）----
    q(".list-item").click();
    await waitFor(".page-push .card h2"); await sleep(700);
    qa(".page-push .link").find((l) => l.textContent === "巨乳").click();
    await waitFor(".sr-layer.open"); await sleep(900);
    const before = { srTopLeft: srTopLeft(), detailLeft: detailLeft(), detailOp: q(".page-push") ? Number(getComputedStyle(q(".page-push")).opacity).toFixed(2) : null };
    const fb = frameStats(700);
    q(".sr-layer.open .sr-body .list-item").click();
    await sleep(30);
    const justAfter = { srTopLeft: srTopLeft(), detailLeft: detailLeft(), nav: document.documentElement.dataset.nav || "", detailOp: q(".page-push") ? Number(getComputedStyle(q(".page-push")).opacity).toFixed(2) : null };
    const statsB = await fb;
    await waitFor(".page-push .card h2"); await sleep(500);
    log.push({ step: "B-search-to-detail", before, justAfter, stats: statsB, vt: window.__jmVT ? window.__jmVT.count : 0, where: where() });
    // VT 期间搜索层必须已经瞬间到位（420 = 完全滑出）；否则 VT 新快照会抓到"搜索层仍盖着屏幕"
    if (justAfter.nav && justAfter.srTopLeft !== null && justAfter.srTopLeft < 400) {
      throw new Error("VT 期间搜索层没有瞬间到位（srTopLeft=" + justAfter.srTopLeft + "）：VT 新快照会抓到中间态 → 不丝滑");
    }
    back(); await sleep(1000);
    log.push({ step: "B-back", where: where() });

    // ---- C：在搜索层连点两张卡片 → 只按一次返回必须回到搜索层 ----
    const cards = qa(".sr-layer.open .sr-body .list-item");
    if (cards.length < 2) throw new Error("搜索层卡片不足 2 张，无法测连点");
    cards[0].click();
    cards[1].click();
    await sleep(1400);
    log.push({ step: "C-after-double-tap", where: where(), title: (q(".page-push h2") || {}).textContent || "" });
    back(); await sleep(1000);
    const afterBack = { where: where(), title: (q(".page-push h2") || {}).textContent || "", srOpen: !!q(".sr-layer.open") };
    log.push({ step: "C-back-once", ...afterBack });
    if (afterBack.where !== "search") {
      throw new Error("连点两张卡片后，按一次返回没有回到搜索层（落在 " + afterBack.where + "）：多压了一层详情");
    }
  } catch (e) {
    log.push({ step: "DRIVER-ERROR", message: String((e && e.message) || e) });
  }

  log.push({ step: "errs", errs: (window.__errs || []).slice(0, 5) });
  return log;
})()
