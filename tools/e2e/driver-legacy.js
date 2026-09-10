// 兼容包（老内核）验证用的 driver：确认页面确实由 ES5 legacy 包 + SystemJS 启动
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const log = [];
  // 等应用挂载（legacy 包启动比现代包慢）
  for (let i = 0; i < 40 && !q(".age-confirm") && !q(".list-item"); i++) await sleep(500);
  log.push({
    step: "legacy-boot",
    title: document.title,
    reactMounted: (q("#root") || {}).childElementCount > 0,
    ageGate: !!q(".age-confirm"),
    // 现代性探测被模拟关掉 + SystemJS 已加载 = 走的是 legacy 包
    forcedLegacy: window.__vite_is_modern_browser !== true,
    systemjsLoaded: typeof window.System !== "undefined",
    legacyScripts: Array.from(document.querySelectorAll("script"))
      .map((s) => s.src || s.getAttribute("data-src") || "")
      .filter((u) => /legacy/.test(u)),
    oldWebviewNoticeShown: q("#jm-old-webview") ? !q("#jm-old-webview").hidden : null,
    errs: (window.__errs || []).slice(0, 5)
  });
  if (!log[0].reactMounted) throw new Error("legacy 包没有把应用渲染出来：" + JSON.stringify(log[0]));
  if (!log[0].systemjsLoaded) throw new Error("legacy 包未加载 SystemJS（polyfills 没生效）");
  // 过 18+ 门 → 首页列表
  if (q(".age-confirm")) q(".age-confirm").click();
  for (let i = 0; i < 40 && !q(".list-item"); i++) await sleep(500);
  log.push({ step: "legacy-home", cards: document.querySelectorAll(".list-item").length, errs: (window.__errs || []).slice(0, 5) });
  if (document.querySelectorAll(".list-item").length === 0) throw new Error("首页列表没渲染出来");
  // 兼容包必须自报家门（BUILD_VARIANT=compat）：应用内更新据此挑 compat 资产，不能下成 modern 包
  const menuBtn = q(".menu-btn");
  if (menuBtn) {
    menuBtn.click();
    await sleep(800);
    const note = Array.from(document.querySelectorAll(".menu-note")).map((n) => (n.textContent || "").trim());
    log.push({ step: "legacy-variant-label", versionLine: note.find((t) => /官方协议/.test(t)) || "", notes: note });
    if (!note.some((t) => /兼容包/.test(t))) throw new Error("兼容包版本行未标注「兼容包」：" + JSON.stringify(note));
    q(".menu-backdrop") && q(".menu-backdrop").click();
  }
  return log;
})()
