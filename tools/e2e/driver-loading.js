// 加载态回归（v3.13 新增）：两件事，都是用户实测报出来的。
//
// ① **首页骨架屏必须出现在两条"启动路径"上**：过完 18+ 门进首页、从别的页（如分类页）切回首页。
//    病根：骨架的判据是 `busy && 空列表`（ui/blocks/AlbumFeed），而首页的**启动流程**
//    （ContentView 里那段：还原最优线路 → 取 setting → 拉推荐）直接调 client.getRandomRecommend()，
//    过去没有任何东西把 busy 置起来 —— 于是空列表 + busy=false = 骨架不画、网格也是空的 = **整片空白**。
//
//    判别性在这里：只断言"最终有内容"是不够的 —— 那个断言在**有 bug 的版本上照样是绿的**。
//    能区分修好没修好的断言必须是"**加载期间看得见占位**"。
//
// ② **骨架的列数必须与真网格同一档**：用户把「每行列数」改成 3 列（窄屏下真网格 3 列）时，
//    骨架过去只有自己的断点规则（≤640px 恒 2 列）→ 占位与真实内容对不上，加载完成那一瞬间整页跳一下。
//    负对照：把档位改回「自适应」，同一视口下骨架必须是 2 列 —— 证明上面那条不是"恒 3 列"。
//
// ⚠️ 桩是秒回的：不注入延迟就采不到"加载中"这一帧（骨架可能一帧都没画完就被内容替换掉）。
//    所以这里用 stub 的 `window.__delayMap[path] = ms`（失败注入的同族手段）把接口拖慢，
//    每条断言之后都恢复成 0，不给后面的步骤留脏状态。
(async () => {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const txt = (el) => (el ? (el.textContent || "").trim() : "");
  const waitFor = async (sel, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const el = q(sel); if (el) return el; await sleep(50); }
    throw new Error("waitFor timeout: " + sel);
  };
  /** 骨架是否**真的占了屏**（存在但高度 0 不算 —— 那和没画没区别） */
  const skelEl = () => {
    const el = q(".skeleton-grid");
    return el && el.offsetHeight > 0 ? el : null;
  };
  /** 轨道数：Chrome 把 grid-template-columns 算成"每档一个像素值"，数空格即可 */
  const tracks = (sel) => {
    const el = q(sel);
    if (!el) return 0;
    return getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
  };
  const cards = () => qa(".browse-page .list-item").length;
  const emit = (t) => window.dispatchEvent(new CustomEvent(t));
  const delay = (path, ms) => { window.__delayMap = window.__delayMap || {}; window.__delayMap[path] = ms; };

  /** 等到骨架占屏（且内容还没到）。返回采到的读数，超时返回 null */
  const awaitSkeleton = async (timeout = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (skelEl() && cards() === 0) {
        // 立刻采样：骨架的**类名**与真网格的列数都要在这一帧读，不能等
        return { skelTracks: tracks(".skeleton-grid"), gridTracks: tracks(".browse-page .list"), cls: skelEl().className };
      }
      await sleep(40);
    }
    return null;
  };

  window.__delayMap = window.__delayMap || {};
  delay("random_recommend", 2000);

  // ── ① 过 18+ 门进首页：加载期间必须有骨架 ───────────────────────────────
  const gateBtn = await waitFor(".age-confirm");
  gateBtn.click();
  const gateSkel = await awaitSkeleton(4000);
  log.push({ step: "gate-to-home", skel: gateSkel, gateStillOpen: !!q(".age-gate"), cards: cards() });
  if (!gateSkel) {
    throw new Error("过完 18+ 门进首页时**没有骨架屏**（空列表 + 无占位 = 用户看不出在加载）");
  }

  // 内容落地 → 骨架必须撤掉（否则"骨架常驻"是另一种 bug）
  await waitFor(".browse-page .list-item", 8000);
  await sleep(120);
  log.push({ step: "home-loaded", skel: !!skelEl(), cards: cards() });
  if (skelEl()) throw new Error("内容已经落地，骨架屏还留在屏上");
  if (cards() === 0) throw new Error("首页内容没有渲染出来");

  // ── ② 分类页 → 首页：换成这条路径，骨架同样必须有 ────────────────────────
  const navBtn = (re) => {
    const b = qa(".bottom-nav .nav-item").find((x) => re.test(txt(x)));
    if (!b) throw new Error("底栏找不到 " + re + "（单元被藏了？）");
    return b;
  };
  navBtn(/分类/).click();
  await waitFor(".catrow", 8000);
  await sleep(500);
  const catCards = cards();
  navBtn(/首页/).click();
  const tabSkel = await awaitSkeleton(4000);
  log.push({ step: "cat-to-home", catCards, skel: tabSkel, cards: cards() });
  if (catCards === 0) throw new Error("分类页本身没出内容，这一步的前提就不成立");
  if (!tabSkel) {
    throw new Error("从分类页切回首页时**没有骨架屏**（切 tab 会整块重挂载，这一段过去是整片空白）");
  }
  await waitFor(".browse-page .list-item", 8000);
  await sleep(120);
  if (skelEl()) throw new Error("切回首页后内容已落地，骨架仍在屏上");

  // ── ③ 骨架列数 = 真网格列数（3 列档）────────────────────────────────────
  const KEY = "jmclient.listLayout.v1";
  delay("latest", 2000);
  const tab = (label) => {
    const b = qa(".tabs .tk").find((x) => txt(x) === label);
    if (!b) throw new Error("首页分段找不到「" + label + "」（分段控件变了？）");
    return b;
  };

  localStorage.setItem(KEY, JSON.stringify({ version: 1, columns: 3 }));
  emit("jm:listLayout");
  await sleep(300);
  const grid3 = tracks(".browse-page .list");
  if (grid3 !== 3) throw new Error("把每行列数改成 3 列之后，真网格不是 3 列（是 " + grid3 + "）——前提不成立");
  // 切到「最新」：loadLatest 会先清空列表并置 busy → 骨架
  tab("最新").click();
  const wide = await awaitSkeleton(4000);
  log.push({ step: "cols-3", gridTracks: grid3, skel: wide });
  if (!wide) throw new Error("切到「最新」分段时没有骨架屏");
  if (wide.skelTracks !== 3) {
    throw new Error("列数设为 3 时骨架是 " + wide.skelTracks + " 列，与真网格（3 列）不一致 —— 占位与内容对不上");
  }

  // ── ④ 负对照：改回「自适应」→ 同一视口（420px 手机断点）骨架必须是 2 列 ──
  await waitFor(".browse-page .list-item", 8000);
  localStorage.setItem(KEY, JSON.stringify({ version: 1, columns: "auto" }));
  emit("jm:listLayout");
  await sleep(300);
  const gridAuto = tracks(".browse-page .list");
  if (gridAuto !== 2) throw new Error("420px 视口下自适应档位真网格不是 2 列（是 " + gridAuto + "）—— 断点变了？");
  tab("推荐").click();
  const narrow = await awaitSkeleton(4000);
  log.push({ step: "cols-auto", gridTracks: gridAuto, skel: narrow });
  if (!narrow) throw new Error("切到「推荐」分段时没有骨架屏");
  if (narrow.skelTracks !== 2) {
    throw new Error("自适应档位（420px）下骨架是 " + narrow.skelTracks + " 列，应为 2 列 —— 上面那条 3 列断言可能是巧合");
  }

  // ── 收尾：清掉注入与配置，别给别的 driver 留脏状态 ──────────────────────
  await waitFor(".browse-page .list-item", 8000);
  delay("random_recommend", 0);
  delay("latest", 0);
  localStorage.removeItem(KEY);
  emit("jm:listLayout");
  await sleep(200);
  log.push({ step: "final", cards: cards(), skel: !!skelEl(), fatal: (document.getElementById("jm-fatal") || {}).textContent || "", errs: (window.__errs || []).slice(0, 5) });
  if (skelEl()) throw new Error("收尾时骨架还挂在屏上（有东西没有熄灭）");
  return log;
})()
