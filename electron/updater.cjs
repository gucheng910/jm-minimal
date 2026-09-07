// JMClient 桌面端更新器（electron-updater）
// NSIS 安装版：GitHub feed 差分自动更新（检测→下载→退出旧版→静默安装，保留用户数据与安装目录）
// 便携版：无自动更新能力 → 检查 GitHub 最新版并引导去下载新便携包
"use strict";

const { app, shell } = require("electron");
const path = require("path");

const GH_API = "https://api.github.com/repos/gucheng910/jm-minimal/releases/latest";
const FETCH_TIMEOUT_MS = 10000;

const isPortable =
  Boolean(process.env.PORTABLE_EXECUTABLE_FILE) ||
  /portable/i.test(path.basename(process.execPath || ""));

let autoUpdater = null;
if (!isPortable) {
  try { autoUpdater = require("electron-updater").autoUpdater; } catch { autoUpdater = null; }
}

function parseVersion(tag) {
  const m = String(tag || "").replace(/^v/i, "").match(/\d+(\.\d+)*/);
  if (!m) return [];
  return m[0].split(".").map((n) => Number(n) || 0);
}
function isNewer(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function createDesktopUpdater(options) {
  const o = options || {};
  const send = typeof o.onState === "function" ? o.onState : () => {};

  let phase = "idle"; // idle|checking|latest|available|downloading|downloaded|error
  let latestVersion = "";
  let latestNotes = "";
  let assetUrl = "";
  let percent = 0;
  let transferred = 0;
  let total = 0;
  let error = "";
  let busy = false;

  const state = () => ({
    mode: isPortable ? "portable" : "nsis",
    phase,
    currentVersion: app.getVersion(),
    latestVersion,
    latestNotes,
    assetUrl,
    percent,
    transferred,
    total,
    error
  });
  const push = () => { try { send(state()); } catch { /* ignore */ } };

  if (autoUpdater) {
    // 覆盖更新源（测试 / 国内镜像用）；默认读打包时生成的 app-update.yml（GitHub）
    if (o.feedUrl) {
      try { autoUpdater.setFeedURL({ provider: "generic", url: o.feedUrl }); } catch { /* ignore */ }
    }
    autoUpdater.autoDownload = true;           // 有新版本自动后台下载（差分）
    autoUpdater.autoInstallOnAppQuit = true;   // 下载完成后，用户正常退出时自动安装
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
      info: () => {},
      warn: (m) => { if (/error|fail/i.test(String(m))) console.warn("[updater]", m); },
      error: (m) => console.error("[updater]", m),
      debug: () => {}
    };
    autoUpdater.on("checking-for-update", () => { phase = "checking"; error = ""; push(); });
    autoUpdater.on("update-available", (info) => {
      phase = "available";
      latestVersion = String(info && info.version ? info.version : "");
      error = "";
      push();
    });
    autoUpdater.on("update-not-available", () => {
      phase = "latest";
      latestVersion = "";
      error = "";
      push();
    });
    autoUpdater.on("download-progress", (p) => {
      phase = "downloading";
      percent = Math.round(Number(p && p.percent) || 0);
      transferred = Number(p && p.transferred) || 0;
      total = Number(p && p.total) || 0;
      error = "";
      push();
    });
    autoUpdater.on("update-downloaded", (info) => {
      phase = "downloaded";
      latestVersion = String((info && info.version) || latestVersion);
      percent = 100;
      error = "";
      push();
    });
    autoUpdater.on("error", (e) => {
      const msg = e && e.message ? e.message : String(e);
      phase = "error";
      error = friendlyError(msg);
      push();
    });
  }

  function friendlyError(msg) {
    if (!msg) return "更新失败，请重试";
    if (/Cannot find (latest\.yml|app-update\.yml)|404/i.test(msg)) {
      return "更新源缺少元数据（latest.yml），请稍后再试或到发布页手动下载";
    }
    if (/network|ENOTFOUND|ECONNREFUSED|timed? ?out|ETIMEDOUT|getaddrinfo/i.test(msg)) {
      return "网络连接失败：无法访问更新服务器（GitHub 偶发不可达），可稍后重试或手动下载";
    }
    if (/sha512|integrity|checksum/i.test(msg)) return "更新包校验失败，请重试";
    return msg.slice(0, 160);
  }

  async function fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "jm-minimal/" + app.getVersion(), Accept: "application/vnd.github+json" },
        signal: ctrl.signal
      });
      if (!resp.ok) throw new Error("http " + resp.status);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 便携版：仅查版本，下载走系统浏览器（用户自选保存位置） */
  async function checkPortable() {
    phase = "checking";
    error = "";
    push();
    try {
      const rel = await fetchJson(GH_API);
      const tag = String(rel.tag_name || "");
      latestVersion = tag.replace(/^v/i, "");
      latestNotes = String(rel.name || tag || "");
      if (isNewer(parseVersion(tag), parseVersion(app.getVersion()))) {
        const assets = Array.isArray(rel.assets) ? rel.assets : [];
        const hit = assets.find((a) => /\.exe$/i.test(a.name) && /portable/i.test(a.name)) ||
          assets.find((a) => /\.exe$/i.test(a.name));
        assetUrl = hit ? String(hit.browser_download_url || "") : String(rel.html_url || "");
        phase = "available";
      } else {
        assetUrl = "";
        phase = "latest";
      }
      push();
    } catch (e) {
      phase = "error";
      error = "检查更新失败：" + friendlyError(e && e.message ? e.message : String(e));
      push();
    }
  }

  async function checkNsis() {
    phase = "checking";
    error = "";
    push();
    if (!autoUpdater) {
      phase = "error";
      error = "当前环境不支持自动更新（组件缺失）";
      push();
      return;
    }
    if (!app.isPackaged) {
      phase = "error";
      error = "开发模式（未打包）无法检查更新，请运行安装版";
      push();
      return;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      phase = "error";
      error = friendlyError(e && e.message ? e.message : String(e));
      push();
    }
  }

  return {
    isPortable,
    getState: state,
    async check() {
      if (busy) return state();
      busy = true;
      try {
        if (isPortable) await checkPortable();
        else await checkNsis();
      } finally {
        busy = false;
      }
      return state();
    },
    async act() {
      // 依据当前状态执行主动作：nsis 下载完成→退出并安装；便携版→系统浏览器下载
      if (!isPortable && autoUpdater && phase === "downloaded") {
        try { autoUpdater.quitAndInstall(false, true); } catch { /* ignore */ }
        return state();
      }
      if (isPortable && phase === "available" && assetUrl) {
        try { await shell.openExternal(assetUrl); } catch { /* ignore */ }
        phase = "idle";
        push();
      }
      return state();
    }
  };
}

module.exports = { createDesktopUpdater, isPortable };
