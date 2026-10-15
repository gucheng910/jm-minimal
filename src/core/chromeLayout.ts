import { UI_KEYS } from "./constants";
import { moveInList, moveToInList, orderize } from "./layoutOrder";
import type { LayoutItem, LayoutSection } from "./layoutOrder";

/**
 * 顶栏 / 底栏 / 阅读器控制条的「单元编排」参数层。
 *
 * 与 `core/detailLayout.ts`（详情页区块）和 `core/listLayout.ts`（列表卡片）**同构**：
 * 只管三件事 —— **有哪些单元、什么顺序、显不显示**，不管像素。
 *
 * ── 为什么要把这三个栏"解离"出来 ─────────────────────────────────────
 * 这三处过去是**写死的 JSX**：顶栏 3 个工具（缓存/搜索/换源）、底栏 4 个标签
 * （首页/分类/搜索/设置）、阅读器控制条 8 个元素（返回/标题/页码 + 进度条 + 4 个工具）。
 * 于是"用户不想要底栏的某项 / 想把搜索挪到最左 / 阅读器只留两个工具"就只能改代码。
 * 解离之后：**每个按钮是一个有 id 的单元**（能单独查、单独排序、单独隐藏、单独在面板里描述），
 * 栏只是"按配置把单元排一排"。渲染层在 `ui/chrome/units.tsx`。
 *
 * ⚠️ 三条纪律（与另两层逐字一致）：
 *   ① **只管顺序 / 显隐，不管像素**；
 *   ② **必需单元不可隐藏**（`hideable: false` 时面板上连开关都不画 —— 画一个点了没反应的
 *      开关比不画更糟）；
 *   ③ **依赖不满足的单元不渲染**（离线时没有"更快的源"、单话作品没有"换话"、
 *      已缓存时按钮变成"已缓存"）—— 那是**运行时条件**，不是配置能决定的；
 *      配置只能在它之上"再藏一层"。
 *
 * ── 默认配置 = 解离前的写死行为（红线）────────────────────────────────
 * `DEFAULT_CHROME_LAYOUT` 的每个顺序表都**逐字等于**改造前 JSX 里的顺序，
 * 且 `hidden` 为空 ⇒ 从没配过的用户看到的 DOM 与改造前**逐字一致**。
 * 这条有单测钉着（`chromeLayout.test.ts` 的"默认顺序 == 历史写死顺序"）。
 */

// ────────────────────────────────────────────────
// 单元 id（按"栏 + 组"分组；组 = 一个独立的顺序表）
// ────────────────────────────────────────────────
export type TopLeftId = "menu" | "title";
export type TopActionId = "cache" | "search" | "source";
export type NavUnitId = "home" | "categories" | "search" | "settings";
export type ReaderTopId = "back" | "title" | "page";
export type ReaderToolId = "source" | "chapter" | "cache" | "settings";
/**
 * 阅读器**状态栏条目**（v3.12，调研 §1 的 P1：**"进度条不是原子单元"**）。
 *
 * 出处：KOReader 的底部状态栏条目可多选、可排序、可自定义文本；Moon+ 在进度条那一行里
 * 塞了 时间 / 电池 / 书名 / 章节页码 / 进度五类条目。它们都证明：进度条是**容器**，
 * 里面放什么应当是**条目**而不是写死的一段。
 *
 * ⚠️ 这一节与别节**极性相反**：默认**全关**。理由是红线 —— 进度条现在只是一根细条，
 * 默认打开任何一条都会改变所有老用户的阅读界面。所以默认 `hidden` 里预置了全部四条，
 * 用户要什么就打开什么（入口在**阅读器的「阅读设置」抽屉**里，见 ui/sheets/ReaderSettingsSheet）。
 *
 * ⚠️ 没有「电池」条目：调研里有（Moon+），但本机没装设备电量插件（Capacitor Device），
 * 拿不到电量 —— 不做一个永远显示不出来、或者显示错值的哑条目。
 */
export type ReaderStatusId = "chapter" | "page" | "pct" | "clock";

/** 分区名。`hidden` 里的条目写成 `"<section>:<id>"` —— 见下面专门一节。 */
export type ChromeSection = "topLeft" | "topActions" | "nav" | "readerTop" | "readerTools" | "readerStatus";

