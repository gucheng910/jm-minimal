// v3.8「目录排法」回归（在线详情页 · 真实用户路径）
//
// 为什么单独一支：`chapLayout` 是**属性 + CSS**实现的（`data-dl-chap="grid2"` 挂在 `.detail-card` 上，
// 由 `.detail-card[data-dl-chap="grid2"] .chap-list` 切成网格）。单测只能证明"属性输出对"，
// 证明不了"浏览器真的把它渲染成两列" —— 所以这里量**计算样式**与**几何**。
//
// 判别力：
//   · 默认档不许有属性、`.chap-list` 必须是普通块（不是 grid）；
//   · 选「两列」后：属性出现 + display=grid + 两条轨道 + 前两行的 top 相同而 left 不同（**几何证据**）；
//   · **章节一个都不能少**（换的是排法，不是筛选）；
//   · 回到默认档：属性**干净消失**、display 回到 block。
(async () => {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const KEY = "jmclient.detailStyle.v1";

  // 打开详情页（与 driver-reader 同一套 stub 事件）
  window.dispatchEvent(new CustomEvent("jm:openAid", { detail: "900002" }));
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && !q(".detail-card")) await sleep(80);
  await sleep(700);
  const card = q(".detail-card");
  if (!card) throw new Error("详情页没有出现（.detail-card 找不到）");
  const list = q(".detail-card .chap-list");
  if (!list) throw new Error("目录列表没有渲染（.chap-list 找不到）");

  const snap = () => {
    const l = q(".detail-card .chap-list");
    const rows = qa(".detail-card .chap-list .chap-row");
    const cs = l ? getComputedStyle(l) : null;
    const first = rows[0] ? rows[0].getBoundingClientRect() : null;
    const second = rows[1] ? rows[1].getBoundingClientRect() : null;
    const tag = q(".detail-card .chap-list .chap-tag");
    return {
      attr: (q(".detail-card") || {}).getAttribute ? q(".detail-card").getAttribute("data-dl-chap") : null,
      display: cs ? cs.display : null,
      tracks: cs && cs.display === "grid" ? String(cs.gridTemplateColumns).trim().split(/\s+/).length : 0,
      rows: rows.length,
      row0Top: first ? Math.round(first.top) : null,
      row1Top: second ? Math.round(second.top) : null,
      row0Left: first ? Math.round(first.left) : null,
      row1Left: second ? Math.round(second.left) : null,
      tagDisplay: tag ? getComputedStyle(tag).display : "no-tag"
    };
  };

  // ── ① 默认档（单列）：不许有属性，也不许是 grid ──────────────────────────
  const def = snap();
  log.push({ step: "default", ...def });
  if (def.attr !== null) throw new Error("默认档不该有 data-dl-chap（红线：DOM 逐字不变）：" + def.attr);
  if (def.display === "grid") throw new Error("默认档的 .chap-list 不应该是 grid：" + def.display);

  // ── ② 选「两列」→ 属性 + 计算样式 + **几何**都要变 ──────────────────────
  const raw = localStorage.getItem(KEY);
  const cfg = raw ? JSON.parse(raw) : {};
  localStorage.setItem(KEY, JSON.stringify(Object.assign({}, cfg, { chapLayout: "grid2" })));
  window.dispatchEvent(new CustomEvent("jm:detailStyle"));
  await sleep(600);
  const grid = snap();
  log.push({ step: "grid2", ...grid });
  if (grid.attr !== "grid2") throw new Error("选了「两列」但 .detail-card 上没有 data-dl-chap=grid2：" + grid.attr);
  if (grid.display !== "grid") throw new Error("选了「两列」但 .chap-list 的计算 display 不是 grid：" + grid.display);
  if (grid.tracks !== 2) throw new Error("网格不是两条轨道：" + grid.tracks);
  if (!(grid.row0Top === grid.row1Top && grid.row0Left !== grid.row1Left)) {
    throw new Error("前两行不是并排的（几何证据不成立）：" +
      JSON.stringify({ row0: [grid.row0Left, grid.row0Top], row1: [grid.row1Left, grid.row1Top] }));
  }
  // 换的是排法，不是筛选：章节数一个都不能少
  if (grid.rows !== def.rows) {
    throw new Error("换成两列之后章节数变了（换排法不该动内容）：" + def.rows + " → " + grid.rows);
  }
  // 轴冲突②（形态 × 密度）：窄单元格里不显示角标（当前话仍有 .on 加粗）
  if (grid.tagDisplay !== "none" && def.tagDisplay !== "no-tag") {
    throw new Error("两列档下角标应当隐藏（单元格放不下）：" + grid.tagDisplay);
  }

  // ── ③ 回到默认档：属性**干净消失**、display 回到普通块 ──────────────────
  const backCfg = JSON.parse(localStorage.getItem(KEY) || "{}");
  delete backCfg.chapLayout;
  localStorage.setItem(KEY, JSON.stringify(backCfg));
  window.dispatchEvent(new CustomEvent("jm:detailStyle"));
  await sleep(600);
  const back = snap();
  log.push({ step: "restored", ...back });
  if (back.attr !== null) throw new Error("回到单列后属性没有干净消失：" + back.attr);
  if (back.display === "grid") throw new Error("回到单列后仍是 grid：" + back.display);

  // ── ④ v3.9 目录**顺序**：倒序后行标签序列必须**整体反转** ────────────────
  //     判据写成"整串反转"而不是"第一行是第 N 话"：后者要假设 stub 的话名格式，
  //     前者对任何话名（"第 3 话" / 自定义名）都成立，而且能抓出"只换了几行"这种半吊子实现。
  const labels = () => qa(".detail-card .chap-list .chap-row .chap-name").map((e) => (e.textContent || "").trim());
  const labelsAsc = labels();
  if (labelsAsc.length < 2) throw new Error("目录行太少（stub 应当有 3 话）无法验证倒序：" + labelsAsc.length);
  const setCfg = (patch) => {
    const cur = JSON.parse(localStorage.getItem(KEY) || "{}");
    for (const k of Object.keys(patch)) { if (patch[k] === null) delete cur[k]; else cur[k] = patch[k]; }
    localStorage.setItem(KEY, JSON.stringify(cur));
    window.dispatchEvent(new CustomEvent("jm:detailStyle"));
  };
  setCfg({ chapOrder: "desc" });
  await sleep(620);
  const labelsDesc = labels();
  log.push({ step: "order-desc", asc: labelsAsc, desc: labelsDesc });
  if (labelsDesc.join(",") !== labelsAsc.slice().reverse().join(",")) {
    throw new Error("倒序后行标签不是整体反转：" + JSON.stringify({ asc: labelsAsc, desc: labelsDesc }));
  }
  const attrDesc = (q(".detail-card") || {}).getAttribute ? q(".detail-card").getAttribute("data-dl-chaporder") : null;
  if (attrDesc !== "desc") throw new Error("倒序没有写出观测属性 data-dl-chaporder： " + attrDesc);
  setCfg({ chapOrder: "asc" });
  await sleep(620);
  const labelsBack = labels();
  log.push({ step: "order-asc", back: labelsBack });
  if (labelsBack.join(",") !== labelsAsc.join(",")) throw new Error("回到正序后顺序没复原：" + JSON.stringify(labelsBack));
  if ((q(".detail-card").getAttribute("data-dl-chaporder")) !== null) {
    throw new Error("回到正序后属性没有干净消失");
  }

  // ── ⑤ v3.9 目录**筛选**：只看已缓存。stub 里没有缓存 → 必须显示**空态人话**，不是空盒子 ──
  setCfg({ chapFilter: "cached" });
  await sleep(900);   // 会触发一次本地缓存扫描（异步），多等一会
  const rowsFiltered = qa(".detail-card .chap-list .chap-row").length;
  const filterText = qa(".detail-card .chap-list .chap-row .chap-name").map((e) => (e.textContent || "").trim()).join("|");
  log.push({ step: "filter-cached", rows: rowsFiltered, text: filterText, attr: q(".detail-card").getAttribute("data-dl-chapfilter") });
  if (rowsFiltered !== 1 || filterText.indexOf("本地没有缓存的话") < 0) {
    throw new Error("「只看已缓存」且本地没缓存时应当只剩一条空态人话，实测：" + rowsFiltered + " 行 / " + filterText);
  }
  setCfg({ chapFilter: "all" });
  await sleep(700);
  const rowsAll = qa(".detail-card .chap-list .chap-row").length;
  log.push({ step: "filter-all", rows: rowsAll });
  if (rowsAll !== labelsAsc.length) throw new Error("回到「全部」后行数没复原：" + rowsAll + " vs " + labelsAsc.length);

  // ── ⑥ v3.10 主视觉排布：左图右文（默认）↔ 封面居中。用**几何**验证，不看类名 ──
  const heroSnap = () => {
    const hero = q(".detail-card .d-hero");
    const cover = q(".detail-card .d-cover-box");
    const info = q(".detail-card .d-hero-info");
    if (!hero || !cover || !info) return null;
    const h = hero.getBoundingClientRect(), c = cover.getBoundingClientRect(), i = info.getBoundingClientRect();
    return {
      dir: getComputedStyle(hero).flexDirection,
      coverCX: Math.round(c.left + c.width / 2), coverTop: Math.round(c.top), coverH: Math.round(c.height),
      infoLeft: Math.round(i.left), infoTop: Math.round(i.top),
      heroCX: Math.round(h.left + h.width / 2)
    };
  };
  const heroLeft = heroSnap();
  if (!heroLeft) throw new Error("找不到主视觉的封面 / 信息区（.d-cover-box / .d-hero-info）");
  log.push({ step: "hero-left", ...heroLeft });
  if (heroLeft.dir !== "row") throw new Error("默认档主视觉应当是横排（左图右文）：" + heroLeft.dir);
  if (!(heroLeft.coverCX < heroLeft.infoLeft)) {
    throw new Error("默认档封面应当在信息区左侧（几何不成立）：" + JSON.stringify(heroLeft));
  }
  setCfg({ heroLayout: "center" });
  await sleep(620);
  const heroCenter = heroSnap();
  log.push({ step: "hero-center", ...heroCenter });
  if (heroCenter.dir !== "column") throw new Error("选了「封面居中」但主视觉仍是横排：" + heroCenter.dir);
  if (Math.abs(heroCenter.coverCX - heroCenter.heroCX) > 2) {
    throw new Error("封面没有水平居中（封面中心 vs 容器中心）：" + JSON.stringify(heroCenter));
  }
  if (!(heroCenter.infoTop >= heroCenter.coverTop + heroCenter.coverH)) {
    throw new Error("信息区没有落到封面下方（应当叠放）：" + JSON.stringify(heroCenter));
  }
  if (q(".detail-card").getAttribute("data-dl-herolayout") !== "center") {
    throw new Error("封面居中档没有写出观测属性 data-dl-herolayout");
  }
  setCfg({ heroLayout: null });   // 删键 = 回默认
  await sleep(620);
  const heroBack = heroSnap();
  log.push({ step: "hero-restored", ...heroBack });
  if (heroBack.dir !== "row") throw new Error("回到默认档后主视觉没有复原为横排：" + heroBack.dir);
  if (q(".detail-card").getAttribute("data-dl-herolayout") !== null) {
    throw new Error("回到默认档后属性没有干净消失");
  }

  // 复原存储（不给后面的 driver 留脏配置）
  if (raw === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, raw);

  // ── v3.14 列表页卡片形态（海报 / 封面压字 / 单列行）+ 标题行数 ─────────────
  //    形态是"属性 + CSS"实现的（`.list.form-*`），单测只能证明类名输出对，
  //    证明不了浏览器真把它渲染成那样 —— 所以这里量**几何**：
  //      · 海报：文字在封面**下方**（top ≥ 封面底）；
  //      · 封面压字：文字块**压在封面里**（bottom ≤ 封面底、且 top < 封面底）；
  //      · 单列行：**1 条轨道** + 封面 56×72 + 文字在封面**右侧**（left ≥ 封面右）。
  //    负对照在最后：回到海报档，文字必须回到封面下方、网格回到跟随断点。
  const LKEY = "jmclient.listLayout.v1";
  const rawList = localStorage.getItem(LKEY);
  const setList = async (patch) => {
    const cur = JSON.parse(localStorage.getItem(LKEY) || "{}");
    localStorage.setItem(LKEY, JSON.stringify({ version: 2, ...cur, ...patch }));
    window.dispatchEvent(new CustomEvent("jm:listLayout"));
    await sleep(420);
  };
  const tracks = () => {
    const el = q(".browse-page .list") || q(".list");
    return el ? getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length : 0;
  };
  const geom = () => {
    const item = q(".list .list-item");
    if (!item) throw new Error("列表里没有卡片（先回首页/分类页？）");
    const box = item.querySelector(".thumb-box") || item.querySelector(".thumb");
    /**
     * ⚠️ 文字块必须按"**直接子元素里那个不是封面的 div**"取，不能用 `item.querySelector("div")`：
     * 封面没有 URL 时 `Cover` 渲染的是 `<div class="thumb empty">`（**它也是 div**），
     * 于是 querySelector 会把封面自己当成文字块 —— 量出来两块矩形重合，
     * 断言就变成"封面在封面下方"这种胡话。
     * （全量跑时真踩到了：img_host 还没落地的那一瞬间封面是空的，
     *   而单独跑这支驱动时它已经落地 —— 典型的"看时序的脸"的断言。）
     */
    const text = Array.from(item.children).find((el) => el.tagName === "DIV" && !el.classList.contains("thumb"));
    if (!box || !text) throw new Error("卡片结构不是预期的（box=" + !!box + " text=" + !!text + "）");
    /**
     * 兜底判据：两块必须真的是**两个不同的元素**。
     * 全量跑时正是这里坏掉过一次（封面没 URL 时是 `<div class="thumb empty">`，
     * `querySelector("div")` 把它当成了文字块）—— 那时量出来的两块矩形完全重合，
     * 断言的报错是"文字没有回到封面下方"，看起来像**产品**坏了，其实是**测量**坏了。
     * 有了这条，同样的坏口径会直接报"量到了同一个元素"。
     */
    if (box === text || box.contains(text) || text.contains(box)) {
      throw new Error("封面与文字块量到了同一个元素（测量口径坏了，不是产品坏了）");
    }
    const b = box.getBoundingClientRect();
    const t = text.getBoundingClientRect();
    return {
      cover: [Math.round(b.width), Math.round(b.height), Math.round(b.left), Math.round(b.top)],
      empty: box.classList.contains("empty"),
      text: [Math.round(t.left), Math.round(t.top), Math.round(t.bottom)],
      coverBottom: Math.round(b.bottom), coverRight: Math.round(b.right),
      trackCount: tracks(),
      cls: item.parentElement.className
    };
  };

  // 先回列表页：这一段之前驱动停在**详情页**（.detail-card），而详情页里也有 `.list-item`
  // （相关漫画），不回去的话量到的是那一块的卡片 —— 几何断言会变成"测另一个东西"。
  //
  // ⚠️ 还要先**过 18+ 门**：这支驱动此前一路用 `jm:openAid` 直接开详情页（那条路不走启动流程），
  //    所以首页其实一直停在"门后未启动"的状态 —— 门不过，首页列表永远是空的。
  //    点一下确认才让 ContentView 的启动流程继续跑（它会去拉推荐列表）。
  const gateBtn = q(".age-confirm");
  if (gateBtn) { gateBtn.click(); await sleep(600); }
  window.dispatchEvent(new CustomEvent("jm:back", { detail: { consumed: false } }));
  {
    const tb = Date.now();
    while (Date.now() - tb < 9000 && (q(".detail-card") || !q(".list .list-item"))) await sleep(120);
  }
  await sleep(600);
  if (q(".detail-card")) throw new Error("退回列表页失败（.detail-card 还在）");
  if (!q(".list .list-item")) throw new Error("退回列表页后列表里没有卡片");

  // 测量口径的**离线自检**：造一张"封面没有 URL"的卡片结构（`Cover` 在 url 为空时渲染的
  // 就是 `<div class="thumb empty">`），确认上面那套取法拿到的确实是**文字块**。
  // 为什么要它：全量跑时那次红是**测量**坏了（两块量成同一个元素），而封面空不空取决于
  // img_host 落地的时序 —— 不能靠"碰上"来验证，所以在这里把那个结构就地造出来验。
  {
    const probe = document.createElement("div");
    probe.innerHTML = '<button class="list-item"><div class="thumb empty"><span>x</span></div>'
      + '<div><div class="title">t</div><div class="muted">m</div></div></button>';
    const it = probe.firstChild;
    const bx = it.querySelector(".thumb-box") || it.querySelector(".thumb");
    const tx = Array.from(it.children).find((el) => el.tagName === "DIV" && !el.classList.contains("thumb"));
    if (!bx || !tx || bx === tx || !tx.querySelector(".title")) {
      throw new Error("空封面的测量口径自检失败（box/text 取错元素）");
    }
    log.push({ step: "geom-selfcheck", coverCls: bx.className, textHasTitle: !!tx.querySelector(".title") });
  }

  const poster = await (async () => { await setList({ form: "poster", columns: "auto" }); return geom(); })();
  log.push({ step: "list-poster", ...poster });
  if (/form-/.test(poster.cls)) throw new Error("海报档（默认）不该有 form-* 类：" + poster.cls);
  if (!(poster.text[1] >= poster.coverBottom - 1)) {
    throw new Error("海报档的文字没有落在封面下方：" + JSON.stringify(poster));
  }

  await setList({ form: "overlay" });
  const overlay = geom();
  log.push({ step: "list-overlay", ...overlay });
  if (overlay.cls.indexOf("form-overlay") < 0) throw new Error("选了「封面压字」但网格没有 form-overlay 类");
  if (!(overlay.text[2] <= overlay.coverBottom + 1 && overlay.text[1] < overlay.coverBottom - 20)) {
    throw new Error("封面压字档的文字没有压在封面底部：" + JSON.stringify(overlay));
  }
  if (Math.abs(overlay.cover[1] - poster.cover[1]) > 2) {
    throw new Error("压字档不该改封面高度（轴独立性）：" + poster.cover[1] + " → " + overlay.cover[1]);
  }

  await setList({ form: "row" });
  const row = geom();
  log.push({ step: "list-row", ...row });
  if (row.trackCount !== 1) throw new Error("单列行形态应当只有 1 条轨道：" + row.trackCount);
  if (row.cover[0] !== 56 || row.cover[1] !== 72) throw new Error("行卡封面应为 56×72：" + JSON.stringify(row.cover));
  if (!(row.text[0] >= row.coverRight - 1)) throw new Error("行卡的文字没有落到封面右侧：" + JSON.stringify(row));
  // 轴冲突的负对照：行卡形态下把列数设成 3，**仍然只有 1 条轨道**（列数确实不生效）
  await setList({ columns: 3 });
  const row3 = geom();
  log.push({ step: "list-row-cols3", trackCount: row3.trackCount, cls: row3.cls });
  if (row3.trackCount !== 1) throw new Error("行卡 + 3 列档却出现了多轨道（轴冲突没断掉）：" + row3.trackCount);

  // 标题行数：1 行时 line-clamp 与预留高度都要收
  await setList({ form: "poster", columns: "auto", titleLines: 2 });
  const t2 = q(".list .list-item .title");
  const twoLines = { clamp: getComputedStyle(t2).webkitLineClamp, minH: getComputedStyle(t2).minHeight };
  await setList({ titleLines: 1 });
  const t1 = q(".list .list-item .title");
  const oneLine = { clamp: getComputedStyle(t1).webkitLineClamp, minH: getComputedStyle(t1).minHeight };
  log.push({ step: "list-titlelines", twoLines, oneLine });
  if (twoLines.clamp !== "2" || oneLine.clamp !== "1") {
    throw new Error("标题行数档没有落到 -webkit-line-clamp：" + JSON.stringify({ twoLines, oneLine }));
  }
  if (oneLine.minH === twoLines.minH) {
    throw new Error("1 行档没有把预留的两行高度收掉（看起来只是字少了一行）：" + oneLine.minH);
  }

  // 复原：回到"从没配过"（这一步同时是负对照：文字回到封面下方、网格回到跟随断点）
  if (rawList === null) localStorage.removeItem(LKEY); else localStorage.setItem(LKEY, rawList);
  window.dispatchEvent(new CustomEvent("jm:listLayout"));
  await sleep(420);
  const restored = geom();
  log.push({ step: "list-restored", cls: restored.cls, trackCount: restored.trackCount, text: restored.text, coverBottom: restored.coverBottom });
  if (/form-|cols-|title-1/.test(restored.cls)) throw new Error("复原后网格上还有配置类：" + restored.cls);
  if (!(restored.text[1] >= restored.coverBottom - 1)) throw new Error("复原后文字没有回到封面下方：" + JSON.stringify(restored));

  log.push({ step: "final", fatal: (document.getElementById("jm-fatal") || {}).textContent || "", errs: (window.__errs || []).slice(0, 5) });
  return log;
})()
