import { UI_KEYS } from "./constants";
import { moveInList, moveToInList, orderize } from "./layoutOrder";
import type { LayoutSection } from "./layoutOrder";
import type { AlbumSummary } from "./types";

/**
 * 列表页「展示编排」参数层。与 core/detailLayout.ts 同构 —— 那一层管详情页，这一层管**列表卡片**。
 *
 * 编排的是两件事：
 *   1. 卡片副标题里出现哪几个字段、以什么顺序出现
 *      （今天写死成 `[album.author, album.category?.title, album.sub].filter(Boolean).join(" · ")`）；
 *   2. 每行几列（今天纯靠断点：手机 3 列，>620px 2 列，更宽 4 / 6 列）。
 *
 * 为什么列表页能编排的东西**比详情页少**（这是刻意的，不是没做完）：
 *   详情页是**有限页面**，区块顺序真的会变；列表页是无限滚动网格，
 *   把"工具行 / 错误卡 / 网格 / 加载中"重排没有意义——网格必须占主体，
 *   错误卡和空态是互斥状态而不是可摆放的模块。
 *   所以这里编排的是**卡片内部**，也就是用户真正会盯着看的那一行小字。
 *
 * ⚠️ 与 detailLayout 同一条纪律：**只管顺序 / 显隐 / 列数，不管像素**。
 *   列数是"2 列 / 3 列 / 自适应"这种档位，不是宽度数值。
 */

// ────────────────────────────────────────────────
// 卡片副标题：.list-item .muted 里那几个字段
// ────────────────────────────────────────────────
export type ListFieldId = "author" | "category" | "sub";

export interface ListFieldMeta {
  label: string;
  /** 这个字段取自 AlbumSummary 的哪里（面板上写出来，省得猜） */
  from: string;
  hideable: boolean;
}

export const LIST_FIELD_META: Record<ListFieldId, ListFieldMeta> = {
  author: { label: "作者", from: "album.author", hideable: true },
  category: { label: "分类", from: "album.category.title", hideable: true },
  sub: { label: "副标题", from: "album.sub（章节 / 页数）", hideable: true }
};

export const LIST_FIELD_IDS: readonly ListFieldId[] = ["author", "category", "sub"];

// ────────────────────────────────────────────────
// 每行列数
// ────────────────────────────────────────────────
/**
 * `"auto"` = 跟随断点（也就是今天的行为，默认值）。
 * 写死 2 / 3 会覆盖所有断点 —— 这是有意的：用户选了就不该被屏幕宽度改回去。
 */
export type ListColumns = "auto" | 2 | 3;

export const LIST_COLUMN_OPTIONS: ReadonlyArray<{ value: ListColumns; label: string; hint: string }> = [
  { value: "auto", label: "自适应", hint: "跟随屏幕宽度（默认）" },
  { value: 3, label: "3 列", hint: "和手机默认一致" },
  { value: 2, label: "2 列", hint: "封面更大，适合窄屏" }
];

// ────────────────────────────────────────────────
// 卡片形态（v3.14）
// ────────────────────────────────────────────────
/**
 * 卡片的**形态**。与详情页区块的「形态」是同一个词、同一层意思：同一块内容的不同外观。
 *
 * 出处（本仓库 `jm-custom-forms-research-pages.md` §"形态（网格/列表）"）：
 *   · Mihon 书架支持**网格 / 列表**切换（`LibrarySettingsSheet` 一族）；
 *   · Kotatsu 干脆有两套卡片布局：`item_manga_grid.xml` / `item_manga_list.xml`，
 *     两者的 `@+id/badge` 都是**压在封面上的**角标 —— 也就是本层的 `overlay` 那一档
 *     在成熟产品里确实存在（不是我们编的）。
 *
 * ⚠️ 与「每行列数」的**轴冲突**（本项目第 ① 条轴冲突规则：一个轴不能悄悄改另一个轴）：
 *   `form === "row"`（单列行卡）恒为 1 列，于是「每行列数」在这一形态下**不生效**。
 *   处理办法不是"读的时候偷偷忽略"，而是**面板上不显示**（`listColumnsClass` 也返回空串）——
 *   "面板上看得见的 == 读出来生效的"，与详情页的 `formsFor` 是同一条纪律。
 */
export type ListCardForm = "poster" | "overlay" | "row";

export const LIST_FORM_OPTIONS: ReadonlyArray<{ value: ListCardForm; label: string; hint: string }> = [
  { value: "poster", label: "海报", hint: "封面在上、文字在下（与现在一致）" },
  { value: "overlay", label: "封面压字", hint: "标题压在封面底部：省掉封面下面那一行，一屏能多放一行" },
  { value: "row", label: "单列行", hint: "封面在左、文字在右的一整行；此时「每行列数」不生效" }
];

// ────────────────────────────────────────────────
// 标题行数（v3.14）
// ────────────────────────────────────────────────
/** 卡片标题最多显示几行（原来是 CSS 里写死的 2 行） */
export type ListTitleLines = 2 | 1;

