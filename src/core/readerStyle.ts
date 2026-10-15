import { UI_KEYS } from "./constants";

/**
 * 阅读器**观感**参数层（v3.13）。与 `detailStyle` 同族（本地档位 + 读时自愈 + 只写非默认值），
 * 但管的对象是阅读器这个**沉浸全屏**页面。
 *
 * ── 为什么单独一层，而不是塞进 `chromeLayout` ────────────────────────
 * 那两层管的是**两件不同的事**，混在一起会让"面板上看到什么"取决于另一个模块的字段：
 *   · `chromeLayout`  = 有哪些**单元**、什么顺序、显不显示（结构，判据是 id 表）；
 *   · `readerStyle`   = 这些单元与那块画布**长什么样**（观感，判据是档位值）。
 * 与详情页的 `detailLayout` / `detailStyle` 分工逐字同构（那条界线本项目一直在守）。
 *
 * ── 默认配置 = 改造前的写死行为（红线）────────────────────────────────
 *   · `scrollbar: "hidden"` —— 今天 `html.jm-reading` 上就是 `scrollbar-width: none`（完全隐藏）；
 *   · `autoHide: "3s"`      —— 今天 `Reader.showChrome()` 里写死 `3000`。
 * 所以"从没配过"的用户拿到的阅读器与改造前**逐字一致**。
 */

// ────────────────────────────────────────────────
// 轴 1：滚动条
// ────────────────────────────────────────────────
/**
 * 阅读器滚动条。`"hidden"` = 今天的行为（沉浸阅读，屏幕上没有任何条）。
 *
 * 为什么需要这个轴：连续（滚动）模式下读的是**整个页面**（`html.jm-reading` 在滚），
 * 长条漫画一屏滚过去很容易"不知道读到哪了"，而滚动条是**零成本**的位置指示器
 * （不需要读任何数据、不占版面）。另一半用户则要沉浸，所以做成档位而不是改默认值。
 */
export type ReaderScrollbar = "hidden" | "thin" | "auto";

// ────────────────────────────────────────────────
// 轴 2：控制条自动隐藏
// ────────────────────────────────────────────────
/** 控制条（上排标题 + 下排工具）浮出后自动收起的时间；`"never"` = 不自动隐藏 */
export type ReaderAutoHide = "3s" | "6s" | "never";

export const READER_AUTOHIDE_MS: Record<ReaderAutoHide, number> = {
  "3s": 3000,   // = 改造前写死的值
  "6s": 6000,
  never: 0      // 0 = 不挂定时器；再点一下画面仍可手动收起（onReaderTap 的分支）
};

// ────────────────────────────────────────────────
// 配置
// ────────────────────────────────────────────────
export interface ReaderStyleConfig {
  version: number;
  scrollbar: ReaderScrollbar;
  autoHide: ReaderAutoHide;
}

export const READER_STYLE_VERSION = 1;

export const DEFAULT_READER_STYLE: ReaderStyleConfig = {
  version: READER_STYLE_VERSION,
  scrollbar: "hidden",
  autoHide: "3s"
};

export const READER_SCROLLBAR_OPTIONS: ReadonlyArray<{ value: ReaderScrollbar; label: string; hint: string }> = [
  { value: "hidden", label: "隐藏", hint: "与现在一致：沉浸阅读，屏上没有任何条" },
  { value: "thin", label: "细条", hint: "6px 细条；长条漫画里能一眼看出读到哪了" },
  { value: "auto", label: "常显", hint: "系统宽度的滚动条（桌面端好用）" }
];

export const READER_AUTOHIDE_OPTIONS: ReadonlyArray<{ value: ReaderAutoHide; label: string; hint: string }> = [
  { value: "3s", label: "3 秒", hint: "与现在一致" },
  { value: "6s", label: "6 秒", hint: "看得慢一点也不用反复点出来" },
  { value: "never", label: "不自动隐藏", hint: "控制条一直留着；再点一下画面才收起" }
];

// ────────────────────────────────────────────────
// 归一化（对脏数据 / 旧数据自愈）
// ────────────────────────────────────────────────
function pick<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return typeof v === "string" && (allowed as readonly string[]).indexOf(v) >= 0 ? (v as T) : dflt;
}

