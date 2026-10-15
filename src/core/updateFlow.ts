import { emit, on } from "./bus";
import { LOCAL_VERSION } from "./constants";
import { isSkipped, loadSkipVersion, markCheckedAt, shouldAutoCheck, skipVersion } from "./appVersion";
import { iosIpaTarget, nativeUpdate } from "./updateAndroid";
import { openExternal } from "./openExternal";
import { isDesktop } from "./dnsClean";
import { isIos } from "./platform";

/**
 * 更新流程（v3.16）：**两端（桌面 / 安卓）合成一个状态机**，上层只认这一个快照。
 *
 * ── 这一层负责的其实是**策略**，不是下载 ────────────────────────────
 * 真正的下载/安装早就有两条成熟链路（`electron/updater.cjs` 的差分自动更新、
 * `core/updateAndroid.ts` 的多镜像 + AppUpdater）。以前缺的是"**什么时候提示、提示什么、怎么记住**"，
 * 所以这里只管四件事：
 *   ① **静默检查**：节流（距上次 ≥6h）+ 每次启动只一次 + **失败绝不提示**；
 *   ② **不再提醒**：只写"跳过的版本号"（等值比较 → 只跳这一个版本）；
 *   ③ **主按钮语义**：下载 / 下载中 / 安装，按阶段切换（出处见文件末尾的参考清单）；
 *   ④ 把两端的差异（便携版与 iOS 只能引导下载、安卓没有百分比）如实暴露成 `kind` 与 `percent`，
 *      让界面**不去猜**平台。
 *
 * ── 参考 ────────────────────────────────────────────────────────────
 * · BiliPai `AppUpdateDialogHost.kt` 的主按钮状态机：
 *   `COMPLETED→安装更新 / QUEUED→等待下载 / DOWNLOADING→下载中 / !hasAsset→前往下载 / else→下载更新`
 *   （我们多一档 `opensBrowser`：便携版 / iOS 交给系统浏览器，按钮必须是"前往下载"而不是"下载更新"，
 *    否则用户点完以为在下载、其实什么都没发生）
 * · fluxdo `aboutUpdate_zh.arb` 的文案：发现新版本 / 立即更新 / 不再提醒 / 更新内容。
 */

export type UpdKind = "desktop" | "native" | "none";
export type UpdPhase = "idle" | "checking" | "latest" | "available" | "downloading" | "downloaded" | "installing" | "error";

export interface UpdSnapshot {
  kind: UpdKind;
  phase: UpdPhase;
  currentVersion: string;
  latestVersion: string;
  /**
   * 发布说明（GitHub Release 正文）。
   * ⚠️ 它**不是**"更新日志弹窗"的数据源（那个是内置的 `core/changelog.ts`，离线可用）——
   * 这里只给"发现新版本"弹窗补一段"这一版都改了什么"的正文，拿不到就整段不渲染。
   */
  notes: string;
  /** -1 = 未知（安卓的 DownloadManager 只给 done/failed，没有百分比） */
  percent: number;
  transferred: number;
  total: number;
  /** 当前通道名（安卓的"直连 / 镜像 1"）；桌面为空 */
  channel: string;
  error: string;
  /** 下载完成后能不能自己装：便携版与 iOS 做不到（只能引导用户去装） */
  canSelfInstall: boolean;
  /** "立即更新"实际是打开浏览器而不是自己下载 */
  opensBrowser: boolean;
}

/** 桌面 IPC 的载荷（`electron/updater.cjs` 推上来的那份；这里定义一次，别处都引它） */
export interface DesktopUpdatePayload {
  mode: "portable" | "nsis";
  phase: "idle" | "checking" | "latest" | "available" | "downloading" | "downloaded" | "error";
  currentVersion: string;
  latestVersion: string;
  latestNotes: string;
  assetUrl: string;
  percent: number;
  transferred: number;
  total: number;
  error: string;
}
export interface DesktopBridge {
  check(): Promise<DesktopUpdatePayload>;
  act(): Promise<DesktopUpdatePayload>;
  reveal?(): Promise<{ ok: boolean; file?: string }>;
  onState(cb: (s: DesktopUpdatePayload) => void): () => void;
}
declare global {
  interface Window { jmUpdate?: DesktopBridge }
}

