// 版本与更新：从 GitHub Releases 检查新版本 → 下载 APK → 系统安装
import { Capacitor, registerPlugin } from "@capacitor/core";
import { useEffect, useRef, useState } from "react";
import { pushToast } from "./toast";

const LOCAL_VERSION = "1.0";
const REPO = "gucheng910/jm-minimal";
const API_URL = "https://api.github.com/repos/" + REPO + "/releases/latest";

type UpdState = "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "installing";

interface UpdaterApi {
  download: (o: { url: string }) => Promise<{ ok: boolean }>;
  status: () => Promise<{ done: boolean; failed?: boolean; fileSize?: number }>;
  install: () => Promise<void>;
}
const updater = registerPlugin<UpdaterApi>("AppUpdater");

function parseVersion(tag: string): number[] {
  const m = String(tag || "").replace(/^v/i, "").match(/\d+(\.\d+)*/);
  if (!m) return [];
  return m[0].split(".").map((n) => Number(n) || 0);
}
function isNewer(latest: number[], cur: number[]): boolean {
  const len = Math.max(latest.length, cur.length);
  for (let i = 0; i < len; i++) {
    const a = latest[i] || 0;
    const b = cur[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

const LABEL: Record<UpdState, string> = {
  idle: "检查更新",
  checking: "检查中…",
  latest: "已是最新版本",
  available: "发现新版本，点击更新",
  downloading: "下载中…",
  ready: "下载完成，点击安装",
  installing: "正在安装…"
};

export default function UpdateSection() {
  const [state, setState] = useState<UpdState>("idle");
  const [dlUrl, setDlUrl] = useState("");
  const pollRef = useRef<number | null>(null);
  const isNative = Capacitor.isNativePlatform();

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  async function checkUpdate() {
    if (state !== "idle") return;
    setState("checking");
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error("http " + res.status);
      const rel = await res.json();
      const tag = String(rel.tag_name || "");
      const latest = parseVersion(tag);
      if (latest.length === 0 || !isNewer(latest, parseVersion(LOCAL_VERSION))) {
        setState("latest");
        return;
      }
      const assets: Array<{ name: string; browser_download_url: string }> = Array.isArray(rel.assets) ? rel.assets : [];
      // 只认版本号大小；资产按“构建类型”匹配（构建时注入，与发行说明文字无关）
      const flavor = String((import.meta.env && import.meta.env.VITE_BUILD_VARIANT) || "modern").toLowerCase();
      const apks = assets.filter((a) => /\.apk$/i.test(a.name));
      const hit = apks.find((a) => {
        const n = a.name.toLowerCase();
        if (flavor === "compat") return n.includes("compat") || a.name.includes("兼容");
        return n.includes("modern") || a.name.includes("现代");
      });
      const asset = hit || (apks.length === 1 ? apks[0] : null);
      if (!asset) { setState("idle"); pushToast("发布版中未找到本机对应安装包（modern/compat）", "err"); return; }
      setDlUrl(asset.browser_download_url);
      setState("available");
    } catch {
      setState("idle");
      pushToast("检查更新失败（网络或暂无发布）", "err");
    }
  }

  async function startDownload() {
    if (!dlUrl) return;
    setState("downloading");
    try {
      await updater.download({ url: dlUrl });
    } catch (e) {
      setState("idle");
      pushToast("开始下载失败：" + String(e).slice(0, 80), "err");
      return;
    }
    pollRef.current = window.setInterval(async () => {
      try {
        const s = await updater.status();
        if (s.done) {
          if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
          if (s.failed) { setState("idle"); pushToast("下载失败，请重试", "err"); }
          else setState("ready");
        }
      } catch { /* 继续轮询 */ }
    }, 2000);
  }

  async function doInstall() {
    setState("installing");
    try {
      await updater.install();
      pushToast("请在系统弹窗中完成安装授权", "info");
    } catch (e) {
      pushToast("安装失败：" + String(e).slice(0, 80), "err");
    }
    setState("idle");
  }

  if (!isNative) return null;
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <button className="menu-link update-btn" disabled={state === "checking" || state === "latest" || state === "downloading" || state === "installing"} onClick={() => {
        if (state === "idle") checkUpdate();
        else if (state === "available") startDownload();
        else if (state === "ready") doInstall();
      }}>
        {LABEL[state]}
      </button>
    </div>
  );
}
