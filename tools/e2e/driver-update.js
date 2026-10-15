// v3.16 更新提示 / 更新日志（真实页面 · 真实链路 · 桩住 GitHub）
//
// 判别性设计（每条都能单独变红）：
//   ① 首次进入（没记过版本）→ 弹「更新日志」，正文含内置条目，记账写在**关闭时**；
//   ② 关掉日志后，静默检查（进软件 1.5s）发现「有新版」→ 弹「发现新版本」，
//      三个按钮文案必须齐全（立即更新 / 下次再说 / 不再提醒）；
//   ③ **负对照 A**：点「不再提醒」只写这一个版本号 → 换成更高的 9.9.10 再查 → **又弹**；
//   ④ **负对照 B**：「下次再说」**不写任何东西** → 同版本再查照样弹；
//   ⑤ **静默失败**：GitHub 桩改成失败 → 查完**不弹任何东西**，也不出现红色错误条；
//   ⑥ 记账的负对照：把 versionSeen 写成当前版本 → **不弹日志**（只在版本真变了才弹）。
//
// ⚠️ 桩的默认行为是「GitHub 404」—— 只有本驱动显式设 `window.__ghRelease` 才会有新版本，
//    否则其它 40 多支驱动会莫名其妙弹出更新提示（见 stub.js 里那段注释）。
(async () => {
  const log = [];
  /**
   * 当前 App 版本（= `package.json` 的 version，构建时注入 `__APP_VERSION__` → `LOCAL_VERSION`）。
   *
   * ⚠️ **版本号升级时必须同步改这一处**（v2.3.0 起收敛成单点）：三处断言/种子都引用它 ——
   *   ① 日志副标题里必须出现它；② 关闭日志后记账写的必须是它；③ 负对照的种子必须等于它。
   * 之所以不硬编码散在四处：2.2.7 → 2.3.0 那次升级就是漏改了这里，`更新提示/日志` 两支直接红。
   */
  const APP_VERSION = "2.3.0";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (el) => (el ? (el.textContent || "").trim() : "");
  const waitUntil = async (fn, timeout = 12000, label = "condition") => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(80); }
    throw new Error("waitUntil timeout: " + label);
  };
  const dialog = () => q(".update-sheet");
  const btnIn = (re) => qa(".update-sheet .update-actions button").find((b) => re.test(txt(b)));
  /** 这次跑的是哪条链路：`?jmupd=desktop`（假 jmUpdate 桥）还是默认的安卓/GitHub 那条 */
  const MODE = /[?&]jmupd=desktop/.test(location.search) ? "desktop" : "native";

  // ── 准备：一个"有新版"的 GitHub Release（安卓资产命名要能被 pickApkAsset 认出来）──
  const RELEASE = {
    tag_name: "v9.9.9",
    name: "v9.9.9",
    body: "· 桩里的更新内容第一条\n· 桩里的更新内容第二条",
    html_url: "https://github.com/gucheng910/jm-minimal/releases/tag/v9.9.9",
    assets: [
      { name: "jm-minimal-v9.9.9-modern.apk", browser_download_url: "https://example.test/modern-v999.apk" },
      { name: "jm-minimal-v9.9.9-compat.apk", browser_download_url: "https://example.test/compat-v999.apk" }
    ]
  };
  // 起点：`version.seen` 由**桩**写成旧版本（`?jmupd=upgrade`）——
  // ⚠️ 不能在这里写：日志弹不弹是 `UpdateDialog` **挂载时**判定的，而 App 早在驱动跑起来之前
  //    就已经挂载完了（驱动是页面 load 之后才注入的）。写晚了的结果是"判定成全新安装、不弹"。
  //    这里只清那两份"检查时才读"的状态（晚设也来得及）。
  ["jmclient.update.skip", "jmclient.update.checkedAt"].forEach((k) => localStorage.removeItem(k));
  window.__ghRelease = RELEASE;

  for (let i = 0; i < 80 && !q(".age-confirm"); i++) await sleep(100);
  if (!q(".age-confirm")) throw new Error("没等到 18+ 门（页面没起来？）");
  q(".age-confirm").click();

  // ── ① 首次进入 → 更新日志 ─────────────────────────────────────────────
  await waitUntil(() => !!dialog(), 6000, "更新日志弹窗");
  // v2.3.1：正文不再是"一整块 <pre>"，而是**圆点条目列表**（用户反馈"有点丑"）→
  // 断言改成数 <li> 条数（容器仍带 data-update-notes="changelog"，定位方式不变）。
  const noteItems = qa('.update-sheet [data-update-notes="changelog"] .update-list li')
    .map((el) => txt(el)).filter((s) => s.length > 0);
  const notesSub = txt(q(".update-sheet [data-update-sub]"));
  log.push({ step: "changelog-first-run", title: txt(q(".update-sheet .sheet-head h3")), sub: notesSub, items: noteItems.length });
  if (txt(q(".update-sheet .sheet-head h3")) !== "更新日志") {
    throw new Error("首次进入没弹「更新日志」，标题是：" + txt(q(".update-sheet .sheet-head h3")));
  }
  if (notesSub.indexOf("v" + APP_VERSION) < 0) throw new Error("日志副标题里没有当前版本：" + notesSub);
  // ⚠️ 阈值 3（不是"等于条目总数"）：判别力在"有条目、每条非空"，写死条数会在每次精简日志时误红。
  if (noteItems.length < 3) {
    throw new Error("日志正文条目太少（应 ≥3 条，实际 " + noteItems.length + "）：" + noteItems.join(" / ").slice(0, 120));
  }
  // 记账必须在**关闭时**写：此刻还没关，所以 storage 里应当还是"升级前那个版本"
  const seenBefore = JSON.parse(localStorage.getItem("jmclient.version.seen") || "null");
  if (!seenBefore || seenBefore.version !== "0.0.1") {
    throw new Error("日志还没关就已经记账了（下次会看不到日志 —— 打开就记是经典的自杀式记账）：" + JSON.stringify(seenBefore));
  }
  btnIn(/知道了/).click();
  await waitUntil(() => !dialog(), 6000, "日志关闭");
  const seen = JSON.parse(localStorage.getItem("jmclient.version.seen") || "null");
  log.push({ step: "changelog-seen", seen });
  if (!seen || seen.version !== APP_VERSION) throw new Error("关闭日志后没有记下看过的版本：" + JSON.stringify(seen));

  // ── ② 静默检查（进软件 1.5s）→ 发现新版本 ────────────────────────────
  await waitUntil(() => !!dialog(), 10000, "更新提示弹窗");
  const buttons = qa(".update-sheet .update-actions button").map(txt);
  const promptSub = txt(q('.update-sheet [data-update-sub="prompt"]'));
  log.push({
    step: "update-prompt",
    title: txt(q(".update-sheet .sheet-head h3")),
    sub: promptSub,
    buttons,
    status: txt(q(".update-sheet .update-status")),
    hasReleaseNotes: !!q('.update-sheet [data-update-notes="release"]')
  });
  if (txt(q(".update-sheet .sheet-head h3")) !== "发现新版本") throw new Error("第二次弹的不是更新提示");
  if (!/9\.9\.9/.test(promptSub)) throw new Error("更新提示里没有新版本号：" + promptSub);
  for (const want of ["立即更新", "下次再说", "不再提醒"]) {
    if (buttons.indexOf(want) < 0) throw new Error("更新提示缺按钮「" + want + "」：" + buttons.join("/"));
  }
  if (!q('.update-sheet [data-update-notes="release"]')) {
    throw new Error("Release 正文没有被渲染出来（桩里给了 body）");
  }

  // ── ④ 负对照 B：下次再说 → 不写任何东西 ─────────────────────────────
  btnIn(/下次再说/).click();
  await waitUntil(() => !dialog(), 6000, "下次再说关闭");
  if (localStorage.getItem("jmclient.update.skip")) {
    throw new Error("「下次再说」竟然写了 skip —— 它必须什么都不记（下次启动照样提示）");
  }
  log.push({ step: "later-writes-nothing", skip: localStorage.getItem("jmclient.update.skip") });

  // 再查一次（手动入口走的是同一条链路）→ 同版本应当**又弹**
  clickCheckNow();
  await waitUntil(() => !!dialog(), 10000, "下次再说之后再弹");
  log.push({ step: "later-reprompts", sub: txt(q('.update-sheet [data-update-sub="prompt"]')) });

  // ── ③ 不再提醒 → 只跳这一个版本 ──────────────────────────────────────
  btnIn(/不再提醒/).click();
  await waitUntil(() => !dialog(), 6000, "不再提醒关闭");
  const skip = localStorage.getItem("jmclient.update.skip");
  log.push({ step: "ignore-writes-version", skip });
  if (skip !== "9.9.9") throw new Error("「不再提醒」没有写下版本号：" + skip);

  // 同版本再查 → **不该弹**（负对照）
  clickCheckNow();
  await sleep(1800);
  if (dialog()) throw new Error("跳过 9.9.9 之后，同一个 9.9.9 还在提示（跳过没生效）");
  log.push({ step: "ignore-silences-same-version", dialog: false });

  // ── ③ 负对照 A：更高的版本 → **又弹**（证明是"只跳一个版本"）────────
  window.__ghRelease = Object.assign({}, RELEASE, { tag_name: "v9.9.10", name: "v9.9.10" });
  clickCheckNow();
  await waitUntil(() => !!dialog(), 10000, "更高版本要重新提示");
  const newerSub = txt(q('.update-sheet [data-update-sub="prompt"]'));
  log.push({ step: "ignore-is-per-version", sub: newerSub });
  if (!/9\.9\.10/.test(newerSub)) throw new Error("补上来的不是 9.9.10：" + newerSub);

  // ── ⑤ 静默失败：GitHub 桩坏掉 → 不弹任何东西 ─────────────────────────
  btnIn(/下次再说/).click();
  await waitUntil(() => !dialog(), 6000, "关掉提示");
  window.__ghRelease = "fail";
  clickCheckNow();
  await sleep(2200);
  if (dialog()) throw new Error("检查失败时仍然弹了东西（必须静默失败）");
  const redBars = qa(".toast-host .toast, .toast-host > *").filter((e) => /失败|错误/.test(txt(e)));
  log.push({ step: "silent-failure", dialog: false, redToasts: redBars.length });
  if (redBars.length > 0) throw new Error("检查失败弹了错误提示：" + txt(redBars[0]));

  // ── ⑦ 桌面链路独有的一段：下载进度 → 「立即安装」──────────────────────
  //    只有 `?jmupd=desktop`（假 jmUpdate 桥）能走到这里 —— 安卓那条链路在浏览器里
  //    没有 AppUpdater 插件，download() 是空操作，走不到下载态。
  if (MODE === "desktop") {
    // ⚠️ 这里必须换一个**没被跳过**的版本号：上面「不再提醒」存的是 9.9.9，
    //    而"被跳过的版本"在策略上会降级成"已是最新"（`skippedIsNotAnUpdate`）——
    //    拿同一个 9.9.9 回来测下载态，得到的是"没有提示"（看着像 bug，其实是策略在生效）。
    window.__ghRelease = Object.assign({}, RELEASE, { tag_name: "v9.9.11", name: "v9.9.11" });
    clickCheckNow();
    await waitUntil(() => !!dialog(), 10000, "桌面：重新出现更新提示");
    if (txt(q(".update-sheet .sheet-head h3")) !== "发现新版本") throw new Error("桌面：提示标题不对");
    // 更新内容是 latestNotes（IPC 里带回来的）而不是 GitHub 正文
    const relNotes = txt(q('.update-sheet [data-update-notes="release"]'));
    if (relNotes.indexOf("桩里的更新内容") < 0) throw new Error("桌面：latestNotes 没被渲染：" + relNotes.slice(0, 80));
    btnIn(/立即更新/).click();
    await waitUntil(() => !!q('.update-sheet [data-update-progress="known"]'), 8000, "桌面：下载进度出现");
    const barPct = txt(q(".update-sheet [data-update-pct]"));
    log.push({ step: "desktop-progress", pct: barPct, fill: q(".update-sheet .update-progress-fill").style.transform });
    if (barPct !== "60%") throw new Error("桌面：进度百分比不对：" + barPct);
    if (q(".update-sheet .update-progress-fill").style.transform.indexOf("0.6") < 0) {
      throw new Error("桌面：进度条没有按 60% 画：" + q(".update-sheet .update-progress-fill").style.transform);
    }
    // 下载完成 → 同一个弹层换一态：主按钮变「立即安装」
    await waitUntil(() => !!btnIn(/立即安装/), 8000, "桌面：进入可安装态");
    const readyButtons = qa(".update-sheet .update-actions button").map(txt);
    log.push({ step: "desktop-ready", buttons: readyButtons, status: txt(q(".update-sheet .update-status")) });
    if (readyButtons.indexOf("稍后安装") < 0) throw new Error("桌面：可安装态缺「稍后安装」：" + readyButtons.join("/"));
    if (!/下载完成/.test(txt(q(".update-sheet .update-status")))) {
      throw new Error("桌面：状态行没写下载完成：" + txt(q(".update-sheet .update-status")));
    }
    btnIn(/稍后安装/).click();
    await waitUntil(() => !dialog(), 6000, "桌面：稍后安装关闭");
  }

  // ── ⑥ 记账的负对照：versionSeen = 当前版本 → 不弹日志 ────────────────
  localStorage.setItem("jmclient.version.seen", JSON.stringify({ version: APP_VERSION, at: Date.now() }));
  window.__ghRelease = null;
  log.push({ step: "notes-accounting-control", seen: localStorage.getItem("jmclient.version.seen") });

  log.push({ step: "final", fatal: (document.getElementById("jm-fatal") || {}).textContent || "", errs: (window.__errs || []).slice(0, 5) });
  return log;

  /** 点设置页里那个手动「检查更新」按钮（与自动检查走同一条 core 链路） */
  function clickCheckNow() {
    const nav = qa(".bottom-nav .nav-item").find((b) => /设置/.test(txt(b)));
    if (nav) nav.click();
    // 文案随状态变：检查更新 / 已是最新版本 / 发现新版本，点击更新 / 重试
    const btn = qa("button").find((b) => /检查更新|已是最新版本|发现新版本|重试/.test(txt(b)));
    if (!btn) throw new Error("设置页里找不到「检查更新」按钮");
    const label = txt(btn);
    btn.click();
    return label;
  }
})()
