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

  // ---- 更快的源：弹窗 + 自动测速 ----
  btn("更快的源").click();
  await waitFor(".reader-sheet");
  log.push({
    step: "source-open",
    rows: qa(".reader-sheet .sheet-row .title").map(txt),
    testing: /正在测速/.test(txt(q(".reader-sheet .muted")))
  });
  await waitUntil(() => !/正在测速/.test(txt(q(".reader-sheet .muted"))), 20000, "speed test done");
  await sleep(400);
  log.push({
    step: "source-tested",
    sheetStillOpen: !!q(".reader-sheet"),
    rows: qa(".reader-sheet .sheet-row").map((r) => ({ title: txt(r.querySelector(".title")), meta: txt(r.querySelector(".muted")), active: r.classList.contains("active") })),
    toast: txt(q(".toast")),
    probeReqs: (window.__reqs || []).filter((r) => r.path === "setting").length
  });
  // 手动点「图源1」（更慢的那个）：弹窗保持打开、当前项跟着变
  const slow = qa(".reader-sheet .sheet-row").find((r) => /图源1/.test(txt(r)));
  if (slow) slow.click();
  await sleep(1200);
  log.push({
    step: "source-manual",
    sheetStillOpen: !!q(".reader-sheet"),
    active: qa(".reader-sheet .sheet-row").filter((r) => r.classList.contains("active")).map((r) => txt(r.querySelector(".title"))),
    toast: txt(q(".toast"))
  });
  btn("关闭").click();
  await waitGone(".reader-sheet");

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
  await sleep(1600);
  log.push({
    step: "chapter-switched",
    title: txt(q(".reader-title")),
    lastReadId: readIds().slice(-1)[0],
    sheetClosed: !q(".reader-sheet"),
    toolbar: tbButtons()
  });

  // ---- 选话缓存：默认只选当前话 ----
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
    badges: qa(".reader-sheet .check-row .badge").length
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
  btn("关闭").click();
  await waitGone(".reader-sheet");
  log.push({ step: "final", fatal: (document.getElementById("jm-fatal") || {}).textContent || "", errs: window.__errs.slice(0, 5) });
  return log;
})()
