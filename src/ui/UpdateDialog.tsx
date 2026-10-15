import { useEffect, useRef, useState } from "react";
import { Sheet } from "./blocks/Sheet";
import { useBackHandler } from "../hooks/useBackHandler";
import { LOCAL_VERSION } from "../core/constants";
import { currentChangelog } from "../core/changelog";
import { changelogDecision, markVersionSeen } from "../core/appVersion";
import { on } from "../core/bus";
import { primaryLabel, statusText, shouldPrompt, updateFlow, opensBrowserFor } from "../core/updateFlow";
import type { UpdSnapshot } from "../core/updateFlow";
import { openExternal } from "../core/openExternal";
import { RELEASES_URL } from "../core/platform";

/**
 * 更新提示 / 更新日志（v3.16）—— **一个外壳两种内容**。
 *
 * ── 为什么合成一个组件而不是两个 ────────────────────────────────────
 * 两者外观完全同构（标题 + 副标题 + 可滚动正文 + 按钮行），差别只在数据与按钮；
 * 拆成两个会立刻出现两份"标题 + × + 底部按钮"的复制品 —— 这个项目已经因为
 * 抄 7 遍弹层壳吃过一次亏（`ui/blocks/Sheet.tsx` 的文件头就是那次教训）。
 *
 * ── 形态为什么是底部弹层而不是居中对话框 ────────────────────────────
 * 复用项目现有的 `Sheet`（遮罩 + 面板 + 入场/出场过渡 + 点遮罩关闭 + 返回键），
 * 于是**零新样式**就能与"更快的源 / 阅读设置 / 排序"那些浮层长得一致 ——
 * 用户说的"不至于太丑"，最稳的做法就是别自己另起一套视觉。
 * 信息结构参考 BiliPai 的 `Material3AppUpdateDialog.kt`（标题「发现新版本」+ 副标题「版本 X」
 * + 右上 × + 可滚动更新内容 + 进度 + 主/次按钮），文案参考 fluxdo 的 `aboutUpdate_zh.arb`。
 *
 * ── 三条容易做错的规则（都写在代码里了）──────────────────────────────
 *   ① 更新日志的记账在**关闭时**写（`markVersionSeen`），不在打开时 ——
 *      否则弹窗没渲染完就被记成"看过"，用户下次还是看不到；
 *   ② 日志与更新提示**不抢屏**：日志开着时新版本提示排队等它关掉；
 *   ③ 下载中**不提供"取消下载"**：桌面端 electron-updater 没有取消接口，
 *      安卓那条链路也是原生 DownloadManager 在跑 —— 给一个按不动的按钮比不给更糟。
 *      所以这一档给的是「后台下载」（关掉弹窗、任务继续，设置页里能看到进度）。
 */
type View = "none" | "prompt" | "notes";

/**
 * @param ready 18+ 门是否已通过。**没过门不做日志判定**：
 *   否则日志会叠在入口门上（用户在确认年龄之前先看到"更新日志"，顺序很怪），
 *   而且那样一来"升级后第一次进首页"就成了"升级后第一次打开应用"。
 */
