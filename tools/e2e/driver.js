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
    // 详情页 v7.1：标签改成了胶囊 .tagchip（作者仍是蓝字 .link），两类都认
    const el = qa(".page-push .link, .page-push .tagchip").find((l) => l.textContent === text);
    if (!el) throw new Error("link not found: " + text + " / have: " + qa(".page-push .link, .page-push .tagchip").map((x) => x.textContent).join(","));
    el.click();
  };

  // 18+ 确认页右上角「无网直达缓存」：点开缓存中心时确认页不能盖在上面，关掉后要回到确认页
  //
  // ⚠️ 这里原来是一句裸 `q(".age-cache")` + 抛错。harness 在 `Page.navigate` 后只等固定的
  // 2.5s，而**冷启动的 dev server**（刚起进程 + 首次 transform + 清过浏览器缓存）经常来不及
  // 把首屏画出来 —— 实测连续两次报"18+ 页没有右上角缓存入口"，而同一份代码在热起来的
  // server 上跑得好好的。改成等待：按钮**始终不出现**时照样红，只是不再和"首屏还没画完"抢时间。
  const gateCacheBtn = await waitFor(".age-cache");
  const zOf = (sel) => { const el = q(sel); return el ? Number(getComputedStyle(el).zIndex) : NaN; };
  const zGate0 = zOf(".age-gate");
  gateCacheBtn.click();
  await waitFor(".cache-overlay");
  await sleep(60); // 淡入过渡中：确认页要留在下面当背板（抽走会在过渡期间露出主页）
  const midGate = !!q(".age-gate");
  const midZ = { gate: zOf(".age-gate"), cache: zOf(".cache-overlay") };
  const midCacheOpacity = Number(getComputedStyle(q(".cache-overlay")).opacity);
  await sleep(400);
  const openZ = { gate: zOf(".age-gate"), cache: zOf(".cache-overlay") };
  const cacheClose = q(".cache-header .ghost");
  if (cacheClose) cacheClose.click();
  await sleep(800);
  const backZ = zOf(".age-gate");
  log.push({ step: "gate-cache-entry", midGate, midCacheOpacity, midZ, openZ, zGate0, backZ, backToGate: !!q(".age-gate") });
  if (!midGate) throw new Error("缓存中心淡入时确认页被抽走（过渡期间会露出主页）");
  if (!(midZ.gate < midZ.cache) || !(openZ.gate < openZ.cache)) throw new Error("确认页没有压在缓存中心之下");
  if (!q(".age-gate") || !(backZ > openZ.cache)) throw new Error("关掉缓存后确认页没有回到最上层");

  (await waitFor(".age-confirm")).click();
  await waitFor(".list-item");
  await sleep(600);
  snap("home");

  // ---- 首页分段：推荐（random_recommend）/ 最新（/latest）----
  const latestTab = qa(".tabs .tk").find((b) => (b.textContent || "").trim() === "最新");
  if (latestTab) {
    latestTab.click();
    await sleep(2500);
    log.push({
      step: "home-latest",
      tabs: qa(".tabs .tk").map((t) => (t.textContent || "").trim()),
      active: (q(".tabs .tk.on") || {}).textContent || "",
      cards: qa(".list-item").length,
      reqs: (window.__reqs || []).filter((r) => r.path === "latest").slice(-1),
      loadMoreBtn: qa("button").some((b) => (b.textContent || "").trim() === "加载更多"),
      sentinel: !!q(".cat-sentinel")
    });
    const recTab = qa(".tabs .tk").find((b) => (b.textContent || "").trim() === "推荐");
    if (recTab) { recTab.click(); await sleep(1800); }
  }

  // ---- 刷新失败但旧列表还在：只能给提示，不能顶出错误卡 ----
  // 曾经的 bug：失败回滚旧列表后 error 没撤，于是"内容明明加载出来了却提示网络问题"
  window.__failMap = { random_recommend: 99 };
  window.dispatchEvent(new CustomEvent("jm:refreshHome"));
  let failCards = 0;
  let failErr = "";
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    failCards = qa(".list-item").length;
    failErr = ((q(".card.err") || {}).textContent || "").slice(0, 40);
    if (failCards > 0 || failErr) break; // 重试跑完：要么列表回来了，要么真的报了错
  }
  log.push({ step: "refresh-fail-keeps-list", cards: failCards, errCard: failErr, toast: ((q(".toast") || {}).textContent || "").slice(0, 40) });
  if (failCards > 0 && failErr) throw new Error("刷新失败回滚了列表，却同时顶出了错误卡：" + failErr);
  if (failCards === 0) throw new Error("刷新失败没有把旧列表放回来（出现空白/骨架停留）");
  window.__failMap = { random_recommend: 0 };

  // 下拉刷新用 CDP 原生触摸单独验证（见 _archive/ptr-cdp.mjs）：
  // 合成 DOM TouchEvent 在无触摸的桌面环境下 React 不会挂监听，测不出真实行为

  // ---- 周榜页（mode === "week"）回归 ----
  // 首页改版后：周榜入口是「每周必看」分段（原先是「排行榜」按钮）
  const rankBtn = qa("button").find((b) => (b.textContent || "").trim() === "每周必看");
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
          groups: qa(".ed-inspector .grpname").map((g) => (g.textContent || "").trim()),
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
      // ---- 列表位置记忆：进详情再返回，列表不能跳回开头 ----
      // （真机曾因标签行用 el.scrollIntoView 把整页平滑滚回顶部；这里守住"返回后位置不变"）
      window.scrollTo(0, 260);
      await sleep(500);
      const beforeY = Math.round(window.scrollY);
      const card = q(".list-item");
      if (card && beforeY > 50) {
        card.click();
        await waitFor(".page-push .card h2", 20000);
        await sleep(1500);
        const inDetailY = Math.round(window.scrollY);
        back();
        await sleep(1500);
        const afterY = Math.round(window.scrollY);
        log.push({ step: "category-back-keeps-scroll", beforeY, inDetailY, afterY, kept: Math.abs(afterY - beforeY) < 40 });
        if (Math.abs(afterY - beforeY) >= 40) throw new Error("从详情返回后列表位置没恢复：" + beforeY + " → " + afterY);
      } else {
        log.push({ step: "category-back-keeps-scroll", skipped: "页面不够长，滚不到 260", beforeY });
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
  const titleA = (q(".page-push h2") || {}).textContent || "";
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

  back(); await sleep(700);
  if (!q(".sr-layer.open") || ((q(".sr-title h2") || {}).textContent || "").indexOf("巨乳") === -1) {
    throw new Error("从搜索层里的详情返回，没有回到那个搜索层：" + JSON.stringify((q(".sr-title h2") || {}).textContent || ""));
  }
  snap("backToSearchX");
  back(); await sleep(800);
  if (!q(".page-push") || ((q(".page-push h2") || {}).textContent || "") !== titleA) {
    throw new Error("从搜索层返回没有回到原来的详情：" + JSON.stringify((q(".page-push h2") || {}).textContent || ""));
  }
  snap("backToDetailA");
  back(); await sleep(700);
  if (q(".page-push") || q(".sr-layer.open")) throw new Error("详情页返回没有回到列表");
  snap("backToHome");

  // ---- 第二次搜索：真·页面栈（不再是"杀后台"）----
  // 列表 → 详情A → 搜索X(巨乳) → 详情B → 搜索Y(無修正)
  // 返回链必须是：Y → B → X → A → 列表（上一版在这里会回错页面/内容串了，故这里必须断言）
  q(".list-item").click();
  await waitFor(".page-push .card h2"); await sleep(400);
  const titleA2 = (q(".page-push h2") || {}).textContent || "";
  clickLink("巨乳");
  await waitFor(".sr-layer.open"); await sleep(500);
  qa(".sr-body .list-item")[0].click();
  await waitFor(".page-push .card h2"); await sleep(600);
  const titleB = (q(".page-push h2") || {}).textContent || "";
  snap("detailB2");
  clickLink("無修正");
  await waitFor(".sr-layer.open"); await sleep(600);
  snap("searchY_stack");
  log.push({ step: "req-after-second-tag", last: window.__reqs[window.__reqs.length - 1] });

  const srTitleNow = () => ((q(".sr-layer.open .sr-title h2") || {}).textContent || "");
  const detailTitleNow = () => ((q(".page-push h2") || {}).textContent || "");
  const expectSearch = (want, where) => {
    const t = srTitleNow();
    if (t.indexOf(want) === -1) throw new Error("返回落点不对（" + where + "）：期望搜索页含「" + want + "」，实际 " + JSON.stringify(t));
  };
  const expectDetail = (want, where) => {
    if (!q(".page-push")) throw new Error("返回落点不对（" + where + "）：期望详情页，实际不在详情页");
    const t = detailTitleNow();
    if (want && t !== want) throw new Error("返回落点不对（" + where + "）：期望详情「" + want + "」，实际 " + JSON.stringify(t));
  };
  if (srTitleNow().indexOf("無修正") === -1) throw new Error("第二次标签搜索没有打开新搜索层：" + JSON.stringify(srTitleNow()));

  back(); await sleep(800); expectDetail(titleB, "Y→B"); snap("backToDetailB");
  back(); await sleep(800); expectSearch("巨乳", "B→X"); snap("backToSearchX2");
  back(); await sleep(800); expectDetail(titleA2, "X→A"); snap("backToDetailA2");
  back(); await sleep(900);
  if (q(".page-push") || q(".sr-layer.open")) throw new Error("最后一次返回没有回到列表（仍在 " + (q(".page-push") ? "详情" : "搜索层") + "）");
  snap("backToHome2");

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
    // Phase 1 断言：进入阅读器时页数已知 → 必须先有"比例盒骨架"（有高度），且计数器不能被
    // "scrollHeight≈0 已滚到底" 误判成一进就停在最后一页（老内核没有 content-visibility 时必现）
    const figs = qa(".jm-figure");
    const firstH = figs.length ? Math.round(figs[0].getBoundingClientRect().height) : 0;
    const pageLabel = ((q(".reader-toolbar .rt-page") || {}).textContent || "").trim();
    const nums = pageLabel.split("/").map((s) => Number((s || "").trim()));
    const skeletonFilled = qa(".jm-figure[data-ready]").length;
    log.push({ step: "reader-skeleton", figures: figs.length, firstHeight: firstH, pageLabel, loadedFigures: skeletonFilled });
    if (figs.length === 0) throw new Error("阅读器没有渲染页面骨架（.jm-figure 为空）");
    if (firstH < 100) throw new Error("页面骨架没有预留高度（" + firstH + "px）：计数器与滚动位置会飘");
    if (nums.length === 2 && Number.isFinite(nums[0]) && Number.isFinite(nums[1]) && nums[1] > 1 && nums[0] === nums[1]) {
      throw new Error("计数器一进入阅读器就跳到最后一页：" + pageLabel);
    }
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
    const versionLine = note.find((t) => /官方协议/.test(t)) || "";
    const errLines = qa(".small-err").map((e) => (e.textContent || "").trim());
    log.push({ step: "proto-drift", versionLine, errLines });
    // 桩里 jm3_version 比客户端 APP_VERSION 新 → 版本行里必须标出服务端版本（判据不能失效）；
    // 且不得再用红字报错渲染 —— 2026-09-11 真机反馈：用户把那条红字当成"应用出错"。
    if (!/服务端已到\s*2\.1\.7/.test(versionLine)) throw new Error("协议漂移说明未出现在版本行：" + JSON.stringify(versionLine));
    if (errLines.some((t) => /官方协议/.test(t))) throw new Error("协议漂移又变回红字报错了：" + errLines.join(" | "));
    // 抽屉是浮层：返回键应先关抽屉（不跳页、不退 App）
    back();
    await sleep(700);
    log.push({ step: "back-closes-drawer", drawerStillOpen: !!q(".side-drawer.open"), navTab: (q(".nav-item.active") || {}).textContent || "" });
    if (q(".side-drawer.open")) throw new Error("返回键没有关掉侧边抽屉");
    q(".menu-backdrop")?.click();
    await sleep(600);
  }

  // ---- 详情页布局面板：入口可达 + 改动真的落到详情页 + 能恢复 ----
  // 这是 core/detailLayout.ts 那层参数第一次面向用户，所以验的是**整条链**：
  // 抽屉入口 → 面板 → localStorage → 详情页重渲染。
  // 放在抽屉那一段之后（此刻在列表页、抽屉已关），结束时也会把配置恢复默认，不影响后面的 tail 步骤。
  const T = (el) => (el ? (el.textContent || "").trim() : "");
  /**
   * 打开「自定义 UI」面板，切到 wantTab。
   * 抽屉里现在只有这一个入口（原来「详情页布局」「列表页布局」各一行，是同一功能两个入口）；
   * 抽屉那行直接开在「详情页」tab，列表页要再点一下 tab。
   */
  /**
   * v3.2 外壳改版后页面切换的方式：**画廊卡片**。
   * 原来那条常驻控制条（`.ed-bar` 里的「列表页 / 详情页」分段 + 窄/标准/宽）已删除 ——
   * 页面切换改由「选择页面」屏的卡片承担（用户要的"像手机查看近期应用那样"）。
   * 按 `data-page` 选而不是按文案选：卡片里还印着缩略图的正文，文案匹配会误伤。
   */
  const CARD_SEL = ".ed-gallery .ed-card";
  const PAGE_KEY = { "列表页": "list", "详情页": "detail", "顶栏和底栏": "chrome", "阅读器": "reader" };
  const cardOf = (key) => q(".ed-gallery .ed-card[data-page='" + key + "']");
  /** 编辑屏标题 = 当前页名；画廊屏是「自定义 UI」（顶栏两屏共用，标题是屏判别器） */
  const currentPage = () => T(q(".ed-top h2"));
  /**
   * 打开「自定义 UI」，再点画廊卡片切到 wantTab。
   *
   * ⚠️ v3.13：**抽屉里那条入口已按用户要求删除**，现在唯一的入口在**设置页最上方**
   * （设置那张 section 一直是渲染着的，只是非设置 tab 时挂着 `view-hidden`）。
   *
   * 这里刻意**不点底栏「设置」切 tab**：本驱动的后面还有"在列表页点卡片"这类步骤，
   * 切到设置 tab 会把首页那个 ContentView 卸载重挂（等于换了舞台）。
   * 入口是真实存在的按钮、点击走的是真实 React 回调，只是这一支**不去管它可见与否**——
   * "用户能不能看见它"由 `driver-chrome` ⑦ 那条专门的驱动钉
   * （它断言：设置页第一个分组就是「自定义 UI」，且抽屉里没有）。
   */
  const openLayoutPanel = async (wantTab) => {
    if (!q(".ed-page")) {
      const entry = qa(".settings-page .grow").find((b) => /自定义 UI/.test(b.textContent || ""));
      if (!entry) throw new Error("设置页没有「自定义 UI」入口");
      entry.click();
      await sleep(900);
    }
    if (!q(".ed-page")) throw new Error("点了入口但自定义 UI 面板没打开");
    // v3.2：进入后先是「选择页面」画廊屏 —— 必须点卡片才进编辑屏
    if (!q(CARD_SEL)) throw new Error("进入自定义 UI 后没有出现页面画廊");
    const want = wantTab || "详情页";
    const key = PAGE_KEY[want];
    if (!key) throw new Error("未知页面名：" + want);
    const card = cardOf(key);
    if (!card) throw new Error("画廊里没有「" + want + "」卡片（现有：" + qa(CARD_SEL).map((b) => b.getAttribute("data-page")).join(" / ") + "）");
    card.click();
    await sleep(600);
    if (!q(".ed-canvas")) throw new Error("点了「" + want + "」卡片但没有进入编辑屏");
  };
  /**
   * v3.3（用户第 3 条）：**「排布总表」已删除** —— 所以这里不再有"展开面板"这一步。
   *
   * 删掉一张总表的前提是"它承载的每一类配置都还有入口"，本步逐条证明（这是本波的硬约束）：
   *   · 顶层顺序        → 画布上长按拖动（`canvas-drag` 步骤已验证）
   *   · 顶层显隐        → 区块配置栏**最上面**那个开关（下面验）
   *   · 内层顺序 / 显隐 → 点「信息栏」后的配置表（NodeOrderList；下面验）
   *   · 列表页列数 / 副标题字段 → 点列表画布里的卡片（ListCardInspector；下面验）
   *   · 恢复默认        → 顶栏「⋯」菜单里的「恢复全部默认」（下面验）
   */

  await openLayoutPanel();
  log.push({
    step: "detail-layout-open",
    title: T(q(".ed-top h2")),
    page: currentPage(),
    slim: !!q(".ed-inspector.slim"),
    styleControls: qa(".ed-inspector .dl-style").length,
    // v3.3：抓手已删除 —— 这里从"应有 8 个"反转为"必须是 0"
    grips: qa(".ed-canvas .ed-grip").length,
    drawerClosed: !q(".side-drawer.open")
  });
  // v3.2：编辑屏的标题就是当前页名（画廊屏才叫「自定义 UI」）——
  // 顺带把"从抽屉进来 → 画廊 → 点详情页卡片 → 进编辑屏"这条链断在标题上
  if (currentPage() !== "详情页") throw new Error("点「详情页」卡片后编辑屏标题不对：" + currentPage());
  // v2：没选中任何块时检查器收成一条 —— "不点就不占画布"（「挤」的解药）
  if (!q(".ed-inspector.slim")) throw new Error("没选中时检查器没有收起");
  if (qa(".ed-inspector .ditem").length) throw new Error("收起态不该渲染任何配置行");
  if (qa(".ed-canvas .ed-grip").length !== 0) throw new Error("块上仍有抓手（v3.3 已删）：" + qa(".ed-canvas .ed-grip").length);

  // ① 面板确实消失了：菜单里没有「排布总表」，检查器里没有 .ed-panels
  q(".ed-more").click();
  await sleep(250);
  const menuItems = qa(".ed-menu .ed-menuitem").map(T);
  log.push({ step: "layout-panel-removed", menuItems, panels: qa(".ed-inspector .ed-panels").length });
  if (menuItems.some((x) => /排布总表/.test(x))) throw new Error("「⋯」菜单里还有「排布总表」：" + JSON.stringify(menuItems));
  if (qa(".ed-inspector .ed-panels").length) throw new Error("检查器里还有折叠面板容器 .ed-panels");
  const scrim = q(".ed-scrim"); if (scrim) { scrim.click(); await sleep(200); }

  // ② 内层配置的新家：点「**主视觉**」→ 它的配置里同时有「左右栏」「信息栏内的顺序」(3)
  //    与「四宫格字段」(4) —— 三层都在同一处。
  //
  //    ⚠️ v3.5（用户第 3 条）：内层**不再是可点选的模块**（「主视觉是一个大模块，
  //    封面信息栏和四宫格等等也是在主视觉的配置里设置，而不是也都做成可点击的模块」），
  //    所以这里不再点 `.ed-slot[data-blk=info]`（那个元素已经不存在），
  //    而是点顶层 `hero` 块 —— 三层内层配置都挂在它下面（可达性硬约束）。
  const infoBlk = q(".ed-canvas .ed-blk[data-blk='hero']");
  if (!infoBlk) throw new Error("画布里找不到「主视觉」块（.ed-blk[data-blk=hero]）");
  infoBlk.click();
  await sleep(400);
  const nodeRows = qa(".ed-inspector .ed-nodelist .ditem");
  const nodeSwitches = qa(".ed-inspector .ed-nodelist .ditem button.switch").length;
  log.push({
    step: "detail-inspector-entries",
    nodeRows: nodeRows.length,
    nodeSwitches,
    rowLabels: nodeRows.map((d) => T(d.querySelector(".dl-label"))),
    stepArrows: qa(".ed-inspector .ed-module .dl-step").length,
    hasDone: !!q(".ed-inspector .ed-module .ed-paneldone")
  });
  // 2 + 3 + 4 = 9 行（左右栏：封面 / 信息栏；信息栏内：标题 / 四宫格 / 数据条；
  // 四宫格字段：作者 / 话数 / JM号 / 收录）。v3.5 之前"信息栏内 + 四宫格字段"那 7 行
  // 只有点中 `info` 才看得到 —— 内层不可点选之后，那 7 行必须**也在 hero 这里**出现，
  // 否则就是"配置项没有入口"（门禁不会因此变红的那种坑）。这 9 行都应允许隐藏。
  if (nodeRows.length !== 9) throw new Error("「主视觉」配置里的内层节点行数不对（应 2+3+4=9 行）：" + nodeRows.length);
  if (nodeSwitches !== 8) {
    throw new Error("内层节点开关数不对（应 8 个：封面 + 标题/四宫格/数据条 + 四个字段；" +
      "信息栏自己不可隐藏）：" + nodeSwitches);
  }
  // v3.3（用户第 5 / 9 条）：▲▼ 已删；右上角有「完成」
  if (qa(".ed-inspector .ed-module .dl-step").length) throw new Error("区块配置栏里还有 ▲▼（v3.3 已删，位置靠长按拖动）");
  if (!q(".ed-inspector .ed-module .ed-paneldone")) throw new Error("区块配置栏右上角没有「完成」按钮");
  // ⚠️ 「显示 / 隐藏」那一行**只在可隐藏的节点上**渲染（信息栏自己不可隐藏 → 它没有这一行），
  //    所以那条断言放在下面的「标签」步骤里 —— 那里才是可隐藏的块。

  // ③ 顶层显隐的新入口：选中「标签」→ 用配置栏最上面那个开关关掉它 → 配置要立刻落盘
  const tagBlk = qa(".ed-canvas .ed-blk").find((b) => b.getAttribute("data-blk") === "tags");
  if (!tagBlk) throw new Error("画布里找不到「标签」块");
  tagBlk.click();
  await sleep(400);
  // v3.3（用户第 5 条）：可隐藏的块，配置栏**最上面一条**就是「显示 / 隐藏」
  const showRow = q(".ed-inspector .ed-module .dl-rows");
  log.push({
    step: "detail-show-row-first",
    showRowFirst: !!showRow && /ed-showrow/.test(showRow.className),
    label: showRow ? T(showRow.querySelector(".dl-label")) : null
  });
  if (!showRow || !/ed-showrow/.test(showRow.className)) throw new Error("「显示 / 隐藏」不在区块配置栏的最上面");
  const showSw = q(".ed-inspector .ed-showrow button.switch");
  if (!showSw) throw new Error("选中「标签」后，配置栏最上面没有显示 / 隐藏开关");
  showSw.click();
  await sleep(350);
  const savedHidden = (JSON.parse(localStorage.getItem("jmclient.detailLayout.v1") || "{}").hidden) || [];
  log.push({ step: "detail-layout-toggled", savedHidden });
  if (savedHidden.indexOf("tags") < 0) throw new Error("关掉「标签」没有写进配置：" + JSON.stringify(savedHidden));

  // 关编辑器 → 进详情 → 标签胶囊整块应该不在
  q(".ed-back").click();
  await sleep(700);
  const dlCard = q(".list-item");
  if (!dlCard) throw new Error("没有列表卡片可点，无法验证布局是否真的生效");
  dlCard.click();
  await waitFor(".page-push .card h2"); await sleep(700);
  log.push({
    step: "detail-layout-applied",
    tagchips: qa(".page-push .tagchip").length,
    actorsBlock: qa(".page-push .d-actors").length,
    heroStillThere: !!q(".page-push .d-hero")
  });
  if (qa(".page-push .tagchip").length) throw new Error("配置里关掉了「标签」，详情页却还有标签胶囊");
  // 别的区块不受影响（关一个不该连带关掉邻居）
  if (!q(".page-push .d-hero")) throw new Error("关掉「标签」把主视觉也弄没了");
  if (!qa(".page-push .d-actors").length) throw new Error("关掉「标签」把登场人物也弄没了");

  // 回列表 → 从「⋯」菜单恢复默认（v3.3：总表的那颗按钮没了，恢复默认由菜单承担）
  back(); await sleep(900);
  await openLayoutPanel();
  q(".ed-more").click(); await sleep(250);
  const resetItem = qa(".ed-menu .ed-menuitem").find((b) => /恢复/.test(T(b)));
  if (!resetItem) throw new Error("「⋯」菜单里找不到「恢复全部默认」");
  resetItem.click();
  await sleep(500);
  const restoredHidden = (JSON.parse(localStorage.getItem("jmclient.detailLayout.v1") || "{}").hidden) || [];
  log.push({
    step: "detail-layout-restored",
    restoredHidden,
    offRows: qa(".ed-inspector .ditem.dl-off").length
  });
  if (restoredHidden.length) throw new Error("「恢复全部默认」没有清掉 hidden：" + JSON.stringify(restoredHidden));
  q(".ed-back").click();
  await sleep(700);

  // ---- 样式与大小 v2：选中模块 → 专属检查器 → 有界滑块 → 真的落到详情页 DOM ----
  // 这条链是 core/detailStyle.ts → 内联 style（几何）+ data-dl-*（观测钩子）→ 详情页。
  // 单测能覆盖前两段，唯独「真的改到了渲染出来的详情页」只能在真页面上验。
  await openLayoutPanel();
  // ① 点画布第 2 块（主视觉）→ 检查器弹出**这一块**的配置：封面 / 标题两个滑块
  qa(".ed-canvas .ed-blk")[1].click();
  await sleep(300);
  const coverSlider = q('.ed-inspector [data-style-key="cover"] input[type="range"]');
  if (!coverSlider) throw new Error("选中主视觉后没出现「封面大小」滑块");
  const heroControls = qa(".ed-inspector [data-style-key]").length;
  /**
   * v3：主视觉从 2 项扩到 4 项（+ 数据条字号 / 四宫格字号）。
   * v3.10：又加了「封面排布」（左图右文 / 封面居中）⇒ 5 项。
   * 这条断言的**判据**是"主视觉的专属项就是这几项、不多不少"（防止别的块的键漏到这一块），
   * 所以加轴时必须一起更新 —— 下面还把**键名**也钉住，光看数量漏不进东西。
   */
  const heroKeys = qa(".ed-inspector [data-style-key]").map((e) => e.getAttribute("data-style-key"));
  if (heroControls !== 5) {
    throw new Error("主视觉的专属配置应为 5 项（封面 / 封面排布 / 标题 / 数据条字号 / 四宫格字号），实际：" +
      heroControls + " → " + heroKeys.join(","));
  }
  if (heroKeys.join(",") !== "cover,heroLayout,title,statFont,factFont") {
    throw new Error("主视觉的专属配置项不对（顺序 / 成员）：" + heroKeys.join(","));
  }
  // ② 拖滑块到 140（React 的 onChange 挂在 input 事件上：原生 setter + dispatch input）
  const setRange = (input, v) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value").set;
    setter.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  setRange(coverSlider, 140);
  await sleep(300);
  const styleSaved = JSON.parse(localStorage.getItem("jmclient.detailStyle.v1") || "{}");
  log.push({
    step: "detail-style-set",
    savedCover: styleSaved.cover,
    coverOut: T(q('.ed-inspector [data-style-key="cover"] .dl-out')),
    resetBtns: qa(".ed-inspector .dl-reset").length,
    dot: !!q(".ed-inspector .dl-dot")
  });
  if (styleSaved.cover !== 140) throw new Error("滑块值没有落盘：" + JSON.stringify(styleSaved));
  if (!qa(".ed-inspector .dl-reset").length) throw new Error("改过之后没有出现单项复位 ↺");
  if (!q(".ed-inspector .dl-dot")) throw new Error("改过之后没点圆点");
  q(".ed-back").click();
  await sleep(700);
  // 进详情页 → .detail-card 上挂着 data-dl-cover="140"（观测钩子），封面实测 140 宽（内联 style）
  const styleCard = q(".list-item");
  if (!styleCard) throw new Error("没有列表卡片可点，无法验证样式是否生效");
  styleCard.click();
  await waitFor(".page-push .detail-card"); await sleep(700);
  const dCard = q(".page-push .detail-card");
  const coverBox = q(".page-push .d-cover-box");
  const coverW = coverBox ? Math.round(coverBox.getBoundingClientRect().width) : 0;
  log.push({
    step: "detail-style-applied",
    dlAttrs: Array.from(dCard.attributes).map((a) => a.name + "=" + a.value).filter((s) => s.indexOf("data-dl-") === 0),
    coverW
  });
  if (dCard.getAttribute("data-dl-cover") !== "140") {
    throw new Error("详情页上没有 data-dl-cover=140：" + Array.from(dCard.attributes).map((a) => a.name).join(","));
  }
  if (coverW !== 140) throw new Error("封面宽度不对（期望 140，实测 " + coverW + "）");
  back(); await sleep(900);
  // 单项复位 ↺：只收回这一项，别的不动（重新进编辑器后选中已清空，先选回主视觉）
  await openLayoutPanel();
  qa(".ed-canvas .ed-blk")[1].click();
  await sleep(300);
  const one = qa(".ed-inspector .dl-reset").find((b) => (b.getAttribute("aria-label") || "").indexOf("封面") >= 0) || qa(".ed-inspector .dl-reset")[0];
  if (!one) throw new Error("改过之后没有单项复位按钮");
  one.click();
  await sleep(300);
  const afterReset = JSON.parse(localStorage.getItem("jmclient.detailStyle.v1") || "{}");
  log.push({ step: "detail-style-reset-one", savedCover: afterReset.cover, resetBtns: qa(".ed-inspector .dl-reset").length });
  if ((afterReset.cover ?? 104) !== 104) throw new Error("单项复位没有把封面收回默认：" + JSON.stringify(afterReset));
  if (qa(".ed-inspector .dl-reset").length) throw new Error("全部回默认后单项复位按钮还留着");
  q(".ed-back").click();
  await sleep(700);

  // ---- 画布交互：点选 / 直接拖拽 / 预览态 ----
  // 这三样是「自定义 UI」作为**编辑器页**（而不是弹层）才有的能力，也是本轮的收口。
  // 预览态那三条用 `getComputedStyle` 判可见性 —— display:none 的节点仍在 DOM 里，数 length 会误判。
  await openLayoutPanel();
  const visCount = (sel) => qa(sel).filter((e) => getComputedStyle(e).display !== "none").length;
  const blkOrder = () => qa(".ed-canvas .ed-blk").map((b) => b.getAttribute("data-blk"));
  // ⚠️ v3.4（Wave I）：顶层块从 8 变 7 —— `notice`（付费提示）已并入动作区主按钮、不再是区块。
  //    这条数字是"块集合有没有被多渲染/少渲染"的哨兵，所以**跟着改数字、形状不变**。
  if (qa(".ed-canvas .ed-blk").length !== 7) throw new Error("画布块数不对（应为 7 个顶层块，v3.4 起 notice 已下线）：" + qa(".ed-canvas .ed-blk").length);

  // ①′ 删掉的功能必须是"真的不存在"（不只是从清单里少一项）：
  //   · 画布上不该再有「付费提示」那个空壳块（它的 id 还在类型里，最容易被人"顺手加回来"）；
  //   · 检查器里不该再有「提示字号」这个**改不动任何东西**的哑滑块（它连键都删了）。
  //   注意判据落在**可见文本 / 渲染结果**上，不是"代码里没有那个字符串"。
  if (qa('.ed-canvas [data-blk="notice"]').length) {
    throw new Error("画布上还有「付费提示」块（v3.4 已并入动作区主按钮，不该再渲染）：" + qa('.ed-canvas [data-blk="notice"]').length);
  }
  if (/提示字号/.test(document.body.textContent || "")) {
    throw new Error("界面上又出现了「提示字号」（付费提示已下线；这个滑块改不动任何东西 = 哑控件）");
  }

  // ① 点选：点第 3 块 → 恰好选中它，检查器弹出**这一块**的专属配置（v2：上下文检查器）
  qa(".ed-canvas .ed-blk")[2].click();
  await sleep(300);
  log.push({
    step: "canvas-select",
    selBlocks: qa(".ed-canvas .ed-blk.ed-sel").length,
    inspectorSays: T(q(".ed-module .grpname .dl-from")),
    module: (q(".ed-module") || {}).getAttribute ? q(".ed-module").getAttribute("data-module") : null
  });
  if (qa(".ed-canvas .ed-blk.ed-sel").length !== 1) {
    throw new Error("点一下应恰好选中一块，实际：" + qa(".ed-canvas .ed-blk.ed-sel").length);
  }
  if (!/第 3 块/.test(T(q(".ed-module .grpname .dl-from")))) {
    throw new Error("检查器没跟着选中走：" + T(q(".ed-module .grpname .dl-from")));
  }

  // ①b v3 槽位（红线）：**没动过宽度**时容器一个槽位属性都不该有；
  //     宽度档位控件要在（点谁配谁的一部分）。
  //     注：并排/窄屏降级那两条靠 CSS 媒体查询，driver 改不了视口 →
  //     那两条在 tools/e2e/slot-layout.mjs（CDP 视口模拟）里验。
  {
    const card = q(".ed-canvas .detail-card");
    const slotAttrBefore = card ? card.getAttribute("data-slots") : "no-card";
    const spanBtns = qa(".ed-inspector .ed-span button").map((b) => T(b));
    log.push({ step: "canvas-slot-default", slotAttrBefore, spanBtns });
    if (slotAttrBefore !== null) {
      throw new Error("默认配置下 .detail-card 不该有 data-slots（线上 DOM 逐字不变的红线）：" + slotAttrBefore);
    }
    if (spanBtns.length !== 6) {
      throw new Error("检查器里应有 6 个宽度档位（满宽/3-4/2-3/1-2/1-3/1-4），实际：" + JSON.stringify(spanBtns));
    }
    // v3.4：用户第 7 条点名要的 3/4 档（9 列）—— 这条不是"放宽到 6 个"，而是**要求它必须在**
    if (spanBtns.indexOf("3/4") < 0) {
      throw new Error("宽度档位里缺 3/4（用户第 7 条点名要的档位）：" + JSON.stringify(spanBtns));
    }
  }

  // ①c v3 槽位：点「1/2」→ 容器属性 + 块属性 + 落盘版本三处都要跟上；再点「满宽」→ 红线复原
  {
    const selId = (q(".ed-canvas .ed-blk.ed-sel") || {}).getAttribute
      ? q(".ed-canvas .ed-blk.ed-sel").getAttribute("data-blk") : null;
    const half = qa(".ed-inspector .ed-span button").find((b) => T(b) === "1/2");
    if (!half) throw new Error("找不到「1/2」宽度档位");
    half.click();
    await sleep(400);
    const onAttr = q(".ed-canvas .detail-card").getAttribute("data-slots");
    const selBlk = q(".ed-canvas .ed-blk.ed-sel");
    const spanAttr = selBlk ? selBlk.getAttribute("data-span") : null;
    const saved = JSON.parse(localStorage.getItem("jmclient.detailLayout.v1") || "{}");
    log.push({ step: "canvas-slot-half", onAttr, spanAttr, selId, version: saved.version, spans: saved.spans });
    if (onAttr !== "1") throw new Error("设了半宽后容器应有 data-slots=1：" + onAttr);
    if (spanAttr !== "6") throw new Error("选中的块应有 data-span=6：" + spanAttr);
    if (saved.version !== 3) throw new Error("改宽度应把配置升到 version 3：" + saved.version);
    if (!saved.spans || !selId || saved.spans[selId] !== 6) {
      throw new Error("半宽没落盘：" + JSON.stringify(saved.spans));
    }

    const full = qa(".ed-inspector .ed-span button").find((b) => T(b) === "满宽");
    if (!full) throw new Error("找不到「满宽」档位");
    full.click();
    await sleep(400);
    const offAttr = q(".ed-canvas .detail-card").getAttribute("data-slots");
    const saved2 = JSON.parse(localStorage.getItem("jmclient.detailLayout.v1") || "{}");
    log.push({ step: "canvas-slot-restore", offAttr, spans: saved2.spans });
    if (offAttr !== null) {
      throw new Error("恢复满宽后容器不该再有 data-slots（红线要能复原）：" + offAttr);
    }
    if (saved2.spans && Object.keys(saved2.spans).length) {
      throw new Error("恢复满宽后 spans 应清空（不残留 v3 痕迹）：" + JSON.stringify(saved2.spans));
    }
  }

  // ①d v3.4：宽度 **3/4 档** + 行内**位置**（用户第 7 条）—— 全部要几何证据，不只看属性
  {
    const boxOf = (el) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width) };
    };
    const selBlk = () => q(".ed-canvas .ed-blk.ed-sel");
    const pickSpan = (label) => {
      const b = qa(".ed-inspector .ed-span button").find((x) => T(x) === label);
      if (!b) throw new Error("找不到宽度档位「" + label + "」");
      return b;
    };
    const savedCfg = () => JSON.parse(localStorage.getItem("jmclient.detailLayout.v1") || "{}");

    // ①d-1 3/4：实宽必须落在 1/2 与满宽之间，且 data-span=9
    pickSpan("1/2").click(); await sleep(400);
    const halfBox = boxOf(selBlk());
    pickSpan("3/4").click(); await sleep(400);
    const q3Box = boxOf(selBlk());
    const ratio = halfBox.w ? q3Box.w / halfBox.w : 0;
    log.push({
      step: "canvas-span-34",
      span: selBlk().getAttribute("data-span"),
      halfW: halfBox.w, threeQW: q3Box.w, ratio: Number(ratio.toFixed(3))
    });
    if (selBlk().getAttribute("data-span") !== "9") {
      throw new Error("3/4 档没落到 data-span=9：" + selBlk().getAttribute("data-span"));
    }
    if (!(ratio > 1.35 && ratio < 1.65)) {
      throw new Error("3/4 实宽 / 1/2 实宽 应≈1.5（9 列 vs 6 列），实为 " + ratio.toFixed(3));
    }

    // ①d-2 9 + 3 必须同处一行 —— "能凑满一行"就是 3/4 这个档位存在的理由
    const selIdx = qa(".ed-canvas .ed-blk").indexOf(selBlk());
    const mate = qa(".ed-canvas .ed-blk")[selIdx + 1];
    if (!mate) throw new Error("3/4 用例需要后面还有一块（拿 1/4 来凑满一行）");
    mate.click(); await sleep(320);
    pickSpan("1/4").click(); await sleep(400);
    const a9 = boxOf(qa(".ed-canvas .ed-blk")[selIdx]);
    const b3 = boxOf(qa(".ed-canvas .ed-blk")[selIdx + 1]);
    log.push({ step: "canvas-span-9plus3", a: a9, b: b3, sameRow: Math.abs(a9.top - b3.top) < 3 });
    if (Math.abs(a9.top - b3.top) >= 3) {
      throw new Error("9 列 + 3 列应当同处一行（9+3=12），实际 top " + a9.top + " vs " + b3.top);
    }
    if (!(b3.left > a9.left)) throw new Error("1/4 块应当在 3/4 块右边：" + a9.left + " vs " + b3.left);

    // ①d-3 行内位置：把这块（1/4）改成 1/2 再点「中」→ 必须真的右移，且两侧各有一个空占位格
    pickSpan("1/2").click(); await sleep(400);
    const offBefore = boxOf(selBlk());
    const midBtn = qa(".ed-inspector .ed-offsetseg button").find((b) => T(b) === "中");
    if (!midBtn) throw new Error("配置栏里没有「位置 → 中」按钮（用户第 7 条）");
    midBtn.click(); await sleep(450);
    const offAfter = boxOf(selBlk());
    const cfgNow = savedCfg();
    const curId = selBlk().getAttribute("data-blk");
    const prevGap = selBlk().previousElementSibling;
    const nextGap = selBlk().nextElementSibling;
    const prevIsGap = !!(prevGap && prevGap.classList && prevGap.classList.contains("d-gap"));
    const nextIsGap = !!(nextGap && nextGap.classList && nextGap.classList.contains("d-gap"));
    const pw = prevIsGap ? boxOf(prevGap).w : 0;
    const nw = nextIsGap ? boxOf(nextGap).w : 0;
    const shift = offAfter.left - offBefore.left;
    log.push({
      step: "canvas-offset-center",
      id: curId, leftBefore: offBefore.left, leftAfter: offAfter.left, shift,
      w: offAfter.w, prevGap: pw, nextGap: nw, offsets: cfgNow.offsets, gaps: qa(".ed-canvas .d-gap").length
    });
    if (!cfgNow.offsets || cfgNow.offsets[curId] !== 3) {
      throw new Error("点「中」没把 offset=3 落盘：" + JSON.stringify(cfgNow.offsets));
    }
    if (!(shift > 30)) throw new Error("点「中」之后块没有真的右移（shift=" + shift + "px）");
    if (!prevIsGap || !nextIsGap) {
      throw new Error("1/2 块居中后左右应当各是一个空占位格：prev=" + prevIsGap + " next=" + nextIsGap);
    }
    // 空占位格必须真的**占住列**：两侧都该恰好是 3 列宽（12 列制、1/2 居中）
    if (Math.abs(pw - nw) > 1.5) {
      throw new Error("两侧空占位格宽度不等（3 列 vs 3 列），实际 " + pw + " vs " + nw);
    }
    if (!(pw > 20)) throw new Error("空占位格宽度太小，没真的占住 3 列：" + pw);
    if (!(offAfter.left - a9.left >= 0)) throw new Error("居中后块跑到了这一行左边界之外");

    // ①d-4 复原：两块都回满宽 → 空占位格与 data-slots 一起消失（红线要能复原）
    pickSpan("满宽").click(); await sleep(380);
    qa(".ed-canvas .ed-blk")[selIdx].click(); await sleep(320);
    pickSpan("满宽").click(); await sleep(400);
    const cfgEnd = savedCfg();
    log.push({
      step: "canvas-offset-restore",
      slotsAttr: q(".ed-canvas .detail-card").getAttribute("data-slots"),
      gaps: qa(".ed-canvas .d-gap").length,
      spans: cfgEnd.spans, offsets: cfgEnd.offsets
    });
    if (q(".ed-canvas .detail-card").getAttribute("data-slots") !== null) {
      throw new Error("复原满宽后仍挂着 data-slots");
    }
    if (qa(".ed-canvas .d-gap").length !== 0) {
      throw new Error("没有窄块时不该有空占位格：" + qa(".ed-canvas .d-gap").length);
    }
    if ((cfgEnd.spans && Object.keys(cfgEnd.spans).length) || (cfgEnd.offsets && Object.keys(cfgEnd.offsets).length)) {
      throw new Error("复原后 spans/offsets 应清空：" + JSON.stringify({ spans: cfgEnd.spans, offsets: cfgEnd.offsets }));
    }
  }

  // ①e v3.5：`detail` 的三个面板**各自可隐藏**（用户第 4 条前半）
  //     + 「至少留一个」被**解释**而不是静默吞掉（"要解释，不要哑掉"）。
  //
  //     ⚠️ 这一段的顺序是刻意的：面板显隐要在**默认形态（横栏）**下验 ——
  //      "只剩一个就不画横栏"这条规则只对横栏形态成立（折叠形态没有横栏可言）。
  const savedCfgV35 = () => JSON.parse(localStorage.getItem("jmclient.detailLayout.v1") || "{}");
  const detailBlk = () => qa(".ed-canvas .ed-blk").find((b) => b.getAttribute("data-blk") === "detail");
  const panelRow = (id) => qa(".ed-inspector .ed-nodelist .ditem").find((d) => d.getAttribute("data-node") === id);
  const panelSwitch = (id) => { const r = panelRow(id); return r ? r.querySelector("button.switch") : null; };
  {
    const tabsNow = () => qa(".ed-canvas .d-tabs .tk").map(T);
    if (!detailBlk()) throw new Error("画布里找不到「目录 / 评论 / 相关漫画」块");
    log.push({
      step: "detail-panel-baseline",
      tabs: tabsNow(),
      foldRows: qa(".ed-canvas .d-fold .d-fold-item").length,
      savedForms: savedCfgV35().forms
    });
    if (tabsNow().length !== 3) throw new Error("默认应渲染 3 个面板标签：" + JSON.stringify(tabsNow()));
    if (qa(".ed-canvas .d-fold .d-fold-item").length) throw new Error("没配过形态就出现了折叠行（红线：线上 DOM 不该变）");

    detailBlk().click();
    await sleep(350);
    const panelIds = qa(".ed-inspector .ed-nodelist .ditem").map((d) => d.getAttribute("data-node"));
    log.push({ step: "detail-panel-rows", panelIds, switches: qa(".ed-inspector .ed-nodelist .ditem button.switch").length });
    if (panelIds.join("|") !== "dir|cmt|rel") {
      throw new Error("「目录 / 评论 / 相关漫画」的配置行不对（应 dir|cmt|rel）：" + JSON.stringify(panelIds));
    }

    // 关掉「相关漫画」→ 横栏剩 2 个；再关「评论」→ 只剩目录，**横栏消失**
    panelSwitch("rel").click(); await sleep(350);
    const afterOne = tabsNow();
    panelSwitch("cmt").click(); await sleep(350);
    const afterTwo = tabsNow();
    log.push({
      step: "detail-panels-hidden",
      afterOne, afterTwo, tabBar: !!q(".ed-canvas .d-tabs"),
      dirBody: !!q(".ed-canvas .chap-list"), savedHidden: savedCfgV35().hidden
    });
    if (afterOne.join("|") !== "目录|评论") throw new Error("关掉相关漫画后横栏不对：" + JSON.stringify(afterOne));
    if (q(".ed-canvas .d-tabs")) throw new Error("只剩一个面板时不该再画横栏（一个标签的横栏白占一行）");
    if (!q(".ed-canvas .chap-list")) throw new Error("只剩目录时目录面板必须照常渲染");

    // 【关键】不许三个全关：点最后一个 → **配置不变**、并且**给出一行说明**
    panelSwitch("dir").click(); await sleep(350);
    const refuseEl = q(".ed-inspector .ed-refuse");
    const savedHiddenNow = savedCfgV35().hidden || [];
    log.push({
      step: "detail-panel-refuse",
      hidden: savedHiddenNow,
      refuseText: refuseEl ? T(refuseEl).slice(0, 24) : null,
      dirStillThere: !!q(".ed-canvas .chap-list")
    });
    if (savedHiddenNow.indexOf("dir") >= 0) throw new Error("三个面板被全关掉了（应当拒绝）：" + JSON.stringify(savedHiddenNow));
    if (!q(".ed-canvas .chap-list")) throw new Error("拒绝之后目录面板不该消失");
    if (!refuseEl) throw new Error("点到最后一个面板被拒时没有给出任何说明（= 点了没反应，哑控件同罪）");

    // 复原：两个都打开 → 横栏回到 3 个标签
    panelSwitch("cmt").click(); await sleep(300);
    panelSwitch("rel").click(); await sleep(350);
    log.push({ step: "detail-panels-restored", tabs: tabsNow(), hidden: savedCfgV35().hidden });
    if (tabsNow().length !== 3) throw new Error("复原后横栏没有回到 3 个标签：" + JSON.stringify(tabsNow()));
  }

  // ①f v3.5：`detail` 的**形态**（用户第 4 条后半：「切换成折叠起来的三行的形态」）
  //     + 编辑态与预览态的**点击语义不同**（编辑态点它 = 选中区块，不是展开）。
  {
    const formBtns = () => qa(".ed-inspector .ed-formseg button").map(T);
    const foldRows = () => qa(".ed-canvas .d-fold .d-fold-item");
    const foldNames = () => qa(".ed-canvas .d-fold-name").map(T);
    const modeBtn = (label) => qa(".ed-modeswitch button").find((b) => T(b) === label);

    detailBlk().click();
    await sleep(350);
    log.push({ step: "detail-form-picker", formBtns: formBtns(), cur: T(q(".ed-inspector .ed-form .dl-from")) });
    if (formBtns().join("|") !== "标签页|折叠三行") {
      throw new Error("「形态」档位不对（应 标签页 / 折叠三行）：" + JSON.stringify(formBtns()));
    }
    // 没有形态可选的块**不该**出现这一行（只有一个形态 = 没得选 = 哑控件）
    qa(".ed-canvas .ed-blk")[2].click();
    await sleep(300);
    if (qa(".ed-inspector .ed-formseg").length) throw new Error("没有形态可选的区块也渲染了「形态」档位行");
    detailBlk().click();
    await sleep(300);

    const foldBtn = qa(".ed-inspector .ed-formseg button").find((b) => T(b) === "折叠三行");
    if (!foldBtn) throw new Error("配置栏里找不到「折叠三行」档位");
    foldBtn.click();
    await sleep(450);
    log.push({
      step: "detail-fold-rows",
      rows: foldRows().length,
      names: foldNames(),
      tabsGone: !q(".ed-canvas .d-tabs"),
      saved: savedCfgV35().forms
    });
    if (savedCfgV35().forms.detail !== "folded") throw new Error("折叠形态没落盘：" + JSON.stringify(savedCfgV35().forms));
    if (foldRows().length !== 3) throw new Error("折叠形态应有 3 行：" + foldRows().length);
    if (q(".ed-canvas .d-tabs")) throw new Error("折叠形态下不该再渲染横栏");
    // 画布样例：series 3 话 / 评论无数据 / 无相关漫画 → 计数只在该有的时候出现
    if (foldNames().join("|") !== "目录 3 话|评论|相关漫画") {
      throw new Error("折叠行文案不对：" + JSON.stringify(foldNames()));
    }

    // ---- 编辑态：行是静态 div；点它 = **选中区块**，绝不是展开 ----
    const heads = qa(".ed-canvas .d-fold-head");
    if (heads.length !== 3) throw new Error("折叠行头数量不对：" + heads.length);
    if (heads.some((h) => h.tagName === "BUTTON")) {
      throw new Error("编辑态的折叠行头是 button（应静态 div —— 否则「点一下」会和「选中区块」抢手势）");
    }
    qa(".ed-canvas .ed-blk")[0].click();     // 先把选中挪走，确保下面那次点击是"有效变化"
    await sleep(300);
    q(".ed-canvas .d-fold-head").click();
    await sleep(350);
    const selEl = q(".ed-canvas .ed-blk.ed-sel");
    log.push({
      step: "detail-fold-edit-click",
      selected: selEl ? selEl.getAttribute("data-blk") : null,
      bodies: qa(".ed-canvas .d-fold-body").length,
      headTag: q(".ed-canvas .d-fold-head").tagName
    });
    if (!selEl || selEl.getAttribute("data-blk") !== "detail") {
      throw new Error("编辑态点折叠行没有选中该区块（应选中 detail）：" + (selEl && selEl.getAttribute("data-blk")));
    }
    if (qa(".ed-canvas .d-fold-body").length) throw new Error("编辑态点折叠行把内容展开了（编辑态不该可交互）");

    // ---- 预览态：点一下展开、再点收起 ----
    if (!modeBtn("预览")) throw new Error("顶栏找不到「预览」按钮");
    modeBtn("预览").click();
    await sleep(500);
    qa(".ed-canvas .d-fold-head")[0].click();
    await sleep(400);
    const bodyCnt = qa(".ed-canvas .d-fold-body").length;
    const dirShown = !!q(".ed-canvas .d-fold-body .chap-list");
    qa(".ed-canvas .d-fold-head")[0].click();
    await sleep(350);
    const closedCnt = qa(".ed-canvas .d-fold-body").length;
    log.push({ step: "detail-fold-preview", bodyCnt, dirShown, closedCnt });
    if (bodyCnt !== 1 || !dirShown) throw new Error("预览态点第一行没有展开目录：" + bodyCnt + "/" + dirShown);
    if (closedCnt !== 0) throw new Error("预览态再点一次没有收起：" + closedCnt);

    // ---- 复原：回编辑态 + 形态回「标签页」----
    modeBtn("编辑").click();
    await sleep(450);
    detailBlk().click();
    await sleep(320);
    const backToTabs = qa(".ed-inspector .ed-formseg button").find((b) => T(b) === "标签页");
    if (!backToTabs) throw new Error("恢复默认形态的档位找不到");
    backToTabs.click();
    await sleep(450);
    log.push({
      step: "detail-form-restored",
      forms: savedCfgV35().forms,
      tabs: qa(".ed-canvas .d-tabs .tk").map(T),
      foldRows: foldRows().length
    });
    if (savedCfgV35().forms && savedCfgV35().forms.detail) {
      throw new Error("形态复位后 forms 应清空（默认不写）：" + JSON.stringify(savedCfgV35().forms));
    }
    if (qa(".ed-canvas .d-tabs .tk").length !== 3) throw new Error("形态复位后横栏没有回来");
    if (foldRows().length) throw new Error("形态复位后仍留着折叠行");
  }

  // ② 画布上**长按整块**拖（v2）：长按起拖 → 拖动中兄弟块让位（FLIP）→ 落点即所得
  const beforeOrder = blkOrder();
  const blk0 = qa(".ed-canvas .ed-blk")[0];
  const flipOf = () => Number(q(".ed-canvas").getAttribute("data-flip") || "0");
  const flipBefore = flipOf();
  /** v3 落盘时机：localStorage 里的顺序（拖动中必须**不变**，松手才变） */
  const savedOf = () => JSON.parse(localStorage.getItem("jmclient.detailLayout.v1") || "{}").blocks;
  const savedBefore = savedOf();
  /** 合成 pointer 事件（带 pointerType，走长按那条分支） */
  const pt = (type, y) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, clientX: 20 });
    Object.defineProperty(ev, "pointerType", { value: "touch" });
    Object.defineProperty(ev, "pointerId", { value: 1 });
    return ev;
  };
  blk0.dispatchEvent(pt("pointerdown", 0));
  await sleep(400); // 过长按阈值（280ms）
  if (!blk0.classList.contains("ed-drag")) throw new Error("长按 280ms 后没有进入拖动态");
  blk0.dispatchEvent(pt("pointermove", 3000));
  await sleep(250); // 等让位动画跑
  const midOrder = blkOrder();
  const midDrag = qa(".ed-canvas .ed-blk.ed-drag").length;
  const flipAfter = flipOf();
  const savedMidDrag = savedOf(); // 拖动进行中：应当还是拖动前的旧顺序（v3：不落盘）
  blk0.dispatchEvent(pt("pointerup", 3000));
  await sleep(300);
  const afterOrder = blkOrder();
  const savedAfterDrop = savedOf(); // 松手后：应当是落位后的新顺序（v3：提交一次）
  log.push({
    step: "canvas-drag",
    beforeOrder, midOrder, afterOrder,
    midDrag, flipRan: flipAfter > flipBefore,
    savedBefore, savedMidDrag, savedAfterDrop,
    savedBlocks: savedOf()
  });
  if (afterOrder[afterOrder.length - 1] !== beforeOrder[0]) {
    throw new Error("画布拖拽没有把第一块移到最后：" + JSON.stringify(afterOrder));
  }
  // 避让要**边拖边生效**：中途顺序就已经在换，兄弟块让位动画真的跑过
  if (midOrder[midOrder.length - 1] !== beforeOrder[0]) {
    throw new Error("拖动中途没有实时换位：" + JSON.stringify(midOrder));
  }
  if (midDrag !== 1) throw new Error("拖动态没挂对（应恰好 1 块）：" + midDrag);
  if (!(flipAfter > flipBefore)) throw new Error("兄弟块让位动画没跑过（data-flip 没长）");
  // v3 落盘时机（本条的由来：以前每帧 pointermove 都落盘 + 广播，中端机就是"卡"）：
  //   拖动进行中 localStorage 必须**一个字都没写**；松手后必须**一次**写成落位后的顺序。
  if (JSON.stringify(savedMidDrag) !== JSON.stringify(savedBefore)) {
    throw new Error("拖动中就落盘了（v3 要求松手才提交）：" + JSON.stringify(savedMidDrag) + " ← " + JSON.stringify(savedBefore));
  }
  if (JSON.stringify(savedAfterDrop) !== JSON.stringify(afterOrder)) {
    throw new Error("松手后没落盘或顺序不对：saved=" + JSON.stringify(savedAfterDrop) + " dom=" + JSON.stringify(afterOrder));
  }
  if (qa(".ed-canvas .ed-blk.ed-drag").length) throw new Error("松手后还挂着拖动态");

  // 附带①：没长按就大幅移动 = 是滚动，不许起拖（手势不被劫持是 v2 的硬约束）
  const blk1 = qa(".ed-canvas .ed-blk")[1];
  blk1.dispatchEvent(pt("pointerdown", 0));
  blk1.dispatchEvent(pt("pointermove", 200));
  await sleep(400);
  const noDrag = qa(".ed-canvas .ed-blk.ed-drag").length;
  blk1.dispatchEvent(pt("pointerup", 200));
  await sleep(100);
  if (noDrag) throw new Error("没长按就移动居然起拖了（滚动会被劫持）");

  // 附带②：v3.3（用户第 5 条）—— **抓手已删除**，拖动入口只剩"长按块本体"。
  //   所以这一段从"⠿ 手柄按下立即拖"反转为两条更强的断言：
  //     ① 块上确实没有抓手；
  //     ② 只按一下（不跨长按阈值）**不该**起拖 —— 否则单击选中就会变成误拖。
  if (qa(".ed-canvas .ed-grip").length) throw new Error("块上还有抓手（v3.3 已删）：" + qa(".ed-canvas .ed-grip").length);
  const blkBody = qa(".ed-canvas .ed-blk")[1];
  blkBody.dispatchEvent(pt("pointerdown", 0));
  await sleep(120);                       // 远小于 LONG_PRESS_MS(280)
  const pressDrag = qa(".ed-canvas .ed-blk.ed-drag").length;
  blkBody.dispatchEvent(pt("pointerup", 0));
  await sleep(100);
  if (pressDrag) throw new Error("只按一下（未长按）就起拖了：" + pressDrag);

  // 附带③：ghost 跟手（Wave1A-2）—— 抓起来的块脱离文档流跟指针走，原位留"坑" + 插入缝。
  //
  // v3.4 起判定是「两个框**接触**即换位」，于是**任何朝邻居方向的位移都会立刻换位**：
  //   旧版靠"位移不超过块高的一半、绝不越过中线"来保证这段不换位（注释里那句"越过中线
  //   就该换位是 canvas-drag 的活儿"就是那时的前提）—— 那个前提随判据反转**已经失效**。
  //   现在改成抓**第一块朝上**移：它上面没有邻居，接触判据无从触发。
  // 测量量（dy = 块高的 10%，6~16px）与三条跟手判据（≥80% / 不过冲 / 收敛 ≤1.5px）不变。
  const allBlks = qa(".ed-canvas .ed-blk");
  const blkG = allBlks[0];
  const rectG = blkG.getBoundingClientRect();
  const dyG = Math.max(6, Math.min(16, Math.floor(rectG.height * 0.1)));
  const yGrab = Math.round(rectG.top + rectG.height * 0.4);
  const yGrab2 = yGrab - dyG;
  const ghostEl = () => q(".ed-canvas .ed-ghost");
  /** 读镜像的内联 transform（useCanvasDrag 每一步缓动都会重写它） */
  const ghostY = (el) => {
    if (!el) return null;
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform || "");
    return m ? Number(m[2]) : null;
  };
  const blocksBeforeGhost = qa(".ed-canvas .ed-blk").length;
  const orderBeforeGhost = blkOrder().join(",");

  blkG.dispatchEvent(pt("pointerdown", yGrab));
  await sleep(400); // 过长按阈值（280ms）
  const ghost1 = ghostEl();
  const gy1 = ghostY(ghost1);
  blkG.dispatchEvent(pt("pointermove", yGrab2));
  await sleep(250); // 等缓动逼近（rAF 每帧 35%；move 里还会立刻推进一步）
  const gy2 = ghostY(ghostEl());
  await sleep(200); // 再等一段：缓动应当已**收敛**（这一步专门验"最终贴上指针"，不是"动过就算"）
  const gy3 = ghostY(ghostEl());
  const gapsDuring = qa(".ed-canvas .ed-gap").length;
  const blocksDuringGhost = qa(".ed-canvas .ed-blk").length;
  blkG.dispatchEvent(pt("pointerup", yGrab2));
  await sleep(300);
  const ghostAfterDrop = qa(".ed-canvas .ed-ghost").length;
  const gapAfterDrop = qa(".ed-canvas .ed-gap").length;
  const orderAfterGhost = blkOrder().join(",");
  log.push({
    step: "canvas-ghost",
    ghost: !!ghost1,
    ghostBlock: blkG.getAttribute("data-blk"),
    ghostRectH: Math.round(rectG.height),
    ghostSize: ghost1 ? ghost1.style.width + "x" + ghost1.style.height : null,
    ghostY1: gy1, ghostY2: gy2, ghostY3: gy3, dyG,
    gapsDuring, blocksBeforeGhost, blocksDuringGhost,
    ghostAfterDrop, gapAfterDrop,
    orderKept: orderAfterGhost === orderBeforeGhost
  });
  if (!ghost1) throw new Error("长按起拖后没有跟手镜像（.ed-canvas .ed-ghost）");
  if (gy1 == null || gy2 == null) throw new Error("镜像没有写内联 transform（跟手全靠它）");
  // ---- 跟手强度（收尾波收紧；原判据是 `>= 2px`，M-4）----
  // 旧的 `gy1 - gy2 >= 2` 太松：指针移 16px、镜像只动 2px 也算"跟手"。
  // 这类松断言正是"拖拽卡死"能连续多波全绿溜过去的原因（见 jm-drag-stack-audit.md M-4）。
  // 现在两头都管：
  //   ① 松手前那一段：镜像位移必须 **≥ 指针位移的 80%**，且**不许过冲**（缓动是逼近，不是超调）；
  //   ② 缓动收敛后：镜像位移与指针位移**基本重合**（差 ≤1.5px）—— "最终贴上了"才算跟手。
  const ghostMoved = gy1 - gy2;
  const ghostSettled = gy1 - gy3;
  const ghostRatio = dyG ? ghostMoved / dyG : 0;
  if (!(ghostMoved >= dyG * 0.8)) {
    throw new Error(
      "镜像跟手不足：指针移 " + dyG + "px，镜像只移 " + ghostMoved + "px（要求 ≥80%，实为 " +
      Math.round(ghostRatio * 100) + "%）"
    );
  }
  if (ghostMoved > dyG + 2) {
    throw new Error("镜像位移超过指针位移（缓动不该过冲）：" + ghostMoved + "px > " + dyG + "px");
  }
  if (Math.abs(ghostSettled - dyG) > 1.5) {
    throw new Error(
      "缓动没收敛到指针位置：镜像共移 " + ghostSettled + "px vs 指针 " + dyG + "px（差 " +
      Math.abs(ghostSettled - dyG).toFixed(1) + "px > 1.5px）"
    );
  }
  // 镜像尺寸要跟"坑"一致（克隆的是块本身，不是一根手柄、也不是没尺寸的空壳）
  if (Math.abs(parseFloat(ghost1.style.width) - rectG.width) > 1) {
    throw new Error("镜像宽度不对：" + ghost1.style.width + " vs 块 " + rectG.width);
  }
  if (gapsDuring !== 1) throw new Error("拖动中插入缝不是恰好 1 条：" + gapsDuring);
  // 镜像**不许**被当成一块：它一旦混进 .ed-blk，落点判定与顺序断言都会歪一格
  if (blocksDuringGhost !== blocksBeforeGhost) {
    throw new Error("镜像混进了块集合（.ed-blk 计数 " + blocksBeforeGhost + " → " + blocksDuringGhost + "）");
  }
  if (ghostAfterDrop || gapAfterDrop) {
    throw new Error("松手后镜像/插入缝没撤干净：ghost=" + ghostAfterDrop + " gap=" + gapAfterDrop);
  }
  if (orderAfterGhost !== orderBeforeGhost) {
    throw new Error("第一块朝上小位移（它上面没有邻居，接触判据不该触发）却换了位：" +
      orderBeforeGhost + " → " + orderAfterGhost);
  }

  // 附带④：v3.4 **「接触即换位」**（用户第 6 条）—— 本波的核心，量的是**触发距离**。
  //
  // 用户原话：「拖动时黑框不跟手，似乎要中线越过判定框才换位；希望两个判定框接触即换位」。
  //   旧判据 = 指针越过目标块**中线**：抓块上边缘时手指要走 1.5 个块高（≈150px）才换位，
  //            抓下边缘只要 0.5 个 —— 手感随抓取点漂移，这就是"不跟手"的根因；
  //   新判据 = 被拖块**矩形**与目标矩形一接触就换（方向由运动方向决定）。
  // 做法：抓第一块的中部，向下**逐像素**推，记录"推到第几像素时顺序变了"。
  // 同时给一条**负对照**：这个位移必须远小于旧判据所需的距离，否则这条断言没有判别力。
  {
    const blksC = qa(".ed-canvas .ed-blk");
    const firstC = blksC[0];
    const secondC = blksC[1];
    if (!secondC) throw new Error("死区用例需要至少两块");
    const r1 = firstC.getBoundingClientRect();
    const r2 = secondC.getBoundingClientRect();
    const orderAtStart = blkOrder().join(",");
    const yGrab0 = Math.round(r1.top + r1.height / 2);
    firstC.dispatchEvent(pt("pointerdown", yGrab0));
    await sleep(420); // 过长按阈值
    const orderAtHold = blkOrder().join(",");
    if (orderAtHold !== orderAtStart) {
      throw new Error("起拖瞬间（还没移动）落点就变了：" + orderAtStart + " → " + orderAtHold);
    }
    /**
     * ── v3.5 **判据反转**：从「接触即换位」改成「**有死区**」──────────────
     * 旧断言的期望值是「17px 就触发」（越灵越好）。用户实测之后是：
     * 「拖动时手感还很差，**太灵敏了**，稍微动一下就变化许多」——
     * 所以现在的期望是**半个块之内一动不动**（AndroidX `ItemTouchHelper.getMoveThreshold()`
     * 默认 `.5f`：偏移不到自身尺寸的一半，连判定都不做），越过死区之后才换位。
     * 这条不是放宽：它把"能换位"的要求换成了"**必须走够半天才换**"，方向相反。
     */
    const deadZone = Math.max(24, 0.5 * r1.height);
    let firstSwapAt = null;
    for (let d = 1; d <= 400; d++) {
      firstC.dispatchEvent(pt("pointermove", yGrab0 + d));
      await sleep(d <= Math.round(deadZone * 0.8) ? 12 : 40); // 死区里只需确认"没反应"
      if (blkOrder().join(",") !== orderAtStart) { firstSwapAt = d; break; }
    }
    const orderAtSwap = blkOrder().join(",");
    /**
     * ── v3.5.2 **判据反转（第二处）**：影子带从"半个块"夹到 **≤10% 主轴尺寸（下限 24px）** ──
     * 依据：GridStack 把方向滞回夹到 `≤10% 格`（`gridstack-core.ts:3100-3119`）；原生四家
     * （Android / calvin / Flutter / m3e）**没有一家**用"半个块"，而且反向**只付一笔**
     * （我们旧实现还要再叠加一遍死区 → 真机实测反向要 160px 才动一格）。
     *
     * 旧断言是「退回到换位距离的一半（< 半个块）→ 不许换回来」，方向与用户反馈相反
     * （「往一个方向拖后不松手往另一个方向继续拖动就会变得迟钝和卡手」）。现在是**两半**：
     *   ① 回退 **< 滞回** → 不许换回来（滞回仍在，防手抖翻面）；
     *   ② 回退 **> 滞回** → **必须**换回来（只付一笔）。
     * 本场景 `hero` 高 139 → 旧滞回 69.5px、新滞回 24px，所以"回退 35px"这条
     * **在交付版 v3.5 上必须是红的**（判别力自证）。
     */
    const band = Math.max(24, Math.min(0.5 * r1.height, 0.1 * r1.height));
    const dampPx = Math.max(2, Math.round(band) - 12);
    const yDamp = yGrab0 + firstSwapAt - dampPx;
    firstC.dispatchEvent(pt("pointermove", yDamp));
    await sleep(220);
    const orderAfterDamp = blkOrder().join(",");
    /**
     * ③ 反向**逐步实测**（不要假设"回退 firstSwapAt/2 就够"）：
     * v3.5.3 起起拖门槛可能小到 24px，"一半"会与上面的滞回检查**塌缩成同一个点**（实测踩过）。
     * 所以这里按 8px 一步步回退，量到"真的换回来"为止 —— 这个距离本身就是"反向成本"，
     * 它才是用户"换个方向就迟钝卡手"的机器级读数。
     */
    let backToRevert = null;
    let yBack = yDamp;
    for (let backPx = dampPx + 8; backPx <= 200; backPx += 8) {
      yBack = yGrab0 + firstSwapAt - backPx;
      firstC.dispatchEvent(pt("pointermove", yBack));
      await sleep(30);
      if (blkOrder().join(",") !== orderAtSwap) { backToRevert = backPx; break; }
    }
    const orderAfterBack = blkOrder().join(",");
    firstC.dispatchEvent(pt("pointerup", yBack));
    await sleep(340);
    const orderAfterDrop = blkOrder().join(",");
    /** 旧判据（v3.4「接触即换位」）需要的下行距离 = 间隙 + max(6px, 15% 较短边) */
    const gapDz = Math.round(r2.top - r1.bottom);
    const legacyNeeds = Math.max(0, gapDz) + Math.ceil(Math.max(6, 0.15 * Math.min(r1.height, r2.height)));
    log.push({
      step: "canvas-dead-zone",
      deadZone: Math.round(deadZone),
      shadowBand: Math.round(band),
      blockH: Math.round(r1.height),
      gapToNext: gapDz,
      firstSwapAt,
      dampBackPx: dampPx,
      revertBackPx: backToRevert,
      legacyNeedsPx: legacyNeeds,
      orderAtStart, orderAtSwap, orderAfterDamp, orderAfterBack, orderAfterDrop
    });
    if (firstSwapAt == null) throw new Error("推了 400px 都没换位（死区把换位彻底挡住了）");
    /**
     * ── v3.5.3 **判据反转（第三处）**：起拖门槛从"被拖块自己的尺寸"改成"**朝行进方向最近那一块**的尺寸" ──
     *
     * 旧断言：门槛 = `max(24, 0.5 × 被拖块高)`（本场景 hero 高 139 → **70px**），要求
     * `firstSwapAt ≥ 0.8×70`，且"必须比 v3.4 的接触即换位（16px）明显更钝（+20px）"。
     * 新口径：门槛 = `max(24, 0.5 × **目标**高)`（下面那块 tags 高 28 → **24px**；同一阈值也由
     * "被拖块前沿越过目标中线"这条判据给出：间隙 10 + 目标半高 14 ≈ 24px）。
     * 依据（调研报告 §3.2 的相关性表）：旧口径门槛与"被拖块尺寸" r=0.98、与目标 r=−0.14
     * ⇒「拖大块永远木」；新口径与目标 r≈1.00。
     *
     * 于是这一节的判据整体换向：
     *   ① **绝对下限仍在**（`firstSwapAt ≥ 0.8 × 24`）—— 仍然没有回到 v3.4 的"一碰就换"；
     *   ② 门槛**按目标**算（上限 = 目标半高 + 间隙 + 余量）；
     *   ③ **负对照反转**：新口径必须**明显小于**旧口径（拖大块不再木）。
     *      这一条在 v3.6 的产物上必须**是红的**（那里 firstSwapAt=70 > 50）。
     */
    const needNew = Math.max(24, 0.5 * r2.height);
    if (firstSwapAt < Math.round(needNew * 0.8)) {
      throw new Error("换位只推了 " + firstSwapAt + "px 就发生（按目标算的门槛 " + Math.round(needNew) +
        "px）——又变回「太灵敏」了");
    }
    if (firstSwapAt > needNew + gapDz + 20) {
      throw new Error("换位要推 " + firstSwapAt + "px（按目标算的门槛才 " + Math.round(needNew) +
        "px、间隙 " + gapDz + "px）—— 太钝了");
    }
    if (!(firstSwapAt < Math.round(deadZone) - 20)) {
      throw new Error("负对照不成立：旧口径（按被拖块 " + Math.round(r1.height) + "px 高）要 " +
        Math.round(deadZone) + "px、新口径只推了 " + firstSwapAt + "px —— 新模型没有比旧模型更灵");
    }
    /** v3.4「接触即换位」仍需被挡住：门槛（24px）必须**大于**它（16px）。只差 8px 是因为
     *  这一格的目标很矮（28px）—— 这正是新口径"走过矮的块就能快"的体现，不是什么宽松。 */
    if (!(firstSwapAt > legacyNeeds)) {
      throw new Error("负对照不成立：v3.4 接触即换位只要 " + legacyNeeds + "px，而新模型 " +
        firstSwapAt + "px —— 死区等于没有");
    }
    if (orderAfterDamp !== orderAtSwap) {
      throw new Error("回退 " + (Math.round(band) - 12) + "px（< 滞回 " + Math.round(band) +
        "px）就换回来了 —— 滞回没了，手抖会来回翻：" + orderAtSwap + " → " + orderAfterDamp);
    }
    if (orderAfterBack === orderAtSwap || backToRevert == null) {
      throw new Error("回退了 200px 还没换回来 —— 反向要付两笔（旧实现的迟钝卡手）：" +
        orderAtSwap + " → " + orderAfterBack);
    }
    /** 反向成本要有界：实测 v3.5 要 160px、v3.6 是 80px；这里钉住"不超过 120px 就必须换回来" */
    if (backToRevert > 120) {
      throw new Error("反向要回退 " + backToRevert + "px 才换回来（应 ≤120px）—— 又变迟钝了");
    }
    if (orderAtSwap === orderAtStart) {
      throw new Error("正向推了 " + firstSwapAt + "px 却没有换位：" + orderAtStart);
    }
    /**
     * ⚠️ v3.5.2 起这一串手势以「**退回原位**」结束（第 ② 步就是要它换回来），
     * 所以不能再要求"松手后的顺序与起始不同"（那是旧流程的产物）。
     * 改成断言"**所见即所落**"：松手提交的顺序 == 松手那一刻看到的顺序。
     * "换位真的提交了"这条由 `canvas-drag` 步骤（`savedAfterDrop === afterOrder`）负责。
     */
    if (orderAfterDrop !== orderAfterBack) {
      throw new Error("松手提交的顺序与松手时看到的不一致（所见即所落破了）：" +
        orderAfterBack + " → " + orderAfterDrop);
    }

    // ---- v3.5（用户第 2 条）：拖动开始时**收起已唤起的配置栏**，且界面不许乱跑 ----
    // 前置：先选中一块把配置栏唤起来；再长按拖它。
    // 判据：① 配置栏真的收了；② 拖动中**每个块的布局位置**没变（收起不该引起重排）；
    //       ③ 画布滚动位置没变（窄屏下收起会改画布视口高度，滚动被夹住就会"乱跑"）。
    const tagsBlk = () => q(".ed-canvas .ed-blk[data-blk='tags']");
    const geomSig = () => qa(".ed-canvas .ed-blk")
      .map((b) => b.getAttribute("data-blk") + ":" + b.offsetLeft + "," + b.offsetTop).join("|");
    tagsBlk().click();
    await sleep(320);
    const beforeCollapse = {
      inspectorOpen: !!q(".ed-inspector .ed-module"),
      geom: geomSig(),
      scrollTop: q(".ed-stage") ? q(".ed-stage").scrollTop : 0,
      canvasW: q(".ed-canvas") ? q(".ed-canvas").offsetWidth : 0
    };
    const rT = tagsBlk().getBoundingClientRect();
    const yT = Math.round(rT.top + rT.height / 2);
    tagsBlk().dispatchEvent(pt("pointerdown", yT));
    await sleep(450); // 过长按阈值 → 起拖（onDragStart 在这一帧触发）
    const duringDrag = {
      inspectorOpen: !!q(".ed-inspector .ed-module"),
      geom: geomSig(),
      scrollTop: q(".ed-stage") ? q(".ed-stage").scrollTop : 0,
      canvasW: q(".ed-canvas") ? q(".ed-canvas").offsetWidth : 0
    };
    tagsBlk().dispatchEvent(pt("pointerup", yT));
    await sleep(340);
    log.push({ step: "drag-collapses-inspector", beforeCollapse, duringDrag });
    if (!beforeCollapse.inspectorOpen) {
      throw new Error("前置不成立：点区块之后配置栏没被唤起（这条断言就没有判别力）");
    }
    if (duringDrag.inspectorOpen) {
      throw new Error("拖动时配置栏没有收起来（用户第 2 条：已唤起的配置不会自动缩起来）");
    }
    if (duringDrag.geom !== beforeCollapse.geom) {
      throw new Error("拖动时块的布局位置变了（界面乱跑）：" + beforeCollapse.geom + " → " + duringDrag.geom);
    }
    if (duringDrag.scrollTop !== beforeCollapse.scrollTop) {
      throw new Error("拖动时画布滚动位置变了：" + beforeCollapse.scrollTop + " → " + duringDrag.scrollTop);
    }
  }

  // ---- v3.5.1（用户第 2 条反馈）：**行内落位** —— 独占一行的块横向拖动 =
  //      把它拖进自己那一行的空位（1/2 放正中、1/3 放正中或右侧）。
  // 判据全部要几何/落盘证据：
  //   ① 独占一行的 1/2 块横向拖到行中部 → offset=3 落盘 + 两侧各一个 3 列空占位格；
  //   ② 拖回左缘 → offset 清掉（顶格）；
  //   ③ 纵向换序不受影响（先横向落中、再纵拖一格 → 顺序变但 offset 保持）。
  {
    const offSaved = () => (JSON.parse(localStorage.getItem("jmclient.detailLayout.v1") || "{}").offsets || {});
    const blkById = (id) => q(".ed-canvas .ed-blk[data-blk='" + id + "']");
    const rowsOf = () => {
      const blks = qa(".ed-canvas .ed-blk");
      const rows = [];
      let cur = null, bottom = -1;
      for (const b of blks) {
        const r = b.getBoundingClientRect();
        if (cur && r.top < bottom - 2) { cur.push(b); bottom = Math.max(bottom, r.bottom); }
        else { cur = [b]; bottom = r.bottom; rows.push(cur); }
      }
      return rows;
    };
    // 前置：tags 设 1/2、它前一块（actors）设满宽 → tags 独占一行（"行内空位"存在的前提）
    blkById("actors").click(); await sleep(300);
    qa(".ed-inspector .ed-span button").find((x) => T(x) === "满宽").click(); await sleep(400);
    blkById("tags").click(); await sleep(300);
    qa(".ed-inspector .ed-span button").find((x) => T(x) === "1/2").click(); await sleep(450);
    const tagRow = rowsOf().find((row) => row.some((b) => b.getAttribute("data-blk") === "tags"));
    if (!tagRow || tagRow.length !== 1) {
      throw new Error("前置不成立：tags 没有独占一行（行内落位用例没有判别力）");
    }
    const rt = blkById("tags").getBoundingClientRect();
    const yGrabRow = Math.round(rt.top + rt.height / 2);
    const canvasL = q(".ed-canvas").getBoundingClientRect().left;
    const canvasW = q(".ed-canvas").offsetWidth;
    /** 合成 pointer：clientX 可变（行内落位判的是横向位置） */
    const ptx = (type, x, y) => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, clientX: x });
      Object.defineProperty(ev, "pointerType", { value: "touch" });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      return ev;
    };
    /**
     * ① 横向拖到**行中部**：目标 = **行（列表）的中点**，不是画布的中点。
     *
     * ⚠️ v3.5.2 修正：原来打的是 `canvasL + canvasW/2`（画布中点）。画布中点与行中点相差
     * 约 13px（画布左右各留边），而 harness 的 420px 视口下这个偏差正好把 `raw` 卡在
     * 2.47（旧公式 `floor(rel − span/2 + 0.5)` 得 3.11 恰好蒙对、新公式 `round` 得 2）
     * —— 也就是说**旧目标本来就瞄偏了**，只是被旧公式的取整方向掩盖。
     * 用户真正的动作是"把这块挪到这一行的中间"，所以目标就该是行中点。
     */
    const rowBox = q(".ed-canvas .detail-card");
    const rowRect = rowBox ? rowBox.getBoundingClientRect() : null;
    const xMid = rowRect ? Math.round(rowRect.left + rowRect.width / 2)
                         : canvasL + Math.round(canvasW * 0.5);
    blkById("tags").dispatchEvent(ptx("pointerdown", Math.round(rt.left + rt.width / 2), yGrabRow));
    await sleep(420);
    if (!blkById("tags").classList.contains("ed-drag")) throw new Error("行内落位用例：长按没有起拖");
    for (let i = 1; i <= 8; i++) {
      blkById("tags").dispatchEvent(ptx("pointermove", Math.round(rt.left + rt.width / 2) + (xMid - (rt.left + rt.width / 2)) * (i / 8), yGrabRow));
      await sleep(40);
    }
    /**
     * ⚠️ 合成事件的实测怪癖：这一串里**最后一次 pointermove 会丢**。
     * 机器级证据：驱动发了 8 次 move，页面内计数只收到 **7 次**（每次两路 = `ap:14`），
     * 坐标序列停在 `… 186 198`，而驱动的终点是 210.5 —— 于是 app 停在倒数第二个坐标上、
     * 落点差一列（而且它自洽：预览显示 2、松手提交 2）。
     * 真机触摸是连续事件流，不存在"只丢最后一个"这种现象，所以这是**驱动侧的假象**：
     * 这里把终点**重发两次**，保证 app 至少收到一次终点坐标。
     */
    for (let k = 0; k < 2; k++) {
      blkById("tags").dispatchEvent(ptx("pointermove", xMid, yGrabRow));
      await sleep(130);
    }
    await sleep(260);
    // ⚠️ 判定时机：拖动**中** offset 只在内存里（v3 纪律：拖动中零落盘），所以这里量**几何**
    // （块真的挪到行中间 + 两侧各一条空占位格），松手后再量**落盘**的 offset —— 两条合起来
    // 才构成"拖动落进行内空位"的完整证据，任何一条单独都证明不了。
    const boxMid = (() => { const r = blkById("tags").getBoundingClientRect(); return { left: Math.round(r.left), w: Math.round(r.width) }; })();
    const gapsMid = qa(".ed-canvas .d-gap").length;
    const savedMidRowDrag = offSaved().tags; // 拖动中必须还是 undefined（零落盘契约）
    blkById("tags").dispatchEvent(ptx("pointerup", xMid, yGrabRow));
    await sleep(380);
    const offsetEnd = offSaved().tags; // 松手后一次提交
    log.push({ step: "canvas-row-offset-drag", savedMidRowDrag, offsetEnd, boxMid, gapsMid, canvasW });
    if (savedMidRowDrag !== undefined) {
      throw new Error("行内落位在拖动中就落盘了（破坏零 I/O 契约）：" + savedMidRowDrag);
    }
    if (offsetEnd !== 3) {
      throw new Error("拖到行中部没有落进居中列（松手后 offset 应为 3，实际 " + offsetEnd + "）");
    }
    if (gapsMid < 2) {
      throw new Error("行内落位后没有空占位格（应左右各一，实际 " + gapsMid + "）");
    }
    // ② 拖回左缘 → offset 清掉
    const rt2 = blkById("tags").getBoundingClientRect();
    const yGrabRow2 = Math.round(rt2.top + rt2.height / 2);
    const xLeft = canvasL + 6;
    blkById("tags").dispatchEvent(ptx("pointerdown", Math.round(rt2.left + rt2.width / 2), yGrabRow2));
    await sleep(420);
    for (let i = 1; i <= 6; i++) {
      blkById("tags").dispatchEvent(ptx("pointermove", Math.round(rt2.left + rt2.width / 2) + (xLeft - (rt2.left + rt2.width / 2)) * (i / 6), yGrabRow2));
      await sleep(40);
    }
    await sleep(260);
    blkById("tags").dispatchEvent(ptx("pointerup", xLeft, yGrabRow2));
    await sleep(380);
    const offsetLeft = offSaved().tags;
    log.push({ step: "canvas-row-offset-reset", offsetLeft });
    if (offsetLeft !== undefined) {
      throw new Error("拖回左缘没有清掉 offset（顶格 = 不写，实际 " + offsetLeft + "）");
    }
    // ③ 复原：tags 回满宽（不把改动留给后面的用例）
    blkById("tags").click(); await sleep(300);
    qa(".ed-inspector .ed-span button").find((x) => T(x) === "满宽").click(); await sleep(400);
  }

  // ---- v3 配置键扩面：原本"点进去只有 ▲▼ + 显隐"的 5 个块，现在各有关键项 ----
  // 挑最有感的三个键验，且三者各走一条**不同的落盘机制**，覆盖三条真实风险：
  //   · tagSize   —— 内联 style + 由字号派生的高度/内边距（走路径 A）
  //   · actionPadY—— 内联 style 改的是**几何**（用按钮真实高度验，不只看属性）
  //   · actorSize —— 唯一走属性选择器的键（那个元素的 font-size 带 !important，内联会被压掉）
  // 这三条正是"用户拖了滑块页面毫无反应"这类静默失效的哨兵。
  const canvasCard = () => q(".ed-canvas .detail-card");
  const blkBy = (id) => q(".ed-canvas .ed-blk[data-blk='" + id + "']");
  const dlAttr = (n) => (canvasCard() ? canvasCard().getAttribute(n) : null);

  // (a) 标签大小：拖到最大 → 胶囊的计算字号真的变大 + 观测属性出现
  const tagBefore = getComputedStyle(q(".ed-canvas .tagchip")).fontSize;
  blkBy("tags").click();
  await sleep(300);
  const tagSlider = q('.ed-inspector [data-style-key="tagSize"] input[type="range"]');
  if (!tagSlider) throw new Error("选中「标签」块后检查器里没有 tagSize 滑块（键没挂上这张表）");
  setRange(tagSlider, 16);
  await sleep(350);
  const tagAfter = getComputedStyle(q(".ed-canvas .tagchip")).fontSize;
  log.push({ step: "style-tags", tagBefore, tagAfter, attr: dlAttr("data-dl-tagsize") });
  if (tagAfter !== "16px") throw new Error("标签字号没生效：" + tagBefore + " → " + tagAfter);
  if (dlAttr("data-dl-tagsize") !== "16") throw new Error("没有 data-dl-tagsize 观测属性");

  // (a2) 滑块**防抖提交**（收尾波 ①）：连打 8 次输入 → 滑动期间**零落盘**、停手后**只落盘一次**。
  // 这是"手机上拖滑块不卡"的回归哨兵：如果有人把它改回"每次 onChange 都写盘 + 广播"，这里当场红。
  // （原来每帧一次同步写盘 + 一次广播，广播还让三个订阅方各重读重渲染 —— 与拖块当年的病根同源。）
  await sleep(400); // 先让上一步的防抖排空，别把它的那次写算到本轮头上
  const STYLE_KEY = "jmclient.detailStyle.v1";
  const _origSetItem = localStorage.setItem.bind(localStorage);
  let styleWrites = 0;
  localStorage.setItem = function (k, v) {
    if (String(k) === STYLE_KEY) styleWrites++;
    return _origSetItem(k, v);
  };
  const burstSlider = q('.ed-inspector [data-style-key="tagSize"] input[type="range"]');
  if (!burstSlider) throw new Error("防抖断言拿不到 tagSize 滑块（上一步应当已选中「标签」）");
  // 连打 8 次输入（模拟拖一根滑块）。⚠️ **必须以非默认值收尾**：tagSize 的默认值是 12，
  // 若连打回到 12，后面既有清理步骤要的 `.dl-reset`（只在非默认时渲染）就不存在了 →
  // `null.click()` 会把整个 driver 掀翻（这条踩过一次，全量套件里表现为"导航回归 ✗"）。
  for (const v of [11, 12, 13, 14, 15, 14, 13, 15]) { setRange(burstSlider, v); await sleep(30); }
  const writesDuringBurst = styleWrites;
  await sleep(600); // 等防抖到期
  const writesAfterSettle = styleWrites;
  localStorage.setItem = _origSetItem;
  log.push({ step: "style-slider-debounce", writesDuringBurst, writesAfterSettle });
  if (writesDuringBurst !== 0) {
    throw new Error("滑块滑动期间就落盘了 " + writesDuringBurst + " 次（应当只动内存、停手才提交）");
  }
  if (writesAfterSettle !== 1) {
    throw new Error("一次滑动应当只落盘 1 次，实际 " + writesAfterSettle + " 次");
  }

  // (b) 按钮高矮：改的是几何 —— 量真实高度，不信属性
  blkBy("action").click();
  await sleep(300);
  const padSlider = q('.ed-inspector [data-style-key="actionPadY"] input[type="range"]');
  if (!padSlider) throw new Error("选中「动作区」后检查器里没有 actionPadY 滑块");
  const btnHBefore = Math.round(q(".ed-canvas .actrow .btn").getBoundingClientRect().height);
  setRange(padSlider, 22);
  await sleep(350);
  const btnHAfter = Math.round(q(".ed-canvas .actrow .btn").getBoundingClientRect().height);
  log.push({ step: "style-action", btnHBefore, btnHAfter, attr: dlAttr("data-dl-actionpady") });
  if (!(btnHAfter > btnHBefore)) throw new Error("按钮没变高：" + btnHBefore + " → " + btnHAfter);

  // (c) 人物字号：唯一走属性选择器的键 —— 这条专门锁 `!important` 那条路真的赢了
  blkBy("actors").click();
  await sleep(300);
  const actorsBefore = getComputedStyle(q(".ed-canvas .d-actors")).fontSize;
  const optLg = qa('.ed-inspector [data-style-key="actorSize"] button').find((b) => T(b) === "大");
  if (!optLg) throw new Error("选中「登场人物」后没有 actorSize 档位（StyleRow 只认 slider/switch？）");
  optLg.click();
  await sleep(350);
  const actorsAfter = getComputedStyle(q(".ed-canvas .d-actors")).fontSize;
  log.push({ step: "style-actor", actorsBefore, actorsAfter, attr: dlAttr("data-dl-actorsize") });
  if (actorsAfter !== "15px") {
    throw new Error("人物字号没生效（.d-meta 的 !important 把内联压掉那条路断了）：" + actorsBefore + " → " + actorsAfter);
  }
  // 切回默认档 → 属性必须消失（默认零输出是红线）
  qa('.ed-inspector [data-style-key="actorSize"] button').find((b) => T(b) === "标准").click();
  await sleep(300);
  if (dlAttr("data-dl-actorsize")) throw new Error("切回默认档后 data-dl-actorsize 还挂着");

  // (d) 简介：改字号 + 行距后**展开一次**，文字必须完整不截断。
  // 施工图 jm-stylekeys-plan.md §2.10 点名的哨兵：`descStyle()` 的折叠高度是按行数 × 行高系数
  // 算出来的，`descLine` 改的正是行高 —— 只改 clamp 不改系数、或展开态忘了解除 clamp，
  // 都会表现为"文字被截断而看起来像正常折叠"（单测测不到，只有量 scrollHeight 才看得见）。
  blkBy("desc").click();
  await sleep(300);
  const fontSlider = q('.ed-inspector [data-style-key="descFont"] input[type="range"]');
  const lineSlider = q('.ed-inspector [data-style-key="descLine"] input[type="range"]');
  if (!fontSlider || !lineSlider) throw new Error("选中「简介」后没有 descFont / descLine 滑块");
  setRange(fontSlider, 19); // 最大字号
  await sleep(150);
  setRange(lineSlider, 2); // 最大行距
  await sleep(450); // 等防抖提交（滑块走的是防抖落盘，不是每帧）
  const descEl = q(".ed-canvas .d-desc");
  const moreBtn = q(".ed-canvas .d-more");
  if (!descEl) throw new Error("画布里没有简介段落 .d-desc");
  if (!moreBtn) throw new Error("简介没出现「展开」入口（样例文本应当被 clamp 掉）");
  const descFontApplied = getComputedStyle(descEl).fontSize;
  const csDesc = getComputedStyle(descEl);
  const clampClosed = csDesc.webkitLineClamp || csDesc.lineClamp || "";
  moreBtn.click();
  await sleep(600); // 等展开过渡（240ms）走完
  const descOverflow = descEl.scrollHeight - descEl.clientHeight;
  const clampOpened = getComputedStyle(descEl).webkitLineClamp || getComputedStyle(descEl).lineClamp || "";
  log.push({
    step: "style-desc-expand",
    descFontApplied, clampClosed, clampOpened,
    moreText: (moreBtn.textContent || "").trim(), descOverflow
  });
  if (descFontApplied !== "19px") throw new Error("简介字号没生效：" + descFontApplied);
  if (descOverflow > 2) {
    throw new Error(
      "展开后简介仍被截断：scrollHeight 比 clientHeight 多 " + descOverflow +
      "px（descLine 与 maxHeight 系数没联动，或展开态没解除 clamp）"
    );
  }

  // 收尾：把上面改过的三项也用 ↺ 收回默认（顺带验新键的单项复位真的能用），
  // 后面的步骤要在默认样式下跑。
  // 简介先收起（展开态会改变后面的量测），再 ↺ 回默认字号/行距
  const moreBtn2 = q(".ed-canvas .d-more");
  if (moreBtn2 && (moreBtn2.textContent || "").indexOf("收起") >= 0) { moreBtn2.click(); await sleep(400); }
  q('.ed-inspector [data-style-key="descFont"] .dl-reset').click();
  await sleep(250);
  q('.ed-inspector [data-style-key="descLine"] .dl-reset').click();
  await sleep(250);
  blkBy("tags").click();
  await sleep(250);
  q('.ed-inspector [data-style-key="tagSize"] .dl-reset').click();
  await sleep(250);
  blkBy("action").click();
  await sleep(250);
  q('.ed-inspector [data-style-key="actionPadY"] .dl-reset').click();
  await sleep(300);
  const dlLeft = Array.from(canvasCard().attributes).map((a) => a.name).filter((n) => n.indexOf("data-dl-") === 0);
  log.push({ step: "style-keys-reset", leftAttrs: dlLeft });
  if (dlLeft.length) throw new Error("v3 新键没有收回默认（还留着 " + dlLeft.join(",") + "）");

  // ---- v3.5：内层**不再是可点选的模块**（用户第 3 条）----
  // 这一节原来是"内嵌可拖"（`nested-drag` / `nested-drag-horizontal`）：拖主视觉内部的
  // 标题 / 四宫格 / 字段来换顺序。用户实测后的要求是反方向的：
  // 「**主视觉是一个大模块**，封面信息栏和四宫格等等也是在主视觉的配置里设置，
  //   **而不是也都做成可点击的模块**」→ 内层的画布手势**整体移除**。
  // 所以本节改成新不变量的断言（见下面 `nested-slots-gone` / `nested-click-selects-parent` /
  // `nested-order-via-inspector`）：**不是把步骤删掉**，而是换成"内层不可点选 +
  // 内层顺序仍有可达入口"这两条 —— 后者才是删掉这条能力之后最容易静默失守的地方。
  const savedLayout = () => JSON.parse(localStorage.getItem("jmclient.detailLayout.v1") || "{}");

  // ---- v3.5：内层**不再是可点选的模块**（用户第 3 条）----
  // 旧步骤（`nested-drag` / `nested-drag-horizontal`）拖的是 `.ed-slot[...]` —— 那些元素
  // 按用户要求已经不存在了。所以这里换成**新不变量**的断言，而不是把步骤删掉了事：
  //   ① 编辑态画布上 `.ed-slot` 数量 = 0（内层没有可点选痕迹）；
  //   ② 点内层元素（标题）→ 选中的是**父块 hero**（"主视觉是一个大模块"的机器级证据）；
  //   ③ **只点 hero**（全程不碰内层）就能改到「四宫格字段」与「封面/信息栏左右」的顺序，
  //      且画布立刻跟着变 —— 这是"删功能必须留入口"的端到端证据：内层不再可点选之后，
  //      那些配置会不会变成永远打不开，单测与其余 e2e 都看不出来。
  const slotCount = qa(".ed-canvas .ed-slot").length;
  log.push({ step: "nested-slots-gone", slotCount });
  if (slotCount !== 0) {
    throw new Error("编辑态画布上还有 .ed-slot（内层仍被当成可点选模块）：" + slotCount);
  }
  const blkCount = qa(".ed-canvas .ed-blk").length;
  q(".ed-canvas .d-title").click();
  await sleep(320);
  const heroSel = !!q(".ed-canvas .ed-blk[data-blk='hero'].ed-sel");
  const selModule = q(".ed-inspector [data-module]")
    ? q(".ed-inspector [data-module]").getAttribute("data-module") : null;
  log.push({ step: "nested-click-selects-parent", blkCount, heroSel, selModule });
  if (!heroSel) {
    throw new Error("点内层元素（标题）没有选中父块 hero（内层仍被当成独立模块）：" + selModule);
  }

  const factKeys = () => qa(".ed-canvas .d-facts .fact .k").map((e) => T(e));
  const factsBefore = JSON.stringify(factKeys());
  const factRow = () => qa(".ed-inspector .ed-nodelist .ditem")
    .find((d) => T(d.querySelector(".dl-label")) === "话数 / 页数");
  if (!factRow()) {
    throw new Error("点 hero 后配置栏里没有「话数 / 页数」那一行（四宫格字段的顺序失去入口）");
  }
  const upF = factRow().querySelector('button[aria-label^="上移"]');
  if (!upF) throw new Error("四宫格字段表里没有「上移」按钮（内层顺序失去入口）");
  upF.click();
  await sleep(400);
  const factsAfter = JSON.stringify(factKeys());
  log.push({ step: "nested-order-via-inspector", factsBefore, factsAfter });
  if (factsAfter === factsBefore) {
    throw new Error("只点 hero 改不动四宫格顺序 —— 内层配置没有可达入口：" + factsAfter);
  }
  const downF = factRow().querySelector('button[aria-label^="下移"]');
  if (!downF) throw new Error("四宫格字段表里没有「下移」按钮");
  downF.click();
  await sleep(400);
  const factsRestored = JSON.stringify(factKeys());
  log.push({ step: "nested-order-restore", factsRestored, ok: factsRestored === factsBefore });
  if (factsRestored !== factsBefore) {
    throw new Error("四宫格顺序复原失败：期望 " + factsBefore + "，实为 " + factsRestored);
  }

  // 左右两栏（封面 / 信息栏）的顺序同样只点 hero 就能改
  const heroSlotsBefore = JSON.stringify(savedLayout().heroSlots || []);
  const slotRow = () => qa(".ed-inspector .ed-nodelist .ditem")
    .find((d) => T(d.querySelector(".dl-label")) === "信息栏");
  if (!slotRow()) throw new Error("点主视觉后配置栏里没有「信息栏」那一行（左右栏顺序失去入口）");
  const upS = slotRow().querySelector('button[aria-label^="上移"]');
  if (!upS) throw new Error("左右栏顺序表里没有「上移」按钮");
  upS.click();
  await sleep(400);
  const heroSlotsAfter = JSON.stringify(savedLayout().heroSlots || []);
  log.push({ step: "nested-order-hero-slots", heroSlotsBefore, heroSlotsAfter });
  if (heroSlotsAfter === heroSlotsBefore) throw new Error("只点 hero 改不动左右栏顺序");
  const downS = slotRow().querySelector('button[aria-label^="下移"]');
  if (!downS) throw new Error("左右栏顺序表里没有「下移」按钮");
  downS.click();
  await sleep(400);
  const heroSlotsRestored = JSON.stringify(savedLayout().heroSlots || []);
  log.push({ step: "nested-order-hero-slots-restore", heroSlotsRestored, ok: heroSlotsRestored === heroSlotsBefore });
  if (heroSlotsRestored !== heroSlotsBefore) {
    throw new Error("左右栏顺序复原失败：期望 " + heroSlotsBefore + "，实为 " + heroSlotsRestored);
  }

  // ③ 预览态：描边 / 抓手 / 序号一个不留，检查器整个不渲染（Webstudio 的 Hide UI / Preview 模式）
  qa(".ed-top .seg-choice[aria-label='编辑模式'] button").find((b) => T(b) === "预览").click();
  await sleep(400);
  log.push({
    step: "canvas-preview",
    grips: visCount(".ed-canvas .ed-grip"),
    chips: visCount(".ed-canvas .ed-namechip"),
    outlines: visCount(".ed-canvas .ed-blk"),
    inspector: qa(".ed-inspector").length
  });
  // v3.3：抓手 / 块名 chip 已经不存在了 —— 这两条断言保留（0 仍然必须成立，
  // 而且现在它们同时证明了"新代码没有把装饰又加回来"）。
  if (visCount(".ed-canvas .ed-grip")) throw new Error("预览态还留着拖拽抓手");
  if (visCount(".ed-canvas .ed-namechip")) throw new Error("预览态还留着块名 chip");
  // 预览态真正的意义在这里：**编辑态的包装层一个都不留**（不是"看不看得见"而是"根本不存在"）
  if (visCount(".ed-canvas .ed-blk")) throw new Error("预览态还渲染着编辑包装层 .ed-blk");
  if (qa(".ed-inspector").length) throw new Error("预览态还渲染着检查器");

  // ④ v3.3（用户第 3 条）：**「宽屏」开关已删除**，取而代之的是"任何视口都按配的宽度排"。
  //    这里只验结构性契约（顶栏不再有这个按钮、画布也不再挂那个类）；
  //    "窄视口下真的并排"是几何契约，由能控制视口的 editor-gallery.mjs / slot-layout.mjs 验。
  log.push({
    step: "canvas-wide-preview-removed",
    wideChip: qa(".ed-top .ed-widechip").length,
    previewWideClass: /ed-preview-wide/.test((q(".ed-canvas") || {}).className || "")
  });
  if (qa(".ed-top .ed-widechip").length) throw new Error("顶栏还有「宽屏」按钮（v3.3 已删）");
  if (/ed-preview-wide/.test((q(".ed-canvas") || {}).className || "")) throw new Error("画布还挂着已删除的 ed-preview-wide");

  // 收尾：回编辑态、恢复默认，让后面的步骤不受影响（v3.3：恢复默认在「⋯」菜单里）
  qa(".ed-top .seg-choice[aria-label='编辑模式'] button").find((b) => T(b) === "编辑").click();
  await sleep(300);
  q(".ed-more").click(); await sleep(250);
  const resetItem2 = qa(".ed-menu .ed-menuitem").find((b) => /恢复/.test(T(b)));
  if (!resetItem2) throw new Error("「⋯」菜单里找不到「恢复全部默认」");
  resetItem2.click();
  await sleep(400);
  q(".ed-back").click();
  await sleep(700);

  // ---- 列表页布局面板：卡片副标题 + 每行列数真的落到网格上 ----
  // 与上面详情页那段对称。这里断言的"生效"证据是**网格类名**与**卡片副标题文案**，
  // 两者都能在列表页直接读到，不需要额外状态。
  /** 列表页那一页就在同一个面板里（抽屉只剩一个入口），切 tab 即可 */
  const COL_SEL = ".ed-inspector .seg-choice[aria-label='每行列数'] button";
  const openListLayoutPanel = async () => {
    await openLayoutPanel("列表页");
    if (!q(".ed-page")) throw new Error("切到列表页后面板不见了");
    // v3.3：列表页的配置入口是**点画布里的卡片**（排布总表已删除）——
    // 这一步同时验证了"删掉总表之后列表页配置仍有入口"这条硬约束。
    const card = q(".ed-listblk");
    if (!card) throw new Error("列表页画布里没有可点选的卡片区块（.ed-listblk）");
    card.click();
    await sleep(450);
    if (!q(".ed-inspector .ed-listcard")) throw new Error("点了列表页卡片却没有出现卡片配置");
  };
  const gridClass = () => (q(".list") || {}).className || "";
  const firstSubtitle = () => T(q(".list-item .muted"));

  const subtitleBefore = firstSubtitle();
  await openListLayoutPanel();
  log.push({
    step: "list-layout-open",
    title: T(q(".ed-top h2")),
    page: currentPage(),
    groups: qa(".ed-inspector .ed-listcard .grpname").map(T),
    rows: qa(".ed-inspector .ed-listcard .ditem").length,
    switches: qa(".ed-inspector .ed-listcard .ditem button.switch").length,
    columnOptions: qa(COL_SEL).map(T),
    hasDone: !!q(".ed-inspector .ed-listcard .ed-paneldone"),
    drawerClosed: !q(".side-drawer.open")
  });
  if (currentPage() !== "列表页") throw new Error("点「列表页」卡片后编辑屏标题不对：" + currentPage());
  if (qa(".ed-inspector .ed-listcard .ditem").length !== 3) throw new Error("字段行数不对：" + qa(".ed-inspector .ed-listcard .ditem").length);
  if (qa(COL_SEL).length !== 3) throw new Error("列数档位不是 3 个");
  // 用户第 9 条：所有配置栏都要有「完成」
  if (!q(".ed-inspector .ed-listcard .ed-paneldone")) throw new Error("列表页卡片配置栏没有「完成」按钮");

  // 三个字段全关 → 副标题应为空串（空内容由 `.list-item .muted:empty` 收掉）
  for (const name of ["作者", "分类", "副标题"]) {
    const r = qa(".ed-inspector .ed-listcard .ditem").find((d) => T(d.querySelector(".dl-label")).indexOf(name) === 0);
    if (!r) throw new Error("列表页卡片配置里找不到「" + name + "」行");
    r.querySelector("button.switch").click();
    await sleep(220);
  }
  // 选 2 列
  qa(COL_SEL).find((b) => T(b) === "2 列").click();
  await sleep(300);
  const listSaved = JSON.parse(localStorage.getItem("jmclient.listLayout.v1") || "{}");
  log.push({ step: "list-layout-changed", hidden: listSaved.hidden, columns: listSaved.columns });
  if ((listSaved.hidden || []).length !== 3) throw new Error("三个字段没都写进 hidden：" + JSON.stringify(listSaved.hidden));
  if (listSaved.columns !== 2) throw new Error("列数没写进去：" + JSON.stringify(listSaved.columns));

  // 关面板 → 回列表 → 网格真变成 2 列、副标题真的空了
  q(".ed-back").click();
  await sleep(800);
  log.push({
    step: "list-layout-applied",
    gridClass: gridClass(),
    subtitle: firstSubtitle(),
    subtitleBefore,
    cards: qa(".list-item").length
  });
  if (!/cols-2/.test(gridClass())) throw new Error("选了 2 列但网格没有 cols-2：" + gridClass());
  if (firstSubtitle() !== "") throw new Error("三个字段都关了，卡片副标题却不是空的：" + JSON.stringify(firstSubtitle()));

  // 恢复默认 → 副标题回到原样、网格回到"跟随断点"（v3.3：入口是「⋯」菜单里的「恢复全部默认」，
  // 它现在连列表页配置一起重置 —— 排布总表那颗「恢复默认布局」按钮随面板一起删了）
  await openListLayoutPanel();
  q(".ed-more").click(); await sleep(250);
  const resetItem3 = qa(".ed-menu .ed-menuitem").find((b) => /恢复/.test(T(b)));
  if (!resetItem3) throw new Error("「⋯」菜单里找不到「恢复全部默认」");
  resetItem3.click();
  await sleep(450);
  q(".ed-back").click();
  await sleep(800);
  log.push({
    step: "list-layout-restored",
    gridClass: gridClass(),
    subtitle: firstSubtitle(),
    saved: JSON.parse(localStorage.getItem("jmclient.listLayout.v1") || "{}")
  });
  if (/cols-/.test(gridClass())) throw new Error("恢复默认后网格还带着列数类：" + gridClass());
  if (firstSubtitle() !== subtitleBefore) {
    throw new Error("恢复默认后副标题没回到原样：" + JSON.stringify({ before: subtitleBefore, after: firstSubtitle() }));
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