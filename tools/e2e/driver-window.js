// 阅读器**窗口化渲染**回归：整章 40 页里只有视口附近几页真正挂载 <img>（以及切块重排的 canvas），
// 其余页必须是等高占位盒。要钉住五件事：
//   1) 页数不缩水：.jm-figure 数量恒等于总页数（滚动条长度、进度比例都靠它）；
//   2) 资源有上限：img / canvas 数量必须停在窗口大小上（原来是一章 200 张全挂）；
//   3) 离屏即回收：滚走的页不能再有 img / canvas（canvas 是每页 8MB 级的全分辨率位图）；
//   4) 占位盒等高：同一页"挂着时的高度"与"变成占位盒后的高度"必须一致（否则滚动会跳）；
//   5) 计数与跳页不受影响：滚动/输入页码跳转后，计数器与挂载的页都要跟上；往回翻要能重新挂回来。
(async () => {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (el) => (el ? (el.textContent || "").trim() : "");
  const waitUntil = async (fn, timeout = 15000, label = "condition") => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(60); }
    throw new Error("waitUntil timeout: " + label);
  };
  const waitFor = async (sel, timeout) => { await waitUntil(() => !!q(sel), timeout, sel); return q(sel); };

  const TOTAL = 40;
  const AHEAD = 4;
  const BEHIND = 2;                  // 与 src/Reader.tsx 的窗口常量对齐（高配档）
  const BUDGET = AHEAD + BEHIND + 1; // 窗口内最多这么多页真的挂 img
  const ALBUM = "900001";
  /**
   * `?jmnoworker=1`：把 Worker 从全局抹掉，逼重排走**主线程降级路径**。
   * 两条路都必须在同一个驱动里被验证到 —— 否则"Worker 不可用的老内核"这条分支永远没人跑。
   */
  const NO_WORKER = /[?&]jmnoworker=1/.test(location.search);
  if (NO_WORKER) window.Worker = undefined;

  // ---- 造 N 页 blob 图（两档高度：验证"每页自己的比例"在换成占位盒后不改变滚动高度）----
  const makeBlob = (h) => new Promise((res) => {
    const c = document.createElement("canvas");
    c.width = 300; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#333"; g.fillRect(0, 0, 300, h);
    g.fillStyle = "#888"; g.fillRect(0, 0, 300, 24);
    c.toBlob((b) => res(URL.createObjectURL(b)), "image/png");
  });
  const urls = [];
  for (let i = 0; i < TOTAL; i++) urls.push(await makeBlob(i % 5 === 3 ? 600 : 420));
  const images = urls.map((u, i) => ({ page: i + 1, image: u, name: String(i + 1).padStart(3, "0") }));

  // ---- 拦 comic_read：换成 40 页（带 scramble_id，让切块重排那条 canvas 路径也真的跑起来）----
  const of = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const u = typeof input === "string" ? input : (input && input.url) || "";
    if (u.indexOf("comic_read") >= 0) {
      const body = { code: 200, data: { id: ALBUM, name: "窗口化测试", scramble_id: 1, images } };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    }
    return of(input, init);
  };

  // ---- 进详情 → 立即阅读 ----
  // 首屏是 18+ 确认页（每次 e2e 都清过源站存储，所以必然出现）：先确认，再等列表
  const confirm = await waitFor(".age-confirm", 20000);
  confirm.click();
  await waitFor(".list-item", 20000);
  q(".list-item").click();
  await waitFor(".page-push .card h2", 20000);
  await sleep(1200);
  const readBtn = qa(".page-push button").find((b) => txt(b) === "立即阅读");
  if (!readBtn) throw new Error("详情页没有「立即阅读」按钮");
  readBtn.click();
  await waitFor(".reader-toolbar", 15000);

  const mountedPages = () => qa(".reader-cont .jm-figure img.jm-page").map((im) => Number(im.dataset.page));
  const metric = () => ({
    figures: qa(".reader-cont .jm-figure").length,
    imgs: qa(".reader-cont img.jm-page").length,
    canvases: qa(".reader-cont canvas.scramble-canvas").length,
    ready: qa(".reader-cont .jm-figure[data-ready]").length,
    label: txt(q(".reader-toolbar .rt-page")),
    docH: document.documentElement.scrollHeight,
    mounted: mountedPages()
  });
  const pageLabelNo = () => Number((txt(q(".reader-toolbar .rt-page")).split("/")[0] || "0").trim());
  const heightOf = (n) => {
    const el = document.getElementById("jm-pg-" + n);
    return el ? Math.round(el.getBoundingClientRect().height) : -1;
  };
  const scrollToPage = (n) => {
    const el = document.getElementById("jm-pg-" + n);
    if (!el) throw new Error("找不到 #jm-pg-" + n);
    window.scrollTo(0, el.getBoundingClientRect().top + (window.scrollY || 0));
  };

  await waitUntil(() => qa(".reader-cont .jm-figure").length === TOTAL, 15000, "40 个页面骨架");
  await waitUntil(() => qa(".reader-cont img.jm-page").length > 0, 15000, "窗口内的页开始加载");
  await waitUntil(() => !!q("#jm-pg-1 canvas.scramble-canvas"), 15000, "第 1 页重排画布出现");
  await sleep(1200);
  const start = metric();
  // 重排真的画出内容了（空画布 toDataURL 只有几百字节，有内容的 png 是几 KB 起）
  const canvasBytes = (n) => {
    const cv = q("#jm-pg-" + n + " canvas.scramble-canvas");
    if (!cv) return -1;
    try { return cv.toDataURL("image/png").length; } catch { return -2; }
  };
  const jobs = window.__jmScrambleJobs || 0;
  log.push({ step: "enter", ...start, noWorker: NO_WORKER, jobs, canvas1Bytes: canvasBytes(1) });

  // 1) 页数一个都不能少（占位盒也算），但真挂出来的图必须停在窗口预算内
  if (start.figures !== TOTAL) throw new Error("页面骨架数量不对：" + start.figures + " / 期望 " + TOTAL);
  if (start.imgs > BUDGET) throw new Error("进入阅读器就挂了 " + start.imgs + " 张图（预算 " + BUDGET + "）—— 窗口化没生效");
  if (start.canvases > BUDGET) throw new Error("切块画布 " + start.canvases + " 张（预算 " + BUDGET + "）");
  if (!q("#jm-pg-1 img.jm-page")) throw new Error("第 1 页没有挂出 img");
  if (canvasBytes(1) < 1500) throw new Error("第 1 页的重排画布是空的（bytes=" + canvasBytes(1) + "）—— 重排没画进去");
  if (NO_WORKER) {
    if (jobs !== 0) throw new Error("抹掉 Worker 之后仍然跑了 " + jobs + " 趟 Worker 任务（降级判定没生效）");
  } else if (jobs < 1) {
    throw new Error("一趟 Worker 重排都没跑（悄悄降级到主线程了？）");
  }

  // 2) 滚到中间：计数器跟着走、窗口跟着挪、单页真的挂出来
  scrollToPage(20);
  await waitUntil(() => pageLabelNo() >= 16, 8000, "滚到中间后页码跟上了");
  await waitUntil(() => !!q("#jm-pg-20 img.jm-page"), 8000, "第 20 页挂出 img");
  await sleep(900);
  const mid = metric();
  const h20Mounted = heightOf(20);
  log.push({ step: "scroll-mid", ...mid, h20Mounted });
  if (mid.figures !== TOTAL) throw new Error("滚到中间后页面骨架数量变了：" + mid.figures);
  if (mid.imgs > BUDGET) throw new Error("滚到中间后挂了 " + mid.imgs + " 张图（预算 " + BUDGET + "）");
  if (mid.canvases > BUDGET) throw new Error("滚到中间后画布 " + mid.canvases + " 张（预算 " + BUDGET + "）");
  if (mid.mounted.indexOf(pageLabelNo()) < 0) {
    throw new Error("计数器=" + pageLabelNo() + " 但这一页没挂 img，挂着的是 [" + mid.mounted.join(",") + "]");
  }
  if (h20Mounted < 100) throw new Error("第 20 页挂出来却没有高度：" + h20Mounted);

  // 3) 输入页码跳页（另一条路径：jumpTo → #jm-pg-N.scrollIntoView）
  const settingsBtn = qa(".reader-toolbar button").find((b) => txt(b) === "设置");
  if (!settingsBtn) throw new Error("工具栏没有「设置」按钮");
  settingsBtn.click();
  await waitFor(".reader-sheet", 8000);
  const jumpInput = q(".reader-sheet input.page-input");
  if (!jumpInput) throw new Error("阅读设置里没有页码输入框");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(jumpInput, "35");
  jumpInput.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(120);
  // 设置里的跳页靠输入框回车触发（onKeyDown → onJumpTo）
  jumpInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitUntil(() => !!q("#jm-pg-35 img.jm-page"), 12000, "跳到第 35 页后该页挂出 img");
  await sleep(800);
  window.dispatchEvent(new CustomEvent("jm:back", { detail: { consumed: false } })); // 关弹窗（返回键只关弹窗）
  await sleep(400);
  const jumped = metric();
  log.push({ step: "jump-35", ...jumped });
  if (jumped.imgs > BUDGET) throw new Error("跳页后挂了 " + jumped.imgs + " 张图（预算 " + BUDGET + "）");

  // 4) 离屏即回收 + 占位盒等高：第 20 页此刻已滚出窗口
  await waitUntil(() => !q("#jm-pg-20 img.jm-page"), 8000, "第 20 页离屏后卸掉 img");
  await sleep(300);
  const h20Slot = heightOf(20);
  const slotHasCanvas = qa("#jm-pg-20 canvas").length;
  log.push({ step: "offscreen-released", h20Mounted, h20Slot, slotHasCanvas, canvases: qa(".reader-cont canvas.scramble-canvas").length });
  if (slotHasCanvas > 0) throw new Error("离屏页的切块画布没有回收（#jm-pg-20 里还有 canvas）");
  if (Math.abs(h20Slot - h20Mounted) > 2) {
    throw new Error("离屏占位盒高度不一致：挂着 " + h20Mounted + "px → 占位 " + h20Slot + "px（滚动会跳）");
  }

  // 5) 往回翻到底：卸过的页必须能重新挂回来
  window.scrollTo(0, 0);
  await waitUntil(() => !!q("#jm-pg-1 img.jm-page"), 10000, "回到顶部后第 1 页重新挂出 img");
  await sleep(900);
  const backTop = metric();
  log.push({ step: "back-top", ...backTop, page1Ready: !!q("#jm-pg-1[data-ready]"), canvas1Bytes: canvasBytes(1) });
  if (backTop.imgs > BUDGET) throw new Error("回到顶部后挂了 " + backTop.imgs + " 张图（预算 " + BUDGET + "）");
  if (backTop.canvases > BUDGET) throw new Error("回到顶部后画布 " + backTop.canvases + " 张（预算 " + BUDGET + "）");
  if (!q("#jm-pg-1 img.jm-page")) throw new Error("回到顶部后第 1 页没有 img（卸载后的页没挂回来）");
  if (!q("#jm-pg-1[data-ready]")) throw new Error("回到顶部后第 1 页没有恢复 data-ready（图没解码成功）");
  if (canvasBytes(1) < 1500) throw new Error("回到顶部后第 1 页画布是空的（bytes=" + canvasBytes(1) + "）—— 重挂后没重新重排");

  log.push({ step: "final", fatal: txt(q("#jm-fatal")), docH: document.documentElement.scrollHeight });
  return log;
})()
