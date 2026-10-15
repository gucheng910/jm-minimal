import { registerPlugin } from "@capacitor/core";
import { fetchWithTimeout } from "./fetchTimeout";
import { BUILD_VARIANT, LOCAL_VERSION } from "./constants";
import { pickApkAsset, pickIpaAsset } from "./updateAsset";
import { hasPlugin, isIos, RELEASES_URL } from "./platform";
import { isSkipped } from "./appVersion";

/**
 * 安卓 / iOS 的原生更新链路（v3.16 从 `ui/UpdateSection.tsx` **原样搬过来**）。
 *
 * 搬家的唯一原因：现在有**两个入口**要用它 —— 设置页里那个手动按钮，
 * 以及"进入软件后弹出来的更新提示"。逻辑留在组件里的话，弹窗就得把它复制一遍，
 * 而这条链路是本项目最"脏"的一段（多镜像 + 45s 通道超时 + 原生插件轮询），
 * 复制两份必然分叉。所以：**逻辑收在这里，两个入口都只做渲染**。
 *
 * ── 与原实现的差异（只有两处，都是为了"被两个入口共用"）──────────────
 *   ① 状态从 React `useState` 变成模块状态 + 订阅（`subscribe`）；
 *   ② 提示语从直接 `pushToast` 变成 `onNotice` 事件 —— core 层不许 import UI。
 *      `UpdateSection` 订阅后照样弹 toast（行为与搬家前逐字一致），
 *      更新弹窗则不弹 toast（它把"改走镜像 1…"这类信息显示在自己那一行里）。
 *
 * ── 平台事实（别改错）────────────────────────────────────────────────
 *   · 只有安卓注册 `AppUpdater`；iOS/Web 下拿到的是 null；
 *   · iOS **不能**自己装 ipa（系统不允许 App 装 App），所以 iOS 的"立即更新"
 *     是把 ipa 直链交给浏览器（见 `openIpaDownload` 的说明），由 SideStore 完成安装；
 *   · 安卓的 DownloadManager **不给百分比**（插件只暴露 done/failed/fileSize），
 *     所以快照里的 `percent` 恒为 -1 —— 界面据此显示"不确定进度条"而不是假百分比。
 */

const REPO = "gucheng910/jm-minimal";
const API_URL = "https://api.github.com/repos/" + REPO + "/releases/latest";

/**
 * 下载通道：GitHub 的 release 资源在国内网络经常取不到 —— 实测小米 4W（Android 6）上
 * api.github.com 通（757ms 200），但 release 下载地址 30s 超时，DownloadManager 直接报 failed，
 * 用户看到的就是"能检查到新版本，但更新不了"。所以直连失败后按顺序换镜像。
 * 镜像只是 URL 前缀拼接（ghproxy 家族都是这个形式），下面两个在受限网络实测能取到文件。
 */
export const MIRROR_PREFIXES = ["https://ghproxy.net/", "https://gh-proxy.com/"];
/** 单通道等待上限：DownloadManager 失败一般 30s 左右返回，45s 够用又不会让用户干等 */
export const CHANNEL_TIMEOUT_MS = 45000;

export type NativeUpdPhase = "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "installing";

/**
 * 手动更新按钮的文案 —— **纯函数**。
 *
 * 为什么把它搬到这里（原来散在 `ui/UpdateSection` 的两张 `Record<phase,string>` 表 + 一个内联后缀）：
 *   · `ready`（已下载完成）阶段原来**不显示 error**（后缀只认 `idle`）—— 于是
 *     「安装失败：…」之后按钮仍然写着「下载完成，点击安装」，界面看起来像什么都没发生，
 *     用户只会反复点它。文案是状态机的一部分，就该跟状态机一起被测。
 *   · 阶段 → 文案 的映射现在只有一处，`UpdateSection` 退化成纯渲染。
 *
 * `ios` 分开传是因为 iOS 上「点击更新」不是自己下载安装，而是把 ipa 交给浏览器 ——
 * 文案必须说清楚（它是本项目唯一一处"按钮写的和做的不是一回事"的地方，所以尤其不能含糊）。
 */
