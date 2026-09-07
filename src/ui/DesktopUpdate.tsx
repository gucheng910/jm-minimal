// 桌面端更新卡（electron-updater / 便携版引导）：挂在侧边栏「版本」区
// 安装版（NSIS）：检查 → 差分下载 → 重启并安装（自动关旧版，保留数据）
// 便携版：查 GitHub 最新版 → 系统浏览器下载新便携包（自选保存位置）
import { useEffect, useState } from "react";
import { pushToast } from "./toast";
import { LOCAL_VERSION } from "../core/constants";
import { openExternal } from "../core/openExternal";
import { isDesktop } from "../core/dnsClean";

export type UpdatePhase =
  | "idle" | "checking" | "latest" | "available" | "downloading" | "downloaded" | "error";

export interface DesktopUpdateState {
  mode: "portable" | "nsis";
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion: string;
  latestNotes: string;
  assetUrl: string;
  percent: number;
  transferred: number;
  total: number;
  error: string;
}

interface UpdateBridge {
  check(): Promise<DesktopUpdateState>;
  act(): Promise<DesktopUpdateState>;
  onState(cb: (s: DesktopUpdateState) => void): () => void;
}
declare global {
  interface Window { jmUpdate?: UpdateBridge }
}

const REPO = "https://github.com/gucheng910/jm-minimal";
const RELEASES_URL = REPO + "/releases/latest";

function fmtBytes(n: number): string {
  if (!(n > 0)) return "0 B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

export default function DesktopUpdate() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const bridge: UpdateBridge | null = isDesktop && window.jmUpdate ? window.jmUpdate : null;

  // 只订阅状态推送（异步进度/下载完成）；检查动作由用户点击触发
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const off = bridge.onState((s) => { if (alive) setState(s); });
    return () => { alive = false; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!bridge) return null;
  const phase = state?.phase || "idle";
  const nsis = !state || state.mode === "nsis";

  async function doCheck() {
    if (busy || !bridge) return;
    setBusy(true);
    try {
      const s = await bridge.check();
      setState(s);
      if (s.phase === "available") {
        pushToast("发现新版本 v" + s.latestVersion + (s.mode === "portable" ? "，点「去下载」" : "，开始自动下载"), "info");
      }
    } catch {
      pushToast("检查更新失败", "err");
    } finally {
      setBusy(false);
    }
  }

  async function doAct() {
    if (busy || !bridge) return;
    setBusy(true);
    try {
      const s = await bridge.act();
      setState(s);
      if (s.mode === "nsis" && s.phase === "downloaded") {
        // quitAndInstall 即将退出，无需更多提示
      }
      if (s.mode === "portable" && s.phase === "available") {
        // 已打开系统浏览器下载
      }
    } catch {
      pushToast("操作失败", "err");
    } finally {
      setBusy(false);
    }
  }

  const label: Record<string, string> = {
    idle: nsis ? "检查更新" : "检查更新（便携版）",
    checking: "检查中…",
    latest: "已是最新版本",
    available: nsis ? "发现新版本 v" + (state?.latestVersion || "") : "发现新版本 v" + (state?.latestVersion || ""),
    downloading: "下载更新 " + (state?.percent ?? 0) + "%",
    downloaded: "重启并安装 v" + (state?.latestVersion || ""),
    error: "重试检查"
  };

  const canCheck = !busy && phase !== "checking" && phase !== "downloading";
  const downloading = phase === "downloading";
  const downloaded = phase === "downloaded";

  return (
    <div className="update-desktop">
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {downloaded ? (
          <button className="menu-link update-btn" disabled={busy} onClick={doAct}>⚡ {label.downloaded}</button>
        ) : (
          <button className="menu-link update-btn" disabled={!canCheck} onClick={doCheck}>
            {phase === "error" ? label.error : label[phase] || "检查更新"}
          </button>
        )}
        {!nsis && phase === "available" && !downloading && (
          <button className="menu-link" disabled={busy} onClick={doAct}>去下载</button>
        )}
        {!nsis && (
          <button className="menu-link" onClick={() => openExternal(RELEASES_URL)}>发布页 ↗</button>
        )}
      </div>
      {nsis && phase === "available" && state?.latestVersion && (
        <p className="muted menu-note">
          发现新版 v{state.latestVersion}（当前 v{LOCAL_VERSION}），正在自动下载，完成后点击安装即可
        </p>
      )}
      {downloading && state && (
        <div className="update-progress">
          <div className="update-progress-bar">
            <div className="update-progress-fill" style={{ width: Math.min(100, state.percent || 0) + "%" }} />
          </div>
          <span className="muted mono-num">
            {fmtBytes(state.transferred)} / {fmtBytes(state.total)}
          </span>
        </div>
      )}
      {downloaded && (
        <p className="muted menu-note">更新已就绪：点击「重启并安装」将关闭当前程序并自动安装（漫画缓存与设置保留）</p>
      )}
      {phase === "error" && (
        <div className="menu-note">
          <p className="err small-err">{state?.error || "更新失败"}</p>
          <button className="menu-link" onClick={() => openExternal(RELEASES_URL)}>去发布页手动下载 ↗</button>
        </div>
      )}
    </div>
  );
}
