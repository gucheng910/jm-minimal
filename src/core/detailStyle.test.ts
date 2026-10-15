// @vitest-environment jsdom
/**
 * 详情页版面样式参数层（core/detailStyle.ts）。
 *
 * 最要紧的一条是「**默认配置下不产生任何 DOM 差异**」：
 * `detailStyleAttrs()` 只输出非默认项，`coverBoxStyle/titleStyle/descStyle` 只在非默认时
 * 给内联 style —— 没改过设置的用户看到的 DOM 与本层引入之前逐字一致。
 * 这条一旦破了，就是"什么都没动却变了样"，且很难查。
 *
 * v2 新增两类契约：
 *   · **v1 → v2 迁移**：老的 s/m/l、"2"/"3"/"4"/"all" 存量配置必须无损落到新数值；
 *   · **有界**：任何数值都被夹到 STYLE_RANGE 并吸附到 step 网格（可调 ≠ 任意）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETAIL_STYLE,
  DETAIL_STYLE_META,
  STYLE_RANGE,
  actionBtnStyle,
  chapRowStyle,
  coverBoxStyle,
  descFontStyle,
  descLineStyle,
  descStyle,
  detailStyleAttrs,
  factValStyle,
  isDetailStyleKeyDefault,
  isDetailStyleModified,
  loadDetailStyle,
  normalizeDetailStyle,
  resetDetailStyle,
  resetDetailStyleKey,
  saveDetailStyle,
  setDetailStyle,
  statStyle,
  tabsStyle,
  tagChipStyle,
  titleStyle
} from "./detailStyle";
import type { NumericStyleKey } from "./detailStyle";
import { UI_KEYS } from "./constants";

describe("默认值契约", () => {
  it("默认配置 = 当前实装的观感（不改设置的用户看到的就是它）", () => {
    expect(DEFAULT_DETAIL_STYLE).toEqual({
      version: 3, cover: 104, title: 16, desc: 2, descAll: false, density: "normal", radius: "md",
      // v3 的新键：默认值逐个等于现状 CSS 里的实际值（v3.4 删掉了 noticeSize，见 core/detailStyle）
      tagSize: 12, actorSize: "md", actionPadY: 14, actionFont: 14,
      tabGap: 18, chapFont: 14, statFont: 11, factFont: 12, descFont: 14, descLine: 1.7,
      // v3.8：目录排法。默认 `list` = **逐字等于现状**（单列列表）
      chapLayout: "list",
      // v3.9：目录顺序 / 筛选。默认 `asc` + `all` = 服务端顺序、全都显示 = 现状
      chapOrder: "asc", chapFilter: "all",
      // v3.10：主视觉排布。默认 `left` = 左图右文 = 现状
      heroLayout: "left"
    });
  });

  it("【关键】默认配置下 detailStyleAttrs 返回空对象 —— DOM 逐字不变", () => {
    expect(detailStyleAttrs(DEFAULT_DETAIL_STYLE)).toEqual({});
  });

  it("【关键】默认配置下三个内联样式助手都不给 style —— DOM 逐字不变", () => {
    expect(coverBoxStyle(DEFAULT_DETAIL_STYLE)).toBeUndefined();
    expect(titleStyle(DEFAULT_DETAIL_STYLE)).toBeUndefined();
    expect(descStyle(DEFAULT_DETAIL_STYLE)).toBeUndefined();
  });

  it("【关键】默认配置下 v3 的内联助手也都不给 style —— DOM 逐字不变", () => {
    const helpers = [
      tagChipStyle, statStyle, factValStyle,
      chapRowStyle, descFontStyle, descLineStyle, actionBtnStyle, tabsStyle
    ];
    for (const h of helpers) expect(h(DEFAULT_DETAIL_STYLE)).toBeUndefined();
  });

  it("滑块项的默认值都落在自己的滑块范围内", () => {
    for (const key of Object.keys(STYLE_RANGE) as NumericStyleKey[]) {
      const r = STYLE_RANGE[key];
      const v = DEFAULT_DETAIL_STYLE[key];
      expect(v).toBeGreaterThanOrEqual(r.min);
      expect(v).toBeLessThanOrEqual(r.max);
    }
  });

  it("档位项的默认值都必须在它自己的档位表里（否则界面上没有选中态）", () => {
    for (const meta of DETAIL_STYLE_META) {
      if (meta.kind !== "options") continue;
      expect(meta.options.map((o) => o.value)).toContain(DEFAULT_DETAIL_STYLE[meta.key]);
    }
  });

  it("元数据覆盖了所有可配置项，没有漏项", () => {
    expect(DETAIL_STYLE_META.map((m) => m.key).sort())
      .toEqual([
        "actionFont", "actionPadY", "actorSize", "chapFilter", "chapFont", "chapLayout", "chapOrder",
        "cover", "density", "desc", "descAll", "descFont", "descLine", "factFont", "heroLayout",
        "radius", "statFont", "tabGap", "tagSize", "title"
      ]);
  });

  it("块级的档位项 = 人物字号 + 目录三轴 + 封面排布（都不该在「页面设置」里冒出来）", () => {
    // v3.8 前这条是 `["actorSize"]`。往后每加一个"只对某一块有意义"的档位就会多一项：
    // v3.8 = 目录排法；v3.9 = 目录顺序 / 筛选；v3.10 = 封面排布。判据（scope:"block" 不进页面设置）没变。
    const blockScoped = DETAIL_STYLE_META
      .filter((m) => m.kind === "options" && m.scope === "block")
      .map((m) => m.key);
    expect(blockScoped).toEqual(["heroLayout", "actorSize", "chapLayout", "chapOrder", "chapFilter"]);
  });
});

describe("detailStyleAttrs（只输出非默认项）", () => {
  it("改了一项就只多一个属性（数值项以字符串输出）", () => {
    const cfg = setDetailStyle(DEFAULT_DETAIL_STYLE, "cover", 140);
    expect(detailStyleAttrs(cfg)).toEqual({ "data-dl-cover": "140" });
  });

  it("改回默认后属性消失", () => {
    const cfg = resetDetailStyleKey(setDetailStyle(DEFAULT_DETAIL_STYLE, "title", 20), "title");
    expect(detailStyleAttrs(cfg)).toEqual({});
  });

  it("属性名与 index.css / 测试钩子对得上", () => {
    const cfg = normalizeDetailStyle({ cover: 80, title: 19, desc: 4, descAll: true, density: "compact", radius: "none" });
    expect(detailStyleAttrs(cfg)).toEqual({
      "data-dl-cover": "80",
      "data-dl-title": "19",
      "data-dl-desc": "4",
      "data-dl-descall": "1",
      "data-dl-density": "compact",
      "data-dl-radius": "none"
    });
  });
});

describe("内联样式（数值项的几何出口）", () => {
  it("封面：3:4 等比，高 = 宽 × 4/3 取整（与 v1 三档 80×107 / 104×139 / 140×187 同算法）", () => {
    expect(coverBoxStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "cover", 80))).toEqual({ width: 80, height: 107 });
    expect(coverBoxStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "cover", 104))).toBeUndefined();
    expect(coverBoxStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "cover", 140))).toEqual({ width: 140, height: 187 });
    expect(coverBoxStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "cover", 200))).toEqual({ width: 200, height: 267 });
  });

  it("标题：只给字号", () => {
    expect(titleStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "title", 20))).toEqual({ fontSize: 20 });
  });

  it("简介：clamp 与折叠高度必须一起给（只给一个会切字）", () => {
    expect(descStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "desc", 3))).toEqual({ WebkitLineClamp: 3, maxHeight: "5.1em" });
  });

  it("简介显示全部：解除 clamp 与高度上限", () => {
    expect(descStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "descAll", true)))
      .toEqual({ WebkitLineClamp: "unset", maxHeight: "none" });
  });
});

describe("v1 → v2 迁移（存量配置无感升级）", () => {
  it("封面三档落到当年的实际像素", () => {
    expect(normalizeDetailStyle({ cover: "s" }).cover).toBe(80);
    expect(normalizeDetailStyle({ cover: "m" }).cover).toBe(104);
    expect(normalizeDetailStyle({ cover: "l" }).cover).toBe(140);
  });

  it("标题三档落到当年的实际字号", () => {
    expect(normalizeDetailStyle({ title: "s" }).title).toBe(14);
    expect(normalizeDetailStyle({ title: "m" }).title).toBe(16);
    expect(normalizeDetailStyle({ title: "l" }).title).toBe(19);
  });

  it("简介行数与「全部」", () => {
    expect(normalizeDetailStyle({ desc: "2" }).desc).toBe(2);
    expect(normalizeDetailStyle({ desc: "3" }).desc).toBe(3);
    expect(normalizeDetailStyle({ desc: "4" }).desc).toBe(4);
    expect(normalizeDetailStyle({ desc: "all" })).toEqual({ ...DEFAULT_DETAIL_STYLE, descAll: true });
  });

  it("一整份 v1 配置迁移后每一项都有着落（v3 的新键一律回落默认，不扰动旧迁移）", () => {
    expect(normalizeDetailStyle({ version: 1, cover: "l", title: "s", desc: "3", density: "roomy", radius: "lg" }))
      .toEqual({ ...DEFAULT_DETAIL_STYLE, cover: 140, title: 14, desc: 3, density: "roomy", radius: "lg" });
  });
});

describe("脏数据自愈（normalize）", () => {
  it("非法值回落默认（脏类型；越界数值是另一回事，见下）", () => {
    expect(normalizeDetailStyle({ cover: "huge", title: { x: 1 }, desc: "xx", descAll: "yes" })).toEqual(DEFAULT_DETAIL_STYLE);
  });

  it("数值越界被夹住（可调 ≠ 任意）", () => {
    expect(normalizeDetailStyle({ cover: 9999 }).cover).toBe(STYLE_RANGE.cover.max);
    expect(normalizeDetailStyle({ cover: -5 }).cover).toBe(STYLE_RANGE.cover.min);
    expect(normalizeDetailStyle({ title: 999 }).title).toBe(STYLE_RANGE.title.max);
    expect(normalizeDetailStyle({ desc: 99 }).desc).toBe(STYLE_RANGE.desc.max);
  });

  it("数值吸附到 step 网格（封面 step 4）", () => {
    expect(normalizeDetailStyle({ cover: 105 }).cover).toBe(104);
    expect(normalizeDetailStyle({ cover: 107 }).cover).toBe(108);
  });

  it("非对象 / null / 数组不崩", () => {
    expect(normalizeDetailStyle(null)).toEqual(DEFAULT_DETAIL_STYLE);
    expect(normalizeDetailStyle("cover")).toEqual(DEFAULT_DETAIL_STYLE);
    expect(normalizeDetailStyle([])).toEqual(DEFAULT_DETAIL_STYLE);
  });

  it("合法值保留、缺的字段补默认", () => {
    expect(normalizeDetailStyle({ cover: 140 })).toEqual({ ...DEFAULT_DETAIL_STYLE, cover: 140 });
  });

  it("localStorage 里是坏 JSON 也不崩，回落默认", () => {
    localStorage.setItem(UI_KEYS.detailStyle, "{ 不是 JSON");
    expect(loadDetailStyle()).toEqual(DEFAULT_DETAIL_STYLE);
  });
});

describe("持久化", () => {
  it("存读往返", () => {
    const cfg = setDetailStyle(DEFAULT_DETAIL_STYLE, "density", "roomy");
    saveDetailStyle(cfg);
    expect(loadDetailStyle()).toEqual(cfg);
    localStorage.removeItem(UI_KEYS.detailStyle);
    expect(loadDetailStyle()).toEqual(DEFAULT_DETAIL_STYLE);
  });

  it("v1 存量数据读出来就是迁移后的 v2", () => {
    localStorage.setItem(UI_KEYS.detailStyle, JSON.stringify({ version: 1, cover: "l", title: "m", desc: "all", density: "normal", radius: "md" }));
    expect(loadDetailStyle()).toEqual({ ...DEFAULT_DETAIL_STYLE, cover: 140, descAll: true });
    localStorage.removeItem(UI_KEYS.detailStyle);
  });
});

describe("变更（纯函数）", () => {
  it("没变时返回同一个引用（不白白重渲染）", () => {
    expect(setDetailStyle(DEFAULT_DETAIL_STYLE, "cover", 104)).toBe(DEFAULT_DETAIL_STYLE);
    expect(resetDetailStyleKey(DEFAULT_DETAIL_STYLE, "cover")).toBe(DEFAULT_DETAIL_STYLE);
  });

  it("变了返回新对象，且不改入参", () => {
    const before = { ...DEFAULT_DETAIL_STYLE };
    const after = setDetailStyle(DEFAULT_DETAIL_STYLE, "cover", 80);
    expect(after).not.toBe(DEFAULT_DETAIL_STYLE);
    expect(DEFAULT_DETAIL_STYLE).toEqual(before);
    expect(after.cover).toBe(80);
  });

  it("单项复位只动那一项", () => {
    let cfg = setDetailStyle(DEFAULT_DETAIL_STYLE, "cover", 200);
    cfg = setDetailStyle(cfg, "title", 30);
    cfg = resetDetailStyleKey(cfg, "cover");
    expect(cfg.cover).toBe(DEFAULT_DETAIL_STYLE.cover);
    expect(cfg.title).toBe(30);
  });

  it("全部复位回到默认", () => {
    const cfg = setDetailStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "cover", 200), "radius", "none");
    expect(resetDetailStyle()).toEqual(DEFAULT_DETAIL_STYLE);
    expect(cfg).not.toEqual(DEFAULT_DETAIL_STYLE);
  });
});

describe("「这一组被改过」圆点", () => {
  it("默认时不亮", () => {
    expect(isDetailStyleModified(DEFAULT_DETAIL_STYLE)).toBe(false);
  });

  it("改任意一项就亮，改回去就灭", () => {
    const cfg = setDetailStyle(DEFAULT_DETAIL_STYLE, "descAll", true);
    expect(isDetailStyleModified(cfg)).toBe(true);
    expect(isDetailStyleKeyDefault(cfg, "descAll")).toBe(false);
    expect(isDetailStyleModified(resetDetailStyleKey(cfg, "descAll"))).toBe(false);
  });

  it("数值项同理", () => {
    const cfg = setDetailStyle(DEFAULT_DETAIL_STYLE, "cover", 200);
    expect(isDetailStyleModified(cfg)).toBe(true);
    expect(isDetailStyleModified(resetDetailStyleKey(cfg, "cover"))).toBe(false);
  });
});

// ────────────────────────────────────────────────
// v3：新增数值键的契约（v3.4 删掉 noticeSize —— 它是"改不动任何东西"的哑控件）
// ────────────────────────────────────────────────
describe("v3 数值键：夹取与观测钩子", () => {
  /** 键 → 它挂在 .detail-card 上的观测属性（与 core/detailStyle.ATTR_OF 对齐；改名即红） */
  const ATTR: Partial<Record<NumericStyleKey, string>> = {
    tagSize: "data-dl-tagsize",
    actionPadY: "data-dl-actionpady",
    actionFont: "data-dl-actionfont",
    tabGap: "data-dl-tabgap",
    chapFont: "data-dl-chapfont",
    statFont: "data-dl-statfont",
    factFont: "data-dl-factfont",
    descFont: "data-dl-descfont",
    descLine: "data-dl-descline"
  };

  it("每个数值键改到最大：只多一条对应属性，值是上限", () => {
    for (const key of Object.keys(ATTR) as NumericStyleKey[]) {
      const cfg = setDetailStyle(DEFAULT_DETAIL_STYLE, key, STYLE_RANGE[key].max);
      expect(detailStyleAttrs(cfg)).toEqual({ [ATTR[key] as string]: String(STYLE_RANGE[key].max) });
    }
  });

  it("越界被夹住（下溢 → min，上溢 → max）", () => {
    expect(normalizeDetailStyle({ tagSize: 9999 }).tagSize).toBe(STYLE_RANGE.tagSize.max);
    expect(normalizeDetailStyle({ tagSize: -9999 }).tagSize).toBe(STYLE_RANGE.tagSize.min);
    expect(normalizeDetailStyle({ actionPadY: 9999 }).actionPadY).toBe(STYLE_RANGE.actionPadY.max);
    expect(normalizeDetailStyle({ descLine: 9 }).descLine).toBe(STYLE_RANGE.descLine.max);
    expect(normalizeDetailStyle({ descLine: 0 }).descLine).toBe(STYLE_RANGE.descLine.min);
  });

  it("【关键】descLine 吸附到 0.05 网格且**没有浮点残差**（残差会让默认值判定失效 → 破零差异红线）", () => {
    expect(normalizeDetailStyle({ descLine: 1.7 }).descLine).toBe(1.7);
    expect(normalizeDetailStyle({ descLine: 1.75 }).descLine).toBe(1.75);
    expect(normalizeDetailStyle({ descLine: 1.72 }).descLine).toBe(1.7);
    expect(isDetailStyleKeyDefault(normalizeDetailStyle({}), "descLine")).toBe(true);
  });

  it("旧配置里没有这些新键 → 归一化后全等于默认值", () => {
    const migrated = normalizeDetailStyle({ version: 1, cover: "l", title: "s", desc: "3" });
    for (const key of Object.keys(ATTR) as NumericStyleKey[]) {
      expect(migrated[key]).toBe(DEFAULT_DETAIL_STYLE[key]);
    }
    expect(migrated.actorSize).toBe(DEFAULT_DETAIL_STYLE.actorSize);
  });

  it("档位值非法回落默认、合法则落到观测属性上（actorSize；它同时要被 !important 那条规则接住）", () => {
    expect(normalizeDetailStyle({ actorSize: "huge" }).actorSize).toBe("md");
    expect(normalizeDetailStyle({ actorSize: "lg" }).actorSize).toBe("lg");
    expect(detailStyleAttrs(normalizeDetailStyle({ actorSize: "lg" }))).toEqual({ "data-dl-actorsize": "lg" });
  });
});

