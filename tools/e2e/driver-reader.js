// 阅读器内弹窗回归：更快的源（自动测速 + 弹窗不关闭）/ 换话 / 选话缓存（全选·反选·已缓存徽标）
(async () => {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (el) => (el ? (el.textContent || "").trim() : "");
  const waitUntil = async (fn, timeout = 12000, label = "condition") => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(60); }
    throw new Error("waitUntil timeout: " + label);
  };
  const waitFor = async (sel, timeout) => { await waitUntil(() => !!q(sel), timeout, sel); return q(sel); };
  const waitGone = (sel, timeout) => waitUntil(() => !q(sel), timeout, "gone " + sel);
  const btn = (text) => {
    const b = qa("button").find((x) => txt(x) === text);
    if (!b) throw new Error("button not found: " + text + " / have: " + qa(".reader-toolbar button").map(txt).join(","));
    return b;
  };
  const btnStarts = (prefix) => {
    const b = qa("button").find((x) => txt(x).startsWith(prefix));
    if (!b) throw new Error("button not found (prefix): " + prefix);
    return b;
  };
  const tbButtons = () => qa(".reader-toolbar button").map(txt);
  const back = () => window.dispatchEvent(new CustomEvent("jm:back", { detail: { consumed: false } }));
  // 对比度检查：弹窗文字/按钮在抽屉底色上的 WCAG 对比度（防止再出现"文字过淡像禁用"）
  const effBg = (el) => {
    let n = el;
    while (n) {
      const m = getComputedStyle(n).backgroundColor.match(/[\d.]+/g);
      if (m && (m.length < 4 || Number(m[3]) > 0.95)) return m.slice(0, 3).map(Number);
      n = n.parentElement;
    }
    return [255, 255, 255];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (el) => {
    const fg = getComputedStyle(el).color.match(/[\d.]+/g).slice(0, 3).map(Number);
    const bg = effBg(el);
    const l1 = lum(fg), l2 = lum(bg);
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
  };
  const sheetContrast = () => Array.from(document.querySelectorAll(".reader-sheet .sheet-actions button, .reader-sheet .sheet-row .title, .reader-sheet .sheet-row .muted"))
    .map((el) => ({ text: txt(el).slice(0, 14), ratio: contrast(el) }));
  const assertContrast = (label) => {
    const rows = sheetContrast();
    const bad = rows.filter((r) => r.ratio < 3);
    if (bad.length) throw new Error(label + " 弹窗对比度不足: " + JSON.stringify(bad));
    return rows;
  };
  const readIds = () => (window.__reqs || []).filter((r) => r.path === "comic_read").map((r) => r.id);
  const cacheIds = () => { try { return JSON.parse(localStorage.getItem("jmclient.cacheTasks.v2") || "[]").map((t) => t.id); } catch (e) { return []; } };

  (await waitFor(".age-confirm")).click();
  await waitFor(".list-item");
  await sleep(600);

  // 打开连载第2话 → 立即阅读
  window.dispatchEvent(new CustomEvent("jm:openAid", { detail: "900002" }));
  await waitFor(".page-push h2");
  await sleep(1300);
  btn("立即阅读").click();
  await waitFor(".reader-wrap");
  await sleep(900);
  log.push({ step: "toolbar", buttons: tbButtons(), sourceSelectGone: !q(".reader-toolbar select.source-select") });

  /**
   * v3.8「解耦」：控制条上每个元素都是**有 id 的单元**（`data-unit`），
   * 顺序由 core/chromeLayout.ts 的 `readerTop` / `readerTools` 决定。
   *
   * 判据写成"**在位单元必须是注册表里的、且顺序与注册表一致**"，而不是"必须正好 4 个"：
   * 条件不满足的单元本来就不渲染（离线没有"更快的源"、单话作品没有"换话"、已缓存时按钮变"已缓存"）
   * —— 那是运行时事实，不是配置能决定的（见 core/chromeLayout.ts 的三条纪律）。
   * 判别力：如果渲染层忽略了配置（各自硬编码），`data-unit` 会整片缺失 → 这里直接红。
   */
  {
    const unitOf = (el) => el.getAttribute("data-unit") || "";
    const topUnits = qa(".reader-toolbar .rt-top > *").map(unitOf);
    const toolUnits = qa(".reader-toolbar .rt-tools > *").map(unitOf);
    const TOP_CANON = ["readerTop:back", "readerTop:title", "readerTop:page"];
    const TOOL_CANON = ["readerTools:source", "readerTools:chapter", "readerTools:cache", "readerTools:settings"];
    const asSubsequence = (got, canon) => {
      let i = 0;
      for (const u of got) {
        const at = canon.indexOf(u, i);
        if (at < 0) return false;
        i = at + 1;
      }
      return true;
    };
    log.push({ step: "toolbar-units", top: topUnits, tools: toolUnits });
    if (topUnits.length === 0 || toolUnits.length === 0) {
      throw new Error("控制条没有单元属性（data-unit 全缺）：top=" + topUnits.join(",") + " tools=" + toolUnits.join(","));
    }
    if (!asSubsequence(topUnits, TOP_CANON)) throw new Error("控制条上排出现未注册 / 乱序单元：" + topUnits.join(","));
    if (!asSubsequence(toolUnits, TOOL_CANON)) throw new Error("控制条工具出现未注册 / 乱序单元：" + toolUnits.join(","));
    if (topUnits[0] !== "readerTop:back") throw new Error("上排第一个应当是「返回」（唯一退出入口）：" + topUnits[0]);
  }


  // 右侧浮标（阅读器的"滚动条"）必须在视口内且有实际高度：
  // 工具栏是 position:fixed inset:0 的整屏遮罩，若拿它的 rect.bottom 当浮标起点，浮标会被推到屏幕外且高度为 0
  window.scrollBy(0, 400);
  await sleep(200);
  const railEl = q(".reader-rail");
  const rr = railEl ? railEl.getBoundingClientRect() : null;
  const railDiag = rr ? {
    h: Math.round(rr.height), top: Math.round(rr.top), bottom: Math.round(rr.bottom),
    opacity: getComputedStyle(railEl).opacity,
    inView: rr.height > 120 && rr.top >= 0 && rr.bottom <= innerHeight + 1
  } : null;
  if (!railDiag || !railDiag.inView || railDiag.opacity !== "1") throw new Error("阅读器右侧浮标不可见: " + JSON.stringify(railDiag));
  log.push({ step: "rail", ...railDiag });

  // ---- 更快的源：弹窗 + 自动测速 ----
  btn("更快的源").click();
  await waitFor(".reader-sheet");
  log.push({
    step: "source-open",
    rows: qa(".reader-sheet .sheet-row .title").map(txt),
    testing: /正在测速/.test(txt(q(".reader-sheet .muted"))),
    contrast: assertContrast("更快的源")
  });
  // 系统返回键：只关弹窗，不退出阅读器（先测，避免之后选源时浮层已自动关闭）
  back();
  await waitGone(".reader-sheet", 8000);
  log.push({ step: "back-closes-source-sheet", readerAlive: !!q(".reader-wrap"), toolbar: tbButtons() });

  // 重新打开：自动测速完成 → 浮层保持打开，行内写回耗时
  btn("更快的源").click();
  await waitFor(".reader-sheet");
  await sleep(300);
  await waitUntil(() => !/正在测速/.test(txt(q(".reader-sheet .muted"))), 20000, "speed test done");
  await sleep(400);
  log.push({
    step: "source-tested",
    sheetStillOpen: !!q(".reader-sheet"),
    rows: qa(".reader-sheet .sheet-row").map((r) => ({ title: txt(r.querySelector(".title")), meta: txt(r.querySelector(".muted")), active: r.classList.contains("active") })),
    toast: txt(q(".toast")),
    probeReqs: (window.__reqs || []).filter((r) => r.path === "setting").length
  });
  // 手动点「图源1」（更慢的那个）：浮层立刻关闭，阅读器先进骨架再整块填充
  const slow = qa(".reader-sheet .sheet-row").find((r) => /图源1/.test(txt(r)));
  if (slow) slow.click();
  await sleep(80);
  const sourceStage = { loadingShown: !!q(".reader-wrap .loading-box.small"), skeletons: qa(".reader-cont .jm-figure > img").length };
  if (!sourceStage.loadingShown) throw new Error("换源后没有出现加载骨架");
  await waitGone(".reader-sheet", 8000);
  await waitUntil(() => !q(".reader-wrap .loading-box.small") && qa(".reader-cont .jm-figure").length > 0, 12000, "source reload filled");
  log.push({
    step: "source-manual",
    sheetClosed: !q(".reader-sheet"),
    stage: sourceStage,
    figures: qa(".reader-cont .jm-figure").length,
    toast: txt(q(".toast"))
  });

  // ---- 关闭弹窗即取消在途测速（不再切源/刷新）----
  btn("更快的源").click();
  await waitFor(".reader-sheet");
  back();                                   // 测速还没跑完就关掉
  await waitGone(".reader-sheet", 8000);
  await sleep(1800);
  log.push({
    step: "close-cancels-speedtest",
    toolbar: tbButtons(),
    switchedAfterClose: /已切换最快/.test(txt(q(".toast"))),
    sheetOpen: !!q(".reader-sheet")
  });

  // ---- 换话：按钮显示当前话，弹窗列出全部话，切换后标题/请求都变 ----
  btn("第2话").click();
  await waitFor(".reader-sheet");
  log.push({
    step: "chapter-open",
    head: txt(q(".reader-sheet h3")),
    rows: qa(".reader-sheet .sheet-row .title").map(txt),
    current: txt(q(".reader-sheet .sheet-row.active .title"))
  });
  const ch3 = qa(".reader-sheet .sheet-row").find((r) => /第3话/.test(txt(r)));
  ch3.click();
  await sleep(80);
  const chapterStage = { loadingShown: !!q(".reader-wrap .loading-box.small"), skeletons: qa(".reader-cont .jm-figure > img").length };
  if (!chapterStage.loadingShown) throw new Error("换话后没有出现加载骨架");
  await waitGone(".reader-sheet", 8000);
  await waitUntil(() => !q(".reader-wrap .loading-box.small") && qa(".reader-cont .jm-figure").length > 0, 12000, "chapter reload filled");
  log.push({
    step: "chapter-switched",
    title: txt(q(".reader-title")),
    lastReadId: readIds().slice(-1)[0],
    sheetClosed: !q(".reader-sheet"),
    stage: chapterStage,
    figures: qa(".reader-cont .jm-figure").length,
    toolbar: tbButtons()
  });

  // ---- 选话缓存：默认只选当前话 ----
  btn("缓存").click();
  await waitFor(".reader-sheet");
  // 返回键只关弹窗（阅读器还在）
  back();
  await waitGone(".reader-sheet", 8000);
  log.push({ step: "back-closes-cache-sheet", readerAlive: !!q(".reader-wrap") });
  btn("缓存").click();
  await waitFor(".reader-sheet");
  const boxes = () => qa(".reader-sheet input[type=checkbox]");
  log.push({
    step: "cache-open",
    head: txt(q(".reader-sheet h3")),
    boxes: boxes().length,
    checked: boxes().filter((b) => b.checked).length,
    checkedLabels: qa(".reader-sheet .check-row").filter((r) => r.querySelector("input").checked).map((r) => txt(r.querySelector(".title"))),
    actions: qa(".reader-sheet .sheet-actions button").map(txt),
    badges: qa(".reader-sheet .check-row .badge").length,
    contrast: assertContrast("缓存")
  });
  // 全选 → 反选
  btn("全选").click();
  await sleep(200);
  log.push({ step: "cache-select-all", checked: boxes().filter((b) => b.checked).length, confirm: txt(qa(".reader-sheet .sheet-actions button").pop()) });
  btn("反选").click();
  await sleep(200);
  log.push({ step: "cache-invert", checked: boxes().filter((b) => b.checked).length, checkedLabels: qa(".reader-sheet .check-row").filter((r) => r.querySelector("input").checked).map((r) => txt(r.querySelector(".title"))) });
  // 再全选后确认
  btn("全选").click();
  await sleep(200);
  btnStarts("确认开始缓存").click();
  await waitGone(".reader-sheet", 20000);
  await sleep(1200);
  log.push({
    step: "cache-confirmed",
    queuedIds: cacheIds().slice(0, 5),
    readIds: readIds().slice(-3),
    toast: txt(q(".toast")),
    toolbar: tbButtons()
  });

  // ---- 缓存后再开弹窗：已缓存的话必须带 ✓ 徽标 ----
  await waitUntil(() => !qa(".reader-toolbar button").some((b) => /缓存中/.test(txt(b))), 20000, "cache task done");
  await sleep(500);
  btn("第3话").click();
  await waitFor(".reader-sheet");
  log.push({
    step: "chapter-open-after-cache",
    rows: qa(".reader-sheet .sheet-row").map((r) => ({ title: txt(r.querySelector(".title")), meta: txt(r.querySelector(".muted")), cached: !!r.querySelector(".badge.ok") }))
  });
  q(".reader-sheet .sheet-close").click(); // 关闭按钮已改成右上角叉
  await waitGone(".reader-sheet");
  // 整本缓存后：工具栏按钮应变成不可点的「已缓存」
  await waitUntil(() => tbButtons().includes("已缓存"), 8000, "已缓存按钮");
  const cachedBtn = qa(".reader-toolbar button").find((b) => txt(b) === "已缓存");
  log.push({ step: "cache-button-disabled", disabled: cachedBtn.disabled, toolbar: tbButtons() });

  // ---- 阅读设置弹层：模式 / 去条纹 / 跳页 ----
  // 放在最后：它会切换阅读模式，避免影响前面那些对骨架/滚动/浮标的断言。
  // 这一段补的是一个**既有盲区**：图源 / 换话 / 选话缓存三个弹层都有覆盖，只有「阅读设置」没有。
  btn("设置").click();
  await waitFor(".reader-sheet");
  const settingsHead = txt(q(".reader-sheet h3"));
  const modeRows = qa(".reader-sheet .sheet-list .sheet-row .title").map(txt);
  log.push({
    step: "settings-open",
    head: settingsHead,
    modes: modeRows,
    activeMode: txt(q(".reader-sheet .sheet-list .sheet-row.active .title")),
    hasJumpInput: !!q(".reader-sheet input.page-input"),
    hasDeseam: !!q(".reader-sheet .btn-deseam")
  });
  if (settingsHead !== "阅读设置") throw new Error("阅读设置弹层标题不对：" + settingsHead);
  if (modeRows.length < 2) throw new Error("阅读设置缺少模式选项：" + JSON.stringify(modeRows));
  if (!q(".reader-sheet input.page-input")) throw new Error("阅读设置缺少跳页输入框");

  // 切到「单页」→ 应多出「翻页方向」；切回「连续滚动」→ 它应消失。
  // 翻页方向只对单页有意义（连续滚动是上下滚，没有左右分区），这条条件渲染必须有断言守着。
  const singleRow = qa(".reader-sheet .sheet-row").find((r) => /单页/.test(txt(r)));
  if (!singleRow) throw new Error("阅读设置里找不到「单页」");
  singleRow.click();
  await sleep(300);
  const segInSingle = !!q(".reader-sheet .seg-choice");
  if (!segInSingle) throw new Error("切到单页后没有出现「翻页方向」");
  const contRow = qa(".reader-sheet .sheet-row").find((r) => /连续滚动/.test(txt(r)));
  if (!contRow) throw new Error("阅读设置里找不到「连续滚动」");
  contRow.click();
  await sleep(300);
  const segGone = !q(".reader-sheet .seg-choice");
  if (!segGone) throw new Error("切回连续滚动后「翻页方向」应消失");
  log.push({ step: "settings-mode-switch", segInSingle, segGoneInContinuous: segGone });

  // 系统返回键只关弹层、不退出阅读器（与「更快的源」同一条约束）
  back();
  await waitGone(".reader-sheet", 8000);
  log.push({ step: "back-closes-settings-sheet", readerAlive: !!q(".reader-wrap"), sheetGone: !q(".reader-sheet") });

  /**
   * v3.12 状态栏条目（调研：**进度条不是原子单元**）。
   * 三件事都要在真页上验：① 默认**整行不在**（红线）；② 打开后内容/顺序/时间格式对；
   * ③ **经抽屉里的按钮**能开关，且落盘的是同一份配置（不是另一份 state）。
   */
  {
    const KEY = "jmclient.chromeLayout.v1";
    const rows = () => qa(".reader-toolbar .rt-status .rt-st").map((e) => (e.textContent || "").trim());
    if (q(".reader-toolbar .rt-status")) {
      throw new Error("默认不该有状态栏那一行（红线：没配过的用户 DOM 一字不差）");
    }
    // ② 直接写配置 + 广播（与抽屉按钮走的是同一条路径）
    const rawCfg = localStorage.getItem(KEY);
    localStorage.setItem(KEY, JSON.stringify({ version: 2, hidden: [] }));   // version 2 + 一条都不关 = 四条都开
    window.dispatchEvent(new CustomEvent("jm:chromeLayout"));
    await sleep(500);
    const on = rows();
    log.push({ step: "status-on", rows: on });
    if (on.length !== 4) throw new Error("打开四条后状态栏应有 4 个条目，实际：" + on.length + " → " + on.join(" | "));
    if (!/^\d+ \/ \d+$/.test(on[1])) throw new Error("第 2 条应当是「当前 / 总页数」：" + on[1]);
    if (!/^\d+%$/.test(on[2])) throw new Error("第 3 条应当是百分比：" + on[2]);
    if (!/^\d{2}:\d{2}$/.test(on[3])) throw new Error("第 4 条应当是 HH:MM 的时间：" + on[3]);
    // 条目顺序 = 注册表顺序（章节名 / 页码 / 百分比 / 时间）
    const units = qa(".reader-toolbar .rt-status .rt-st").map((e) => e.getAttribute("data-unit") || "");
    if (units.join(",") !== "readerStatus:chapter,readerStatus:page,readerStatus:pct,readerStatus:clock") {
      throw new Error("状态栏条目的单元顺序不对：" + units.join(","));
    }

    // ③ 经抽屉按钮关掉「页码」→ 行里少一条、配置里落盘的是 hidden
    btn("设置").click();
    await waitFor(".reader-sheet");
    await sleep(320);
    const pageBtn = qa(".reader-sheet .settings-actions button").find((b) => txt(b).replace(/\s*✓$/, "") === "页码");
    if (!pageBtn) throw new Error("阅读设置里没有「页码」这个状态栏开关");
    pageBtn.click();
    await sleep(420);
    const afterOff = rows();
    const savedHidden = JSON.parse(localStorage.getItem(KEY) || "{}").hidden || [];
    log.push({ step: "status-toggle", rows: afterOff, hidden: savedHidden });
    if (afterOff.length !== 3 || afterOff.some((t) => /^\d+ \/ \d+$/.test(t))) {
      throw new Error("关掉「页码」后状态栏仍有页码：" + afterOff.join(" | "));
    }
    if (savedHidden.indexOf("readerStatus:page") < 0) {
      throw new Error("关掉「页码」没有落盘到 chromeLayout：" + JSON.stringify(savedHidden));
    }
    // 复原：关上全部（= 默认），并把原来的配置还回去
    window.dispatchEvent(new CustomEvent("jm:chromeLayout"));
    if (rawCfg === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, rawCfg);
    window.dispatchEvent(new CustomEvent("jm:chromeLayout"));
    await sleep(320);
    // 收尾：关掉抽屉（用这支驱动里已验证的关法：走 app 的返回事件 + 等它真的消失）。
    // ⚠️ 不能用 `.sheet-close` 点一下了事：抽屉开着时阅读器**锁着滚动**（pushSheetLock），
    //    锁没解开的话后面那一步的 `window.scrollBy` 不生效、右侧浮标就不会现身。
    back();
    await waitGone(".reader-sheet", 8000);
    await sleep(320);
  }

  // ── ⑨ v3.13「阅读器观感 → 滚动条」真的作用到 <html> 上（这一段要趁阅读器还开着）──
  //    三连断言才是判别性的：默认**没有**属性（与改造前逐字一致）→ 选了档位**有** → 改回默认**摘掉**。
  //    只断言"选了之后有"是不够的：把属性写成常驻也能过那条。
  {
    const rsb = () => document.documentElement.getAttribute("data-jm-rsb");
    if (document.documentElement.hasAttribute("data-jm-rsb")) {
      throw new Error("默认档位下不该有 data-jm-rsb（默认 = 完全隐藏 = 改造前的行为）");
    }
    localStorage.setItem("jmclient.readerStyle.v1", JSON.stringify({ version: 1, scrollbar: "thin", autoHide: "3s" }));
    window.dispatchEvent(new CustomEvent("jm:readerStyle"));
    await sleep(320);
    log.push({ step: "reader-scrollbar-on", rsb: rsb() });
    if (rsb() !== "thin") throw new Error("把滚动条设成「细条」后 <html> 上没有 data-jm-rsb=thin：" + rsb());
    // 改回默认 → 属性必须被**摘掉**（不是写成 "hidden"）
    localStorage.setItem("jmclient.readerStyle.v1", JSON.stringify({ version: 1, scrollbar: "hidden", autoHide: "3s" }));
    window.dispatchEvent(new CustomEvent("jm:readerStyle"));
    await sleep(320);
    if (document.documentElement.hasAttribute("data-jm-rsb")) {
      throw new Error("改回默认档位后属性没被摘掉：" + rsb());
    }
    localStorage.removeItem("jmclient.readerStyle.v1");
    window.dispatchEvent(new CustomEvent("jm:readerStyle"));
    await sleep(160);
  }

  log.push({ step: "final", fatal: (document.getElementById("jm-fatal") || {}).textContent || "", errs: window.__errs.slice(0, 5) });
  return log;
})()
