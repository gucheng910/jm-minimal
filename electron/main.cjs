// JM极简版 PC 壳（Electron）：本地静态服务加载 dist
const { app, BrowserWindow, shell, session, ipcMain } = require("electron");
const { createDnsCleaner } = require("./dns-clean.cjs");
const { createDesktopUpdater } = require("./updater.cjs");
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

    // ---- 内置 DNS 清洗（PC 端免配置 DoT）----
    // 全量流量走本地透传代理：清洗域名池内走 DoH 解析，其余域名系统 DNS 直连透传（无 MITM）
    let cleaner = null;
    cleaner = await createDnsCleaner({
      applyProxy: () => session.defaultSession.setProxy({
        mode: "fixed_servers",
        proxyRules: "http=127.0.0.1:" + cleaner.getState().port + ";https=127.0.0.1:" + cleaner.getState().port,
        proxyBypassRules: "127.0.0.1,localhost,<local>"
      }),
      clearProxy: () => session.defaultSession.setProxy({ mode: "system" }),
      onStatus: (st) => {
        if (!win.isDestroyed()) { try { win.webContents.send("jm:dns-status", st); } catch { /* ignore */ } }
      }
    });
    ipcMain.handle("jm:dns:set", (_ev, enabled) => cleaner.setEnabled(Boolean(enabled)));
    ipcMain.handle("jm:dns:get", () => cleaner.getState());
    ipcMain.on("jm:dns:sync", (_ev, roots) => { void cleaner.syncDomains(Array.isArray(roots) ? roots : []); });
    global.__jmDnsCleaner = cleaner; // 生命周期与主进程一致

    // ---- 桌面端更新（NSIS 自动更新 / 便携版引导下载）----
    const desktopUpdater = createDesktopUpdater({
      feedUrl: process.env.JM_UPDATE_FEED || "",
      onState: (st) => {
        if (!win.isDestroyed()) { try { win.webContents.send("jm:update-state", st); } catch { /* ignore */ } }
      }
    });
    ipcMain.handle("jm:update:check", () => desktopUpdater.check());
    ipcMain.handle("jm:update:act", () => desktopUpdater.act());
    global.__jmUpdater = desktopUpdater;

    await win.loadURL("http://127.0.0.1:" + port + "/");
  });
  app.on("second-instance", () => { /* 单实例即可 */ });
  app.on("window-all-closed", () => { app.quit(); });
}