describe("v3 内联出口", () => {
  it("标签胶囊：字号派生最小高度与内边距（N=16 → 37/7/13，写死期望防公式被悄悄改）", () => {
    expect(tagChipStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "tagSize", 16))).toEqual({
      fontSize: 16, minHeight: 37,
      paddingTop: 7, paddingBottom: 7, paddingLeft: 13, paddingRight: 13
    });
    expect(tagChipStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "tagSize", 10))).toEqual({
      fontSize: 10, minHeight: 23,
      paddingTop: 4, paddingBottom: 4, paddingLeft: 8, paddingRight: 8
    });
  });

  it("字号类键：只给字号", () => {
    expect(statStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "statFont", 14))).toEqual({ fontSize: 14 });
    expect(factValStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "factFont", 16))).toEqual({ fontSize: 16 });
    expect(chapRowStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "chapFont", 16))).toEqual({ fontSize: 16 });
    expect(descFontStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "descFont", 19))).toEqual({ fontSize: 19 });
  });

  it("动作区按钮：两个键合成一份内联（只动上下内边距，左右留给 CSS 的 18px）", () => {
    expect(actionBtnStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "actionPadY", 20)))
      .toEqual({ paddingTop: 20, paddingBottom: 20 });
    expect(actionBtnStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "actionFont", 18))).toEqual({ fontSize: 18 });
    expect(actionBtnStyle(setDetailStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "actionPadY", 22), "actionFont", 12)))
      .toEqual({ paddingTop: 22, paddingBottom: 22, fontSize: 12 });
  });

  it("横栏容器：只给上方间距", () => {
    expect(tabsStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "tabGap", 28))).toEqual({ marginTop: 28 });
  });

  it("简介行距：只给 lineHeight", () => {
    expect(descLineStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "descLine", 1.5))).toEqual({ lineHeight: 1.5 });
  });
});

