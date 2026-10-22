// 封面图「Worker 解码 + 降采样」回归：
//   1) 正常路：列表封面走 canvas（Worker 里 fetch + 解码 + 缩放），画布**有像素**、任务数 > 0，
//      且画布像素尺寸 ≈ 显示盒 × dpr（远小于原图 —— 这就是收益所在）；
//   2) `?jmnoworker=1`：抹掉 Worker 后必须**退回 <img>**（原实现）、照样渲染，且一条任务都不许发。
//
// 怎么把真实字节喂给 Worker：桩里的封面地址是 `https://mock.jm.local/media/albums/<id>_3x4.jpg`
// （DNS 解析不到），而 **Worker 里的 fetch 无法从页面侧打桩**。所以本驱动改桩的 `/setting`：
// 把 `img_host` 指到 dev server 真能给出的一张 PNG（`public/icons/icon-192.png`），
// 拼接后的地址形如 `…/icon-192.png?/media/albums/L1-0_3x4.jpg?v=…`（query 被忽略）→ 200 + image/png。
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

  const NO_WORKER = /[?&]jmnoworker=1/.test(location.search);
  if (NO_WORKER) window.Worker = undefined;
  /**
   * 抹掉 Worker 之前可能已经有封面任务跑过（18+ 门上的静默预取 `core/prewarm` 会抢在驱动之前干活）。
   * 所以这里记一个基线，断言的是"**抹掉之后**不再新增任务"，而不是"总数为 0"。
   */
  const coverJobsAtStart = window.__jmCoverJobs || 0;

  const COVER_HOST = location.origin + "/public/icons/icon-512.png?";

  // 拦 /setting：把 img_host 指到本地那张 PNG（只影响封面地址的拼接，其余字段原样保留）
  const of = window.fetch.bind(window);
  let patched = 0;
  window.fetch = async (input, init) => {
    const u = typeof input === "string" ? input : (input && input.url) || "";
    const res = await of(input, init);
    if (u.indexOf("setting") < 0) return res;
    let body;
    try { body = await res.clone().json(); } catch { return res; }
    if (!body || !body.data || typeof body.data !== "object") return res;
    body.data.img_host = COVER_HOST;
    patched += 1;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  // ---- 过 18+ 门 → 切到「最新」触发一次真实列表请求（卡片会按新的 img_host 重算封面地址）----
  const confirm = await waitFor(".age-confirm", 20000);
  confirm.click();
  await waitFor(".list-item", 20000);
  await waitUntil(() => patched > 0, 15000, "setting 已被改写（img_host → 本地 PNG）");
  const latestTab = qa(".tabs .tk").find((b) => txt(b) === "最新");
  if (!latestTab) throw new Error("首页没有「最新」分段");
  latestTab.click();
  await sleep(600);

  const stats = () => {
    const canvases = qa(".list-item .thumb-box canvas");
    const imgs = qa(".list-item .thumb-box img.thumb");
    const painted = canvases.filter((cv) => {
      try { return cv.toDataURL("image/png").length > 800; } catch { return false; }
    }).length;
    return {
      items: qa(".list-item").length,
      canvases: canvases.length,
      imgs: imgs.length,
      painted,
      jobs: window.__jmCoverJobs || 0,
      hits: window.__jmCoverHits || 0,
      warm: window.__jmCoverWarm || 0,
      sizes: canvases.slice(0, 3).map((cv) => cv.width + "x" + cv.height),
      firstSrc: imgs[0] ? String(imgs[0].getAttribute("src") || "").split("/").slice(-1)[0] : ""
    };
  };

  /** 一张封面卡片的显示盒宽度（CSS px）—— 封面解码目标就是它 × dpr */
  const boxWidth = () => {
    const box = q(".list-item .thumb-box");
    return box ? Math.round(box.getBoundingClientRect().width) : 0;
  };
  /** 按实现（core/imageOffload.ts）算出的期望 canvas 像素宽：显示盒 × min(2, dpr) */
  const expectedCanvasW = () => {
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    return Math.round(boxWidth() * dpr);
  };

  if (NO_WORKER) {
    await waitUntil(() => qa(".list-item .thumb-box img.thumb").length > 0, 15000, "降级路径渲染出 <img>");
    await sleep(500);
    const st = stats();
    log.push({ step: "fallback-img", ...st });
    if (st.canvases !== 0) throw new Error("抹掉 Worker 后仍然出现 canvas 封面（降级判定没生效）");
    const grew = st.jobs - coverJobsAtStart;
    if (grew !== 0) throw new Error("抹掉 Worker 之后仍然新增了 " + grew + " 趟封面 Worker 任务（基线 " + coverJobsAtStart + "）");
    if (st.items === 0) throw new Error("列表没有卡片");
  } else {
    await waitUntil(() => qa(".list-item .thumb-box canvas").length > 0, 15000, "Worker 路径渲染出 canvas 封面");
    await waitUntil(() => stats().painted > 0, 15000, "canvas 封面画出像素");
    await sleep(400);
    const st = stats();
    log.push({ step: "worker-canvas", ...st, boxW: boxWidth(), expectW: expectedCanvasW() });
    if (st.jobs < 1) throw new Error("一趟封面 Worker 任务都没跑（悄悄降级了？）");
    if (st.painted < 1) throw new Error("canvas 封面是空的（Worker 位图没画进去）");
    if (st.imgs !== 0) throw new Error("Worker 路径下不该再出现 <img class=thumb>（出现了 " + st.imgs + " 个）");
    const w = Number((st.sizes[0] || "0x0").split("x")[0]);
    const expectW = expectedCanvasW();
    // 核心断言：canvas 的像素尺寸 = **显示盒 × dpr**（不是原图的 512）—— 这就是「解到显示尺寸」的直接证据
    if (Math.abs(w - expectW) > 2) throw new Error("canvas 像素宽 " + w + " ≠ 显示盒×dpr " + expectW + "（没按显示尺寸解码）");
    if (w >= 512) throw new Error("封面没有被降采样：canvas 像素宽 " + w + "（原图 512）");

    // ---- 持久缓存：切走再切回（卡片全部重挂 = 封面重新请求），必须全部命中本地缓存 ----
    const hitsBefore = st.hits;
    const jobsBefore = st.jobs;
    const tabOf = (name) => qa(".tabs .tk").find((b) => txt(b) === name);
    tabOf("推荐")?.click();
    await sleep(500);
    tabOf("最新")?.click();
    await waitUntil(() => qa(".list-item .thumb-box canvas").length >= 8, 15000, "第二次进列表重新挂出封面");
    await waitUntil(() => stats().painted >= 8, 15000, "第二次进列表封面画出像素");
    await sleep(400);
    const again = stats();
    log.push({ step: "cache-second-pass", ...again, hitsBefore, jobsBefore, hitsGained: again.hits - hitsBefore });
    if (again.hits <= hitsBefore) {
      throw new Error("第二次进列表没有命中本地缓存（hits " + hitsBefore + " → " + again.hits + "）：封面被重新下载了");
    }
    if (again.painted < 8) throw new Error("第二次进列表只有 " + again.painted + "/8 张封面画出像素");
    if (again.imgs !== 0) throw new Error("第二次进列表出现了 <img> 封面（" + again.imgs + " 个）");
  }

  log.push({ step: "final", fatal: txt(q("#jm-fatal")), errs: window.__errs || [] });
  return log;
})()
