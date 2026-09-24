// 回归：进入详情后返回，列表必须回到离开时的位置（2026-09-24 真机"又出现老bug：会滚动外面的列表"）
//
// 曾经的根因：openDetail(item, from) 里 `if (from === "list") saveScrollTarget(window.scrollY)`
// 没有 mode 守卫，而详情页的「相关漫画」也是 from="list" —— 那一刻的 scrollY 是**详情页**的滚动量，
// 被当成"列表位置"存了起来，返回列表时把列表滚到那个值。
// 判据：H2 正常路径 与 H1 经相关漫画，返回后的 window.scrollY 都必须等于离开列表时的位置。
(async () => {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const waitFor = async (sel, timeout = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const el = q(sel); if (el) return el; await sleep(50); }
    throw new Error("waitFor timeout: " + sel);
  };
  const back = () => window.dispatchEvent(new CustomEvent("jm:back", { detail: { consumed: false } }));
  const de = document.documentElement;
  const maxScroll = () => Math.max(0, de.scrollHeight - de.clientHeight);
  const scrollTo = (y) => { window.scrollTo(0, Math.min(y, maxScroll())); return Math.round(window.scrollY); };
  const onList = () => !!q(".list-item") && !q(".page-push");
  const ensureList = async () => {
    for (let i = 0; i < 5 && !onList(); i++) { back(); await sleep(1000); }
    if (!onList()) throw new Error("无法回到列表");
    await sleep(500);
  };
  const TOL = 8; // 列表位置允许的误差（恢复逻辑本身有 ±4px 的容差）
  let failed = false;
  const checkRestored = (tag, saved, after, where) => {
    if (where !== "list") { failed = true; log.push({ step: "FAIL", where: tag, reason: "没有回到列表，落在 " + where }); return; }
    if (Math.abs(after - saved) > TOL) {
      failed = true;
      log.push({ step: "FAIL", where: tag, reason: "列表位置没恢复", savedListY: saved, listYAfter: after });
    }
  };

  (await waitFor(".age-confirm")).click();
  await waitFor(".list-item");
  await sleep(900);

  try {
    // ---- H2：正常路径（列表 → 详情 → 在详情里滚动 → 返回）----
    await ensureList();
    const savedY = scrollTo(700);
    await sleep(300);
    q(".list-item").click();
    await waitFor(".page-push .card h2");
    await sleep(1200);
    const listStillMounted = !!q(".list-item"); // 详情页里列表不该还在 DOM（排除"后面列表被滚"这条解释）
    const detailScrolled = scrollTo(500);
    await sleep(300);
    back();
    await sleep(1500); // 等列表位置的 3 次重试（rAF / 120ms / 400ms）跑完
    const afterH2 = Math.round(window.scrollY);
    log.push({
      step: "H2-normal", savedListY: savedY, detailWasAt: detailScrolled, listYAfter: afterH2,
      where: onList() ? "list" : "other", listMountedInsideDetail: listStillMounted
    });
    checkRestored("H2 正常返回", savedY, afterH2, onList() ? "list" : "other");

    // ---- H1：经「相关漫画」进入下一部（from="list" 但与列表无关）----
    await ensureList();
    const savedY2 = scrollTo(700);
    await sleep(300);
    q(".list-item").click();
    await waitFor(".page-push .card h2");
    await sleep(1600);
    const titleA = (q(".page-push h2") || {}).textContent || "";
    const detailYA = scrollTo(500);
    await sleep(400);
    const relToggle = q(".page-push [data-related-toggle]");
    if (relToggle) { relToggle.click(); await sleep(700); }
    const relCard = q(".related-block .list-item");
    if (!relCard) {
      failed = true;
      log.push({ step: "FAIL", where: "H1", reason: "没有相关漫画卡片，用例无法覆盖" });
    } else {
      relCard.click();
      await waitFor(".page-push .card h2");
      await sleep(1600);
      log.push({ step: "H1-entered", titleA, titleB: (q(".page-push h2") || {}).textContent || "", savedListY: savedY2, detailWasAt: detailYA });
      back();
      await sleep(1500);
      const afterH1 = Math.round(window.scrollY);
      log.push({
        step: "H1-related-back", where: onList() ? "list" : "other",
        savedListY: savedY2, detailWasAt: detailYA, listYAfter: afterH1
      });
      checkRestored("H1 相关漫画返回", savedY2, afterH1, onList() ? "list" : "other");
    }
  } catch (e) {
    failed = true;
    log.push({ step: "DRIVER-ERROR", message: String((e && e.message) || e) });
  }

  log.push({ step: "errs", errs: (window.__errs || []).slice(0, 5) });
  if (failed) {
    const bad = log.filter((x) => x.step === "FAIL" || x.step === "DRIVER-ERROR").map((x) => JSON.stringify(x)).join(" | ");
    throw new Error("列表位置记忆被污染 => " + bad);
  }
  return log;
})()