export const TOP_LEFT_IDS: readonly TopLeftId[] = ["menu", "title"];
export const TOP_ACTION_IDS: readonly TopActionId[] = ["cache", "search", "source"];
export const NAV_UNIT_IDS: readonly NavUnitId[] = ["home", "categories", "search", "settings"];
export const READER_TOP_IDS: readonly ReaderTopId[] = ["back", "title", "page"];
export const READER_TOOL_IDS: readonly ReaderToolId[] = ["source", "chapter", "cache", "settings"];
export const READER_STATUS_IDS: readonly ReaderStatusId[] = ["chapter", "page", "pct", "clock"];

export const CHROME_SECTIONS: readonly ChromeSection[] = ["topLeft", "topActions", "nav", "readerTop", "readerTools", "readerStatus"];

/**
 * 编辑器两个页各管哪几个分区（v3.13）。
 *
 * 为什么写在数据层而不是 UI 里：`CustomUiPage` 的「顶栏和底栏」页与「阅读器」页
 * 必须与这里的注册表**同源** —— 分区一旦增删，面板自动跟上，不会出现"新分区没有入口"
 * （那正是本项目最硬的不变量）。UI 里再手写一份数组必然漂移。
 */
export const CHROME_BAR_SECTIONS: readonly ChromeSection[] = ["topLeft", "topActions", "nav"];
export const READER_CHROME_SECTIONS: readonly ChromeSection[] = ["readerTop", "readerTools", "readerStatus"];

// ────────────────────────────────────────────────
// 单元元数据（面板上显示什么、能不能藏、依赖什么状态）
// ────────────────────────────────────────────────
export interface ChromeUnitMeta extends LayoutItem {
  /**
   * 依赖的运行时状态（面板上写出来，省得用户"开了却没出现"以为是 bug）。
   * 注意：**只是说明**，真正的条件在渲染层（`ui/chrome/units.tsx`）里 ——
   * 配置无法伪造运行时状态。
   */
  need?: string;
}

function meta(id: string, label: string, hideable: boolean, note?: string, need?: string): ChromeUnitMeta {
  return need === undefined ? { id, label, hideable, note } : { id, label, hideable, note, need };
}

export const TOP_LEFT_META: Record<TopLeftId, ChromeUnitMeta> = {
  menu: meta("menu", "菜单按钮", false, "抽屉入口（侧滑菜单）；必需单元，不可隐藏"),
  /**
   * ⚠️ v3.13：`title` 从"可隐藏"改成**必需**。
   * 依据是用户第 3 条的原文约束：「顶栏的 JM 极简版的文字和左菜单唤出按钮不可删」。
   * 改动是**向后兼容**的：`normalizeChromeLayout` 本来就会把"必需单元"从 `hidden` 里剔掉，
   * 所以曾经把它藏起来的老配置会自动恢复显示，不需要版本迁移（见 CHROME_LAYOUT_VERSION 的说明）。
   */
  title: meta("title", "应用标题", false, "顶栏左侧那行「JM极简版」；必需单元，不可隐藏")
};

export const TOP_ACTION_META: Record<TopActionId, ChromeUnitMeta> = {
  cache: meta("cache", "缓存", true, "打开缓存中心"),
  search: meta("search", "搜索", true, "跳到搜索页"),
  source: meta("source", "换源", true, "图源 / 线路 / 一键测速")
};

export const NAV_UNIT_META: Record<NavUnitId, ChromeUnitMeta> = {
  /**
   * ⚠️ v3.13：`home` 从"必需"改成**可隐藏**。
   * 用户第 3 条只点名了「底栏的设置按钮不可删」，其余交给用户 —— 所以这里放开。
   * **不会把用户关在门外**：设置页（必需单元）→ 自定义 UI → 顶栏和底栏，这条路永远在，
   * 所以"把首页藏了又想找回来"有确定的入口。note 里把这条路写出来，省得用户以为点坏了。
   */
  home: meta("home", "首页", true, "推荐 / 最新 / 每周必看。藏掉后回首页的入口：设置 → 自定义 UI → 顶栏和底栏"),
  categories: meta("categories", "分类", true, "分类 / 排行榜"),
  search: meta("search", "搜索", true, "跳到搜索页"),
  settings: meta("settings", "设置", false, "设置页的唯一入口；不可隐藏")
};

