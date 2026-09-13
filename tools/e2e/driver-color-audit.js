// 一次性探针：暗色模式下把所有「靠类名上色」的按钮/文字量出来，并算对比度
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // 逐级向上找到第一个不透明背景
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const parts = (c.match(/[\d.]+/g) || []);
      if (c && c !== "rgba(0, 0, 0, 0)" && (parts.length < 4 || Number(parts[3]) > 0.5)) return rgb(c);
      n = n.parentElement;
    }
    return rgb(getComputedStyle(document.documentElement).backgroundColor || "rgb(16,15,15)");
  };
  const contrast = (el) => {
    const f = lum(rgb(getComputedStyle(el).color)), b = lum(bgOf(el));
    const [hi, lo] = f > b ? [f, b] : [b, f];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const entry = (label, sel) => {
    const el = document.querySelector(sel);
    if (!el) return [label, "(该页无此元素)"];
    return [label, { color: getComputedStyle(el).color, 对比度: contrast(el), tag: el.tagName.toLowerCase() }];
  };

  for (let i = 0; i < 60 && !document.querySelector(".age-confirm"); i++) await sleep(250);
  const g = document.querySelector(".age-confirm"); if (g) g.click();
  await sleep(1500);
  for (let i = 0; i < 40 && document.querySelector(".age-gate"); i++) await sleep(250);

  const home = Object.fromEntries([
    entry("顶栏图标按钮", ".top-actions button"),
    entry("底栏项", ".nav-item"),
    entry("卡片标题", ".list-item .title"),
    entry("卡片副标题", ".list-item .muted")
  ]);

  const card = document.querySelector(".list-item");
  if (card) { card.click(); await sleep(1800); }
  const detail = Object.fromEntries([
    entry("作者/标签蓝字 .link", ".d-meta .link"),
    entry("复制 .d-copy", ".d-copy"),
    entry("返回 .backtxt", ".backtxt"),
    entry("展开 .d-more", ".d-more"),
    entry("主按钮 .btn.primary", ".btn.primary"),
    entry("次按钮 .btn.soft", ".btn.soft")
  ]);

  return {
    theme: document.documentElement.getAttribute("data-theme"),
    tokenLink: getComputedStyle(document.documentElement).getPropertyValue("--link").trim(),
    tokenBtnInk: getComputedStyle(document.documentElement).getPropertyValue("--btn-ink").trim(),
    首页: home,
    详情页: detail
  };
})()