export function normalizeReaderStyle(raw: unknown): ReaderStyleConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<ReaderStyleConfig>;
  return {
    version: READER_STYLE_VERSION,
    scrollbar: pick(src.scrollbar, READER_SCROLLBAR_OPTIONS.map((o) => o.value), DEFAULT_READER_STYLE.scrollbar),
    autoHide: pick(src.autoHide, READER_AUTOHIDE_OPTIONS.map((o) => o.value), DEFAULT_READER_STYLE.autoHide)
  };
}

// ────────────────────────────────────────────────
// 查询 / 编辑 / 复位
// ────────────────────────────────────────────────
export function isReaderStyleModified(cfg: ReaderStyleConfig): boolean {
  return cfg.scrollbar !== DEFAULT_READER_STYLE.scrollbar || cfg.autoHide !== DEFAULT_READER_STYLE.autoHide;
}

/** 某一项是否是默认值（面板据此决定要不要画那个「单项复位 ↺」） */
export function isReaderStyleKeyDefault(cfg: ReaderStyleConfig, key: "scrollbar" | "autoHide"): boolean {
  return cfg[key] === DEFAULT_READER_STYLE[key];
}

export function setReaderStyle<K extends "scrollbar" | "autoHide">(
  cfg: ReaderStyleConfig,
  key: K,
  value: ReaderStyleConfig[K]
): ReaderStyleConfig {
  if (cfg[key] === value) return cfg;              // 值没变 → 原引用（省掉一次重渲染 + 一次落盘）
  return { ...cfg, version: READER_STYLE_VERSION, [key]: value };
}

export function resetReaderStyleKey(cfg: ReaderStyleConfig, key: "scrollbar" | "autoHide"): ReaderStyleConfig {
  return setReaderStyle(cfg, key, DEFAULT_READER_STYLE[key]);
}

export function resetReaderStyle(): ReaderStyleConfig {
  return { ...DEFAULT_READER_STYLE };
}

// ────────────────────────────────────────────────
// 应用到 DOM
// ────────────────────────────────────────────────
/**
 * 把观感写到 `<html>` 上（**属性名 `data-jm-rsb`**）。
 *
 * ⚠️ 为什么挂 `<html>` 而不是阅读器的 `.reader-wrap`：连续模式下滚的是**整个文档**
 * （`html.jm-reading` 在滚，见 index.css 里那条 `scrollbar-width: none`），
 * 滚动条属于**滚动容器**，挂在内层元素上根本不会生效。
 *
 * ⚠️ 默认值一律 `removeAttribute` —— "没配过"的状态就是**属性不存在**，
 * 这样"从没配过"的 DOM 与改造前逐字一致（红线），也让 CSS 侧只有"非默认"的规则。
 */
export function applyReaderStyle(cfg: ReaderStyleConfig): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (cfg.scrollbar === DEFAULT_READER_STYLE.scrollbar) root.removeAttribute("data-jm-rsb");
  else root.setAttribute("data-jm-rsb", cfg.scrollbar);
}

/** 离开阅读器时清掉标记（退出阅读器后普通页面的滚动条不该被这里的选择影响） */
export function clearReaderStyle(): void {
  if (typeof document === "undefined") return;
  document.documentElement.removeAttribute("data-jm-rsb");
}

// ────────────────────────────────────────────────
// 持久化（与另几层同级：localStorage + 读时自愈）
// ────────────────────────────────────────────────
export function loadReaderStyle(): ReaderStyleConfig {
  try {
    const raw = localStorage.getItem(UI_KEYS.readerStyle);
    if (!raw) return resetReaderStyle();
    return normalizeReaderStyle(JSON.parse(raw));
  } catch {
    // JSON 坏了 / 隐私模式禁用 localStorage → 回默认，绝不抛
    return resetReaderStyle();
  }
}

export function saveReaderStyle(cfg: ReaderStyleConfig): void {
  try {
    localStorage.setItem(UI_KEYS.readerStyle, JSON.stringify(normalizeReaderStyle(cfg)));
  } catch { /* 隐私模式：本次会话内仍生效 */ }
}