export const READER_TOP_META: Record<ReaderTopId, ChromeUnitMeta> = {
  back: meta("back", "返回", false, "阅读器唯一的退出入口；不可隐藏"),
  title: meta("title", "作品名", true, "上排中间的标题"),
  page: meta("page", "页码", true, "「当前 / 总页数」")
};

export const READER_TOOL_META: Record<ReaderToolId, ChromeUnitMeta> = {
  source: meta("source", "更快的源", true, "测速并换图源", "仅在线时出现（离线阅读时不渲染）"),
  chapter: meta("chapter", "换话", true, "切换话数", "仅多话作品出现（只有一话时不渲染）"),
  cache: meta("cache", "缓存", true, "缓存本话 / 选择话数；已全部缓存时显示为「已缓存」", "无可用页或正在缓存时禁用"),
  settings: meta("settings", "设置", true, "阅读设置：模式 / 去条纹 / 跳页")
};

/**
 * 状态栏条目（v3.12）。四条**都可开关**（默认全关，见 `ReaderStatusId` 的说明）。
 * `need` 写的是"什么时候有内容"——空值时会渲染成 `-`，不是消失（位置不跳）。
 */
export const READER_STATUS_META: Record<ReaderStatusId, ChromeUnitMeta> = {
  chapter: meta("chapter", "章节名", true, "当前这一话的名字", "单话作品也有名字"),
  page: meta("page", "页码", true, "「当前页 / 总页数」"),
  pct: meta("pct", "百分比", true, "本话读到百分之多少"),
  clock: meta("clock", "时间", true, "当前时间（HH:MM），每分钟自己更新")
};

/** 分区 → 元数据表（面板与渲染层都按它走，避免两处各写一份） */
export function chromeMetaOf(section: ChromeSection): Record<string, ChromeUnitMeta> {
  switch (section) {
    case "topLeft": return TOP_LEFT_META;
    case "topActions": return TOP_ACTION_META;
    case "nav": return NAV_UNIT_META;
    case "readerTop": return READER_TOP_META;
    case "readerTools": return READER_TOOL_META;
    case "readerStatus": return READER_STATUS_META;
  }
}

/** 分区 → 人类可读的名字（面板分区标题 + 报错信息都用它） */
export const CHROME_SECTION_LABEL: Record<ChromeSection, string> = {
  topLeft: "顶栏 · 左侧组",
  topActions: "顶栏 · 工具组",
  nav: "底栏标签",
  readerTop: "阅读器 · 上排",
  readerTools: "阅读器 · 工具",
  readerStatus: "阅读器 · 状态栏"
};

export const CHROME_SECTION_HINT: Record<ChromeSection, string> = {
  // v3.13：这一组两个都是必需单元（用户第 3 条点名的菜单入口与「JM极简版」文字），
  // 所以原来那句"只能决定显示 / 隐藏"已经不成立 —— 面板上的说明必须是**现在**的事实。
  topLeft: "这一组两个都是必需单元（菜单唤出入口 + 应用标题），顺序与显隐都固定",
  topActions: "可以排序：越靠前越靠右（右对齐的一组）",
  nav: "可以排序：越靠前越靠左；只有「设置」不可隐藏",
  readerTop: "顺序固定（返回在最左），只能决定显示 / 隐藏",
  readerTools: "可以排序：越靠前越靠左",
  readerStatus: "默认全关（进度条现在只是一根细条）；打开哪几条就显示哪几条"
};

// ────────────────────────────────────────────────
// 配置
// ────────────────────────────────────────────────
export interface ChromeLayoutConfig {
  version: number;
  topLeft: TopLeftId[];
  topActions: TopActionId[];
  nav: NavUnitId[];
  readerTop: ReaderTopId[];
  readerTools: ReaderToolId[];
  /** 阅读器状态栏条目（v3.12）。顺序 = 显示顺序；**默认四条都在 `hidden` 里**（= 全关） */
  readerStatus: ReaderStatusId[];
  /**
   * 隐藏的单元，条目形如 `"nav:search"` —— **带分区前缀**。
   *
   * 为什么不像另两层那样只写裸 id：这里**同一个 id 会跨分区重名**
   * （`search` 既在顶栏工具组、也在底栏；`title` 既在顶栏左侧组、也在阅读器上排）。
   * 裸 id 会让"藏掉底栏的搜索"顺手把顶栏的搜索也藏了 —— 一个很隐蔽的 bug。
   * 单测里有一条专门钉它（`hide("nav:search")` 之后 `topActions` 里的 search 仍在）。
   */
  hidden: string[];
}

