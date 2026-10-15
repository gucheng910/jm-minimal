// 壳层「单元解耦」回归（v3.8）：顶栏 / 底栏的单元注册表、默认顺序、改配置即时生效、跨分区不牵连
//
// 为什么要有这一支：这三个栏过去是**写死的 JSX**。解耦之后它们由 core/chromeLayout.ts 决定，
// 所以回归要同时钉住两件相反的事：
//   ① **默认态逐字等于解耦前**（顺序、文案、类名一个都不能变 —— 从没配过的用户不该受影响）；
//   ② **配置真的能改**（顺序 / 隐藏）；而且**必需单元藏不掉**、**跨分区重名的 id 不互相牵连**。
// ② 的三条就是这一支的判别力所在：只有"默认态"的断言在解耦失败时也可能是绿的。
(async () => {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (el) => (el ? (el.textContent || "").trim() : "");
  const unitOf = (el) => (el && el.getAttribute ? (el.getAttribute("data-unit") || "") : "");
  const KEY = "jmclient.chromeLayout.v1";
  /** 与 core/bus.ts 的 emit 同构：真值在 localStorage，事件只播"变了" */
  const emitCfg = () => window.dispatchEvent(new CustomEvent("jm:chromeLayout"));

  const nav = () => qa(".bottom-nav .nav-item").map((b) => unitOf(b) + "|" + txt(b));
  const topLeft = () => qa(".top-bar .top-left > *").map(unitOf);
  const topActions = () => qa(".top-bar .top-actions > *").map(unitOf);
  const NAV_DEFAULT = "nav:home|首页,nav:categories|分类,nav:search|搜索,nav:settings|设置";
  const TOPACTIONS_DEFAULT = "topActions:cache,topActions:search,topActions:source";
  const TOPLEFT_DEFAULT = "topLeft:menu,topLeft:title";

  // ── ① 默认态 = 解耦前的写死顺序 ────────────────────────────────────────
  const d = { nav: nav().join(","), topLeft: topLeft().join(","), topActions: topActions().join(",") };
  log.push({ step: "default", ...d });
  if (d.nav !== NAV_DEFAULT) {
    throw new Error("底栏默认单元不对（顺序 / 文案 / data-unit）：" + d.nav);
  }
  if (d.topLeft !== TOPLEFT_DEFAULT) throw new Error("顶栏左侧组默认单元不对：" + d.topLeft);
  if (d.topActions !== TOPACTIONS_DEFAULT) throw new Error("顶栏工具组默认单元不对：" + d.topActions);

  // ── ② 改配置 → **即时生效**（不刷新页面）────────────────────────────────
  //     藏掉「底栏:搜索」并把「设置」拖到最左；顶栏工具组**故意不动**
  localStorage.setItem(KEY, JSON.stringify({ version: 1, hidden: ["nav:search"], nav: ["settings", "home", "categories", "search"] }));
  emitCfg();
  await sleep(260);
  const c = { nav: nav().join(","), topActions: topActions().join(",") };
  log.push({ step: "configured", ...c });
  if (c.nav !== "nav:settings|设置,nav:home|首页,nav:categories|分类") {
    throw new Error("改配置没有生效（顺序 / 隐藏）：" + c.nav);
  }
  // ★ 判别性 A：跨分区重名不牵连 —— 藏掉底栏的「搜索」，顶栏的「搜索」必须**还在**
  if (c.topActions !== TOPACTIONS_DEFAULT) {
    throw new Error("藏掉底栏的搜索把顶栏的搜索也带走了（跨分区重名 bug）：" + c.topActions);
  }

  // ── ③ 必需单元藏不掉（设置 / 菜单 / 应用标题没有替代入口）────────────────
  //     ⚠️ v3.13 起「底栏:首页」**不再是必需单元**（用户第 3 条只点名「底栏的设置按钮不可删」），
  //        所以它从这一组里挪出来，并在下面单独断言"它现在真的藏得掉"。
  localStorage.setItem(KEY, JSON.stringify({ version: 2, hidden: ["nav:settings", "topLeft:menu", "topLeft:title", "nav:home"] }));
  emitCfg();
  await sleep(260);
  const e = { nav: nav().join(","), topLeft: topLeft().join(",") };
  log.push({ step: "required-kept", ...e });
  const REQUIRED_NAV = "nav:categories|分类,nav:search|搜索,nav:settings|设置";
  if (e.nav !== REQUIRED_NAV) {
    throw new Error("必需单元（设置）被藏掉了 / 或「首页」没有被藏掉：" + e.nav);
  }
  if (e.topLeft !== TOPLEFT_DEFAULT) throw new Error("必需单元（菜单按钮 / 应用标题）被藏掉了：" + e.topLeft);

  // ── ④ 顺序表里有未知 id / 缺项 → 自愈（归一化在 App 边界上真的跑了）──────
  localStorage.setItem(KEY, JSON.stringify({ version: 1, nav: ["home", "nosuchunit"] }));
  emitCfg();
  await sleep(260);
  const f = nav().join(",");
  log.push({ step: "normalized", nav: f });
  if (f !== NAV_DEFAULT) throw new Error("未知 / 缺失 id 没有被归一化（应补到尾部并丢掉未知）：" + f);

  // ── ⑤ 复原（不给后面的 driver 留脏配置）────────────────────────────────
  localStorage.removeItem(KEY);
  emitCfg();
  await sleep(260);
  const r = nav().join(",");
  log.push({ step: "restored", nav: r });
  if (r !== NAV_DEFAULT) throw new Error("清掉配置后没有回到默认：" + r);

  // ── ⑥ 解耦之后回调仍接得上：点「分类」应真的切页 ─────────────────────────
  const cat = qa(".bottom-nav .nav-item").find((b) => /分类/.test(txt(b)));
  if (!cat) throw new Error("找不到底栏「分类」单元");
  cat.click();
  await sleep(700);
  const activeTab = txt(q(".bottom-nav .nav-item.active"));
  log.push({ step: "nav-click", activeTab });
  if (!/分类/.test(activeTab)) throw new Error("点了「分类」底栏没有切激活态（单元的回调接丢了）：" + activeTab);

  // ── ⑦ v3.13：入口收敛（设置页最上方有、抽屉里没有）+ 编辑器两个新页 ──────────
  //    这一段覆盖的是用户本轮的第 1、2、3 条：它们是**界面事实**，只能端到端钉。
  const settingsBtn = qa(".bottom-nav .nav-item").find((b) => /设置/.test(txt(b)));
  if (!settingsBtn) throw new Error("底栏找不到「设置」（必需单元，不该被藏）");
  settingsBtn.click();
  await sleep(500);

  const setRows = () => qa(".settings-page .grow").map((b) => txt(b));
  const entry = qa(".settings-page .grow").find((b) => /自定义 UI/.test(txt(b)));
  log.push({ step: "settings-entries", rows: setRows().slice(0, 4) });
  if (!entry) throw new Error("设置页没有「自定义 UI」入口：" + setRows().join(" | "));
  // 它必须是设置页里**第一个**常驻分组行（用户要求"放到最上方"）。
  // 瞬时通知卡（.card.err / .card.msg）不算，它们平时不在。
  const firstGroup = q(".settings-page .sectitle");
  if (!firstGroup || txt(firstGroup) !== "自定义 UI") {
    throw new Error("「自定义 UI」不是设置页第一个分组：" + txt(firstGroup));
  }
  // 删掉的那两样：抽屉里的「自定义 UI」与「低配模式」
  if (q(".drawer-sec .ditem") === null) throw new Error("抽屉里一个 ditem 都没有（选择器失效？）");
  const drawerTexts = qa(".drawer-sec .ditem").map((b) => txt(b));
  log.push({ step: "drawer-items", drawerTexts });
  if (drawerTexts.some((t) => /自定义 UI/.test(t))) throw new Error("抽屉里还留着「自定义 UI」入口");
  if (drawerTexts.some((t) => /低配模式/.test(t))) throw new Error("抽屉里还留着「低配模式」开关");

  entry.click();
  await sleep(500);
  const cards = qa(".ed-gallery .ed-card").map((b) => b.getAttribute("data-page"));
  log.push({ step: "gallery-pages", cards });
  if (cards.join(",") !== "list,detail,chrome,reader") {
    throw new Error("画廊页面不是四个（或顺序变了）：" + cards.join(","));
  }

  // 进「顶栏和底栏」页
  const chromeCard = q('.ed-gallery .ed-card[data-page="chrome"]');
  if (!chromeCard) throw new Error("画廊里没有「顶栏和底栏」卡片");
  chromeCard.click();
  await sleep(400);
  const frame = q(".ed-appframe");
  if (!frame) throw new Error("顶栏和底栏页的画布没出来（.ed-appframe 不存在）");
  const canvasNav = qa(".ed-appframe .bottom-nav .nav-item").map(unitOf);
  const sections = qa(".ed-chromeinsp .ed-nodelist").map((row) => row.getAttribute("data-section"));
  const reqCount = qa(".ed-chromeinsp .ed-req").length;
  log.push({ step: "bars-editor", pageLabel: txt(q(".ed-top h2")), canvasNav: canvasNav.join(","), sections: sections.join(","), reqCount });
  if (canvasNav.join(",") !== "nav:home,nav:categories,nav:search,nav:settings") {
    throw new Error("画布里的底栏不是默认四个单元：" + canvasNav.join(","));
  }
  if (sections.join(",") !== "topLeft,topActions,nav") {
    throw new Error("「顶栏和底栏」页的分区不对（应为三个）：" + sections.join(","));
  }
  // 「必需」单元 = 菜单按钮 / 应用标题 / 设置 → 三个（用户第 3 条的那三样正好对上）
  if (reqCount !== 3) throw new Error("「必需」单元应为 3 个（菜单 / 标题 / 设置），实际 " + reqCount);

  // 点画布上的「分类」→ 面板里对应那一行高亮（画布 → 清单的联动）
  const canvasCat = qa(".ed-appframe .bottom-nav .nav-item").find((b) => /分类/.test(txt(b)));
  canvasCat.click();
  await sleep(200);
  const selRow = q('.ed-chromeinsp [data-unit-row="nav:categories"]');
  log.push({ step: "canvas-pick", sel: selRow ? selRow.className : "" });
  if (!selRow || selRow.className.indexOf("ed-unitsel") < 0) {
    throw new Error("点画布上的单元没有高亮到面板对应行：" + (selRow ? selRow.className : "(没有这一行)"));
  }

  // 在面板里把「分类」关掉 → 存盘 + 广播；关掉编辑器后 App 的底栏必须真的少一项
  const catSwitch = selRow.querySelector(".switch");
  if (!catSwitch) throw new Error("「分类」那一行没有开关（它应该是可隐藏的）");
  catSwitch.click();
  await sleep(300);
  const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
  log.push({ step: "hide-from-editor", savedHidden: saved.hidden });
  if (!Array.isArray(saved.hidden) || saved.hidden.indexOf("nav:categories") < 0) {
    throw new Error("在编辑器里关掉「分类」没有落盘：" + JSON.stringify(saved.hidden));
  }
  // 关掉编辑器（编辑屏 → 画廊 → 关闭），看 App 自己的底栏
  q(".ed-back").click(); await sleep(250);
  q(".ed-back").click(); await sleep(400);
  const afterNav = nav().join(",");
  log.push({ step: "app-after-editor", afterNav });
  if (afterNav !== "nav:home|首页,nav:search|搜索,nav:settings|设置") {
    throw new Error("编辑器里改的配置没有作用到 App 的底栏：" + afterNav);
  }

  // ── ⑧ 阅读器页：第一项观感（滚动条）在画布里就要看得见 ─────────────────────
  const entry2 = qa(".settings-page .grow").find((b) => /自定义 UI/.test(txt(b)));
  entry2.click();
  await sleep(400);
  q('.ed-gallery .ed-card[data-page="reader"]').click();
  await sleep(400);
  if (!q(".ed-readerstage")) throw new Error("阅读器页的画布没出来（.ed-readerstage 不存在）");
  const rdSections = qa(".ed-chromeinsp .ed-nodelist").map((row) => row.getAttribute("data-section"));
  const rdGroups = qa(".ed-chromeinsp fieldset.seg-choice").map((fs) => fs.getAttribute("aria-label"));
  log.push({ step: "reader-editor", sections: rdSections.join(","), groups: rdGroups.join(",") });
  if (rdSections.join(",") !== "readerTop,readerTools,readerStatus") {
    throw new Error("阅读器页的分区不对（应为三个）：" + rdSections.join(","));
  }
  if (rdGroups.join(",") !== "滚动条,控制条自动隐藏") {
    throw new Error("阅读器观感的两个档位组不齐：" + rdGroups.join(","));
  }
  // 默认 = 画布上**不挂**属性（与改造前的"完全隐藏"一致）
  const page0 = q(".ed-readerpage");
  if (page0.hasAttribute("data-jm-rsb")) throw new Error("滚动条默认档位不该挂 data-jm-rsb");
  // 而且**样式真的生效**：默认档位下画布里的滚动容器必须自己把滚动条藏掉
  // （真阅读器是 html.jm-reading 藏的，画布里的容器是另一个元素 —— 不写就会露出一根系统条，
  //   表现为"档位选隐藏、画布上却有一条"。只断言属性是抓不到这个的。）
  const sw = (el) => getComputedStyle(el).scrollbarWidth;
  if (sw(page0) !== "none") throw new Error("默认档位下画布里的滚动容器没藏掉滚动条：" + sw(page0));
  // 选「细条」→ 立刻挂上（画布里看得见，不是盲选）
  const thinBtn = qa(".ed-chromeinsp fieldset[aria-label='滚动条'] button").find((b) => txt(b) === "细条");
  if (!thinBtn) throw new Error("找不到「细条」档位按钮");
  thinBtn.click();
  await sleep(250);
  const page1 = q(".ed-readerpage");
  const rsb = page1.getAttribute("data-jm-rsb");
  log.push({ step: "reader-scrollbar", rsb, scrollbarWidth: sw(page1), saved: JSON.parse(localStorage.getItem("jmclient.readerStyle.v1") || "{}") });
  if (rsb !== "thin") throw new Error("选了「细条」画布没有跟着变（data-jm-rsb=" + rsb + "）");
  if (sw(page1) !== "thin") throw new Error("选了「细条」但画布里的滚动条宽度没变成 thin：" + sw(page1));

  // 收尾：把两处配置清干净，别给别的 driver 留脏状态
  localStorage.removeItem(KEY);
  localStorage.removeItem("jmclient.readerStyle.v1");
  emitCfg();
  window.dispatchEvent(new CustomEvent("jm:readerStyle"));
  await sleep(200);

  log.push({ step: "final", fatal: (document.getElementById("jm-fatal") || {}).textContent || "", errs: (window.__errs || []).slice(0, 5) });
  return log;
})()
