// 回归：特殊搜索页里「反复点同一个漫画 → 返回」不许让列表卡片变大 / 每次跳一下（2026-09-24 真机反馈）
//
// 曾经的真凶：返回时给详情页加了 transform: translateX(+24%)（.pushed-pop）。
// 详情页是非 fixed 元素，向右伸出视口 → 文档横向 scrollWidth 变大 → 移动端视口被撑宽
// （innerWidth 420→441…）→ inset:0 的搜索层跟着变宽 → 网格列宽变大、卡片等比变大，
// 且视口变宽又让 +24% 更大 → 自我放大。故这里直接守三件事：
//   ① 文档不许出现横向溢出（scrollWidth ≤ clientWidth）；
//   ② 视口宽度不许漂移；
//   ③ 卡片宽度不许变。
(async () => {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const waitFor = async (sel, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const el = q(sel); if (el) return el; await sleep(50); }
    throw new Error("waitFor timeout: " + sel);
  };
  const back = () => window.dispatchEvent(new CustomEvent("jm:back", { detail: { consumed: false } }));
  const de = document.documentElement;

  const probe = (tag) => {
    const open = q(".sr-layer.open");
    const body = open ? open.querySelector(".sr-body") : null;
    const card = body ? body.querySelector(".list-item") : null;
    const grid = body ? body.querySelector(".list") : null;
    const cr = card ? card.getBoundingClientRect() : null;
    return {
      tag,
      layers: qa(".sr-layer").length,
      innerW: window.innerWidth,
      clientW: de.clientWidth,
      scrollW: de.scrollWidth,
      cardW: cr ? Math.round(cr.width * 100) / 100 : 0,
      cols: grid ? getComputedStyle(grid).gridTemplateColumns : ""
    };
  };

  const check = (p, base, where) => {
    log.push(p);
    if (p.layers !== 1) throw new Error(where + "：搜索层实例数不是 1（" + p.layers + "）");
    if (p.scrollW > p.clientW + 1) throw new Error(where + "：文档出现横向溢出 scrollWidth=" + p.scrollW + " clientWidth=" + p.clientW);
    if (Math.abs(p.innerW - base.innerW) > 1) throw new Error(where + "：视口宽度漂移 " + base.innerW + " → " + p.innerW);
    if (p.cardW && Math.abs(p.cardW - base.cardW) > 1) throw new Error(where + "：卡片宽度变了 " + base.cardW + " → " + p.cardW);
  };

  (await waitFor(".age-confirm")).click();
  await waitFor(".list-item");
  await sleep(700);
  q(".list-item").click();
  await waitFor(".page-push .card h2");
  await sleep(800);
  const link = qa(".page-push .link").find((l) => l.textContent === "巨乳");
  if (!link) throw new Error("找不到标签链接「巨乳」");
  link.click();
  await waitFor(".sr-layer.open");
  await sleep(900);

  const base = probe("open");
  log.push(base);
  if (base.scrollW > base.clientW + 1) throw new Error("打开搜索层就已有横向溢出：" + JSON.stringify(base));
  if (!base.cardW) throw new Error("搜索层里没有卡片可测");

  for (let i = 0; i < 4; i++) {
    q(".sr-layer.open .sr-body .list-item").click();
    await waitFor(".page-push .card h2");
    await sleep(700);
    if (de.scrollWidth > de.clientWidth + 1) throw new Error("detail" + (i + 1) + "：详情页出现横向溢出 scrollWidth=" + de.scrollWidth);
    back();
    await sleep(1100);
    check(probe("back" + (i + 1)), base, "back" + (i + 1));
  }
  log.push({ step: "errs", errs: (window.__errs || []).slice(0, 5) });
  return log;
})()
