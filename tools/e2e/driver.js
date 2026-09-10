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
  const snap = (label) => {
    const sr = q(".sr-layer");
    const link = q(".page-push .link");
    log.push({
      step: label,
      detail: (q(".page-push h2") || {}).textContent || "",
      pushed: !!q(".page-push.pushed"),
      srOpen: !!sr && sr.classList.contains("open"),
      srTitle: (q(".sr-title h2") || {}).textContent || "",
      srCount: (q(".sr-count") || {}).textContent || "",
      srCards: qa(".sr-body .list-item").length,
      linkColor: link ? getComputedStyle(link).color : "",
      backLabel: (q(".page-push .backtxt") || {}).textContent || ""
    });
  };
  const clickLink = (text) => {
    const el = qa(".page-push .link").find((l) => l.textContent === text);
    if (!el) throw new Error("link not found: " + text + " / have: " + qa(".page-push .link").map((x) => x.textContent).join(","));
    el.click();
  };

  (await waitFor(".age-confirm")).click();
  await waitFor(".list-item");
  await sleep(600);
  snap("home");

  // 下拉刷新用 CDP 原生触摸单独验证（见 _archive/ptr-cdp.mjs）：
  // 合成 DOM TouchEvent 在无触摸的桌面环境下 React 不会挂监听，测不出真实行为

  // ---- 周榜页（mode === "week"）回归 ----
  const rankBtn = qa("button").find((b) => (b.textContent || "").trim() === "排行榜");
  if (rankBtn) {
    rankBtn.click();
    await waitFor(".card h2", 15000);
    await sleep(1500);
    const weekCard = qa(".card h2").find((h) => /周榜/.test(h.textContent || ""));
    log.push({
      step: "week",
      title: weekCard ? weekCard.textContent : "",
      selects: qa("select").length,
      options: qa("select").map((s) => s.options.length),
      cards: qa(".list-item").length,
      weekReqs: (window.__reqs || []).filter((r) => r.path === "week/filter").slice(-2),
      fatal: (document.getElementById("jm-fatal") || {}).textContent || ""
    });
    const backBtn = qa("button").find((b) => (b.textContent || "").trim() === "返回列表");
    if (backBtn) backBtn.click();
    await sleep(1200);
    log.push({ step: "week-back", weekCardGone: !qa(".card h2").some((h) => /周榜/.test(h.textContent || "")), cards: qa(".list-item").length });
    // 回首页 tab（分类 tab 在桩里没有 feed，继续测别的要先回首页）
    const homeNav = qa(".nav-item").find((b) => /首页/.test(b.textContent || ""));
    if (homeNav) homeNav.click();
    await sleep(1500);
    if (qa(".list-item").length === 0) { window.dispatchEvent(new CustomEvent("jm:refreshHome", { detail: undefined })); await sleep(1500); }
    log.push({ step: "back-home-tab", tab: (q(".nav-item.active") || {}).textContent || "", cards: qa(".list-item").length });

    // ---- 分类页（pageMode === "categories"）----
    const catNav = qa(".nav-item").find((b) => /分类/.test(b.textContent || ""));
    if (catNav) {
      catNav.click();
      await sleep(2500);
      log.push({
        step: "category",
        tabs: qa(".tabs .tk").map((c) => (c.textContent || "").trim()),
        morePinned: !!q(".catrow .morebtn"),
        count: (q(".toolrow .cnt") || {}).textContent || "",
        sortLabel: (q("[data-sort-toggle]") || {}).textContent || "",
        cards: qa(".list-item").length,
        first: qa(".list-item")[0] ? (qa(".list-item")[0].querySelector(".title") || {}).textContent : "",
        catReqs: (window.__reqs || []).filter((r) => r.path === "categories/filter").slice(-2)
      });
      // 排序是"列表功能"：先开浮层再选（极简版不再把排序 chip 直接铺在页面上）
      const sortToggle = q("[data-sort-toggle]");
      if (sortToggle) {
        sortToggle.click();
        await sleep(600);
        log.push({ step: "sort-sheet", opened: !!q(".app-sheet"), options: qa(".app-sheet .opt-row").map((b) => (b.textContent || "").trim()) });
        const sortOpt = qa(".app-sheet .opt-row").find((b) => /最多爱心/.test(b.textContent || ""));
        if (sortOpt) {
          sortOpt.click();
          await sleep(2000);
          log.push({ step: "category-sort", sortLabel: (q("[data-sort-toggle]") || {}).textContent || "", catReqs: (window.__reqs || []).filter((r) => r.path === "categories/filter").slice(-1) });
        }
      }
      // 排行榜是"去处"：点它应出现二级榜，且这一态不显示排序
      const rankTab = qa(".tabs .tk").find((b) => (b.textContent || "").trim() === "排行榜");
      if (rankTab) {
        rankTab.click();
        await sleep(2000);
        log.push({
          step: "category-rank",
          tabs: qa(".tabs .tk").map((c) => (c.textContent || "").trim()),
          sortHidden: !q("[data-sort-toggle]"),
          catReqs: (window.__reqs || []).filter((r) => r.path === "categories/filter").slice(-1)
        });
      }
      // 「更多」是行尾钉住的独立控件 → 更多分类浮层（4 组词）
      const moreBtn = q(".catrow .morebtn");
      if (moreBtn) {
        moreBtn.click();
        await sleep(700);
        log.push({
          step: "more-categories",
          groups: qa(".app-sheet .grpname").map((g) => (g.textContent || "").trim()),
          terms: qa(".app-sheet .tags button").length
        });
        const backdrop = q(".drawer-backdrop");
        if (backdrop) backdrop.click();
        await sleep(400);
      }
      // 先选主分类，子分类行才会出现
      const mainChip = qa(".tabs .tk").find((b) => (b.textContent || "").trim() === "同人");
      if (mainChip) {
        mainChip.click();
        await sleep(2000);
        log.push({ step: "category-main", tabs: qa(".tabs .tk").map((c) => (c.textContent || "").trim()), catReqs: (window.__reqs || []).filter((r) => r.path === "categories/filter").slice(-1) });
        const subChip = qa(".tabs .tk").find((b) => (b.textContent || "").trim() === "CG");
        if (subChip) {
          subChip.click();
          await sleep(2000);
          log.push({ step: "category-sub", catReqs: (window.__reqs || []).filter((r) => r.path === "categories/filter").slice(-1) });
        }
      }
      const homeNav2 = qa(".nav-item").find((b) => /首页/.test(b.textContent || ""));
      if (homeNav2) homeNav2.click();
      await sleep(1500);
    }

    // ---- 搜索 tab（pageMode === "search"）----
    const searchNav = qa(".nav-item").find((b) => /搜索/.test(b.textContent || ""));
    if (searchNav) {
      searchNav.click();
      await sleep(2000);
      const setInput = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const input = q(".searchbar input");
      log.push({ step: "search-page", hot: qa(".chip").map((c) => c.textContent).slice(0, 4), hasInput: !!input });
      // 热词 chip 只在「未搜索」状态显示，所以先点它
      const hotChip = qa("button").find((b) => (b.textContent || "").trim() === "热词1");
      if (hotChip) {
        hotChip.click();
        await sleep(2000);
        log.push({ step: "search-hot", reqs: (window.__reqs || []).filter((r) => r.path === "search").slice(-1), inputValue: (q(".searchbar input") || {}).value, cards: qa(".list-item").length });
      }
      if (input) {
        setInput(input, "测试词");
        await sleep(200);
        input.form.requestSubmit();
        await sleep(2500);
        log.push({ step: "search-submit", cards: qa(".list-item").length, reqs: (window.__reqs || []).filter((r) => r.path === "search").slice(-1) });
        const tagChip = qa("button").find((b) => (b.textContent || "").trim() === "标签");
        if (tagChip) {
          tagChip.click();
          await sleep(2000);
          log.push({ step: "search-type-tag", reqs: (window.__reqs || []).filter((r) => r.path === "search").slice(-1) });
        }
      }
      const homeNav3 = qa(".nav-item").find((b) => /首页/.test(b.textContent || ""));
      if (homeNav3) homeNav3.click();
      await sleep(1500);
    }
  }

  q(".list-item").click();
  await waitFor(".page-push .card h2");
  await sleep(500);
  snap("detailA");
  log.push({ step: "links", texts: qa(".page-push .link").map((l) => l.textContent) });

  clickLink("巨乳");
  await waitFor(".sr-layer.open");
  await sleep(600);
  snap("searchX");
  log.push({ step: "req-after-tag", last: window.__reqs[window.__reqs.length - 1] });

  qa(".sr-body .list-item")[0].click();
  await waitFor(".page-push .card h2");
  await sleep(600);
  snap("detailB");

  back(); await sleep(700); snap("backToSearchX");
  back(); await sleep(800); snap("backToDetailA");
  back(); await sleep(700); snap("backToHome");

  q(".list-item").click();
  await waitFor(".page-push .card h2"); await sleep(400);
  clickLink("巨乳");
  await waitFor(".sr-layer.open"); await sleep(500);
  qa(".sr-body .list-item")[0].click();
  await waitFor(".page-push .card h2"); await sleep(500);
  snap("detailB2");
  clickLink("無修正");
  await waitFor(".sr-layer.open"); await sleep(600);
  snap("searchY_kill");
  log.push({ step: "req-after-kill", last: window.__reqs[window.__reqs.length - 1] });
  back(); await sleep(700); snap("backToDetailB");
  back(); await sleep(700); snap("backToHome2");

  // ---- 阅读器：详情 → 立即阅读 → 返回详情（startRead 已迁入 useAlbumDetail）----
  q(".list-item").click();
  await waitFor(".page-push .card h2", 20000);
  await sleep(2500);
  const readBtn = qa(".page-push button").find((b) => (b.textContent || "").trim() === "立即阅读");
  if (readBtn) {
    readBtn.click();
    await waitFor(".reader-toolbar", 15000);
    await sleep(2000);
    log.push({ step: "reader", toolbar: !!q(".reader-toolbar"), readReqs: (window.__reqs || []).filter((r) => r.path === "comic_read").slice(-1), fatal: (document.getElementById("jm-fatal") || {}).textContent || "" });
    const backBtn2 = qa(".reader-toolbar button").find((b) => (b.textContent || "").trim() === "返回");
    if (backBtn2) backBtn2.click();
    await sleep(1500);
    log.push({ step: "reader-back", detailTitle: (q(".page-push h2") || {}).textContent.slice(0, 16), readerGone: !q(".reader-toolbar") });
  }
  back(); await sleep(1200); snap("after-reader-home");

  // ---- 相关漫画 / 登场人物 / 协议漂移（1.7.2 新增）----
  q(".list-item").click();
  await waitFor(".page-push .card h2", 20000);
  await sleep(2500);
  const actorLinks = qa(".page-push .link").filter((l) => {
    const p = l.closest("p");
    return p && /登场人物/.test(p.textContent || "");
  });
  // 极简版把「相关漫画」折进分组行：先展开再读（保持原来的覆盖范围）
  const relToggle = q(".page-push [data-related-toggle]");
  if (relToggle) { relToggle.click(); await sleep(500); }
  log.push({
    step: "detail-meta",
    related: qa(".related-block .list-item").length,
    relatedTitle: (q(".related-block h3") || {}).textContent || "",
    actors: actorLinks.map((l) => l.textContent)
  });

  // 登场人物 → 只读搜索页（search_type=character）
  if (actorLinks[0]) {
    actorLinks[0].click();
    await waitFor(".sr-layer.open", 15000);
    await sleep(2500);
    log.push({
      step: "actor-search",
      srTitle: (q(".sr-title h2") || {}).textContent || "",
      reqs: (window.__reqs || []).filter((r) => r.path === "search").slice(-1),
      cards: qa(".sr-body .list-item").length
    });
    back(); await sleep(1200);
  }

  // 相关漫画 → 打开该漫画详情
  const relCard = q(".related-block .list-item");
  if (relCard) {
    relCard.click();
    await waitFor(".page-push .card h2", 20000);
    await sleep(2000);
    log.push({ step: "related-open", detail: (q(".page-push h2") || {}).textContent.slice(0, 16), relatedGone: !q(".related-block") || qa(".related-block .list-item").length > 0 });
    back(); await sleep(1200);
  }

  // 协议漂移提示（桩里 jm3_version=2.1.7，比客户端 APP_VERSION 新 → 应出现提示）
  const menuBtn = q(".menu-btn");
  if (menuBtn) {
    menuBtn.click();
    await sleep(900);
    const note = qa(".menu-note").map((n) => (n.textContent || "").trim());
    const driftWarning = (qa(".small-err").map((e) => (e.textContent || "").trim()).find((t) => /官方协议已更新/.test(t))) || "";
    log.push({
      step: "proto-drift",
      versionLine: note.find((t) => /官方协议/.test(t)) || "",
      driftWarning
    });
    // 桩里 jm3_version 比客户端 APP_VERSION 新 → 必须出现漂移提示（否则说明判据失效）
    if (!driftWarning) throw new Error("协议漂移提示未出现（桩 jm3_version=2.1.7，客户端 APP_VERSION 见 constants.ts）");
    q(".menu-backdrop")?.click();
    await sleep(600);
  }

  log.push({
    step: "tail-state",
    listItems: qa(".list-item").length,
    where: q(".page-push") ? "detail" : q(".sr-layer.open") ? "search" : "list",
    tab: (q(".nav-item.active") || {}).textContent || "",
    drawerOpen: !!q(".side-drawer.open"),
    appExists: !!q(".app"),
    rootLen: (document.getElementById("root") || {}).innerHTML ? document.getElementById("root").innerHTML.length : 0,
    bodyText: document.body.innerText.slice(0, 80).replace(/\n/g, " | "),
    errs: (window.__errs || []).slice(0, 3),
    menuBtn: !!q(".menu-btn"),
    menuNotes: qa(".menu-note").length
  });
  const tailCard = q(".list-item");
  if (tailCard) {
    tailCard.click();
    await waitFor(".page-push .card h2"); await sleep(400);
    clickLink("作者甲");
    await waitFor(".sr-layer.open"); await sleep(600);
    snap("searchAuthor");
    log.push({ step: "req-author", last: window.__reqs[window.__reqs.length - 1] });
  } else {
    log.push({ step: "tail-skip", reason: "没有列表卡片可点（前序步骤把它带走了）" });
  }

  log.push({ step: "all-search-requests", reqs: window.__reqs.filter((r) => r.path === "search") });
  return log;
})()