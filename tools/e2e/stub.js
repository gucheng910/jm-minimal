(() => {
  const HOST = "mock.jm.local";
  try {
    localStorage.setItem("jmclient.hostcfg.v1", JSON.stringify({ ts: Date.now(), cfg: { Setting: [HOST], Server: [HOST], jm3_Server: [[HOST, "線路1"]] } }));
    localStorage.setItem("jmclient.autoSelect.v1", JSON.stringify({ host: HOST, shunt: "1", ts: Date.now() }));
    localStorage.setItem("jmclient.tosAccepted.v1", "1");
    localStorage.setItem("jmclient.theme", "light");
  } catch (e) {}
  window.__reqs = [];
  // 用 DOM Touch 事件模拟手指（React 的 onTouchStart/Move/End 能收到）
  window.__jmTouch = (type, x, y) => {
    const target = document.elementFromPoint(x, y) || document.body;
    const mk = (cx, cy) => new Touch({ identifier: 1, target, clientX: cx, clientY: cy, pageX: cx, pageY: cy });
    const list = type === "touchEnd" ? [] : [mk(x, y)];
    const ev = new TouchEvent(type, { bubbles: true, cancelable: true, touches: list, targetTouches: list, changedTouches: [mk(x, y)] });
    target.dispatchEvent(ev);
  };
  window.__errs = [];
  window.addEventListener("error", (e) => { try { window.__errs.push(String(e.message || e.error) + " @" + String(e.filename || "").split("/").pop() + ":" + e.lineno); } catch (x) {} });
  window.addEventListener("unhandledrejection", (e) => { try { window.__errs.push("rej: " + ((e.reason && (e.reason.message || String(e.reason))) || "?")); } catch (x) {} });
  const mk = (prefix, n, author) => Array.from({ length: n }, (_, i) => ({ id: prefix + i, name: prefix + "-作品" + i, author, update_at: "2026-01-01" }));
  const detail = (id) => ({ id, name: "详情" + id, author: ["作者甲", "作者乙"], tags: ["巨乳", "無修正", "中文"], actors: ["登场甲", "登场乙"], related_list: mk("REL", 3, "作者甲"), total_photos: 42, description: "简介文本", series: [], price: "", purchased: false });
  const json = (data) => new Response(JSON.stringify({ code: 200, data }), { status: 200, headers: { "content-type": "application/json" } });
  window.fetch = async (input) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const u = new URL(url, location.href);
    const p = u.pathname.replace(/^\//, "");
    if (p === "setting") return json({ version: "1", test_version: "1", jm3_version: "2.1.6", ipcountry: "CN", ad_cache_version: 1, float_ad: false, is_cn: 1, cn_base_url: "", base_url: "", main_web_host: "", img_host: "", app_shunts: [{ key: "1", title: "图源1" }] });
    if (p === "random_recommend") { window.__reqs.push({ path: p }); return json(mk("A", 8, "作者甲")); }
    if (p === "hot_tags") return json(["热词1", "热词2"]);
    if (p === "payment") return json({ plans: [{ key: "p1", name: "月卡", price: 1, days: 30 }], pay_methods: [], uid: 1, orders: [], web_host: "", checkout: "" });
    if (p === "ad_content_all") return json({});
    if (p === "categories") return json({ categories: [{ id: 1, slug: "doujin", name: "同人", sub_categories: [{ id: 11, slug: "cg", name: "CG" }] }, { id: 2, slug: "hanman", name: "韩漫" }] });
    if (p === "categories/filter") { window.__reqs.push({ path: p, c: u.searchParams.get("c"), o: u.searchParams.get("o"), page: u.searchParams.get("page") }); return json({ content: mk("CAT", 5, "作者甲"), total: 5 }); }
    if (p === "week") return json({ categories: [{ id: 11, time: "2026 W36" }, { id: 10, time: "2026 W35" }], type: [{ id: "", title: "全部" }, { id: 1, title: "同人" }] });
    if (p === "week/filter") { window.__reqs.push({ path: p, id: u.searchParams.get("id"), type: u.searchParams.get("type"), page: u.searchParams.get("page") }); return json({ list: mk("WK", 6, "作者甲"), total: 6 }); }
    if (p === "album") { window.__reqs.push({ path: p, id: u.searchParams.get("id") }); return json(detail(u.searchParams.get("id"))); }
    if (p === "comic_read") { window.__reqs.push({ path: p, id: u.searchParams.get("id") }); return json({ id: u.searchParams.get("id"), name: "读取测试", scramble_id: 0, images: [{ page: 1, image: "https://mock.jm.local/1.jpg", name: "001" }, { page: 2, image: "https://mock.jm.local/2.jpg", name: "002" }] }); }
    if (p === "forum") { window.__reqs.push({ path: p, aid: u.searchParams.get("aid") }); return json({ list: [] }); }
    if (p === "search") {
      const q = u.searchParams.get("search_query") || "";
      const type = u.searchParams.get("search_type") || "";
      const page = Number(u.searchParams.get("page") || 1);
      window.__reqs.push({ path: p, q, type, page });
      const prefix = (type === "author" ? "AU" : "TG") + q + "-p" + page + "-";
      return json({ total: 10000, content: mk(prefix, 6, q) });
    }
    window.__reqs.push({ path: p, url: u.href.slice(0, 80) });
    return json([]);
  };
})();