// @vitest-environment jsdom
/**
 * 列表页展示编排参数层。
 *
 * 这里最重要的一条是「**默认必须与改造前逐字一致**」：
 * 改造前那句写死的是 `[album.author, album.category?.title, album.sub].filter(Boolean).join(" · ")`，
 * 所以测试里**把原式照抄一遍**，拿它当基准去比 —— 只要默认配置下两者不等，就是回归。
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  DEFAULT_LIST_LAYOUT,
  LIST_COLUMN_OPTIONS,
  LIST_FIELD_META,
  LIST_FORM_OPTIONS,
  LIST_LAYOUT_VERSION,
  LIST_TITLE_OPTIONS,
  formUsesColumns,
  listColumnsClass,
  listFormClass,
  listSubtitle,
  listTitleClass,
  loadListLayout,
  moveListField,
  normalizeListLayout,
  resetListLayout,
  saveListLayout,
  setListColumns,
  setListFieldHidden,
  setListForm,
  setListTitleLines,
  visibleListFields
} from "./listLayout";
import { UI_KEYS } from "./constants";
import type { AlbumSummary } from "./types";

beforeEach(() => localStorage.clear());

/** 改造前源码里那一句，逐字照抄 —— 作为"默认不许变"的基准 */
const oldSubtitle = (a: AlbumSummary) =>
  [a.author, a.category?.title, a.sub].filter(Boolean).join(" · ");

const ALBUMS: AlbumSummary[] = [
  { id: 1, name: "全都有", author: "作者甲", category: { title: "分类A" }, sub: "读到 第3话" },
  { id: 2, name: "缺sub", author: "作者乙", category: { title: "分类B" } },
  { id: 3, name: "只有作者", author: "作者丙" },
  { id: 4, name: "只有分类", category: { title: "分类C" } },
  { id: 5, name: "什么都没有" },
  { id: 6, name: "空串字段", author: "", category: { title: "" }, sub: "" },
  { id: 7, name: "category 没有 title", author: "作者丁", category: {} },
  { id: 8, name: "sub 是派生字段", author: "作者戊", category: { title: "分类D" }, sub: "共 12 页" }
];

describe("默认值：与改造前逐字一致", () => {
  it("字段顺序 = 作者 · 分类 · 副标题；列数 = 自适应", () => {
    expect(DEFAULT_LIST_LAYOUT.fields).toEqual(["author", "category", "sub"]);
    expect(DEFAULT_LIST_LAYOUT.hidden).toEqual([]);
    expect(DEFAULT_LIST_LAYOUT.columns).toBe("auto");
  });

  it("【关键】8 种字段组合下，listSubtitle 都与改造前那句写死的 join 完全相同", () => {
    const cfg = resetListLayout();
    for (const a of ALBUMS) {
      expect(listSubtitle(cfg, a), "作品「" + a.name + "」").toBe(oldSubtitle(a));
    }
  });

  it("列数为自适应时**不加任何类**（不选就不该出现属性）", () => {
    expect(listColumnsClass(resetListLayout())).toBe("");
  });

  it("空字段不会留下多余的分隔点", () => {
    const cfg = resetListLayout();
    expect(listSubtitle(cfg, { id: 9, name: "x", author: "只作者" })).toBe("只作者");
    expect(listSubtitle(cfg, { id: 9, name: "x", author: "甲", sub: "乙" })).toBe("甲 · 乙");
  });
});

describe("字段显隐与顺序", () => {
  it("关掉「分类」→ 分类与它带来的分隔点一起消失", () => {
    const cfg = setListFieldHidden(resetListLayout(), "category", true);
    expect(visibleListFields(cfg)).toEqual(["author", "sub"]);
    expect(listSubtitle(cfg, ALBUMS[0])).toBe("作者甲 · 读到 第3话");
  });

  it("全关掉 → 空串（卡片就只剩封面和标题）", () => {
    let cfg = resetListLayout();
    for (const id of ["author", "category", "sub"] as const) cfg = setListFieldHidden(cfg, id, true);
    expect(visibleListFields(cfg)).toEqual([]);
    expect(listSubtitle(cfg, ALBUMS[0])).toBe("");
  });

  it("上移/下移改变顺序，从而改变文案里字段的先后", () => {
    const cfg = moveListField(resetListLayout(), "sub", -1); // sub 从第 3 位移到第 2 位
    expect(cfg.fields).toEqual(["author", "sub", "category"]);
    expect(listSubtitle(cfg, ALBUMS[0])).toBe("作者甲 · 读到 第3话 · 分类A");
  });

  it("到头了就不动（首项上移 / 末项下移）", () => {
    const base = resetListLayout();
    expect(moveListField(base, "author", -1)).toBe(base);
    expect(moveListField(base, "sub", 1)).toBe(base);
  });

  it("隐藏后再显示能回到原位（顺序不因隐藏而丢）", () => {
    let cfg = setListFieldHidden(resetListLayout(), "category", true);
    cfg = setListFieldHidden(cfg, "category", false);
    expect(cfg.fields).toEqual(["author", "category", "sub"]);
    expect(cfg.hidden).toEqual([]);
  });
});

