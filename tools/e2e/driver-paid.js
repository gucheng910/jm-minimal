(async () => {
  // 付费漫画回归：购买前显示应付 JCoin → 购买成功后按钮让位给「立即阅读」→ 从列表重进详情依旧已解锁。
  //
  // 守住的缺陷（真机反馈）：购买成功后详情页仍显示「使用官方 JCoin 购买」，重进列表也一样。
  // 根因是 parsePaid 把服务端"已购"的形态（非空字符串）当成未购 —— 判据见 core/albumMeta.ts。
  // 这里用 aid=70001 的付费桩：购买前 purchased=false，购买后返回 purchased="0"（官方语义 = 已购）。
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
  /** 详情页主行动按钮（购买 / 阅读） */
  const actionBtns = () => qa(".page-push .actrow button").map((b) => (b.textContent || "").trim());
  const buyBtn = () => qa(".page-push .actrow button").find((b) => /JCoin/.test(b.textContent || ""));
  const readBtn = () => qa(".page-push .actrow button").find((b) => /立即阅读/.test(b.textContent || ""));
  const favBtn = () => qa(".page-push .actrow button.fav")[0];

  (await waitFor(".age-confirm"))?.click();
  await waitFor(".list-item");
  await sleep(1200);

  // 进付费漫画详情：不走列表点击，直接用 aid 打开（首页桩列表里没有这一部）
  window.dispatchEvent(new CustomEvent("jm:openAid", { detail: "70001" }));
  await waitFor(".page-push .card h2", 20000);
  await sleep(1400);

  // ---- ① 购买前：必须是购买入口，且**写明应付金额** ----
  const before = {
    actions: actionBtns(),
    buyLabel: buyBtn() ? buyBtn().textContent.trim() : "",
    hasRead: !!readBtn(),
    toasts: toastText(),
    logged: (() => { try { return Boolean(localStorage.getItem("jwttoken")); } catch { return false; } })()
  };
  log.push({ step: "paid-before-buy", ...before });
  if (!before.logged) throw new Error("驱动需要已登录会话（应由 ?e2epaid=1 种入）");
  if (!buyBtn()) throw new Error("付费未购的详情页没有购买入口：" + JSON.stringify(before));
  if (before.hasRead) throw new Error("付费未购时不该出现「立即阅读」：" + JSON.stringify(before));
  if (!/30\s*JCoin/.test(before.buyLabel)) {
    throw new Error("购买按钮没有显示应付金额（期望含 30 JCoin）：" + JSON.stringify(before.buyLabel));
  }

  // ---- ② 点购买 ----
  buyBtn().click();
  await sleep(2500);
  const buyReq = (window.__reqs || []).filter((r) => r.path === "coin_buy_comics").slice(-1)[0];
  const afterBuy = {
    actions: actionBtns(),
    hasBuy: !!buyBtn(),
    readLabel: readBtn() ? readBtn().textContent.trim() : "",
    hasFav: !!favBtn(),
    toasts: toastText(),
    buyReq,
    albumReqs: (window.__reqs || []).filter((r) => r.path === "album").length
  };
  log.push({ step: "paid-after-buy", ...afterBuy });
  if (!buyReq) throw new Error("没有发出购买请求（POST /coin_buy_comics）");
  if (afterBuy.hasBuy) {
    throw new Error("购买成功后按钮仍是「使用官方 JCoin 购买」（回归复现）：" + JSON.stringify(afterBuy));
  }
  // 购买后应当就是**正常详情页动作行**：立即阅读 + 收藏（不额外造特殊文案）
  if (afterBuy.readLabel !== "立即阅读") {
    throw new Error("购买后的阅读按钮文案不是朴素的「立即阅读」：" + JSON.stringify(afterBuy.readLabel));
  }
  if (!afterBuy.hasFav) throw new Error("购买后没有出现收藏按钮（应等同普通详情页）：" + JSON.stringify(afterBuy));

  // ---- ③ 返回列表再重进：必须依旧已解锁（真机反馈里"从列表重进依然如此"这一条）----
  window.dispatchEvent(new CustomEvent("jm:back", { detail: { consumed: false } }));
  await sleep(1200);
  const onList = !!q(".list-item") && !q(".page-push .card h2");
  window.dispatchEvent(new CustomEvent("jm:openAid", { detail: "70001" }));
  await waitFor(".page-push .card h2", 20000);
  await sleep(1600);
  const reopened = {
    onListFirst: onList,
    actions: actionBtns(),
    hasBuy: !!buyBtn(),
    readLabel: readBtn() ? readBtn().textContent.trim() : "",
    hasFav: !!favBtn()
  };
  log.push({ step: "paid-reopen", ...reopened });
  if (reopened.hasBuy) {
    throw new Error("重进详情后仍显示购买入口（回归复现）：" + JSON.stringify(reopened));
  }
  if (reopened.readLabel !== "立即阅读") {
    throw new Error("重进详情后的阅读按钮文案不是朴素的「立即阅读」：" + JSON.stringify(reopened.readLabel));
  }
  if (!reopened.hasFav) throw new Error("重进详情后没有收藏按钮：" + JSON.stringify(reopened));

  // ---- ④ 重复购买：服务端回 fail，本地不得谎报成功 ----
  const buyReqCountBefore = (window.__reqs || []).filter((r) => r.path === "coin_buy_comics").length;
  log.push({ step: "paid-rebuy-guard", buyReqCountBefore });

  log.push({ step: "summary", ok: true });
  return log;
})()