/**
 * 配置版本号。
 *
 * ⚠️ **别为了让一次改动"看起来正式"而随手 bump 它**（v3.13 踩过这个念头）。
 * `normalizeChromeLayout` 的迁移判据是"**源数据的版本号 ≠ 当前版本号**"，而不是"缺不缺某几个键"——
 * 那是为了不覆盖用户的选择。副作用是：任何一次 bump 都会把所有**老版本**用户的
 * `hidden` 重新补上 `V2_DEFAULT_HIDDEN`（四条阅读器状态栏条目），
 * 于是"主动把状态栏四条全打开"的人会被无声地重新关掉。
 * 所以只有**真的需要往 hidden 里补默认项**时才 bump（v1 → v2 就是这种情况）。
 */
export const CHROME_LAYOUT_VERSION = 2;

/**
 * v1 → v2 迁移要补进 `hidden` 的条目（v3.12 的四个状态栏条目）。
 *
 * 为什么需要迁移：这一节**默认全关**（红线：默认打开任何一条都会改变所有老用户的阅读界面）。
 * 光把默认配置写成"全关"不够 —— 老用户浏览器里那份 `hidden: []` 的配置会被原样读回来，
 * 于是四条全部显现。所以按版本号补一次（与 detailLayout 的版本迁移同一手法）。
 */
const V2_DEFAULT_HIDDEN: readonly string[] = READER_STATUS_IDS.map((id) => "readerStatus:" + id);

export const DEFAULT_CHROME_LAYOUT: ChromeLayoutConfig = {
  version: CHROME_LAYOUT_VERSION,
  topLeft: [...TOP_LEFT_IDS],
  topActions: [...TOP_ACTION_IDS],
  nav: [...NAV_UNIT_IDS],
  readerTop: [...READER_TOP_IDS],
  readerTools: [...READER_TOOL_IDS],
  readerStatus: [...READER_STATUS_IDS],
  /**
   * ⚠️ 默认 `hidden` **不是空的**：状态栏那一节（v3.12）默认全关 ——
   * 进度条现在只是一根细条，默认打开任何一条都会改变所有老用户的阅读界面（红线）。
   * 别节仍然默认全开（不在这个数组里 = 显示）。
   */
  hidden: [...V2_DEFAULT_HIDDEN]
};

/** 隐藏集合的 key：`分区:id` */
export function hideKey(section: ChromeSection, id: string): string {
  return section + ":" + id;
}

// ────────────────────────────────────────────────
// 归一化（对脏数据 / 旧版本自愈，规则与另两层共用 orderize）
// ────────────────────────────────────────────────
export function normalizeChromeLayout(raw: unknown): ChromeLayoutConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<ChromeLayoutConfig>;

  const hidden: string[] = [];
  const seen = new Set<string>();
  /**
   * v1 → v2 迁移：给老配置补上"状态栏条目默认全关"，**补在最前面**
   * （`hidden` 语义上是个集合，顺序无所谓；放前面只是让"默认项在前、用户项在后"读起来顺）。
   *
   * 判据是**源数据的版本号**（不是"缺不缺这几条"）：用户可能主动把四条全打开、
   * 也可能主动全关掉 —— 用"缺了才补"会把后者当老配置、把用户的选择覆盖掉。
   */
  if (Number(src.version) !== CHROME_LAYOUT_VERSION) {
    for (const k of V2_DEFAULT_HIDDEN) { seen.add(k); hidden.push(k); }
  }
  if (Array.isArray(src.hidden)) {
    for (const k of src.hidden) {
      if (typeof k !== "string") continue;
      if (seen.has(k)) continue;
      const at = k.indexOf(":");
      if (at <= 0) continue;                                   // 没有分区前缀的旧/脏数据：丢掉
      const section = k.slice(0, at) as ChromeSection;
      if (CHROME_SECTIONS.indexOf(section) < 0) continue;       // 未知分区
      const id = k.slice(at + 1);
      const table = chromeMetaOf(section) as Record<string, ChromeUnitMeta | undefined>;
      const m = table[id];
      if (!m) continue;                                        // 未知单元
      if (!m.hideable) continue;                               // 必需单元强制放出来
      seen.add(k);
      hidden.push(k);
    }
  }

  return {
    version: CHROME_LAYOUT_VERSION,
    topLeft: orderize(src.topLeft, TOP_LEFT_IDS),
    topActions: orderize(src.topActions, TOP_ACTION_IDS),
    nav: orderize(src.nav, NAV_UNIT_IDS),
    readerTop: orderize(src.readerTop, READER_TOP_IDS),
    readerTools: orderize(src.readerTools, READER_TOOL_IDS),
    readerStatus: orderize(src.readerStatus, READER_STATUS_IDS),
    hidden
  };
}