export function nativeLabel(s: NativeUpdSnapshot, ios: boolean): string {
  switch (s.phase) {
    case "checking": return "检查中…";
    case "latest": return "已是最新版本";
    case "available": return ios ? "发现新版本，下载 ipa" : "发现新版本，点击更新";
    case "downloading": return "下载中…" + (s.channel ? "（" + s.channel + "）" : "");
    case "ready": return s.error ? "安装失败，点击重试" : "下载完成，点击安装";
    case "installing": return "正在安装…";
    // 「（失败，重试）」而不是「（上次失败，重试）」：抽屉只有 52vw（420px 屏上 218px），
    // 14 个字的版本会比按钮内容宽 4px，于是折成两行、把整列按钮的高度搞得不齐（实测 h=61）。
    // 少 3 个字就单行了，语义没损失。
    default: return s.error ? "检查更新（失败，重试）" : "检查更新";
  }
}

export interface NativeUpdSnapshot {
  phase: NativeUpdPhase;
  /** 最新版本号（去掉 tag 的 `v`） */
  version: string;
  /** Release 正文（作为"完整更新日志"的落地链接文案用；真正给用户看的日志是内置的） */
  notes: string;
  /** 发布页地址（Release 里没给 html_url 时用常量） */
  pageUrl: string;
  /** 安卓：本机对应包的下载地址（modern / compat 用 BUILD_VARIANT 区分） */
  assetUrl: string;
  /** iOS：ipa 直链（拿不到就退化成打开发布页） */
  ipaUrl: string;
  /** 当前尝试的通道名（"直连" / "镜像 1"…），让"卡在哪一步"可见 */
  channel: string;
  /** -1 = 未知（DownloadManager 不给百分比） */
  percent: number;
  fileSize: number;
  error: string;
}

function downloadChannels(url: string): Array<{ label: string; url: string }> {
  const list = [{ label: "直连", url: url }];
  MIRROR_PREFIXES.forEach(function (p, i) { list.push({ label: "镜像 " + (i + 1), url: p + url }); });
  return list;
}

interface UpdaterApi {
  download: (o: { url: string }) => Promise<{ ok: boolean }>;
  status: () => Promise<{ done: boolean; failed?: boolean; fileSize?: number }>;
  install: () => Promise<void>;
}
/** 只在 Android 注册；iOS / Web 下是 null（见文件头） */
const updater = hasPlugin("AppUpdater") ? registerPlugin<UpdaterApi>("AppUpdater") : null;

export function parseVersion(tag: string): number[] {
  const m = String(tag || "").replace(/^v/i, "").match(/\d+(\.\d+)*/);
  if (!m) return [];
  return m[0].split(".").map((n) => Number(n) || 0);
}
export function isNewer(latest: number[], cur: number[]): boolean {
  const len = Math.max(latest.length, cur.length);
  for (let i = 0; i < len; i++) {
    const a = latest[i] || 0;
    const b = cur[i] || 0;
    if (a !== b) return a > b;
  }
  return false;
}

// ---- 状态（模块级真值 + 订阅） ----
let snap: NativeUpdSnapshot = {
  phase: "idle", version: "", notes: "", pageUrl: RELEASES_URL, assetUrl: "", ipaUrl: "",
  channel: "", percent: -1, fileSize: 0, error: ""
};
const subs = new Set<(s: NativeUpdSnapshot) => void>();
const notices = new Set<(text: string, kind: "info" | "err") => void>();
/** 组件卸载 / 用户取消时置 false，用来打断通道轮询 */
let alive = true;
/** 读"这条链路还活着吗"。用函数而不是直接读变量：轮询循环里读的是**可变的模块状态**，
    写成 `while (alive && …)` 会被 lint 判成"循环内没有修改的条件"（它看不到别的组件在改）。 */
function isAlive(): boolean { return alive; }

function set(patch: Partial<NativeUpdSnapshot>): NativeUpdSnapshot {
  snap = { ...snap, ...patch };
  subs.forEach((cb) => { try { cb(snap); } catch { /* 订阅方自己的问题，不影响其它人 */ } });
  return snap;
}
function notice(text: string, kind: "info" | "err" = "info"): void {
  notices.forEach((cb) => { try { cb(text, kind); } catch { /* ignore */ } });
}

