// JM极简版 PWA 离线壳：文档走网络优先（更新即时生效），静态资源缓存优先，API/图片不劫持
const CACHE = "jmmin-v2";
// ⚠ 离线漫画缓存的键名是 jm-offline-<话id>（见 src/core/offline.ts），
// 绝不能在这里被当成旧版本清掉——否则一次 SW 激活就抹掉用户整个离线库。
const keepCache = (name) => name === CACHE || name.startsWith("jm-offline-");
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./index.html", "./manifest.webmanifest", "./loading.svg"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !keepCache(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin !== location.origin) return; // 官方 API / 图床走网络，不缓存
  if (req.mode === "navigate") {
    // 页面文档：优先网络（拿到最新 index.html 即引用新版本资源），断网回退缓存
    e.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      });
    })
  );
});