// ────────────────────────────────────────────────
// 查询
// ────────────────────────────────────────────────
export function isChromeHidden(cfg: ChromeLayoutConfig, section: ChromeSection, id: string): boolean {
  return cfg.hidden.indexOf(hideKey(section, id)) >= 0;
}

/** 分区 → 该分区的 id 类型（让 `visibleChromeUnits` 返回**精确**的联合，而不是 string） */
type SectionIds<S extends ChromeSection> =
  S extends "topLeft" ? TopLeftId
  : S extends "topActions" ? TopActionId
  : S extends "nav" ? NavUnitId
  : S extends "readerTop" ? ReaderTopId
  : S extends "readerTools" ? ReaderToolId
  : ReaderStatusId;

/** 某个分区里**要渲染的**单元顺序（已按配置排序，并去掉隐藏项） */
export function visibleChromeUnits<S extends ChromeSection>(cfg: ChromeLayoutConfig, section: S): SectionIds<S>[] {
  const order = cfg[section] as readonly string[];
  return order.filter((id) => !isChromeHidden(cfg, section, id)) as SectionIds<S>[];
}

// ────────────────────────────────────────────────
// 编辑（面板 / 未来的编辑器用；纯函数，返回新配置）
// ────────────────────────────────────────────────
/** 切换某个单元的显隐。必需单元原样返回（同引用 ⇒ 调用方省掉一次重渲染） */
export function toggleChromeUnit(cfg: ChromeLayoutConfig, section: ChromeSection, id: string): ChromeLayoutConfig {
  const table = chromeMetaOf(section) as Record<string, ChromeUnitMeta | undefined>;
  const m = table[id];
  if (!m || !m.hideable) return cfg;
  const key = hideKey(section, id);
  const hidden = cfg.hidden.indexOf(key) >= 0
    ? cfg.hidden.filter((k) => k !== key)
    : [...cfg.hidden, key];
  return { ...cfg, version: CHROME_LAYOUT_VERSION, hidden };
}

/** 在某个分区里把单元前后移 delta 位（跨分区不会互相挤动） */
export function moveChromeUnit(cfg: ChromeLayoutConfig, section: ChromeSection, id: string, delta: number): ChromeLayoutConfig {
  const list = cfg[section] as readonly string[];
  const next = moveInList(list, id, delta);
  if (!next || next === list) return cfg;   // 不在这个分区 / 已经到头
  return { ...cfg, version: CHROME_LAYOUT_VERSION, [section]: next } as ChromeLayoutConfig;
}

/** 拖拽排序：把单元拖到分区的第 index 位 */
export function moveChromeUnitTo(cfg: ChromeLayoutConfig, section: ChromeSection, id: string, index: number): ChromeLayoutConfig {
  const list = cfg[section] as readonly string[];
  const next = moveToInList(list, id, index);
  if (!next || next === list) return cfg;
  return { ...cfg, version: CHROME_LAYOUT_VERSION, [section]: next } as ChromeLayoutConfig;
}