export const nativeUpdate = {
  get(): NativeUpdSnapshot { return snap; },
  subscribe(cb: (s: NativeUpdSnapshot) => void): () => void {
    subs.add(cb);
    return () => { subs.delete(cb); };
  },
  /** 提示语订阅（UpdateSection 拿它弹 toast；更新弹窗不订阅） */
  onNotice(cb: (text: string, kind: "info" | "err") => void): () => void {
    notices.add(cb);
    return () => { notices.delete(cb); };
  },
  /** 组件重新挂载时复位"还活着"，并让被取消的轮询彻底停下 */
  revive(): void { alive = true; },
  /**
   * 组件卸载。
   * ⚠️ **没有订阅者了才真的停** —— 更新弹窗与设置页里的手动按钮会同时用这条链路，
   * 谁先卸载都不该把对方正在跑的下载打断（"点开弹窗更新 → 顺手回设置页 → 下载停了"是 bug）。
   */
  dispose(): void { if (subs.size === 0) alive = false; },

  /**
   * 把这条链路收回 idle（版本号留着）。
   * 用户点「下次再说」/「不再提醒」之后调它 —— 否则设置页那张卡片会继续显示
   * "发现新版本，点击更新"，与用户刚刚的表达直接矛盾。
   */
  forget(): NativeUpdSnapshot {
    return set({ phase: "idle", channel: "", percent: -1 });
  },

  /**
   * 检查更新。失败时**不弹任何东西**（错误进快照，由调用方决定要不要显示）。
   *
   * ⚠️ `silent` 必须**传进这一层**，不能只在 `updateFlow.check(silent)` 里兜。
   * 原因（v3.17 修的真 bug）：设置页那个更新按钮（`ui/UpdateSection`）读的是
   * **本模块自己的快照**（`nativeUpdate.subscribe`），不是 `updateFlow` 的快照；
   * 所以"静默检查失败"的 error 只要写进这里，就会**无条件**显示成
   * 「检查更新（上次失败，重试）」——`updateFlow` 那层把它清掉也拦不住。
   * 实测现场：GitHub 不通的网络下（这个 App 的大量用户），进软件 1.5s 后的那次静默检查
   * 必然失败 ⇒ 抽屉里长期挂着"上次失败"，还把按钮撑成两行。
   *
   * 语义：**静默检查不留痕**（用户没主动问，就不该给他一个失败状态）；
   * 手动点按钮时才记 error，用户能看到"上次失败，重试"。
   */
  async check(opts: { silent?: boolean } = {}): Promise<NativeUpdSnapshot> {
    const silent = opts.silent === true;
    // 只在"正在做事"时挡住重复调用。**不能**写成 `phase !== "idle"`：
    // 那样"查到了新版本、但用户点了不再提醒（或关掉了提示）"之后，
    // 快照会永远停在 available —— 于是手动点「检查更新」什么都不做（点了没反应）。
    if (snap.phase === "checking" || snap.phase === "downloading" || snap.phase === "installing") return snap;
    set({ phase: "checking", error: "" });
    try {
      // 必须带超时：裸 fetch 在弱网下可能长期不落定，而上面 set({phase:"checking"}) 之后
      // 只有 catch 会复位 —— 一旦挂住，「检查更新」按钮就永久转圈，且不报错。
      const res = await fetchWithTimeout(API_URL, {}, 15000);
      if (!res.ok) throw new Error("http " + res.status);
      const rel = await res.json();
      const tag = String(rel.tag_name || "");
      const latest = parseVersion(tag);
      if (latest.length === 0 || !isNewer(latest, parseVersion(LOCAL_VERSION))) {
        return set({ phase: "latest", error: "" });
      }
      const assets: Array<{ name: string; browser_download_url: string }> = Array.isArray(rel.assets) ? rel.assets : [];
      const version = tag.replace(/^v/i, "");
      const pageUrl = String(rel.html_url || RELEASES_URL);
      const notes = String(rel.body || "");
      // 用户点名"不再提醒"的那个版本 → 对他而言**不算更新**，按"已是最新"收场。
      // 不这么做的话，设置页那个按钮会一直写着「发现新版本，点击更新」，
      // 点下去还会真的去下他刚拒绝过的包（e2e 的负对照就是踩到这个红过）。
      if (isSkipped(version)) {
        return set({ phase: "latest", version, pageUrl, notes, error: "" });
      }
      // iOS：只需要知道"有新版"和要下载的 ipa 地址，不挑 APK 资产
      if (isIos()) {
        const ipa = pickIpaAsset(assets);
        return set({ phase: "available", version, pageUrl, notes, ipaUrl: ipa ? ipa.browser_download_url : "", error: "" });
      }
      // 只认版本号大小；资产按「本机装的是哪个包」匹配 —— modern/compat 两个包**同名同版本**，
      // 只能靠构建期注入的 BUILD_VARIANT 区分（见 core/constants.ts + ui/updateAsset.ts 单测），
      // 否则 compat 用户会被引导下载 modern 包（老内核机型会白屏）。
      const asset = pickApkAsset(assets, BUILD_VARIANT);
      if (!asset) {
        // 找不到对应包：不是"已是最新"，但也**不能**给一个点了没反应的更新提示。
        // 静默检查里同样不留痕（同上：那是"我们自己的发布流程有问题"，不是用户的网络问题）。
        return set({ phase: "idle", version, pageUrl, notes, error: silent ? "" : "发布版里没有本机对应的安装包" });
      }
      return set({ phase: "available", version, pageUrl, notes, assetUrl: asset.browser_download_url, error: "" });
    } catch (e) {
      const msg = String(e && (e as Error).message ? (e as Error).message : e).slice(0, 120);
      // 静默检查失败：清空 error（用户没问，就不该看到红色状态）。日志留一条便于真机排查。
      if (silent && msg) console.debug("[jmd] 静默更新检查失败（不打扰用户）:", msg);
      return set({ phase: "idle", error: silent ? "" : msg });
    }
  },

  /** 走一条通道：发起下载 → 轮询到结束（失败/超时都算这条通道不通） */
  async runChannel(c: { label: string; url: string }): Promise<boolean> {
    if (!updater) return false;
    try {
      await updater.download({ url: c.url });
    } catch {
      return false;
    }
    const t0 = Date.now();
    while (isAlive() && Date.now() - t0 < CHANNEL_TIMEOUT_MS) {
      await new Promise(function (r) { window.setTimeout(r, 1000); });
      let s: { done: boolean; failed?: boolean; fileSize?: number } | null = null;
      try { s = await updater.status(); } catch { s = null; }
      if (s && typeof s.fileSize === "number" && s.fileSize > 0) set({ fileSize: s.fileSize });
      if (s && s.done) return !s.failed;
    }
    return false;
  },

  /** 下载安装包（直连 → 镜像 1 → 镜像 2）。iOS / 没有插件时走"交给浏览器"那条路 */
  async download(): Promise<NativeUpdSnapshot> {
    if (!snap.assetUrl || !updater) return set({ phase: "available" });
    set({ phase: "downloading", percent: -1, channel: "直连", error: "" });
    const channels = downloadChannels(snap.assetUrl);
    for (let i = 0; i < channels.length; i++) {
      if (!isAlive()) return snap;
      const c = channels[i];
      set({ channel: c.label });
      if (i > 0) notice("直连下载不通，改走" + c.label + "…", "info");
      if (await nativeUpdate.runChannel(c)) {
        if (!isAlive()) return snap;
        return set({ phase: "ready", channel: "", percent: 100 });
      }
    }
    if (!isAlive()) return snap;
    return set({ phase: "available", channel: "", percent: -1, error: "直连与镜像都不通" });
  },

  /** 交给系统安装器（会弹授权）；iOS 上由调用方改走 openIpaDownload */
  async install(): Promise<NativeUpdSnapshot> {
    if (!updater) return set({ phase: "available" });
    set({ phase: "installing", error: "" });
    try {
      await updater.install();
      notice("请在系统弹窗中完成安装授权", "info");
      return set({ phase: "idle" });
    } catch (e) {
      return set({ phase: "ready", error: "安装失败：" + String(e).slice(0, 80) });
    }
  }
};

/**
 * iOS：把 ipa 直链交给系统浏览器去下载。
 *
 * 为什么是「直链」而不是「打开 Release 页」：browser 打开 GitHub 的 release 页面在 iPhone 上
 * 体验很差（页面重、资产要点两下），而 ipa 直链会让 Safari 直接开始下载。
 * 下载完的文件进「下载」列表/「文件」App，**点它 iOS 会把 SideStore 列为可选打开方式**
 * （SideStore 注册了 com.apple.itunes.ipa 的 CFBundleDocumentTypes 与 ipa 的
 *  UTImportedTypeDeclarations），由 SideStore 完成安装 —— 官方 App 自己装另一个 App 是做不到的。
 */
export function iosIpaTarget(s: NativeUpdSnapshot): { url: string; text: string } {
  const target = s.ipaUrl || s.pageUrl || RELEASES_URL;
  return {
    url: target,
    text: s.ipaUrl
      ? "已打开浏览器下载 ipa；下完在「下载」或「文件」里点它，选 SideStore 安装（记得先开 LocalDevVPN）"
      : "发布版里没找到 ipa，已打开发布页，请手动下载后用 SideStore 安装"
  };
}
