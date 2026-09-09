// 连载详情 + 足迹回归：话级 payload 缺作者/简介时用书级补全、足迹按「书」合并成一条
(async () => {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (el) => (el ? (el.textContent || "").trim() : "");
  const waitFor = async (sel, timeout = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const el = q(sel); if (el) return el; await sleep(50); }
    throw new Error("waitFor timeout: " + sel + " / body=" + document.body.innerText.slice(0, 200));
  };
  const waitGone = async (sel, timeout = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (!q(sel)) return true; await sleep(50); }
    throw new Error("waitGone timeout: " + sel);
  };
  const openAid = (id) => window.dispatchEvent(new CustomEvent("jm:openAid", { detail: id }));
  const albumReqs = () => (window.__reqs || []).filter((r) => r.path === "album").map((r) => r.id);
  const clickBtn = (text) => {
    const b = qa("button").find((x) => txt(x) === text);
    if (!b) throw new Error("button not found: " + text);
    b.click();
    return b;
  };

  (await waitFor(".age-confirm")).click();
  await waitFor(".list-item");
  await sleep(600);

  // ---- 打开连载第2话：话级 payload 无作者/简介，必须由书级补全 ----
  const before = albumReqs().length;
  openAid("900002");
  await waitFor(".page-push h2");
  await sleep(1500);
  const metaLines = qa(".page-push .card > p.muted").map(txt);
  log.push({
    step: "chapter-detail",
    title: txt(q(".page-push h2")),
    authorLine: metaLines.find((t) => t.startsWith("作者")) || "",
    tagsLine: metaLines.find((t) => t.startsWith("标签")) || "",
    desc: txt(q(".page-push .card > p:not(.muted)")),
    seriesOptions: qa(".page-push select option").map(txt),
    albumReqs: albumReqs().slice(before),
    fatal: (document.getElementById("jm-fatal") || {}).textContent || ""
  });

  // ---- 读第2话 → 返回详情 ----
  clickBtn("立即阅读");
  await waitFor(".reader-wrap");
  await sleep(800);
  clickBtn("返回");
  await waitGone(".reader-wrap");
  await sleep(600);

  // ---- 换到第3话再读一次（同一本书，足迹应合并）----
  openAid("900003");
  await waitFor(".page-push h2");
  await sleep(1200);
  log.push({ step: "chapter-detail-3", title: txt(q(".page-push h2")) });
  clickBtn("立即阅读");
  await waitFor(".reader-wrap");
  await sleep(800);
  clickBtn("返回");
  await waitGone(".reader-wrap");
  await sleep(800);

  // ---- 会员页 → 我的足迹 ----
  const memberNav = qa(".nav-item").find((b) => /会员/.test(txt(b)));
  if (!memberNav) throw new Error("底部没有会员 tab");
  memberNav.click();
  await sleep(1500);
  clickBtn("我的足迹");
  await waitFor(".cache-overlay .list-item");
  await sleep(500);
  const rows = qa(".cache-overlay .list-item");
  log.push({
    step: "history",
    rows: rows.length,
    title: txt(rows[0].querySelector(".title")),
    meta: txt(rows[0].querySelector(".muted")),
    raw: localStorage.getItem("jmclient.history")
  });

  // ---- 点足迹条目 → 打开最后阅读的那一话 ----
  rows[0].click();
  await waitFor(".page-push h2");
  await sleep(1200);
  log.push({
    step: "history-open",
    title: txt(q(".page-push h2")),
    lastAlbumReq: albumReqs().slice(-1)[0],
    fatal: (document.getElementById("jm-fatal") || {}).textContent || "",
    errs: window.__errs.slice(0, 5)
  });
  return log;
})()
