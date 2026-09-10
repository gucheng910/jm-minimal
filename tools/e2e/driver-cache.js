// 缓存中心回归：同书多话合并 / 离线详情页 / 目录缓存徽标 / 未缓存话走网络 / 返回后目录仍在
// 需要 stub 的 ?e2ecache=1 预置数据（localStorage 队列 + IndexedDB 元数据 + Cache API 图片）
(async () => {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (el) => (el ? (el.textContent || "").trim() : "");
  const waitFor = async (sel, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const el = q(sel); if (el) return el; await sleep(50); }
    throw new Error("waitFor timeout: " + sel + " / body=" + document.body.innerText.slice(0, 200));
  };
  const back = () => window.dispatchEvent(new CustomEvent("jm:back", { detail: { consumed: false } }));
  const readReqs = () => (window.__reqs || []).filter((r) => r.path === "comic_read");

  (await waitFor(".age-confirm")).click();
  await waitFor(".list-item");
  await sleep(600);
  if (window.__seedDone) await window.__seedDone;

  // ---- 缓存列表：同书两话合并成一行 ----
  q('button[aria-label="缓存"]').click();
  await waitFor(".cache-overlay");
  // 极简版：缓存中心的分页也改成下划线标签（结构/操作未变）
  const doneChip = qa(".cache-tabs .tk").find((c) => txt(c).startsWith("已缓存"));
  if (!doneChip) throw new Error("没有「已缓存」分页");
  doneChip.click();
  await sleep(700);
  const rows = qa(".cache-overlay .list .list-item");
  log.push({
    step: "cache-list",
    rows: rows.length,
    title: txt(rows[0] && rows[0].querySelector(".title")),
    meta: txt(rows[0] && rows[0].querySelector(".muted")),
    // 同一本书两话必须合并为 1 行
    merged: rows.length === 1
  });

  // ---- 点封面 → 离线详情页（数据全来自 IndexedDB）----
  rows[0].click();
  await waitFor(".book-chapters");
  await sleep(400);
  const statuses = qa(".chapter-main .muted").map(txt);
  log.push({
    step: "offline-detail",
    title: txt(q(".cache-header h2")),
    meta: txt(q(".cache-header .muted")),
    desc: txt(q(".book-desc")),
    tags: txt(q(".book-tags")),
    chapters: qa(".chapter-row").length,
    cachedBadges: qa(".badge.ok").length,
    labels: qa(".chapter-main .title").map(txt),
    statuses
  });
  // 第3话只有一个空 cache（stub 故意造的）：必须判为「未缓存」，否则点进去会卡死
  if (statuses.filter((s) => s.startsWith("已缓存")).length !== 2) {
    throw new Error("缓存判定错误，空 cache 被当成已缓存：" + JSON.stringify(statuses));
  }

  // ---- 未缓存话（第3话）→ 正常走网络 ----
  const ch3 = qa(".chapter-row").find((r) => /第3话/.test(txt(r)));
  if (!ch3) throw new Error("目录里没有第3话");
  ch3.querySelector(".chapter-main").click();
  await waitFor(".reader-wrap");
  await sleep(900);
  log.push({
    step: "online-read-uncached",
    title: txt(q(".reader-title")),
    readReq: readReqs().slice(-1)[0] || null,
    imgs: qa(".reader-wrap img").length,
    offlineToolbarHidden: !qa(".reader-toolbar .source-select").length
  });

  // ---- 返回：离线详情页与目录必须还在 ----
  qa(".reader-toolbar button").find((b) => txt(b) === "返回").click();
  await waitFor(".book-chapters");
  await sleep(300);
  log.push({
    step: "back-to-offline-detail",
    title: txt(q(".cache-header h2")),
    chapters: qa(".chapter-row").length,
    cachedBadges: qa(".badge.ok").length,
    errs: window.__errs.slice(0, 3)
  });

  // ---- 已缓存话（第2话）→ 离线阅读（blob URL，不再请求 comic_read）----
  const before = readReqs().length;
  const ch2 = qa(".chapter-row").find((r) => /第2话/.test(txt(r)));
  ch2.querySelector(".chapter-main").click();
  await waitFor(".reader-wrap");
  await sleep(900);
  log.push({
    step: "offline-read-cached",
    imgs: qa(".reader-wrap img").map((i) => i.src.slice(0, 5)),
    newReadReqs: readReqs().length - before,
    offlineToolbarHidden: !qa(".reader-toolbar .source-select").length,
    // 离线详情页阅读同样记足迹（按书合并）
    history: localStorage.getItem("jmclient.history")
  });

  // ---- 离线阅读器里也能换话：弹窗标出哪些话已缓存 ----
  // 工具栏的换话按钮文字 = 当前话名，等它就位（阅读器数据就绪后才渲染）
  let chapBtn = null;
  for (let i = 0; i < 60 && !chapBtn; i++) {
    chapBtn = qa(".reader-toolbar button").find((b) => /第2话/.test(txt(b))) || null;
    if (!chapBtn) await sleep(200);
  }
  if (!chapBtn) throw new Error("离线阅读器里没有换话按钮：" + qa(".reader-toolbar button").map(txt).join(","));
  {
    chapBtn.click();
    await waitFor(".reader-sheet");
    await sleep(400);
    log.push({
      step: "offline-chapter-sheet",
      rows: qa(".reader-sheet .sheet-row").map((r) => ({ title: txt(r.querySelector(".title")), meta: txt(r.querySelector(".muted")) }))
    });
    qa(".reader-sheet button").find((b) => txt(b) === "关闭").click();
    await sleep(400);
  }

  // ---- 系统返回键：回到离线详情页，再返回回到缓存列表 ----
  back();
  await waitFor(".book-chapters");
  await sleep(300);
  log.push({ step: "back-key-to-book", chapters: qa(".chapter-row").length });
  back();
  await sleep(500);
  log.push({
    step: "back-key-to-list",
    backToCacheList: !!q(".cache-tabs"),
    bookGone: !q(".book-chapters"),
    fatal: (document.getElementById("jm-fatal") || {}).textContent || "",
    errs: window.__errs.slice(0, 5)
  });

  return log;
})()
