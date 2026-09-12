// 版本与更新：从 GitHub Releases 检查新版本 → 下载 APK → 系统安装
import { Capacitor, registerPlugin } from "@capacitor/core";
import { useEffect, useRef, useState } from "react";
import { pushToast } from "./toast";
import { BUILD_VARIANT, LOCAL_VERSION } from "../core/constants";
import { pickApkAsset } from "./updateAsset";
const REPO = "gucheng910/jm-minimal";
const API_URL = "https://api.github.com/repos/" + REPO + "/releases/latest";

/**
 * 下载通道：GitHub 的 release 资源在国内网络经常取不到 —— 实测小米 4W（Android 6）上
 * api.github.com 通（757ms 200），但 release 下载地址 30s 超时，DownloadManager 直接报 failed，
 * 用户看到的就是"能检查到新版本，但更新不了"。所以直连失败后按顺序换镜像。
 * 镜像只是 URL 前缀拼接（ghproxy 家族都是这个形式），下面两个在受限网络实测能取到文件。
 */
const MIRROR_PREFIXES = ["https://ghproxy.net/", "https://gh-proxy.com/"];
/** 单通道等待上限：DownloadManager 失败一般 30s 左右返回，45s 够用又不会让用户干等 */
const CHANNEL_TIMEOUT_MS = 45000;

function downloadChannels(url: string): Array<{ label: string; url: string }> {
  const list = [{ label: "直连", url: url }];
  MIRROR_PREFIXES.forEach(function (p, i) { list.push({ label: "镜像 " + (i + 1), url: p + url }); });
  return list;
}

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
  /** 当前正在尝试的下载通道（显示在按钮上，让"卡在哪一步"可见） */
  const [channel, setChannel] = useState("");
  const aliveRef = useRef(true);
  const isNative = Capacitor.isNativePlatform();

  useEffect(() => () => { aliveRef.current = false; }, []);

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
      // 只认版本号大小；资产按「本机装的是哪个包」匹配 —— modern/compat 两个包**同名同版本**，
      // 只能靠构建期注入的 BUILD_VARIANT 区分（见 core/constants.ts + ui/updateAsset.ts 单测），
      // 否则 compat 用户会被引导下载 modern 包（老内核机型会白屏）。
      const asset = pickApkAsset(assets, BUILD_VARIANT);
      if (!asset) { setState("idle"); pushToast("发布版中未找到本机对应安装包（modern/compat）", "err"); return; }
      setDlUrl(asset.browser_download_url);
      setState("available");
    } catch {
      setState("idle");
      pushToast("检查更新失败（网络或暂无发布）", "err");
    }
  }

  /** 走一条通道：发起下载 → 轮询到结束（失败/超时都算这条通道不通） */
  async function runChannel(c: { label: string; url: string }): Promise<boolean> {
    try {
      await updater.download({ url: c.url });
    } catch {
      return false;
    }
    const t0 = Date.now();
    while (aliveRef.current && Date.now() - t0 < CHANNEL_TIMEOUT_MS) {
      await new Promise(function (r) { window.setTimeout(r, 1000); });
      let s: { done: boolean; failed?: boolean } | null = null;
      try { s = await updater.status(); } catch { s = null; }
      if (s && s.done) return !s.failed;
    }
    return false;
  }

  async function startDownload() {
    if (!dlUrl) return;
    setState("downloading");
    const channels = downloadChannels(dlUrl);
    for (let i = 0; i < channels.length; i++) {
      if (!aliveRef.current) return;
      const c = channels[i];
      setChannel(c.label);
      if (i > 0) pushToast("直连下载不通，改走" + c.label + "…", "info");
      if (await runChannel(c)) {
        if (!aliveRef.current) return;
        setChannel("");
        setState("ready");
        return;
      }
    }
    if (!aliveRef.current) return;
    setChannel("");
    setState("idle");
    pushToast("下载失败：直连与镜像都不通，可到 GitHub 发行页手动下载", "err");
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
        {LABEL[state] + (state === "downloading" && channel ? "（" + channel + "）" : "")}
      </button>
    </div>
  );
}
