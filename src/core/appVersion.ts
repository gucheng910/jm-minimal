import { UI_KEYS } from "./constants";
import { LOCAL_VERSION } from "./constants";

/**
 * 版本记账层（v3.16 更新提示 / 更新日志的地基）。
 *
 * 三份 storage，各管一件事，互不串味：
 *   · `jmclient.version.seen`     —— **看过的版本**（更新日志弹过就写它）；
 *   · `jmclient.update.skip`      —— **不再提醒的版本**（只跳这一个，见下）；
 *   · `jmclient.update.checkedAt` —— 上次**静默检查**的时刻（节流用）。
 *
 * ── 「不再提醒」的语义（用户拍板）────────────────────────────────────
 * **只跳过这一个版本**：下次发布更高版本时照样提示。
 * 存的是版本号字符串而不是布尔 —— 布尔一旦写上就是"永久关闭所有更新提示"，
 * 那是另一种（更粗暴的）语义，用户没选它。判断走 `isSkipped(v)` 的**等值**比较，
 * 所以 `9.9.9 → 9.9.10` 会重新提示，而 `9.9.9 → 9.9.9` 不会。
 *
 * ── 为什么自己解析而不用 JSON.parse 直接吃 ────────────────────────────
 * 与本项目其它配置层同一条纪律：**读时自愈**。storage 里的东西可能是旧版本写的、
 * 也可能被用户手改坏；解析失败一律当成"没记过"，绝不抛、绝不因此让应用起不来。
 */

export interface VersionSeen {
  version: string;
  at: number;
}

/** 距上次静默检查少于这个间隔，本次启动就不再查（避免频繁请求 GitHub API 被限流） */
export const UPDATE_AUTOCHECK_GAP_MS = 6 * 3600 * 1000;

function readRaw(key: string): string {
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}
function writeRaw(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式：本次会话内仍按内存态走 */ }
}

/** 看过的版本（读时自愈：坏数据 → 视为没看过） */
export function loadVersionSeen(): VersionSeen | null {
  const raw = readRaw(UI_KEYS.versionSeen);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<VersionSeen>;
    const version = typeof o.version === "string" ? o.version : "";
    if (!version) return null;
    return { version, at: typeof o.at === "number" ? o.at : 0 };
  } catch {
    return null;
  }
}

/**
 * 标记"这个版本我已经看过更新日志了"。
 * ⚠️ 一定要在**用户真的看到日志之后**调用（关闭弹窗时），而不是打开弹窗时 ——
 * 否则弹窗还没渲染完就被记成看过，用户下次仍然看不到（经典的自杀式记账）。
 */
export function markVersionSeen(version: string, now = Date.now()): void {
  writeRaw(UI_KEYS.versionSeen, JSON.stringify({ version, at: now }));
}

/**
 * 更新日志该不该弹（v3.16，用户拍板触发键 = `LOCAL_VERSION`）。
 *
 * 三态而不是布尔 —— **全新安装不弹**：
 *   · `"seed"`：storage 里**根本没有**记录 ⇒ 这是全新安装。用户没有"以前的版本"可比，
 *     给他看一份"更新日志"是噪音（他要的是"这软件怎么用"）。此时**只记账**（记成当前版本），
 *     于是"下次升级"才满足弹出条件。
 *   · `"show"`：有记录且 ≠ 当前版本 ⇒ 真升级了，弹。
 *   · `"none"`：记录就是当前版本 ⇒ 已经看过了（或者启动时刚 seed 过），不弹。
 *
 * ⚠️ 这条规则是 e2e 逼出来的：一开始按"没记过就弹"实现，结果**14 支老驱动里 4 支当场变红**
 *    （导航 / 缓存 / 阅读器 / 下拉刷新）—— 因为全新 profile 一进首页就多出一层遮罩，
 *    点击和返回键全被它吃掉。那 4 支红得对：它们如实反映了"新装用户一进来就被糊一脸"。
 */
export type ChangelogDecision = "show" | "seed" | "none";

/**
 * 「老用户」痕迹键（v2.3.1）——**只有用户真的动过配置**才会有它们。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────
 * 2.3.0 实测：**老用户升级后首次进首页没弹日志**。根因是这批键的记账机制
 * （`jmclient.version.seen`）本身就晚（v3.16 才引入），之前那些版本**从没写过它**
 * → `seen` 为 null → 被判成"全新安装"→ 只记账不弹。老用户明明有一堆配置，
 * 却被当成刚装的新用户。
 *
 * ── 为什么不能拿"任意 jmclient.\* 键"当痕迹 ────────────────────────
 * e2e 的 `stub.js` 会写 `hostcfg` / `autoSelect` / `tosAccepted` / `theme` ——
 * 若按前缀扫，干净 profile 也会被判成老用户 → 14 支老驱动一进首页就多一层遮罩、
 * 点击与返回键被吃掉（这正是 `changelogDecision` 注释里记的那次事故）。
 * 所以这里只认**用户个性化产物**：五套自定义 UI 的配置（详情页结构/观感、列表页、
 * 顶栏底栏、阅读器）。stub 一个都不写，于是 e2e 干净 profile 仍是"新装"。
 */