describe("v3 descLine 与 descStyle 的联动（防「文字被截断」的哨兵）", () => {
  it("【哨兵】行距非默认 + 行数为默认 → 必须写出 maxHeight = 2 × 行距", () => {
    expect(descStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "descLine", 1.5)))
      .toEqual({ WebkitLineClamp: 2, maxHeight: "3em" });
    expect(descStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "descLine", 2)))
      .toEqual({ WebkitLineClamp: 2, maxHeight: "4em" });
  });

  it("行距默认 + 行数非默认 → 与改造前逐字一致（3 行仍是 5.1em）", () => {
    expect(descStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "desc", 3)))
      .toEqual({ WebkitLineClamp: 3, maxHeight: "5.1em" });
  });

  it("两者都非默认 → 系数是行距，不是硬编码的 1.7", () => {
    const cfg = setDetailStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "desc", 4), "descLine", 1.5);
    expect(descStyle(cfg)).toEqual({ WebkitLineClamp: 4, maxHeight: "6em" });
  });

  it("descAll 仍压过两者（不截断、不限高）", () => {
    const cfg = setDetailStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "descAll", true), "descLine", 1.5);
    expect(descStyle(cfg)).toEqual({ WebkitLineClamp: "unset", maxHeight: "none" });
  });
});