describe("列数", () => {
  it("2 / 3 各自映射到对应类名", () => {
    expect(listColumnsClass(setListColumns(resetListLayout(), 2))).toBe("cols-2");
    expect(listColumnsClass(setListColumns(resetListLayout(), 3))).toBe("cols-3");
  });

  it("设成同一个值返回原对象（不制造无意义的重渲染）", () => {
    const base = resetListLayout();
    expect(setListColumns(base, "auto")).toBe(base);
  });

  it("选项表里第一项是默认的自适应", () => {
    expect(LIST_COLUMN_OPTIONS[0].value).toBe("auto");
    expect(LIST_COLUMN_OPTIONS.map((o) => o.value)).toEqual(["auto", 3, 2]);
  });
});

describe("归一化：脏数据 / 旧版本自愈", () => {
  it("未知字段丢掉", () => {
    const cfg = normalizeListLayout({ fields: ["sub", "不存在的字段", "author"], hidden: [] });
    expect(cfg.fields).toEqual(["sub", "author", "category"]); // category 缺失 → 补到尾部
  });

  it("缺失字段补到尾部（将来新增字段，老配置会自动带上）", () => {
    const cfg = normalizeListLayout({ fields: ["sub"], hidden: [] });
    expect(cfg.fields).toEqual(["sub", "author", "category"]);
  });

  it("重复字段去重", () => {
    expect(normalizeListLayout({ fields: ["sub", "sub", "author"] }).fields).toEqual(["sub", "author", "category"]);
  });

  it("hidden 里的未知字段丢掉", () => {
    expect(normalizeListLayout({ hidden: ["author", "幽灵字段"] }).hidden).toEqual(["author"]);
  });

  it("列数非法 → 回自适应（不渲染出个 0 列网格）", () => {
    expect(normalizeListLayout({ columns: 7 }).columns).toBe("auto");
    expect(normalizeListLayout({ columns: "3" }).columns).toBe("auto");   // 字符串不算
    expect(normalizeListLayout({ columns: null }).columns).toBe("auto");
    expect(normalizeListLayout({}).columns).toBe("auto");
  });

  it("列数合法时保留", () => {
    expect(normalizeListLayout({ columns: 2 }).columns).toBe(2);
    expect(normalizeListLayout({ columns: 3 }).columns).toBe(3);
  });

  it("完全不是对象 / null / 字符串 → 回落默认", () => {
    for (const bad of [null, undefined, "x", 42, true]) {
      expect(normalizeListLayout(bad)).toEqual(DEFAULT_LIST_LAYOUT);
    }
  });

  it("version 总是被写成当前版本（结构迁移的锚点）", () => {
    expect(normalizeListLayout({ version: 99 }).version).toBe(DEFAULT_LIST_LAYOUT.version);
  });

  it("每个字段都标了来源，面板上要显示", () => {
    expect(LIST_FIELD_META.author.from).toBe("album.author");
    expect(LIST_FIELD_META.category.from).toBe("album.category.title");
    expect(LIST_FIELD_META.sub.label).toBe("副标题");
  });
});

describe("持久化", () => {
  it("存了再读能往返（含隐藏、顺序、列数）", () => {
    let cfg = setListFieldHidden(resetListLayout(), "category", true);
    cfg = moveListField(cfg, "sub", -1);
    cfg = setListColumns(cfg, 2);
    saveListLayout(cfg);
    expect(loadListLayout()).toEqual(cfg);
  });

  it("保存时也会 normalize（存进去的一定合法）", () => {
    saveListLayout({ version: 0, fields: ["幽灵"], hidden: ["幽灵"], columns: 9 } as never);
    const raw = JSON.parse(localStorage.getItem(UI_KEYS.listLayout) || "{}");
    expect(raw.fields).toEqual(["author", "category", "sub"]);
    expect(raw.hidden).toEqual([]);
    expect(raw.columns).toBe("auto");
  });

  it("没存过 → 默认", () => {
    expect(loadListLayout()).toEqual(DEFAULT_LIST_LAYOUT);
  });

  it("JSON 坏了 → 默认，不抛", () => {
    localStorage.setItem(UI_KEYS.listLayout, "{ 不是 JSON");
    expect(loadListLayout()).toEqual(DEFAULT_LIST_LAYOUT);
  });

  it("用的 key 是 UI_KEYS.listLayout（别处按这个 key 清数据）", () => {
    saveListLayout(resetListLayout());
    expect(localStorage.getItem(UI_KEYS.listLayout)).toBeTruthy();
    expect(localStorage.getItem(UI_KEYS.detailLayout)).toBeNull(); // 不与详情页那层串key
  });
});