/**
 * 在**可见顺序**里把某个单元前后移 delta 位（v3.13，配置面板的 ▲▼ 用它）。
 *
 * ⚠️ 为什么不直接 `moveChromeUnit`（在原始数组上换位）：隐藏项**仍然占着表里的位置**，
 * 于是"上移一格"很可能只是和某个隐藏项换了位置 —— 屏幕上**毫无变化**，用户只会以为按钮坏了。
 * （detailLayout 的 `moveVisibleNodeTo` 早就是这条口径，这里是同一套折算：
 *  先把被移项摘掉 → 在**余下的可见顺序**里定位锚点 → 再折算回原始数组的下标。）
 */
export function moveChromeUnitVisible(cfg: ChromeLayoutConfig, section: ChromeSection, id: string, delta: number): ChromeLayoutConfig {
  const raw = cfg[section] as readonly string[];
  if (raw.indexOf(id) < 0) return cfg;                          // 不在这个分区里
  const vis = raw.filter((x) => !isChromeHidden(cfg, section, x));
  const i = vis.indexOf(id);
  if (i < 0) return cfg;                                        // 自己被隐藏了：回调方本来就该禁用它
  const to = i + delta;
  if (to < 0 || to >= vis.length) return cfg;                   // 到头了（同值返回 ⇒ 调用方零重渲染）
  const rest = vis.filter((x) => x !== id);
  const anchor = to < rest.length ? rest[to] : null;            // null = 落到末尾
  const rawRest = raw.filter((x) => x !== id);
  const at = anchor ? rawRest.indexOf(anchor) : rawRest.length;
  const next = moveToInList(raw, id, at);
  if (!next || next === raw) return cfg;
  return { ...cfg, version: CHROME_LAYOUT_VERSION, [section]: next } as ChromeLayoutConfig;
}

/** 恢复默认（不写盘；与另两层的 reset* 同义） */
export function resetChromeLayout(): ChromeLayoutConfig {
  return {
    version: CHROME_LAYOUT_VERSION,
    topLeft: [...TOP_LEFT_IDS],
    topActions: [...TOP_ACTION_IDS],
    nav: [...NAV_UNIT_IDS],
    readerTop: [...READER_TOP_IDS],
    readerTools: [...READER_TOOL_IDS],
    readerStatus: [...READER_STATUS_IDS],
    hidden: [...V2_DEFAULT_HIDDEN]
  };
}

/**
 * 面板用的分区视图（产出与 detailLayout / listLayout **同一个** `LayoutSection` 类型）。
 *
 * 必需单元（`hideable: false`）也会出现在 items 里 —— 面板负责"开关不画但条目还在"，
 * 这样用户能看到"这里有个必需的东西"，而不是疑惑"为什么菜单按钮不在列表里"。
 */
export function chromeLayoutSections(cfg: ChromeLayoutConfig): LayoutSection[] {
  return CHROME_SECTIONS.map((section) => ({
    key: section,
    label: CHROME_SECTION_LABEL[section],
    hint: CHROME_SECTION_HINT[section],
    items: (cfg[section] as readonly string[]).map((id) => {
      const m = (chromeMetaOf(section) as Record<string, ChromeUnitMeta | undefined>)[id]!;
      const note = m.need ? (m.note ? m.note + "｜" + m.need : m.need) : m.note;
      return note === undefined ? { id: m.id, label: m.label, hideable: m.hideable } : { id: m.id, label: m.label, hideable: m.hideable, note };
    })
  }));
}

// ────────────────────────────────────────────────
// 持久化（与 detailLayout / listLayout 同级：localStorage + 读时自愈）
// ────────────────────────────────────────────────
export function loadChromeLayout(): ChromeLayoutConfig {
  try {
    const raw = localStorage.getItem(UI_KEYS.chromeLayout);
    if (!raw) return resetChromeLayout();
    return normalizeChromeLayout(JSON.parse(raw));
  } catch {
    // JSON 坏了 / localStorage 被禁用（隐私模式）→ 回默认，绝不抛
    return resetChromeLayout();
  }
}

export function saveChromeLayout(cfg: ChromeLayoutConfig): void {
  try {
    localStorage.setItem(UI_KEYS.chromeLayout, JSON.stringify(normalizeChromeLayout(cfg)));
  } catch { /* 隐私模式：本次会话内仍然生效 */ }
}
