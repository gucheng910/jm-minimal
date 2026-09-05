// JM极简版 PC 壳（Electron）：本地静态服务加载 dist
const { app, BrowserWindow, shell } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");

const DIST = path.join(__dirname, "..", "dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

function startServer(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const file = path.normalize(path.join(DIST, rel));
      if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) {
          // SPA 回退到 index.html
          fs.readFile(path.join(DIST, "index.html"), (e2, d2) => {
            if (e2) { res.writeHead(404); res.end("not found"); }
            else { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(d2); }
          });
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
        res.end(data);
      });
    });
    srv.on("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let server = null;
  app.whenReady().then(async () => {
    // 固定端口，占用则顺延
    for (let p = 17932; p < 17952; p++) {
      try { server = await startServer(p); break; } catch { /* try next */ }
    }
    if (!server) { console.error("无法启动本地服务"); app.quit(); return; }
    const port = server.address().port;
    const win = new BrowserWindow({
      width: 1180,
      height: 860,
      minWidth: 420,
      minHeight: 680,
      title: "JM极简版",
      icon: path.join(__dirname, "..", "build", "icon.png"),
      backgroundColor: "#f4f5f7",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        // 官方接口/图床为多域名且未按桌面环境放行 CORS；禁用同源限制以兼容（仅加载本地壳+官方数据）
        webSecurity: false
      }
    });
    win.setMenuBarVisibility(false);
    // 外链（官方 checkout 等）交给系统浏览器
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      if (!url.startsWith("http://127.0.0.1:" + port)) { e.preventDefault(); shell.openExternal(url); }
    });
    await win.loadURL("http://127.0.0.1:" + port + "/");
  });
  app.on("second-instance", () => { /* 单实例即可 */ });
  app.on("window-all-closed", () => { app.quit(); });
}