/**
 * v3.14 新增的两个轴：**卡片形态**与**标题行数**。
 *
 * 这一组的判别性在两处：
 *   · 默认档必须**一个类都不加**（否则"从没配过的用户 DOM 逐字不变"这条红线就破了）；
 *   · 轴冲突①（形态 × 列数）必须**在模型层就断掉**，而不是靠 CSS 源码顺序去压 ——
 *     靠 CSS 的话"面板上看得见的"与"读出来生效的"就说不清了。
 */
describe("v3.14 形态 / 标题行数", () => {
  it("默认：形态 poster、标题 2 行，且**三个类名函数都返回空串**（红线）", () => {
    const cfg = resetListLayout();
    expect(cfg.form).toBe("poster");
    expect(cfg.titleLines).toBe(2);
    expect(listFormClass(cfg)).toBe("");
    expect(listTitleClass(cfg)).toBe("");
    expect(listColumnsClass(cfg)).toBe("");
  });

  it("形态 → 类名：海报不加类，压字 / 单列行各一个类", () => {
    const base = resetListLayout();
    expect(listFormClass(setListForm(base, "overlay"))).toBe("form-overlay");
    expect(listFormClass(setListForm(base, "row"))).toBe("form-row");
  });

  it("标题 1 行 → `title-1`（2 行是默认，不加类）", () => {
    const base = resetListLayout();
    expect(listTitleClass(setListTitleLines(base, 1))).toBe("title-1");
    expect(listTitleClass(setListTitleLines(base, 2))).toBe("");
  });

  it("★ 轴冲突①：单列行形态下「每行列数」**不生效**（模型层就断掉）", () => {
    const row = setListForm(setListColumns(resetListLayout(), 3), "row");
    expect(formUsesColumns(row)).toBe(false);
    expect(listColumnsClass(row)).toBe("");          // 配了 3 列也不出类 ⇒ 真的没生效
    // 负对照：同样的列数在别的形态下**照旧生效**（别把这条写成"列数永远不起作用"）
    const overlay = setListForm(setListColumns(resetListLayout(), 3), "overlay");
    expect(formUsesColumns(overlay)).toBe(true);
    expect(listColumnsClass(overlay)).toBe("cols-3");
  });

  it("★ 轴独立性：换形态**不顺手改列数**，改列数也不动形态", () => {
    const cfg = setListColumns(resetListLayout(), 2);
    const row = setListForm(cfg, "row");
    expect(row.columns).toBe(2);                     // 配置里的值原样留着（只是暂时不生效）
    expect(setListColumns(row, 3).form).toBe("row");
    // 切回海报 → 那个 2 列立刻又生效（"暂时不生效"必须是可逆的，否则就是偷偷改了配置）
    expect(listColumnsClass(setListForm(row, "poster"))).toBe("cols-2");
  });

  it("等值调用返回**同一个引用**（省掉一次重渲染）", () => {
    const cfg = resetListLayout();
    expect(setListForm(cfg, "poster")).toBe(cfg);
    expect(setListTitleLines(cfg, 2)).toBe(cfg);
  });

  it("归一化：非法形态 → 回 poster（= 改造前的行为），不是回某个「更现代」的档位", () => {
    for (const bad of ["grid", "", null, 3, {}, []]) {
      expect(normalizeListLayout({ form: bad }).form).toBe("poster");
    }
  });

  it("归一化：标题行数只认 1，其余（含 3 / \"1\" / null）都回 2 行", () => {
    expect(normalizeListLayout({ titleLines: 1 }).titleLines).toBe(1);
    for (const bad of [3, "1", 0, null, undefined]) {
      expect(normalizeListLayout({ titleLines: bad }).titleLines).toBe(2);
    }
  });

  it("★ v1 老配置读回来**无损**：新轴补默认值，其余的字段一个都不动", () => {
    // v1 时代存下来的配置：没有 form / titleLines 两个字段
    const v1 = { version: 1, fields: ["sub", "author", "category"], hidden: ["category"], columns: 3 };
    const cfg = normalizeListLayout(v1);
    expect(cfg.fields).toEqual(["sub", "author", "category"]);
    expect(cfg.hidden).toEqual(["category"]);
    expect(cfg.columns).toBe(3);
    expect(cfg.form).toBe("poster");
    expect(cfg.titleLines).toBe(2);
    expect(cfg.version).toBe(LIST_LAYOUT_VERSION);
    // 且渲染层看到的三个类名与"从没配过、只改了列数"完全一致
    expect([listFormClass(cfg), listColumnsClass(cfg), listTitleClass(cfg)]).toEqual(["", "cols-3", ""]);
  });

  it("选项表与类型同源（面板直接迭代它，别处不重写一份）", () => {
    expect(LIST_FORM_OPTIONS.map((o) => o.value)).toEqual(["poster", "overlay", "row"]);
    expect(LIST_TITLE_OPTIONS.map((o) => o.value)).toEqual([2, 1]);
    expect(LIST_COLUMN_OPTIONS.map((o) => o.value)).toEqual(["auto", 3, 2]);
  });
});
