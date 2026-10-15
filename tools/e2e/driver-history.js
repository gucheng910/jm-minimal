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
  // 详情页 v7.2：作者/话数/JM号/收录是四宫格（.d-facts），简介 .d-desc，目录 .chap-row
  const facts = qa(".page-push .d-facts .fact").map(txt);
  const factKeys = qa(".page-push .d-facts .fact .k").map(txt);
  log.push({
    step: "chapter-detail",
    title: txt(q(".page-push h2")),
    authorLine: facts.find((t) => t.startsWith("作者")) || "",
    facts,
    tags: qa(".page-push .tagchip").map(txt),
    desc: txt(q(".page-push .d-desc")),
    chapters: qa(".page-push .chap-row .chap-name").map(txt),
    albumReqs: albumReqs().slice(before),
    fatal: (document.getElementById("jm-fatal") || {}).textContent || ""
  });

  /**
   * 【回归断言】v3.12 补：这一页的**四宫格**以前只被记录、没被断言 ——
   * 于是"详情页的详细内容（作者 / 话数 / JM号 / 收录）不见了"这类回归，四支编辑器 e2e 全绿也抓不到
   * （用户反馈：从列表进详情页，JM号等详细内容加载不出来）。
   * 判据写死**四个标签**与**JM号的值等于这一话的 id**：少一个、或 JM号 变成 "-"，立刻红。
   */
  if (factKeys.join(",") !== "作者,话数,JM号,收录") {
    throw new Error("详情页四宫格字段不对（应为 作者,话数,JM号,收录）：" + factKeys.join(",") + " / 实际文本：" + facts.join(" | "));
  }
  const jmId = (facts.find((t) => t.startsWith("JM号")) || "").replace(/^JM号/, "").replace(/复制$/, "");
  if (jmId !== "900002") {
    throw new Error("详情页 JM号 没有渲染出这一话的 id（应为 900002）：" + JSON.stringify(jmId));
  }
  if (!facts.some((t) => /^话数共 \d+ 话$/.test(t))) {
    throw new Error("详情页「话数」没有渲染出来：" + facts.join(" | "));
  }
  if (!qa(".page-push .chap-row").length) {
    throw new Error("详情页目录一行都没有（章节列表没渲染）");
  }

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

  // ---- 设置页 → 我的足迹 ----
  const memberNav = qa(".nav-item").find((b) => /设置/.test(txt(b)));
  if (!memberNav) throw new Error("底部没有设置 tab");
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