export const LIST_TITLE_OPTIONS: ReadonlyArray<{ value: ListTitleLines; label: string; hint: string }> = [
  { value: 2, label: "2 行", hint: "与现在一致（长标题折两行）" },
  { value: 1, label: "1 行", hint: "标题只留一行：更紧凑，但长标题会被省略" }
];

/** 形态 → 网格容器上的类名（默认形态**不加类** ⇒ 与改造前逐字一致） */
export function listFormClass(cfg: ListLayoutConfig): string {
  return cfg.form === "overlay" ? "form-overlay" : cfg.form === "row" ? "form-row" : "";
}

/** 标题行数 → 类名（默认 2 行**不加类**） */
export function listTitleClass(cfg: ListLayoutConfig): string {
  return cfg.titleLines === 1 ? "title-1" : "";
}

/** 行卡形态下「每行列数」不生效（见 `ListCardForm` 的说明） */
export function formUsesColumns(cfg: ListLayoutConfig): boolean {
  return cfg.form !== "row";
}

// ────────────────────────────────────────────────
// 配置
// ────────────────────────────────────────────────
export interface ListLayoutConfig {
  version: number;
  /** 副标题字段顺序 */
  fields: ListFieldId[];
  hidden: ListFieldId[];
  columns: ListColumns;
  /** 卡片形态（v3.14） */
  form: ListCardForm;
  /** 标题最多几行（v3.14） */
  titleLines: ListTitleLines;
}

/**
 * v1 → v2（v3.14 的形态 / 标题行数）。
 *
 * ⚠️ 这一次**不需要**任何迁移代码，也**不要**写"版本不等于 2 就补点什么"：
 * 两个新轴的默认值恰好就是改造前的行为（`poster` = 封面在上文字在下、`2` 行 = CSS 里写死的值），
 * 所以老配置读回来什么都不用补，渲染逐字不变。
 * （对照：`chromeLayout` 的 v1→v2 必须补，因为那一节默认**全关** —— 有区别才要迁移。）
 */
export const LIST_LAYOUT_VERSION = 2;

export const DEFAULT_LIST_LAYOUT: ListLayoutConfig = {
  version: LIST_LAYOUT_VERSION,
  fields: [...LIST_FIELD_IDS],   // 作者 · 分类 · 副标题 —— 与今天写死的顺序逐字一致
  hidden: [],
  columns: "auto",               // 与今天"纯靠断点"逐字一致
  form: "poster",                // 与今天"封面在上、文字在下"逐字一致
  titleLines: 2                  // 与今天 CSS 里写死的 -webkit-line-clamp: 2 逐字一致
};

// ────────────────────────────────────────────────
// 归一化：对脏数据 / 旧版本数据自愈（与 detailLayout 同一套规则，实现共用）
// ────────────────────────────────────────────────
export function normalizeListLayout(raw: unknown): ListLayoutConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<ListLayoutConfig>;

  const hidden = new Set<ListFieldId>();
  if (Array.isArray(src.hidden)) {
    for (const id of src.hidden) {
      if (typeof id !== "string") continue;
      if (!(id in LIST_FIELD_META)) continue;                      // 未知 id 丢掉
      if (!LIST_FIELD_META[id as ListFieldId].hideable) continue;  // 不许藏的字段强制放出来
      hidden.add(id as ListFieldId);
    }
  }

  return {
    version: LIST_LAYOUT_VERSION,
    fields: orderize(src.fields, LIST_FIELD_IDS),
    hidden: [...hidden],
    // 列数非法（老版本没有这个字段 / 被改坏）→ 回自适应，而不是渲染出个 0 列网格
    columns: src.columns === 2 || src.columns === 3 ? src.columns : "auto",
    form: pickForm(src.form),
    titleLines: src.titleLines === 1 ? 1 : 2
  };
}

/** 形态自愈：非法值回 `poster`（= 改造前的行为），而不是回某个"看起来更现代"的档位 */
function pickForm(v: unknown): ListCardForm {
  return v === "overlay" || v === "row" || v === "poster" ? v : "poster";
}

// ────────────────────────────────────────────────
// 查询
// ────────────────────────────────────────────────
export function isListFieldHidden(cfg: ListLayoutConfig, id: ListFieldId): boolean {
  return cfg.hidden.indexOf(id) >= 0;
}

/** 按配置顺序取出要显示的字段 */
export function visibleListFields(cfg: ListLayoutConfig): ListFieldId[] {
  return cfg.fields.filter((id) => !isListFieldHidden(cfg, id));
}

/** 取某个字段在给定作品上的值 */
function fieldValue(album: AlbumSummary, id: ListFieldId): string {
  switch (id) {
    case "author": return String(album.author || "");
    case "category": return String(album.category?.title || "");
    case "sub": return String(album.sub || "");
  }
}

/**
 * 卡片副标题的最终文案。
 *
 * 默认配置下（作者·分类·副标题全开）**与改造前那句写死的 join 逐字等价**：
 *   `[album.author, album.category?.title, album.sub].filter(Boolean).join(" · ")`
 * `.filter(Boolean)` 对应的就是这里的 `.filter(Boolean)` —— 空字段不会留下多余的分隔点。
 */