// ────────────────────────────────────────────────
// 纯函数（单测就钉这几条）
// ────────────────────────────────────────────────

/** 桌面 IPC 的阶段 → 本层阶段（名字几乎一样，单独写一遍是为了"能单测映射"而不是靠 string 巧合） */
export function phaseOfDesktop(p: DesktopUpdatePayload["phase"]): UpdPhase {
  if (p === "available") return "available";
  if (p === "downloading") return "downloading";
  if (p === "downloaded") return "downloaded";
  if (p === "checking") return "checking";
  if (p === "latest") return "latest";
  if (p === "error") return "error";
  return "idle";
}

/** 原生链路的阶段 → 本层阶段 */
export function phaseOfNative(p: "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "installing"): UpdPhase {
  if (p === "ready") return "downloaded";
  if (p === "installing") return "installing";
  return p;
}

/**
 * 主按钮文案。
 * ⚠️ `opensBrowser` 优先于 `available`：便携版 / iOS 上点"立即更新"是**开浏览器**，
 * 按钮写"下载更新"会让人以为程序在后台下（它没有）。
 */
export function primaryLabel(s: UpdSnapshot): string {
  if (s.phase === "installing") return "正在安装…";
  if (s.phase === "downloaded") return s.canSelfInstall ? "立即安装" : "前往安装";
  if (s.phase === "downloading") return s.percent >= 0 ? "下载中 " + s.percent + "%" : "下载中…";
  if (s.phase === "available") return s.opensBrowser ? "前往下载" : "立即更新";
  if (s.phase === "checking") return "检查中…";
  return "立即更新";
}

/** 副标题（状态行）：下载中显示进度/通道，完成显示"可以安装" */
export function statusText(s: UpdSnapshot): string {
  if (s.phase === "downloading") {
    const pct = s.percent >= 0 ? s.percent + "%" : "下载中";
    return s.channel ? "正在下载 · " + pct + "（" + s.channel + "）" : "正在下载 · " + pct;
  }
  if (s.phase === "downloaded") return s.canSelfInstall ? "下载完成，可以安装" : "已打开下载页，装好后回来即可";
  if (s.phase === "installing") return "正在交给系统安装…";
  if (s.phase === "available") return s.opensBrowser ? "新版安装包需要在浏览器里下载" : "可以现在更新，也可以稍后再说";
  if (s.phase === "error") return s.error || "更新失败，可稍后重试";
  return "";
}

/**
 * 要不要把"发现新版本"这个弹窗摆出来。
 * 三条同时成立：① 阶段是 available / downloaded；② 有版本号；③ **没被"不再提醒"跳过**。
 *
 * ⚠️ `skipped` 的默认值是 **null = "去读存储"**，不是 `""`。
 * 早先写成 `skipped = ""` 时踩过一次：界面不传这个参数，于是 `isSkipped(v, "")`
 * 恒为 false —— "不再提醒"点完照样弹（e2e 的负对照当场变红）。
 * 测试要注入时显式传字符串；界面/生产代码不传。
 */
export function shouldPrompt(s: UpdSnapshot, skipped: string | null = null): boolean {
  if (s.phase !== "available" && s.phase !== "downloaded") return false;
  if (!s.latestVersion) return false;
  const skip = skipped === null ? loadSkipVersion() : skipped;
  return !isSkipped(s.latestVersion, skip);
}

/**
 * 把"被「不再提醒」跳过的那个版本"从 `available` 降级成 `latest`。
 *
 * 为什么必须降级：用户点了「不再提醒」，意思就是"**这个版本对我来说不算更新**"。
 * 不降级的话快照会停在 `available`，于是设置页那个按钮会一直显示
 * 「发现新版本，点击更新」—— 点了还会真的去下他刚拒绝过的包；
 * 而"检查完发现没有可更新的"这句话才是诚实的。
 * ⚠️ 只影响这一个版本（等值比较）：更高的版本照样进 `available` 并弹提示。
 */
function skippedIsNotAnUpdate(phase: UpdPhase, version: string): UpdPhase {
  return phase === "available" && version && isSkipped(version) ? "latest" : phase;
}

/** 「立即更新」要不要自己下载（安卓/桌面安装版：要；便携版与 iOS：交给浏览器） */
export function opensBrowserFor(mode: "portable" | "nsis" | "android" | "ios" | "web"): boolean {
  return mode === "portable" || mode === "ios" || mode === "web";
}

