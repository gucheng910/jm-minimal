(async () => {
  // 登录态一致性回归：种「有 token 但本地资料已过期」的会话，验证
  //   1) 会员页与详情页对"是否已登录"的判断一致（此前会员页看资料、详情页看 token）
  //   2) 会员资料能静默自愈（有记住的账号时自动续期）
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const toastText = () => (qa(".toast").map((t) => t.textContent || "").join(" ") || "").trim();
  const waitFor = async (sel, t = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < t) { const el = q(sel); if (el) return el; await sleep(100); }
    return null;
  };

  (await waitFor(".age-confirm"))?.click();
  await waitFor(".list-item");
  await sleep(1500);

  log.push({
    step: "seed",
    token: localStorage.getItem("jwttoken"),
    expiryExpired: Number(localStorage.getItem("authExpiry")) < Date.now(),
    memberBefore: localStorage.getItem("memberInfo")
  });

  // 会员页：应显示「已登录」的会员中心，而不是登录表单
  const memberNav = qa(".nav-item").find((b) => /会员/.test(b.textContent || ""));
  memberNav?.click();
  await sleep(2500);
  const loginForm = q("input[autocomplete='username']") || q(".member-page form input");
  log.push({
    step: "member-page",
    showsLoginForm: !!loginForm,
    hasMemberCenter: !!qa("h2").find((h) => /会员中心/.test(h.textContent || "")),
    coinText: (qa(".member-page").map((e) => e.textContent || "").join(" ").match(/coin=\d+/i) || [""])[0],
    loginReq: (window.__reqs || []).filter((r) => r.path === "login").slice(-1),
    memberAfter: localStorage.getItem("memberInfo")
  });

  // 详情页：同样应显示收藏按钮（与会员页判断一致）
  const homeNav = qa(".nav-item").find((b) => /首页/.test(b.textContent || ""));
  homeNav?.click();
  await sleep(1800);
  const card = q(".list-item");
  if (card) {
    card.click();
    await waitFor(".page-push .card h2", 20000);
    await sleep(2500);
    const favBtn = qa(".page-push button").find((b) => /收藏/.test(b.textContent || ""));
    // 极简版评论默认折叠：先点开分组行再判断 .comment-box 是否存在
    const cmtToggle = qa(".page-push .grow").find((b) => /评论/.test(b.textContent || ""));
    if (cmtToggle) { cmtToggle.click(); await sleep(450); }
    log.push({ step: "detail-page", hasFavoriteButton: !!favBtn, favoriteLabel: favBtn ? favBtn.textContent.trim() : "", commentBox: !!q(".comment-box") });
  } else {
    log.push({ step: "detail-page", error: "没有列表卡片" });
  }

  // ---- 收藏往返：官方 POST /favorite {aid} 本身就是「切换」，收藏完必须还能取消 ----
  {
    const favBtn = () => qa(".page-push .btn.fav")[0];
    const favReqs = () => (window.__reqs || []).filter((r) => r.path === "favorite" && r.method === "POST");
    if (favBtn()) {
      const before = { label: favBtn().textContent.trim(), disabled: favBtn().disabled };
      favBtn().click();
      await sleep(1600);
      const added = { label: favBtn().textContent.trim(), disabled: favBtn().disabled, type: (favReqs().slice(-1)[0] || {}).type, toast: toastText() };
      favBtn().click();
      await sleep(1600);
      const removed = { label: favBtn().textContent.trim(), disabled: favBtn().disabled, type: (favReqs().slice(-1)[0] || {}).type, toast: toastText() };
      log.push({ step: "favorite-toggle", before, added, removed });
      if (added.label !== "已收藏") throw new Error("点收藏后按钮没变成已收藏：" + JSON.stringify(added));
      if (added.type !== "add") throw new Error("收藏请求没发出去：" + JSON.stringify(added));
      if (added.disabled) throw new Error("已收藏状态下按钮不该被禁用（否则无法取消收藏）");
      if (removed.label !== "收藏") throw new Error("取消收藏失败（按钮仍是已收藏）：" + JSON.stringify(removed));
      if (removed.type !== "remove") throw new Error("取消收藏请求没发出去：" + JSON.stringify(removed));
    } else {
      log.push({ step: "favorite-toggle", error: "详情页没有收藏按钮" });
    }
  }

  // 登出后：会员页应回到登录表单，详情页应不再显示收藏按钮（两侧同步）
  const memberNav2 = qa(".nav-item").find((b) => /会员/.test(b.textContent || ""));
  memberNav2?.click();
  await sleep(2000);
  const logoutBtn = qa(".member-page button").find((b) => /登出/.test(b.textContent || ""));
  if (logoutBtn) {
    logoutBtn.click();
    await sleep(2500);
    log.push({
      step: "after-logout",
      token: localStorage.getItem("jwttoken"),
      memberPageShowsLogin: !!q("input[autocomplete='username']")
    });
    const homeNav2 = qa(".nav-item").find((b) => /首页/.test(b.textContent || ""));
    homeNav2?.click();
    await sleep(1800);
    const card2 = q(".list-item");
    if (card2) {
      card2.click();
      await waitFor(".page-push .card h2", 20000);
      await sleep(2200);
      const cmtToggle2 = qa(".page-push .grow").find((b) => /评论/.test(b.textContent || ""));
      if (cmtToggle2) { cmtToggle2.click(); await sleep(450); }
      log.push({
        step: "detail-after-logout",
        hasFavoriteButton: !!qa(".page-push button").find((b) => /收藏/.test(b.textContent || "")),
        commentBox: !!q(".comment-box")
      });
    }
  }

  // ---- 注册表单（官方字段：用户名/密码/重新输入密码/EMAIL/性别 + 两个勾选拦截）----
  const setInput = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const regReqs = () => (window.__reqs || []).filter((r) => r.path === "register");
  const backToMember = async () => {
    const n = qa(".nav-item").find((b) => /会员/.test(b.textContent || ""));
    n?.click();
    await sleep(2000);
  };
  await backToMember();
  const openReg = qa("button").find((b) => (b.textContent || "").trim() === "注册");
  if (openReg) {
    openReg.click();
    await sleep(800);
    const form = q(".member-page form");
    const inputs = form ? Array.from(form.querySelectorAll("input")) : [];
    log.push({
      step: "register-form",
      title: (q(".member-page h2") || {}).textContent || "",
      labels: qa(".member-page form label").map((l) => (l.textContent || "").trim()).slice(0, 8),
      fields: inputs.map((i) => i.type + ":" + (i.name || i.id || "")),
      hasLoginButton: qa(".member-page form button").some((b) => /返回登录/.test(b.textContent || ""))
    });
    const submit = () => qa(".member-page form button").find((b) => /^(注册|注册中…)$/.test((b.textContent || "").trim()));
    // ① 两个勾选都没勾 → 本地拦截，不发请求
    submit()?.click();
    await sleep(600);
    log.push({ step: "register-need-18", toast: toastText(), reqs: regReqs().length });
    // ② 只勾 18+ → 仍被条款拦截
    const checks = qa(".member-page form input[type=checkbox]");
    checks[0] && checks[0].click();
    await sleep(300);
    submit()?.click();
    await sleep(600);
    log.push({ step: "register-need-terms", toast: toastText(), reqs: regReqs().length });
    // ③ 勾选条款 + 填字段但漏选性别 → 服务端 fail 分支（提示用服务端 msg）
    checks[1] && checks[1].click();
    await sleep(200);
    setInput(inputs[0], "tester2");
    setInput(inputs[1], "pw123456");
    setInput(inputs[2], "pw123456");
    setInput(inputs[3], "tester2@example.com");
    await sleep(300);
    submit()?.click();
    await sleep(1200);
    log.push({ step: "register-server-fail", toast: toastText(), reqs: regReqs().slice(-1) });
    // ④ 选性别 → 成功分支：入参必须与官方一致
    const female = qa(".member-page form input[value=Female]")[0];
    female && female.click();
    await sleep(300);
    submit()?.click();
    await sleep(1500);
    log.push({
      step: "register-ok",
      toast: toastText(),
      req: regReqs().slice(-1)[0],
      backToLogin: !!q("input[autocomplete='username']"),
      usernameKept: (q("input[autocomplete='username']") || {}).value || ""
    });
  } else {
    log.push({ step: "register-form", error: "登录表单上找不到「注册」按钮" });
  }

  log.push({ step: "summary", loggedIn: Boolean(localStorage.getItem("jwttoken")) });
  return log;
})()