// ────────────────────────────────────────────────
// v3.8 目录排法（调研 TOP8 第 2 条）：Mihon / Kotatsu 都把它做成用户设置的轴
// ────────────────────────────────────────────────
describe("v3.8 目录排法 chapLayout：默认不写 · 选了才写 · 脏数据回落", () => {
  /** 两档的观测属性（`ATTR_OF.chapLayout`）；改名即红 —— 与 CSS 的 `.detail-card[data-dl-chap="grid2"]` 对齐 */
  const CHAP_ATTR = "data-dl-chap";

  it("【红线】默认（单列）→ **不输出属性**；选了「两列」→ 只多这一个属性", () => {
    // 判别性成对断言：只输出"非默认项"这条不变量一旦被改（无论改成"永远输出"还是"永远不输出"），
    // 两句里必有一句变红。
    expect(detailStyleAttrs(DEFAULT_DETAIL_STYLE)).toEqual({});
    expect(detailStyleAttrs(setDetailStyle(DEFAULT_DETAIL_STYLE, "chapLayout", "grid2")))
      .toEqual({ [CHAP_ATTR]: "grid2" });
  });

  it("回到默认档（单列）→ 属性**干净地消失**（不是留着空串 / 变成 list）", () => {
    const cfg = setDetailStyle(DEFAULT_DETAIL_STYLE, "chapLayout", "grid2");
    expect(detailStyleAttrs(setDetailStyle(cfg, "chapLayout", "list"))).toEqual({});
  });

  it("标记为「已改过」的逻辑跟着走：两列算改过、单列不算", () => {
    expect(isDetailStyleModified(DEFAULT_DETAIL_STYLE)).toBe(false);
    expect(isDetailStyleModified(setDetailStyle(DEFAULT_DETAIL_STYLE, "chapLayout", "grid2"))).toBe(true);
    // 而且**只**改这一项时，复位它就能回到"没改过"
    expect(isDetailStyleModified(resetDetailStyleKey(setDetailStyle(DEFAULT_DETAIL_STYLE, "chapLayout", "grid2"), "chapLayout"))).toBe(false);
  });

  it("归一化：合法值保留、非法值（未知档 / 数字 / null）一律回落单列", () => {
    expect(normalizeDetailStyle({ chapLayout: "grid2" }).chapLayout).toBe("grid2");
    expect(normalizeDetailStyle({ chapLayout: "list" }).chapLayout).toBe("list");
    for (const bad of ["3col", "grid3", "", 2, null, true, {}]) {
      expect(normalizeDetailStyle({ chapLayout: bad }).chapLayout).toBe("list");
    }
  });

  it("老配置（没有这个键）→ 单列；存盘往返一致", () => {
    expect(normalizeDetailStyle({ cover: 140, density: "compact" }).chapLayout).toBe("list");
    const cfg = setDetailStyle(DEFAULT_DETAIL_STYLE, "chapLayout", "grid2");
    expect(normalizeDetailStyle(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
  });
});

// ────────────────────────────────────────────────
// v3.9 目录两轴（调研 TOP8 第 4 条）：顺序 + 筛选
// ────────────────────────────────────────────────
describe("v3.9 目录顺序 / 筛选：默认不写 · 选了才写 · 脏数据回落", () => {
  it("【红线】默认（正序 + 全部）→ **两个属性都不输出**；选了才各多一个", () => {
    // 与 chapLayout 同一套成对断言：只输出非默认项这条不变量一旦被改，必有一句变红
    expect(detailStyleAttrs(DEFAULT_DETAIL_STYLE)).toEqual({});
    expect(detailStyleAttrs(setDetailStyle(DEFAULT_DETAIL_STYLE, "chapOrder", "desc")))
      .toEqual({ "data-dl-chaporder": "desc" });
    expect(detailStyleAttrs(setDetailStyle(DEFAULT_DETAIL_STYLE, "chapFilter", "cached")))
      .toEqual({ "data-dl-chapfilter": "cached" });
    // 两个一起改：就有两个属性（互不覆盖）
    expect(detailStyleAttrs(setDetailStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "chapOrder", "desc"), "chapFilter", "cached")))
      .toEqual({ "data-dl-chaporder": "desc", "data-dl-chapfilter": "cached" });
  });

  it("回到默认档 → 属性**干净消失**（不留空串）", () => {
    const desc = setDetailStyle(DEFAULT_DETAIL_STYLE, "chapOrder", "desc");
    expect(detailStyleAttrs(setDetailStyle(desc, "chapOrder", "asc"))).toEqual({});
    const filtered = setDetailStyle(DEFAULT_DETAIL_STYLE, "chapFilter", "cached");
    expect(detailStyleAttrs(setDetailStyle(filtered, "chapFilter", "all"))).toEqual({});
  });

  it("归一化：合法值保留、非法值（未知档 / 数字 / null / 大小写错）一律回落默认", () => {
    expect(normalizeDetailStyle({ chapOrder: "desc" }).chapOrder).toBe("desc");
    expect(normalizeDetailStyle({ chapOrder: "asc" }).chapOrder).toBe("asc");
    for (const bad of ["down", "DESC", "", 1, null, true, {}]) {
      expect(normalizeDetailStyle({ chapOrder: bad }).chapOrder).toBe("asc");
    }
    expect(normalizeDetailStyle({ chapFilter: "cached" }).chapFilter).toBe("cached");
    for (const bad of ["CACHED", "downloaded", "", 0, null, {}]) {
      expect(normalizeDetailStyle({ chapFilter: bad }).chapFilter).toBe("all");
    }
  });

  it("老配置（没有这两个键）→ 正序 + 全部；存盘往返一致", () => {
    const old = normalizeDetailStyle({ cover: 140, density: "compact", chapLayout: "grid2" });
    expect(old.chapOrder).toBe("asc");
    expect(old.chapFilter).toBe("all");
    const cfg = setDetailStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "chapOrder", "desc"), "chapFilter", "cached");
    expect(normalizeDetailStyle(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
  });

  it("「改过没有」跟着走：只改目录顺序也算改过（标题上的圆点会亮）", () => {
    expect(isDetailStyleModified(setDetailStyle(DEFAULT_DETAIL_STYLE, "chapOrder", "desc"))).toBe(true);
    expect(isDetailStyleModified(setDetailStyle(DEFAULT_DETAIL_STYLE, "chapFilter", "cached"))).toBe(true);
  });
});