export default function UpdateDialog({ ready = true }: { ready?: boolean }) {
  const [view, setView] = useState<View>("none");
  const [snap, setSnap] = useState<UpdSnapshot>(() => updateFlow.snapshot());
  /** 日志内容只在打开那一刻算一次（关闭时要用同一个对象记账） */
  const [notes, setNotes] = useState(() => currentChangelog());
  /**
   * 「已下载完成」那一档被关掉的版本号。
   *
   * 为什么只给这一档做防复弹：下载完成后快照**不会再变**（还是 downloaded），
   * 关掉它之后下面那个 effect 会立刻把弹窗重新打开 —— 用户点「稍后安装」弹窗原地复活。
   * 而 `available` 档不需要这一手：它只能在**一次新的检查**之后出现，
   * 而"下次再说"会把流程推回 idle（用户要的就是"下次还来问我"）；
   * 给 available 也加防复弹，等于把「下次再说」变成了「不再提醒」。
   */
  const snoozedReadyRef = useRef("");

  useEffect(() => updateFlow.subscribe(setSnap), []);

  // 升级后第一次进首页 → 弹更新日志
  useEffect(() => {
    if (!ready) return;                       // 门后再说（见组件头上的说明）
    const entry = currentChangelog();
    if (!entry) {                             // 没有条目就别弹空壳
      markVersionSeen(LOCAL_VERSION);         // 但记账要记：否则"每次启动都判定成待弹"（白算）
      return;
    }
    const d = changelogDecision(LOCAL_VERSION);
    // 全新安装：只记账、不弹（用户还没有"以前的版本"可比；否则新装用户一进来就被糊一脸遮罩）
    if (d === "seed") { markVersionSeen(LOCAL_VERSION); return; }
    if (d !== "show") return;
    setNotes(entry);
    setView("notes");
  }, [ready]);

  // 常驻入口：侧边栏底部那行版本号（`jm:showChangelog`）→ 手动打开同一份日志
  useEffect(() => on("jm:showChangelog", () => {
    const entry = currentChangelog();
    if (!entry) return;
    setNotes(entry);
    setView("notes");
  }), []);

  // 有新版本 → 弹更新提示（日志开着时先排队；刚被关掉的那一次不重开）
  useEffect(() => {
    if (view === "notes") return;
    if (!shouldPrompt(snap)) return;
    if (snap.phase === "downloaded" && snoozedReadyRef.current === snap.latestVersion) return;
    setView("prompt");
  }, [snap, view]);

  const closeNotes = () => {
    // 规则①：**看过才记账**。放在关闭这一侧，打开时一个字都不写。
    if (notes) markVersionSeen(LOCAL_VERSION);
    setView("none");
  };
  const closePrompt = () => {
    // 只记"已下载完成"这一档（见 snoozedReadyRef 的说明）
    if (snap.phase === "downloaded") snoozedReadyRef.current = snap.latestVersion;
    setView("none");
  };

  useBackHandler(() => {
    if (view === "none") return false;
    if (view === "notes") { closeNotes(); return; }
    // 下载中：返回键只把弹窗收起来（后台继续下），不打断任务
    closePrompt();
  }, [view]);

  const open = view !== "none";
  const downloading = view === "prompt" && snap.phase === "downloading";
  const showProgress = downloading;
  const pct = snap.percent >= 0 ? Math.max(0, Math.min(100, snap.percent)) : -1;
  const errText = view === "prompt" ? snap.error : "";

  const title = view === "notes" ? "更新日志" : "发现新版本";
  const sub = view === "notes"
    ? "v" + LOCAL_VERSION + (notes ? " · " + notes.date : "")
    : "版本 " + (snap.latestVersion || "?") + "（当前 v" + snap.currentVersion + "）";

  return (
    <Sheet
      open={open}
      // onClose 是 Sheet 的必填项（遮罩 / × 都走它）；这里按"当前这一屏该怎么关"分派。
      onClose={view === "notes" ? closeNotes : closePrompt}
      // 下载中：点遮罩不该把"正在进行的事"关掉（等于给了一个隐形取消）
      onBackdrop={downloading ? () => { /* 下载中点了外面不关 */ } : (view === "notes" ? closeNotes : closePrompt)}
      showClose={!downloading}
      closeDisabled={downloading}
      panelClassName="app-sheet update-sheet"
      title={title}
    >
      {/* 副标题：日志视图拆成「版本徽标 · 日期」两枚（v2.3.1 观感重做）；
          textContent 仍含 "v<版本>" 与日期 —— e2e driver-update 的版本断言靠它。 */}
      <p className="update-sub" data-update-sub={view}>
        {view === "notes" ? (
          <>
            <span className="update-ver">v{LOCAL_VERSION}</span>
            <span className="update-sep">·</span>
            {notes && <span className="update-date">{notes.date}</span>}
          </>
        ) : sub}
      </p>

      {view === "notes" && notes && (
        <>
          <p className="update-headline">{notes.title}</p>
          {/* v2.3.1：正文从一整块 <pre>（等宽感、无层次，用户反馈"有点丑"）换成
              **圆点条目列表**。⚠️ 保留 data-update-notes="changelog" —— e2e 靠它定位，
              断言也相应改成"数 <li> 条数"，不再按 "\n" 切 <pre>。 */}
          <div className="update-notes update-notes-list" data-update-notes="changelog">
            <ul className="update-list">
              {notes.items.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          </div>
        </>
      )}

      {view === "prompt" && (
        <>
          <p className="update-status" data-update-status={snap.phase}>{statusText(snap)}</p>
          {/* Release 正文：拿不到就整段不渲染（不要一个空白的"更新内容"标题） */}
          {snap.notes.trim().length > 0 && snap.phase !== "downloaded" && (
            <pre className="update-notes" data-update-notes="release">{snap.notes.trim().slice(0, 4000)}</pre>
          )}
          {showProgress && (
            <div className="update-progress" data-update-progress={pct >= 0 ? "known" : "unknown"}>
              <div className="update-progress-bar">
                <div
                  className={"update-progress-fill" + (pct >= 0 ? "" : " unknown")}
                  style={pct >= 0 ? { transform: "scaleX(" + (pct / 100) + ")" } : undefined}
                />
              </div>
              <span className="muted mono-num" data-update-pct={String(pct)}>
                {pct >= 0
                  ? pct + "%"
                  : (snap.channel ? snap.channel + " · 下载中…" : "下载中…")}
              </span>
            </div>
          )}
          {errText && <p className="err small-err" data-update-error="1">{errText}</p>}
        </>
      )}

      {/*
        ⚠️ v2.3.1：这一行**不再挂 `.sheet-actions`**（原来 `className="sheet-actions update-actions"`）。
        `.sheet-actions button:last-child` 是一条**无条件**的通用规则（末位 = 实心主按钮），
        它是为“取消 / 确定”那种两个按钮的动作行设计的；更新弹窗的按钮数量与主次都不定，
        复用它的实测后果就是**主次颠倒**——“发布页 / 稍后安装 / 下次再说”被画成黑主按钮，
        而真正的主动作（知道了 / 立即更新）不是。项目里同类事故已记过两次
        （见 index.css 里 `.reader-sheet .settings-actions` 那段），修法一致：**别挂它**，
        主次完全由显式类决定，并且主操作排在**末位**（与项目其它弹层的按钮语言一致）。
      */}
      <div className="update-actions">
        {view === "notes" ? (
          <>
            <button type="button" className="btn soft" onClick={() => void openExternal(RELEASES_URL)}>发布页 ↗</button>
            <button type="button" className="btn primary" onClick={closeNotes}>知道了</button>
          </>
        ) : downloading ? (
          // 规则③：下载中不给“取消下载”，只给“后台下载”（关掉弹窗，任务继续）
          <>
            <button type="button" className="btn soft" onClick={closePrompt}>后台下载</button>
            <button type="button" className="btn primary" disabled data-update-primary="downloading">{primaryLabel(snap)}</button>
          </>
        ) : snap.phase === "downloaded" ? (
          <>
            <button type="button" className="btn soft" data-update-later="1" onClick={closePrompt}>稍后安装</button>
            <button type="button" className="btn primary" data-update-primary="install" onClick={() => void updateFlow.installNow()}>
              {primaryLabel(snap)}
            </button>
          </>
        ) : snap.phase === "error" ? (
          <>
            <button type="button" className="btn soft" data-update-later="1" onClick={closePrompt}>下次再说</button>
            <button type="button" className="btn primary" data-update-primary="retry" onClick={() => void updateFlow.act()}>重试</button>
          </>
        ) : (
          <>
            {/* 「下次再说」与「不再提醒」是**两件事**：前者不落盘（下次启动还提示），
                后者只跳过这一个版本（更高版本照样提示）。文案必须把差别说出来。 */}
            <button type="button" className="btn soft" data-update-ignore="1" onClick={() => { updateFlow.ignoreVersion(); closePrompt(); }}>
              不再提醒
            </button>
            <button type="button" className="btn soft" data-update-later="1" onClick={() => { updateFlow.preferLater(); closePrompt(); }}>
              下次再说
            </button>
            <button
              type="button" className="btn primary" data-update-primary="update"
              disabled={snap.phase === "installing"}
              onClick={() => void updateFlow.act()}
            >{primaryLabel(snap)}</button>
            {opensBrowserFor(snap.kind === "desktop" ? "portable" : "android") && snap.opensBrowser && (
              <p className="dl-hint">便携版 / iOS 无法自己安装，会打开浏览器下载。</p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