// ────────────────────────────────────────────────
// 状态与动作
// ────────────────────────────────────────────────
function baseSnapshot(): UpdSnapshot {
  const desktop = isDesktop && !!window.jmUpdate;
  return {
    kind: desktop ? "desktop" : "native",
    phase: "idle",
    currentVersion: LOCAL_VERSION,
    latestVersion: "",
    notes: "",
    percent: -1,
    transferred: 0,
    total: 0,
    channel: "",
    error: "",
    /**
     * ⚠️ 桌面的 `portable / nsis` **不挂在 bridge 上**（它在每次 check/act 的返回值里），
     * 所以这里只能先假设安装版。这不是"猜"：更新提示只可能在一次 check **之后**出现，
     * 那时 `applyDesktop()` 已经把真实的 mode 写进来了；在此之前这两个字段没人看。
     */
    canSelfInstall: true,
    opensBrowser: false
  };
}

/** 把一次桌面的 IPC 返回值并进快照（check / act / onState 三处共用，避免三份映射漂移） */
function applyDesktop(s: DesktopUpdatePayload, silent = false): UpdSnapshot {
  return set({
    kind: "desktop",
    phase: skippedIsNotAnUpdate(phaseOfDesktop(s.phase), s.latestVersion),
    latestVersion: s.latestVersion || snap.latestVersion,
    notes: s.latestNotes || snap.notes,
    percent: typeof s.percent === "number" ? s.percent : -1,
    transferred: s.transferred || 0,
    total: s.total || 0,
    error: s.phase === "error" ? (silent ? "" : s.error || "更新失败") : "",
    canSelfInstall: s.mode !== "portable",
    opensBrowser: s.mode === "portable"
  });
}

let snap: UpdSnapshot = baseSnapshot();
let desktopAttached = false;
let checkedThisSession = false;
const subs = new Set<(s: UpdSnapshot) => void>();

function set(patch: Partial<UpdSnapshot>): UpdSnapshot {
  snap = { ...snap, ...patch };
  subs.forEach((cb) => { try { cb(snap); } catch { /* 订阅方自己的问题 */ } });
  emit("jm:update");
  return snap;
}

function attachDesktop(): void {
  if (desktopAttached || !window.jmUpdate) return;
  desktopAttached = true;
  window.jmUpdate.onState((s) => applyDesktop(s));
}

/** 原生链路的状态同步（Android / iOS） */
let nativeAttached = false;
function attachNative(): void {
  if (nativeAttached) return;
  nativeAttached = true;
  nativeUpdate.revive();
  nativeUpdate.subscribe((s) => {
    set({
      kind: "native",
      phase: phaseOfNative(s.phase),
      latestVersion: s.version || snap.latestVersion,
      percent: s.percent,
      channel: s.channel,
      error: s.error,
      canSelfInstall: true,
      opensBrowser: false
    });
  });
}

