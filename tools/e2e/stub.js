(() => {
  const HOST = "mock.jm.local";
  try {
    localStorage.setItem("jmclient.hostcfg.v1", JSON.stringify({ ts: Date.now(), cfg: { Setting: [HOST], Server: [HOST], jm3_Server: [[HOST, "線路1"]] } }));
    localStorage.setItem("jmclient.autoSelect.v1", JSON.stringify({ host: HOST, shunt: "1", ts: Date.now() }));
    localStorage.setItem("jmclient.tosAccepted.v1", "1");
    localStorage.setItem("jmclient.theme", "light");
    // ?e2eauth=1：种一个「有 token 但本地有效期已过」的会话，用于验证登录态判据一致性
    if (location.search.includes("e2eauth=1")) {
      localStorage.setItem("jwttoken", JSON.stringify("stale-token"));
      localStorage.setItem("memberInfo", JSON.stringify({ uid: 7, username: "旧资料", coin: 1 }));
      localStorage.setItem("authExpiry", String(Date.now() - 60000));
      localStorage.setItem("memberAccount", JSON.stringify({ username: "tester", password: "pw" }));
    }
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
  // 连载桩：真实接口里「话级 payload 的 author/description 为空」，书级（id = series_id）才有
  const SERIES_BOOK = "900001";
  const SERIES_CHAPTERS = [{ id: "900001", name: "", sort: "1" }, { id: "900002", name: "第2话", sort: "2" }, { id: "900003", name: "第3话", sort: "3" }];
  const isSeriesId = (id) => /^90000[123]$/.test(String(id));
  const seriesDetail = (id) => {
    const isBook = String(id) === SERIES_BOOK;
    const ch = SERIES_CHAPTERS.find((c) => c.id === String(id));
    return {
      id, name: isBook ? "连载书A" : "连载书A-" + (ch ? ch.name : ""),
      author: isBook ? ["作者甲", "作者乙"] : [],
      tags: isBook ? ["韩漫", "完结", "巨乳"] : ["巨乳"],
      description: isBook ? "连载简介文本" : "",
      actors: [], related_list: [], total_photos: isBook ? 5905 : 47,
      series: SERIES_CHAPTERS, series_id: SERIES_BOOK, price: "", purchased: false
    };
  };
  const detail = (id) => ({ id, name: "详情" + id, author: ["作者甲", "作者乙"], tags: ["巨乳", "無修正", "中文"], actors: ["登场甲", "登场乙"], related_list: mk("REL", 3, "作者甲"), total_photos: 42, description: "简介文本", series: [], price: "", purchased: false });
  const json = (data) => new Response(JSON.stringify({ code: 200, data }), { status: 200, headers: { "content-type": "application/json" } });
  // 1x1 PNG：缓存中心/阅读器会真实 fetch 图片，桩必须给回可缓存响应（cachePage 要求 resp.ok）
  const PNG = (() => {
    const b = atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==");
    const a = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return a;
  })();
  const img = () => new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });

  // ?e2ecache=1：预置「已缓存 2 话的连载书」——localStorage 队列 + IndexedDB 元数据 + Cache API 图片
  // 必须在 App 模块初始化前写入（cacheTasks 在模块顶层读 localStorage）
  if (location.search.includes("e2ecache=1")) {
    const BOOK = SERIES_BOOK;
    const pages = (n) => Array.from({ length: n }, (_, i) => ({
      page: i + 1, image: "https://mock.jm.local/media/photos/" + BOOK + "/" + String(i + 1).padStart(3, "0") + ".webp?v=1",
      name: String(i + 1).padStart(3, "0")
    }));
    try {
      localStorage.setItem("jmclient.cacheTasks.v2", JSON.stringify([
        { id: "900001", bookId: BOOK, title: "连载书A", chapterName: "", sort: 1, author: "作者甲/作者乙", category: "韩漫", cover: "https://mock.jm.local/media/albums/900001_3x4.jpg?v=1", scrambleId: 0, total: 4, done: 4, status: "done", error: "", updatedAt: Date.now() },
        { id: "900002", bookId: BOOK, title: "连载书A", chapterName: "第2话", sort: 2, author: "作者甲/作者乙", category: "韩漫", cover: "", scrambleId: 0, total: 4, done: 4, status: "done", error: "", updatedAt: Date.now() - 1000 }
      ]));
      localStorage.setItem("jmclient.seriesMap.v1", JSON.stringify({ "900001": BOOK, "900002": BOOK, "900003": BOOK }));
    } catch (e) {}
    window.__seedDone = (async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open("jm-offline", 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains("books")) d.createObjectStore("books", { keyPath: "bookId" });
          if (!d.objectStoreNames.contains("chapters")) d.createObjectStore("chapters", { keyPath: "chapterId" }).createIndex("bookId", "bookId");
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const put = (store, val) => new Promise((res, rej) => {
        const t = db.transaction(store, "readwrite");
        t.objectStore(store).put(val);
        t.oncomplete = () => res(true);
        t.onerror = () => rej(t.error);
      });
      await put("books", {
        bookId: BOOK, name: "连载书A", author: ["作者甲", "作者乙"], tags: ["韩漫", "完结"],
        description: "连载简介文本", cover: "https://mock.jm.local/media/albums/900001_3x4.jpg?v=1",
        chapters: SERIES_CHAPTERS.map((c) => ({ id: c.id, name: c.name, sort: Number(c.sort) })), updatedAt: Date.now()
      });
      for (const id of ["900001", "900002"]) {
        const ch = SERIES_CHAPTERS.find((c) => c.id === id);
        await put("chapters", {
          chapterId: id, bookId: BOOK, name: ch.name, sort: Number(ch.sort), scrambleId: 0,
          total: 4, pages: pages(4), cachedAt: Date.now()
        });
        const c = await caches.open("jm-offline-" + id);
        for (const p of pages(4)) await c.put(p.image, img());
        await c.put("https://mock.jm.local/media/albums/900001_3x4.jpg?v=1_cover_", img());
      }
      return true;
    })();
  }

  window.fetch = async (input) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const u = new URL(url, location.href);
    const p = u.pathname.replace(/^\//, "");
    // 图片：图源1 的图床刻意慢 300ms，用于验证「更快的源」自动选中更快的那一个
    if (/\.(jpg|jpeg|png|webp)$/i.test(u.pathname)) {
      if (u.hostname.startsWith("mock-img1")) await new Promise((r) => setTimeout(r, 300));
      return img();
    }
    if (p === "setting") {
      const shunt = u.searchParams.get("app_img_shunt") || "";
      const host = shunt === "1" ? "mock-img1.jm.local" : shunt === "2" ? "mock-img2.jm.local" : "";
      return json({ version: "1", test_version: "1", jm3_version: "2.1.6", ipcountry: "CN", ad_cache_version: 1, float_ad: false, is_cn: 1, cn_base_url: "", base_url: "", main_web_host: "", img_host: host, app_shunts: [{ key: "1", title: "图源1" }, { key: "2", title: "图源2" }] });
    }
    if (p === "random_recommend") { window.__reqs.push({ path: p }); return json(mk("A", 8, "作者甲")); }
    if (p === "hot_tags") return json(["热词1", "热词2"]);
    if (p === "login") { window.__reqs.push({ path: p }); return json({ jwttoken: "fresh-token", uid: 7, username: "tester", coin: 42, level: 3, exp: 100 }); }
    if (p === "tasks" || p === "daily") { window.__reqs.push({ path: p }); return json({ list: [] }); }
    if (p === "payment") return json({ plans: [{ key: "p1", name: "月卡", price: 1, days: 30 }], pay_methods: [], uid: 1, orders: [], web_host: "", checkout: "" });
    if (p === "ad_content_all") return json({});
    if (p === "categories") return json({ categories: [{ id: 1, slug: "doujin", name: "同人", sub_categories: [{ id: 11, slug: "cg", name: "CG" }] }, { id: 2, slug: "hanman", name: "韩漫" }] });
    if (p === "categories/filter") { window.__reqs.push({ path: p, c: u.searchParams.get("c"), o: u.searchParams.get("o"), page: u.searchParams.get("page") }); return json({ content: mk("CAT", 5, "作者甲"), total: 5 }); }
    if (p === "week") return json({ categories: [{ id: 11, time: "2026 W36" }, { id: 10, time: "2026 W35" }], type: [{ id: "", title: "全部" }, { id: 1, title: "同人" }] });
    if (p === "week/filter") { window.__reqs.push({ path: p, id: u.searchParams.get("id"), type: u.searchParams.get("type"), page: u.searchParams.get("page") }); return json({ list: mk("WK", 6, "作者甲"), total: 6 }); }
    if (p === "album") {
      const id = u.searchParams.get("id");
      window.__reqs.push({ path: p, id });
      return json(isSeriesId(id) ? seriesDetail(id) : detail(id));
    }
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
