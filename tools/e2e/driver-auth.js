(async () => {
  // 登录态一致性回归：种「有 token 但本地资料已过期」的会话，验证
  //   1) 会员页与详情页对"是否已登录"的判断一致（此前会员页看资料、详情页看 token）
  //   2) 会员资料能静默自愈（有记住的账号时自动续期）
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
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

  log.push({ step: "summary", loggedIn: Boolean(localStorage.getItem("jwttoken")) });
  return log;
})()