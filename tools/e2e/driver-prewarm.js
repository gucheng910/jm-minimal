// 18+ 门上的静默预取（core/prewarm）回归：
//   1) **门还挡着**的时候就已经把首屏列表拉下来了（这就是"偷跑"，用户在读 18+ 文案/协议的时间不浪费）；
//   2) 预取到的列表被 ContentView **接管**，确认之后**不会再请求第二次**（否则等于白跑一遍流量）；
//   3) 封面的预热任务在门上就已经发出去了（`__jmCoverJobs` 增长）。
// 桩里的封面域名解析不到，所以这里只断言"预热请求发出去了"，不断言它成功
// （真机上成功的判定在 driver-cover.js 里）。
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
  const reqs = (path) => (window.__reqs || []).filter((r) => r.path === path).length;

  // 门必须先出现（否则这个用例没意义）
  await waitFor(".age-gate", 20000);
  if (!q(".age-confirm")) throw new Error("18+ 门没有确认按钮");

  // ① 门还挡着 → 首屏列表已经被拉下来了
  await waitUntil(() => reqs("random_recommend") >= 1, 20000, "门上就发出 random_recommend");
  // 封面预热是"列表到手之后"才开始发的，给它一点时间（不抛错，先把诊断打出来再断言）
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && (window.__jmCoverJobs || 0) < 1) await sleep(150);
  const atGate = {
    gateVisible: !!q(".age-gate"),
    confirmVisible: !!q(".age-confirm"),
    recommend: reqs("random_recommend"),
    coverJobs: window.__jmCoverJobs || 0,
    coverWarm: window.__jmCoverWarm || 0,
    cards: qa(".list-item").length,
    setting: reqs("setting"),
    prewarm: window.__jmPrewarm || null
  };
  log.push({ step: "prewarm-at-gate", ...atGate });

  if (!atGate.gateVisible) throw new Error("断言时刻门已经不在屏上了（预取太快 / 门被提前关掉）");
  if (atGate.recommend < 1) throw new Error("门上没有预取首屏列表（偷跑没生效）");
  if (atGate.coverJobs < 1) throw new Error("门上没有发出封面预热任务；prewarm 阶段=" + JSON.stringify(atGate.prewarm));
  if (atGate.cards !== 0) throw new Error("门上就渲染出 " + atGate.cards + " 张卡片（预取不该往屏幕上放内容）");

  // ② 点确认 → 列表出来，且**没有**第二次 random_recommend
  qa(".age-confirm")[0].click();
  await waitUntil(() => qa(".list-item").length > 0, 25000, "确认后列表出内容");
  await sleep(1200);
  const after = {
    gateGone: !q(".age-gate"),
    cards: qa(".list-item").length,
    recommend: reqs("random_recommend"),
    firstTitle: txt(q(".list-item .title"))
  };
  log.push({ step: "after-confirm", ...after });

  if (!after.gateGone) throw new Error("点了确认门还在");
  if (after.cards < 1) throw new Error("确认后列表没有内容");
  if (after.recommend !== atGate.recommend) {
    throw new Error("确认后又请求了一次 random_recommend（" + atGate.recommend + " → " + after.recommend
      + "）：预取的列表没有被接管，等于白跑一趟流量");
  }

  log.push({ step: "final", fatal: txt(q("#jm-fatal")), errs: window.__errs || [] });
  return log;
})()
