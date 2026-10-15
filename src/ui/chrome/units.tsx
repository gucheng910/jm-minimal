import { cloneElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { DownloadIcon, GridIcon, HomeIcon, LightningIcon, MenuIcon, SearchIcon, SettingsIcon, UserIcon } from "../icons";
import type { NavUnitId, ReaderStatusId, ReaderToolId, ReaderTopId, TopActionId, TopLeftId } from "../../core/chromeLayout";

/**
 * 三个栏的**单元渲染层**：把过去写死在 `App.tsx` / `Reader.tsx` 里的按钮，
 * 变成"一串有 id、可单独取用"的单元。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────
 *   · `core/chromeLayout.ts` 只管**有哪些单元 / 什么顺序 / 显不显示**（纯数据，能在 node 里测）；
 *     这里只管**长什么样、点了做什么**（React）。两者分开之后，
 *     顺序/显隐的测试不需要挂载组件，渲染的测试不需要构造脏配置。
 *   · 每个单元的 JSX **逐字搬自改造前**（类名、aria-label、图标尺寸、条件渲染都没动）——
 *     默认配置下渲染出的 DOM 与改造前**逐字一致**，这是那一层的红线。
 *
 * ── 三条约定 ──────────────────────────────────────────────────────────
 *   ① 单元是**纯函数**：吃一个 ctx（回调 + 数据），吐一个 ReactNode。不认识 App/Reader 的内部状态；
 *   ② **条件渲染留在单元内部**（离线没有"更快的源"、单话没有"换话"、已缓存时按钮变"已缓存"）——
 *      那是运行时事实，不是配置能决定的；配置只能在它之上再藏一层；
 *   ③ 不在 `map` 里出现的 id 渲染成 `null`（**不抛**）：配置里多一个未知 id 不该让整页白。
 *      归一化本来就该把它丢掉，这里只是最后一道保险。
 */

// ────────────────────────────────────────────────
// 顶栏
// ────────────────────────────────────────────────
export interface TopBarCtx {
  onToggleMenu: () => void;
  onOpenCache: () => void;
  onSearch: () => void;
  onOpenSource: () => void;
}

export const TOP_LEFT_UNITS: Record<TopLeftId, (c: TopBarCtx) => ReactNode> = {
  menu: (c) => (
    <button className="menu-btn" aria-label="菜单" onClick={c.onToggleMenu}><MenuIcon size={20} /></button>
  ),
  title: () => <div className="top-title">JM极简版</div>
};

export const TOP_ACTION_UNITS: Record<TopActionId, (c: TopBarCtx) => ReactNode> = {
  cache: (c) => <button aria-label="缓存" onClick={c.onOpenCache}><DownloadIcon size={20} /></button>,
  search: (c) => <button aria-label="搜索" onClick={c.onSearch}><SearchIcon size={20} /></button>,
  source: (c) => (
    <button
      aria-label="换源"
      title="换源：图源 / 线路 / 一键测速"
      onClick={c.onOpenSource}
    ><LightningIcon size={20} /></button>
  )
};

// ────────────────────────────────────────────────
// 底栏
// ────────────────────────────────────────────────
export interface NavCtx {
  /** 当前标签（决定哪个单元带 active） */
  tab: string;
  onHome: () => void;
  onCategories: () => void;
  onSearch: () => void;
  onSettings: () => void;
}

const navCls = (tab: string, id: string) => (tab === id ? "nav-item active" : "nav-item");

export const NAV_UNITS: Record<NavUnitId, (c: NavCtx) => ReactNode> = {
  home: (c) => (
    <button className={navCls(c.tab, "home")} onClick={c.onHome}><HomeIcon /><span>首页</span></button>
  ),
  categories: (c) => (
    <button className={navCls(c.tab, "categories")} onClick={c.onCategories}><GridIcon /><span>分类</span></button>
  ),
  search: (c) => (
    <button className={navCls(c.tab, "search")} onClick={c.onSearch}><SearchIcon /><span>搜索</span></button>
  ),
  settings: (c) => (
    <button className={navCls(c.tab, "settings")} onClick={c.onSettings}><UserIcon /><span>设置</span></button>
  )
};

// ────────────────────────────────────────────────
// 阅读器控制条
// ────────────────────────────────────────────────
export interface ReaderTopCtx {
  onBack: () => void;
  title: string;
  current: number;
  total: number;
}

export const READER_TOP_UNITS: Record<ReaderTopId, (c: ReaderTopCtx) => ReactNode> = {
  back: (c) => <button onClick={c.onBack}>返回</button>,
  title: (c) => <span className="rt-title one-line">{c.title}</span>,
  page: (c) => <span className="rt-page mono-num">{c.current} / {c.total}</span>
};

export interface ReaderToolCtx {
  /** 离线阅读：不渲染"更快的源" */
  offline: boolean;
  testing: boolean;
  onOpenSourcePicker: () => void;
  /** 章节数：只有一话时不渲染"换话" */
  chaptersCount: number;
  switchBusy: boolean;
  curLabel: string;
  onOpenChapters: () => void;
  /** 已全部缓存 → 按钮变成不可点的"已缓存" */
  allCached: boolean;
  cacheTaskBusy: boolean;
  pagesCount: number;
  /** 缓存任务进度（undefined = 没有在跑的任务）；只在按钮文案里用 */
  task: { done: number; total: number } | null | undefined;
  onOpenCache: () => void;
  /** 去条纹不可用时（NO_SEAM）标题文案不同 */
  noSeam: boolean;
  onOpenSettings: () => void;
}

export const READER_TOOL_UNITS: Record<ReaderToolId, (c: ReaderToolCtx) => ReactNode> = {
  source: (c) => {
    if (c.offline) return null;   // 运行时条件，不是配置能决定的
    return (
      <button className="rt-tool" disabled={c.testing} onClick={c.onOpenSourcePicker} title="测速并选择图源">
        <LightningIcon size={20} />
        <span>{c.testing ? "测速中…" : "更快的源"}</span>
      </button>
    );
  },
  chapter: (c) => {
    if (c.chaptersCount <= 1) return null;   // 只有一话时没有"换话"
    return (
      <button className="rt-tool" onClick={c.onOpenChapters} title="切换话数">
        <MenuIcon size={20} />
        <span>{c.switchBusy ? "切换中…" : (c.curLabel || "换话")}</span>
      </button>
    );
  },
  cache: (c) => {
    if (c.allCached && !c.cacheTaskBusy) {
      return (
        <button className="rt-tool btn-cached" disabled title="本作品已全部缓存">
          <DownloadIcon size={20} />
          <span>已缓存</span>
        </button>
      );
    }
    return (
      <button
        className="rt-tool"
        disabled={c.pagesCount === 0 || c.cacheTaskBusy}
        onClick={c.onOpenCache}
        title={c.chaptersCount > 1 ? "选择要缓存的话数" : "缓存本话"}
      >
        <DownloadIcon size={20} />
        <span>{c.cacheTaskBusy ? <span className="mono-num">{"缓存中 " + (c.task?.done ?? 0) + "/" + (c.task?.total ?? 0)}</span> : "缓存"}</span>
      </button>
    );
  },
  settings: (c) => (
    <button
      className="rt-tool"
      onClick={c.onOpenSettings}
      title={c.noSeam ? "阅读设置：模式 / 跳页" : "阅读设置：模式 / 去条纹 / 跳页"}
    >
      <SettingsIcon size={20} />
      <span>设置</span>
    </button>
  )
};

// ────────────────────────────────────────────────
// 阅读器状态栏条目（v3.12）
// ────────────────────────────────────────────────
export interface ReaderStatusCtx {
  /** 当前这一话的名字（可能为空 → 渲染 "-"，不消失，免得位置跳动） */
  chapter: string;
  current: number;
  total: number;
  /** 本话读到的百分比（0~100 的整数） */
  pct: number;
  /** "HH:MM"（由 Reader 只管在**开着时间条目时**每分钟更新一次） */
  clock: string;
}

export const READER_STATUS_UNITS: Record<ReaderStatusId, (c: ReaderStatusCtx) => ReactNode> = {
  chapter: (c) => <span className="rt-st rt-st-chapter one-line">{c.chapter || "-"}</span>,
  page: (c) => <span className="rt-st mono-num">{c.current} / {c.total}</span>,
  pct: (c) => <span className="rt-st mono-num">{c.pct}%</span>,
  clock: (c) => <span className="rt-st mono-num">{c.clock}</span>
};

// ────────────────────────────────────────────────
// 通用渲染：按配置顺序把单元排一排
// ────────────────────────────────────────────────
/**
 * `ids` 应当已经由 `visibleChromeUnits(cfg, section)` 滤掉隐藏项（那一层管显隐）。
 * 这里只做三件事：按顺序渲染、给根元素挂 `data-unit`、给 React 一个稳定的 key。
 *
 * ⚠️ **不包 wrapper**：包一层 `<span>` 会多出节点，破坏"默认配置下 DOM 与改造前一致"这条红线。
 * 可寻址性靠给**单元自己的根元素**加一个属性实现 —— 与详情页区块的 `data-blk`、宽度档的
 * `data-span` 是同一手法（`data-span` 也只在用户显式改过宽度时才出现）。
 * 所以默认配置下 DOM 的**元素数量 / 类名 / 层级一字未动**，只多了 `data-unit="<分区>:<id>"`。
 *
 * ⚠️ 用 `key={id}`：单元之间**不会**因为顺序变化被复用成错误的那个
 * （React 按 key 匹配，顺序变化只是移动 —— 也就不会把"A 的 onClick"留在"B 的按钮"上）。
 */
export function renderChromeUnits<Id extends string, Ctx>(
  ids: readonly Id[],
  map: Record<Id, (c: Ctx) => ReactNode>,
  ctx: Ctx,
  section?: string
): ReactNode[] {
  return ids.map((id) => {
    const f = map[id] as ((c: Ctx) => ReactNode) | undefined;
    const node = f ? f(ctx) : null;
    if (node === null || node === undefined || typeof node === "boolean") return null;   // 条件不满足 / 未知 id：不渲染，也不抛
    if (!isValidElement(node)) return null;
    return cloneElement(node as ReactElement<{ "data-unit"?: string }>, {
      key: id,
      "data-unit": section ? section + ":" + id : id
    });
  });
}