export function listSubtitle(cfg: ListLayoutConfig, album: AlbumSummary): string {
  return visibleListFields(cfg)
    .map((id) => fieldValue(album, id))
    .filter(Boolean)
    .join(" · ");
}

/**
 * 网格容器要加的类名。空串 = 不加类 = 完全跟随断点（今天的行为）。
 * 之所以用"加一个类"而不是内联 style：内联 gridTemplateColumns 会盖掉断点，
 * 而我们要的是"用户选了才盖" —— 不选的时候连属性都不该出现。
 */
export function listColumnsClass(cfg: ListLayoutConfig): string {
  // 行卡形态恒 1 列：返回空串 ⇒ 配置里的列数档位在这一形态下**真的不生效**
  // （不是靠 CSS 源码顺序去压，那样"读出来生效的"就说不清了，见 ListCardForm 的说明）
  if (!formUsesColumns(cfg)) return "";
  return cfg.columns === 2 ? "cols-2" : cfg.columns === 3 ? "cols-3" : "";
}

/**
 * 配置面板用的分区视图（与 detailLayoutSections 同构，产出同一个通用类型）。
 *
 * 这里只有**一个**分区，是刻意的：列表卡片的副标题就是一行字符串，
 * 三个字段同属那一行，分不出第二个独立的顺序表来。
 * 面板的 `extra` 槽位用来放"每行列数"这个档位选择器（它是值，不是顺序）。
 */
export function listLayoutSections(cfg: ListLayoutConfig): LayoutSection[] {
  return [{
    key: "fields",
    label: "卡片副标题",
    hint: "卡片标题下面那一行小字，从上到下拼成一句",
    items: cfg.fields.map((id) => ({
      id,
      label: LIST_FIELD_META[id].label,
      hideable: LIST_FIELD_META[id].hideable,
      note: LIST_FIELD_META[id].from
    }))
  }];
}

// ────────────────────────────────────────────────
// 变更（纯函数：入参不改，返回新对象）
// ────────────────────────────────────────────────
export function moveListField(cfg: ListLayoutConfig, id: ListFieldId, delta: number): ListLayoutConfig {
  const next = moveInList(cfg.fields, id, delta);
  if (next === null) return cfg;   // 不在表里（理论上不会）
  if (next === cfg.fields) return cfg; // 到头了
  return { ...cfg, fields: next as ListFieldId[] };
}

/** **拖拽**排序：拖到第 index 位。语义同 moveListField，只是位移方式不同（一次跳多位） */
export function moveListFieldTo(cfg: ListLayoutConfig, id: ListFieldId, index: number): ListLayoutConfig {
  const next = moveToInList(cfg.fields, id, index);
  if (next === null) return cfg;
  if (next === cfg.fields) return cfg;
  return { ...cfg, fields: next as ListFieldId[] };
}

export function setListFieldHidden(cfg: ListLayoutConfig, id: ListFieldId, hidden: boolean): ListLayoutConfig {
  const meta = LIST_FIELD_META[id];
  if (!meta || !meta.hideable) return cfg;
  const has = cfg.hidden.indexOf(id) >= 0;
  if (has === hidden) return cfg;
  return { ...cfg, hidden: hidden ? [...cfg.hidden, id] : cfg.hidden.filter((x) => x !== id) };
}

export function setListColumns(cfg: ListLayoutConfig, columns: ListColumns): ListLayoutConfig {
  if (cfg.columns === columns) return cfg;
  return { ...cfg, columns };
}

/** 换形态。⚠️ 只改形态，**不顺手改列数**（轴冲突规则：一个轴不能悄悄改另一个轴） */
export function setListForm(cfg: ListLayoutConfig, form: ListCardForm): ListLayoutConfig {
  if (cfg.form === form) return cfg;
  return { ...cfg, form };
}

export function setListTitleLines(cfg: ListLayoutConfig, titleLines: ListTitleLines): ListLayoutConfig {
  if (cfg.titleLines === titleLines) return cfg;
  return { ...cfg, titleLines };
}

/** 恢复默认 */
export function resetListLayout(): ListLayoutConfig {
  return { ...DEFAULT_LIST_LAYOUT, fields: [...DEFAULT_LIST_LAYOUT.fields], hidden: [] };
}

// ────────────────────────────────────────────────
// 持久化（与 theme / tapZones / detailLayout 同级：localStorage + 读时自愈）
// ────────────────────────────────────────────────
export function loadListLayout(): ListLayoutConfig {
  try {
    const raw = localStorage.getItem(UI_KEYS.listLayout);
    if (!raw) return resetListLayout();
    return normalizeListLayout(JSON.parse(raw));
  } catch {
    // JSON 坏了 / localStorage 被禁用（隐私模式）→ 回默认，绝不抛
    return resetListLayout();
  }
}

export function saveListLayout(cfg: ListLayoutConfig): void {
  try {
    localStorage.setItem(UI_KEYS.listLayout, JSON.stringify(normalizeListLayout(cfg)));
  } catch { /* 隐私模式：静默降级，本次会话内仍然生效 */ }
}