const PRIOR_USAGE_KEYS: string[] = [
  UI_KEYS.detailLayout,
  UI_KEYS.detailStyle,
  UI_KEYS.listLayout,
  UI_KEYS.chromeLayout,
  UI_KEYS.readerStyle
];

/** 这台设备上是否有"用户真的用过（改过配置）"的痕迹 */
export function hasPriorUsage(): boolean {
  try {
    return PRIOR_USAGE_KEYS.some((k) => !!localStorage.getItem(k));
  } catch {
    return false;
  }
}

/**
 * 更新日志该不该弹（v3.16 引入，v2.3.1 修"老用户被当成新装"）。
 *
 *   · `"show"`：真升级了 ⇒ 弹。
 *     —— 有记录且 ≠ 当前版本；**或者没有记录但本机有用户配置痕迹**（老版本升上来的）。
 *   · `"seed"`：确实没有任何记录**且没有任何使用痕迹** ⇒ 全新安装，只记账不弹
 *     （用户没有"以前的版本"可比，给他看更新日志是噪音）。
 *   · `"none"`：记录就是当前版本 ⇒ 已经看过（或启动时刚 seed 过），不弹。
 *
 * ⚠️ 这条规则的历史：最初按"没记过就弹"实现 → 14 支老驱动里 4 支当场变红
 *    （新装用户一进首页就被糊一脸遮罩）；改成"没记过一律不弹" → 又漏掉了
 *    **老用户升级**这条真实路径（2.3.0 首次进首页没弹，用户实测反馈）。
 *    现在按"有没有使用痕迹"三态分开，两条路径都覆盖。
 */
export function changelogDecision(
  current = LOCAL_VERSION,
  seen = loadVersionSeen(),
  /**
   * 使用痕迹。**默认惰性求值**：只在真的没有 `seen` 记录时才去扫 storage
   * （有记录时这个参数根本用不上，别为它白读一遍 localStorage）。
   */
  priorUsage?: boolean
): ChangelogDecision {
  const v = String(current || "").trim();
  if (!v) return "none";
  if (seen) return seen.version === v ? "none" : "show";
  const prior = priorUsage === undefined ? hasPriorUsage() : priorUsage;
  return prior ? "show" : "seed";
}

/**
 * 是否需要弹更新日志（`"show"` 的便捷封装）。
 * 只在"版本真的变了"时为真 —— 全新安装走 `"seed"`，是 false。
 */
export function needsChangelog(current = LOCAL_VERSION, seen = loadVersionSeen()): boolean {
  return changelogDecision(current, seen) === "show";
}

// ---- 不再提醒（只跳这一个版本） ----

/** 被"不再提醒"跳过的版本号（空串 = 没跳过任何版本） */
export function loadSkipVersion(): string {
  return readRaw(UI_KEYS.updateSkip).trim();
}

export function skipVersion(version: string): void {
  const v = String(version || "").trim();
  if (!v) return;
  writeRaw(UI_KEYS.updateSkip, v);
}

/** 这个版本是不是被用户点名"不再提醒"过（**等值**比较，不是"有没有设过"） */
export function isSkipped(version: string, skipped = loadSkipVersion()): boolean {
  const v = String(version || "").trim();
  return v !== "" && v === skipped;
}

// ---- 静默检查的节流 ----

export function loadLastCheckAt(): number {
  const n = Number(readRaw(UI_KEYS.updateCheckedAt));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function markCheckedAt(now = Date.now()): void {
  writeRaw(UI_KEYS.updateCheckedAt, String(now));
}

/**
 * 这次启动要不要静默检查？
 *
 * 两个条件缺一不可：
 *   · 本次会话还没查过（`alreadyCheckedThisSession`）—— 用户说"进入软件后静默检查一次"，
 *     那就**一次**，切页面/返回首页都不该再查；
 *   · 距上次检查至少 `UPDATE_AUTOCHECK_GAP_MS`（默认 6h）—— 否则一天开十次就查十次，
 *     GitHub API 未认证额度是 60 次/小时，被限流后就变成"永远检查失败"。
 */
export function shouldAutoCheck(
  now = Date.now(),
  lastCheckAt = loadLastCheckAt(),
  alreadyCheckedThisSession = false
): boolean {
  if (alreadyCheckedThisSession) return false;
  if (lastCheckAt <= 0) return true;
  return now - lastCheckAt >= UPDATE_AUTOCHECK_GAP_MS;
}