export const updateFlow = {
  snapshot(): UpdSnapshot { return snap; },
  subscribe(cb: (s: UpdSnapshot) => void): () => void {
    subs.add(cb);
    // 订阅即同步一次当前值：调用方不必自己再读一遍（也避免"先渲染空态再跳变"）
    try { cb(snap); } catch { /* ignore */ }
    return () => { subs.delete(cb); };
  },
  /** 订阅总线上的更新事件（弹窗用；它只要"变了"这个信号） */
  onBus(cb: () => void): () => void { return on("jm:update", cb); },

  /**
   * **静默检查**：过完 18+ 门、首页首帧后由 App 调一次。
   * 返回"这次到底有没有真的去查"（节流不通过 / 本次会话已查过 → false，连请求都不发）。
   * 失败时阶段回到 idle 且 `error` 被清空 —— **静默失败**（用户要求：检查失败不要打扰）。
   */
  async checkSilently(): Promise<boolean> {
    if (!shouldAutoCheck(Date.now(), undefined, checkedThisSession)) return false;
    checkedThisSession = true;
    await updateFlow.check(true);
    return true;
  },

  /** 检查（silent=true 时失败不留痕；手动点按钮时 silent=false，错误交给调用方展示） */
  async check(silent = false): Promise<UpdSnapshot> {
    // 同上：只有"正在查 / 正在下 / 正在装"才挡，`available` 态允许重查
    // （否则被跳过或被关掉之后，用户再点「检查更新」是彻底没反应的）。
    if (snap.phase === "checking" || snap.phase === "downloading" || snap.phase === "installing") return snap;
    set({ phase: "checking", error: "" });
    markCheckedAt();
    if (window.jmUpdate && isDesktop) {
      attachDesktop();
      try {
        return applyDesktop(await window.jmUpdate.check(), silent);
      } catch (e) {
        return set({ phase: "idle", error: silent ? "" : String(e).slice(0, 120) });
      }
    }
    attachNative();
    /**
     * ⚠️ `silent` 必须**继续往下传**给原生链路，不能只在本函数出口把它清掉。
     *
     * 踩过的现场（v3.17 修）：设置页那个更新按钮（`ui/UpdateSection`）读的是
     * `nativeUpdate` **自己的**快照，不是 `updateFlow` 的快照。所以只要
     * `nativeUpdate.check()` 把失败写进了它自己的 state，那个按钮就会显示
     * 「检查更新（上次失败，重试）」——本函数下面那句 `error: silent ? "" : …`
     * 只管住了 flow 这一份，拦不住另一个读法。
     * 在 GitHub 不通的网络下这次静默检查必然失败 ⇒ 抽屉里长期挂着"上次失败"。
     */
    const s = await nativeUpdate.check({ silent });
    return set({
      kind: "native",
      phase: skippedIsNotAnUpdate(phaseOfNative(s.phase), s.version),
      latestVersion: s.version || "",
      notes: s.notes || "",
      percent: s.percent,
      channel: s.channel,
      error: s.error ? (silent ? "" : s.error) : "",
      canSelfInstall: true,
      opensBrowser: false
    });
  },

  /** 「下次再说」：什么都不记（下次启动照样提示） */
  preferLater(): void {
    nativeUpdate.forget();
    set({ phase: "idle", error: "" });
  },

  /** 「不再提醒」：只记这一个版本（等值比较 → 更高版本仍会提示） */
  ignoreVersion(): string {
    const v = snap.latestVersion;
    if (v) skipVersion(v);
    nativeUpdate.forget();
    set({ phase: "idle", error: "" });
    return v;
  },

  /** 主按钮：下载 or 安装（含"便携版 / iOS 交给浏览器"那条路） */
  async act(): Promise<UpdSnapshot> {
    if (snap.phase === "downloaded") return updateFlow.installNow();
    if (window.jmUpdate && isDesktop) {
      attachDesktop();
      try {
        return applyDesktop(await window.jmUpdate.act());
      } catch (e) {
        return set({ phase: "error", error: String(e).slice(0, 120) });
      }
    }
    // iOS：把 ipa 直链交给系统浏览器（安卓不会走这里 —— 它是"自己下载"那一档）
    if (snap.kind === "native" && isIos()) {
      const t = iosIpaTarget(nativeUpdate.get());
      void openExternal(t.url);
      return set({ phase: "idle" });
    }
    const s = await nativeUpdate.download();
    return set({ phase: phaseOfNative(s.phase), percent: s.percent, channel: s.channel, error: s.error || "" });
  },

  /** 下载完成后的"是否立即安装" */
  async installNow(): Promise<UpdSnapshot> {
    if (window.jmUpdate && isDesktop) return updateFlow.act();
    const s = await nativeUpdate.install();
    return set({ phase: phaseOfNative(s.phase), error: s.error || "" });
  },

  /** 测试用：重置模块状态与"本次会话已查过"标记 */
  __reset(skipAutoCheck = false): void {
    snap = baseSnapshot();
    desktopAttached = false;
    nativeAttached = false;
    if (skipAutoCheck) checkedThisSession = false;
  },
  /**
   * 测试用：直接摆一个快照进来。
   * 为什么需要它：`ignoreVersion` / `preferLater` 这些**策略**必须能脱离网络测
   * （否则要 mock fetch + 平台判断，测出来的是 mock 的行为不是策略的行为）。
   */
  __setForTest(patch: Partial<UpdSnapshot>): UpdSnapshot {
    return set(patch);
  },
  /** 测试用：读"本次会话是否已查过"（节流那条断言要看它） */
  __checkedThisSession(): boolean { return checkedThisSession; }
};