// ────────────────────────────────────────────────
// v3.10 主视觉排布（调研 TOP8 第 7 条）：左图右文 ↔ 封面居中
// ────────────────────────────────────────────────
describe("v3.10 封面排布 heroLayout：默认不写 · 选了才写 · 脏数据回落", () => {
  it("【红线】默认（左图右文）→ **不输出属性**；选了「封面居中」→ 只多这一个属性", () => {
    expect(detailStyleAttrs(DEFAULT_DETAIL_STYLE)).toEqual({});
    expect(detailStyleAttrs(setDetailStyle(DEFAULT_DETAIL_STYLE, "heroLayout", "center")))
      .toEqual({ "data-dl-herolayout": "center" });
  });

  it("回到默认档 → 属性**干净消失**", () => {
    const center = setDetailStyle(DEFAULT_DETAIL_STYLE, "heroLayout", "center");
    expect(detailStyleAttrs(setDetailStyle(center, "heroLayout", "left"))).toEqual({});
  });

  it("归一化：合法值保留、非法值（未知档 / 数字 / null / 大小写错）一律回落默认", () => {
    expect(normalizeDetailStyle({ heroLayout: "center" }).heroLayout).toBe("center");
    expect(normalizeDetailStyle({ heroLayout: "left" }).heroLayout).toBe("left");
    for (const bad of ["big", "CENTER", "blur", "", 1, null, true, {}]) {
      expect(normalizeDetailStyle({ heroLayout: bad }).heroLayout).toBe("left");
    }
  });

  it("老配置（没有这个键）→ 左图右文；存盘往返一致；且**不动封面大小那条轴**", () => {
    expect(normalizeDetailStyle({ cover: 140 }).heroLayout).toBe("left");
    const cfg = setDetailStyle(setDetailStyle(DEFAULT_DETAIL_STYLE, "heroLayout", "center"), "cover", 168);
    expect(normalizeDetailStyle(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
    // 档位与尺寸是两条独立的轴：改档位不该动尺寸，反之亦然
    expect(cfg.cover).toBe(168);
    expect(detailStyleAttrs(cfg)).toEqual({ "data-dl-herolayout": "center", "data-dl-cover": "168" });
  });
});
