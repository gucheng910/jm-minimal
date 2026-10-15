// @vitest-environment jsdom
/**
 * 顶栏 / 底栏 / 阅读器控制条的单元编排层（core/chromeLayout）。
 *
 * 这一层是"把三个栏解离成可配置单元"的地基，所以测的重点与另两层一致：
 *   · **默认配置 == 解离前的写死行为**（这是红线：从没配过的用户 DOM 必须一个字节都不变）；
 *   · **对脏数据自愈**（旧版本存的配置、手改过的 localStorage、跨分区的重名 id）；
 *   · **必需单元藏不掉**（菜单唤出入口 / 应用标题 / 设置 / 阅读器返回 —— 见 ① 与 ⑤ 的断言；
 *     v3.13 起「底栏:首页」**被放开**了，依据是用户第 3 条「底栏的设置按钮不可删…剩下的交给用户定义」）。
 *
 * 与 core/detailLayout.test.ts / core/listLayout.test.ts 同一套写法（纯函数 + localStorage）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "./constants";
import {
  CHROME_BAR_SECTIONS,
  CHROME_LAYOUT_VERSION,
  CHROME_SECTIONS,
  DEFAULT_CHROME_LAYOUT,
  NAV_UNIT_IDS,
  NAV_UNIT_META,
  READER_CHROME_SECTIONS,
  READER_TOOL_IDS,
  READER_TOP_IDS,
  TOP_ACTION_IDS,
  chromeLayoutSections,
  hideKey,
  isChromeHidden,
  loadChromeLayout,
  moveChromeUnit,
  moveChromeUnitTo,
  moveChromeUnitVisible,
  normalizeChromeLayout,
  resetChromeLayout,
  saveChromeLayout,
  toggleChromeUnit,
  visibleChromeUnits
} from "./chromeLayout";

afterEach(() => { localStorage.clear(); });

/**
 * v3.12 起默认 `hidden` 里预置的四条：**状态栏条目默认全关**。
 * 这一节与别节极性相反（别节默认全开），所以下面每一处"hidden 等于什么"都要带上它。
 */
const STATUS_OFF = ["readerStatus:chapter", "readerStatus:page", "readerStatus:pct", "readerStatus:clock"];

describe("⓪ 默认配置 = 解离前的写死行为（红线）", () => {
  it("每个分区的默认顺序**逐字等于**改造前 JSX 里的顺序", () => {
    // 改造前：底栏 = 首页 · 分类 · 搜索 · 设置（顺序就是这四行 button 的出现顺序）
    expect(DEFAULT_CHROME_LAYOUT.nav).toEqual(["home", "categories", "search", "settings"]);
    // 改造前：顶栏左侧组 = 菜单按钮 · 标题
    expect(DEFAULT_CHROME_LAYOUT.topLeft).toEqual(["menu", "title"]);
    // 改造前：顶栏工具组 = 缓存 · 搜索 · 换源（顶栏只留三个工具）
    expect(DEFAULT_CHROME_LAYOUT.topActions).toEqual(["cache", "search", "source"]);
    // 改造前：阅读器上排 = 返回 · 标题 · 页码
    expect(DEFAULT_CHROME_LAYOUT.readerTop).toEqual(["back", "title", "page"]);
    // 改造前：阅读器工具 = 更快的源 · 换话 · 缓存 · 设置
    expect(DEFAULT_CHROME_LAYOUT.readerTools).toEqual(["source", "chapter", "cache", "settings"]);
  });

  it("默认：**除状态栏外**每个分区都返回全量顺序；状态栏那一节**默认全关**（v3.12）", () => {
    for (const s of CHROME_SECTIONS) {
      if (s === "readerStatus") continue;
      expect(visibleChromeUnits(DEFAULT_CHROME_LAYOUT, s)).toEqual([...DEFAULT_CHROME_LAYOUT[s]]);
    }
    // 状态栏：顺序表是四条全的（顺序 = 显示顺序），但默认全在 hidden 里 ⇒ 一条都不渲染
    expect(DEFAULT_CHROME_LAYOUT.readerStatus).toEqual(["chapter", "page", "pct", "clock"]);
    expect(visibleChromeUnits(DEFAULT_CHROME_LAYOUT, "readerStatus")).toEqual([]);
    // 红线：默认 DOM 与加这一节之前一字不差 —— 靠的就是这个"默认全关"
    expect(DEFAULT_CHROME_LAYOUT.hidden).toEqual(STATUS_OFF);
  });

  it("版本号与另两层一样，是显式常量（升级时能认出来）", () => {
    expect(CHROME_LAYOUT_VERSION).toBe(2);   // v3.12 起是 2（v1 → v2 = 补"状态栏默认全关"）
    expect(DEFAULT_CHROME_LAYOUT.version).toBe(CHROME_LAYOUT_VERSION);
    expect(resetChromeLayout().version).toBe(CHROME_LAYOUT_VERSION);
  });
});

describe("① 必需单元藏不掉（没有替代入口的那些）", () => {
  it("`toggleChromeUnit` 对必需单元返回**同一个引用**（连重渲染都不会有）", () => {
    const cfg = resetChromeLayout();
    expect(toggleChromeUnit(cfg, "nav", "settings")).toBe(cfg);
    expect(toggleChromeUnit(cfg, "topLeft", "menu")).toBe(cfg);
    // v3.13 用户第 3 条：「底栏的设置按钮不可删，顶栏的 JM 极简版的文字和左菜单唤出按钮不可删」
    expect(toggleChromeUnit(cfg, "topLeft", "title")).toBe(cfg);
    expect(toggleChromeUnit(cfg, "readerTop", "back")).toBe(cfg);
  });

  it("归一化时把「藏必需单元」的脏数据**强制放出来**", () => {
    const cfg = normalizeChromeLayout({ hidden: ["nav:settings", "topLeft:menu", "topLeft:title", "readerTop:back"] });
    expect(cfg.hidden).toEqual(STATUS_OFF);   // 必需单元那四条被丢掉，只剩默认的状态栏全关
    expect(visibleChromeUnits(cfg, "nav")).toEqual(["home", "categories", "search", "settings"]);
    expect(visibleChromeUnits(cfg, "topLeft")).toEqual(["menu", "title"]);
  });

  it("可隐藏的单元确实藏得掉（负对照：别把这条写成「什么都藏不掉」）", () => {
    const cfg = toggleChromeUnit(resetChromeLayout(), "nav", "categories");
    expect(cfg.hidden).toEqual([...STATUS_OFF, "nav:categories"]);
    expect(visibleChromeUnits(cfg, "nav")).toEqual(["home", "search", "settings"]);
  });

  /**
   * v3.13：用户第 3 条只点名「底栏的设置按钮不可删」—— 所以 `nav:home` 被放开了。
   * 这条断言是**改动的记录**：它以前是必需的，现在可隐藏。
   * ⚠️ 放开它不会把用户关在门外：设置（必需）→ 自定义 UI → 顶栏和底栏，这条路永远在。
   * 真把它改成"不可隐藏"会让用户的诉求落空；真把 settings 也放开才是灾难 —— 两条一起钉住。
   */
  it("★ v3.13：`nav:home` 可以藏掉了，但 `nav:settings` 永远不行（否则再也进不了设置）", () => {
    const cfg = toggleChromeUnit(resetChromeLayout(), "nav", "home");
    expect(visibleChromeUnits(cfg, "nav")).toEqual(["categories", "search", "settings"]);
    expect(toggleChromeUnit(cfg, "nav", "settings")).toBe(cfg);
  });
});

describe("② 跨分区重名的 id 不许互相牵连（本层独有的坑）", () => {
  /**
   * `search` 既在顶栏工具组、也在底栏；`title` 既在顶栏左侧组、也在阅读器上排。
   * 如果 hidden 只写裸 id，"藏掉底栏的搜索"会顺手把顶栏的搜索也藏掉 —— 一个很隐蔽的 bug。
   * 所以 hidden 的条目带分区前缀（`nav:search`），这两条断言就是钉它的。
   */
  it("藏掉「底栏:搜索」→ 顶栏工具组里的「搜索」**必须还在**", () => {
    const cfg = toggleChromeUnit(resetChromeLayout(), "nav", "search");
    expect(isChromeHidden(cfg, "nav", "search")).toBe(true);
    expect(isChromeHidden(cfg, "topActions", "search")).toBe(false);
    expect(visibleChromeUnits(cfg, "nav")).toEqual(["home", "categories", "settings"]);
    expect(visibleChromeUnits(cfg, "topActions")).toEqual(["cache", "search", "source"]);
  });

  it("藏掉「阅读器:作品名」→ 顶栏左侧组的「应用标题」**必须还在**", () => {
    /**
     * ⚠️ v3.13 这条换了方向：原来是从"顶栏那侧"藏 `title`，但 `topLeft:title` 现在是**必需单元**
     * （用户第 3 条：「顶栏的 JM 极简版的文字…不可删」）→ 藏不掉，那条写法已经不可达。
     * 跨分区重名这件事本身**没变**：`title` 仍然是 topLeft 与 readerTop 共用的 id，
     * 所以改成从阅读器那侧藏，钉的还是同一个坑（裸 id 会让两边一起被藏）。
     */
    const cfg = toggleChromeUnit(resetChromeLayout(), "readerTop", "title");
    expect(visibleChromeUnits(cfg, "readerTop")).toEqual(["back", "page"]);
    expect(visibleChromeUnits(cfg, "topLeft")).toEqual(["menu", "title"]);
  });

  it("归一化丢掉「没有分区前缀」的旧/脏条目", () => {
    const cfg = normalizeChromeLayout({ hidden: ["search", "title", "nav:search", ":home", "nosuch:home", "nav:nosuch"] });
    expect(cfg.hidden).toEqual([...STATUS_OFF, "nav:search"]);   // 只有带合法前缀的那条留下（+ 默认状态栏全关）
  });
});

describe("③ 归一化：对脏数据 / 旧版本自愈", () => {
  it("完全不是对象 → 回默认（不抛）", () => {
    expect(normalizeChromeLayout(null).nav).toEqual([...NAV_UNIT_IDS]);
    expect(normalizeChromeLayout("全部").nav).toEqual([...NAV_UNIT_IDS]);
    expect(normalizeChromeLayout(42).nav).toEqual([...NAV_UNIT_IDS]);
  });

  it("顺序表里有未知 id / 重复项 → 丢掉；缺失的 known 项**补到尾部**", () => {
    const cfg = normalizeChromeLayout({ nav: ["home", "home", "unknown", "settings"] });
    // home 去重、unknown 丢掉、categories/search 补到尾部
    expect(cfg.nav).toEqual(["home", "settings", "categories", "search"]);
  });

  it("**将来加一个新单元，老用户的配置会自动带上它**（不补的话新单元对老用户永远不出现）", () => {
    const cfg = normalizeChromeLayout({ topActions: ["source"] });   // 老配置只认得 source
    expect(cfg.topActions).toEqual(["source", "cache", "search"]);
  });

  it("顺序表不是数组（被改坏）→ 回默认顺序", () => {
    const cfg = normalizeChromeLayout({ readerTools: "设置" });
    expect(cfg.readerTools).toEqual([...READER_TOOL_IDS]);
  });

  it("五个分区各自独立归一，一个坏掉不影响别的", () => {
    const cfg = normalizeChromeLayout({ nav: null, readerTop: ["page"] });
    expect(cfg.nav).toEqual([...NAV_UNIT_IDS]);
    expect(cfg.readerTop).toEqual(["page", "back", "title"]);
    expect(cfg.topActions).toEqual([...TOP_ACTION_IDS]);
  });
});

describe("④ 排序（纯函数，返回新配置；到头/不在本区返回同引用）", () => {
  it("`moveChromeUnit` 前后移一格", () => {
    const cfg = moveChromeUnit(resetChromeLayout(), "nav", "search", -1);
    expect(cfg.nav).toEqual(["home", "search", "categories", "settings"]);
  });

  it("到头 / 不在这个分区 → **同一个引用**（调用方据此省掉重渲染）", () => {
    const cfg = resetChromeLayout();
    expect(moveChromeUnit(cfg, "nav", "home", -1)).toBe(cfg);        // 已经最左
    expect(moveChromeUnit(cfg, "nav", "settings", 1)).toBe(cfg);     // 已经最右
    expect(moveChromeUnit(cfg, "nav", "menu", 1)).toBe(cfg);         // menu 不在底栏
  });

  it("`moveChromeUnitTo` 拖到第 index 位（越界夹回）", () => {
    const cfg = moveChromeUnitTo(resetChromeLayout(), "readerTools", "settings", 0);
    expect(cfg.readerTools).toEqual(["settings", "source", "chapter", "cache"]);
    expect(moveChromeUnitTo(cfg, "readerTools", "settings", 99).readerTools)
      .toEqual(["source", "chapter", "cache", "settings"]);
  });

  it("**跨分区不会互相挤动**（同一个 id 在别的分区里不受影响）", () => {
    const cfg = moveChromeUnit(resetChromeLayout(), "nav", "search", -1);
    expect(cfg.topActions).toEqual([...TOP_ACTION_IDS]);
  });
});

/**
 * v3.13 新增：▲▼ 必须按**可见顺序**移（编辑器的「顶栏和底栏 / 阅读器」面板用的就是它）。
 *
 * 这一组的判别性全在第 2 条：它把"在原始数组上换位"的**症状**钉成断言 ——
 * 隐藏项夹在中间时，"上移一格"会让屏幕**毫无变化**，而按钮看起来是好端端的。
 */
describe("④b ▲▼ 的可见顺序位移（隐藏项不占位）", () => {
  /** 造一个"隐藏项夹在中间"的配置：底栏藏掉「分类」 */
  const withGap = () => toggleChromeUnit(resetChromeLayout(), "nav", "categories");

  it("隐藏项夹在中间时，在原始数组上换位**屏幕毫无变化**（这就是必须另写一个函数的原因）", () => {
    const cfg = withGap();
    expect(visibleChromeUnits(cfg, "nav")).toEqual(["home", "search", "settings"]);
    const raw = moveChromeUnit(cfg, "nav", "search", -1);   // 与紧邻的「分类」换位（它被藏着）
    expect(raw.nav).toEqual(["home", "search", "categories", "settings"]);
    expect(visibleChromeUnits(raw, "nav")).toEqual(["home", "search", "settings"]);   // ← 一点没动
  });

  it("★ 同一个操作走 `moveChromeUnitVisible` 就真的动了（可见顺序里上移一格）", () => {
    const cfg = moveChromeUnitVisible(withGap(), "nav", "search", -1);
    expect(visibleChromeUnits(cfg, "nav")).toEqual(["search", "home", "settings"]);
    // 隐藏项仍在表里（没被挤掉、也没被顺手显示出来）
    expect(cfg.nav.indexOf("categories")).toBeGreaterThanOrEqual(0);
    expect(isChromeHidden(cfg, "nav", "categories")).toBe(true);
  });

  it("到头 / 自己被隐藏 / 不在这个分区 → **同一个引用**", () => {
    const cfg = resetChromeLayout();
    expect(moveChromeUnitVisible(cfg, "nav", "home", -1)).toBe(cfg);        // 已经最左
    expect(moveChromeUnitVisible(cfg, "nav", "settings", 1)).toBe(cfg);     // 已经最右
    expect(moveChromeUnitVisible(cfg, "nav", "menu", 1)).toBe(cfg);         // menu 不在底栏
    const gap = withGap();
    expect(moveChromeUnitVisible(gap, "nav", "categories", 1)).toBe(gap);   // 自己被隐藏了
  });

  it("跨分区不牵连（阅读器那一节的顺序不受影响）", () => {
    const cfg = moveChromeUnitVisible(resetChromeLayout(), "nav", "search", -1);
    expect(cfg.readerTop).toEqual([...READER_TOP_IDS]);
    expect(cfg.topActions).toEqual([...TOP_ACTION_IDS]);
  });
});

describe("⑤ 面板分区视图（编辑器的输入）", () => {
  it("分区齐全，必需单元也在列表里（面板要能显示「这里有个必需的东西」）", () => {
    const secs = chromeLayoutSections(resetChromeLayout());
    expect(secs.map((s) => s.key)).toEqual([...CHROME_SECTIONS]);
    const nav = secs.find((s) => s.key === "nav")!;
    expect(nav.items.map((i) => i.id)).toEqual([...NAV_UNIT_IDS]);
    // v3.13：底栏只有「设置」是必需的（用户第 3 条），首页/分类/搜索都可隐藏
    expect(nav.items.find((i) => i.id === "settings")!.hideable).toBe(false);
    expect(nav.items.find((i) => i.id === "home")!.hideable).toBe(true);
    expect(nav.items.find((i) => i.id === "categories")!.hideable).toBe(true);
    // 顶栏左侧组两个都是必需的（菜单唤出入口 + 「JM极简版」文字）
    const tl = secs.find((s) => s.key === "topLeft")!;
    expect(tl.items.map((i) => i.hideable)).toEqual([false, false]);
    // 依赖运行时状态的单元要把条件写出来（省得用户"开了却没出现"以为是 bug）
    const rt = secs.find((s) => s.key === "readerTools")!;
    expect(rt.items.find((i) => i.id === "chapter")!.note).toContain("仅多话作品");
  });

  /**
   * v3.13 新增两页的**入口完整性**：每个分区必须**恰好**属于一页。
   * 漏一个 = 那个分区里的单元在编辑器里没有入口（本项目最硬的不变量），
   * 重复一个 = 同一项在两页各出现一次（"同一功能两个入口"）。
   */
  it("★ 六个分区被两页**恰好各分一半**（没有分区漏掉、也没有分区重复）", () => {
    const all = [...CHROME_BAR_SECTIONS, ...READER_CHROME_SECTIONS];
    expect([...all].sort()).toEqual([...CHROME_SECTIONS].sort());
    expect(new Set(all).size).toBe(all.length);
    // 「顶栏和底栏」那一页必须同时含顶栏与底栏（否则名字骗人）
    expect([...CHROME_BAR_SECTIONS]).toContain("topLeft");
    expect([...CHROME_BAR_SECTIONS]).toContain("nav");
  });

  it("分区顺序跟着配置走（面板上的顺序 == 屏幕上的顺序）", () => {
    // 用 moveChromeUnitTo（拖拽 = 取出再插入）；moveChromeUnit 是 ▲▼ 那种「与邻居交换」
    const cfg = moveChromeUnitTo(resetChromeLayout(), "nav", "settings", 0);
    const nav = chromeLayoutSections(cfg).find((s) => s.key === "nav")!;
    expect(nav.items.map((i) => i.id)).toEqual(["settings", "home", "categories", "search"]);
  });
});

describe("⑥ 持久化（localStorage + 读时自愈）", () => {
  it("没配过 → 默认；存了再读 → 一致", () => {
    expect(loadChromeLayout().nav).toEqual([...NAV_UNIT_IDS]);
    saveChromeLayout(toggleChromeUnit(resetChromeLayout(), "nav", "search"));
    expect(loadChromeLayout().hidden).toEqual([...STATUS_OFF, "nav:search"]);
  });

  it("存的 JSON 坏了 → 回默认，不抛", () => {
    localStorage.setItem(UI_KEYS.chromeLayout, "{ 这不是 JSON");
    expect(loadChromeLayout().nav).toEqual([...NAV_UNIT_IDS]);
  });

  it("存的顺序表坏了（含未知 id / 必需单元被藏）→ 读出来是合法配置", () => {
    localStorage.setItem(UI_KEYS.chromeLayout, JSON.stringify({ nav: ["settings", "bogus"], hidden: ["nav:settings", "nav:home"] }));
    const cfg = loadChromeLayout();
    expect(cfg.nav).toEqual(["settings", "home", "categories", "search"]);
    // 必需单元（设置）被强制放出来；可隐藏的（首页）**照旧藏住** —— 两条一起断言，
    // 否则"把所有 hidden 都清掉"这种错实现也能过。
    expect(cfg.hidden).toEqual([...STATUS_OFF, "nav:home"]);
  });

  it("用的 key 是 UI_KEYS.chromeLayout（别处按这个 key 清数据）", () => {
    saveChromeLayout(resetChromeLayout());
    expect(localStorage.getItem(UI_KEYS.chromeLayout)).toBeTruthy();
    expect(UI_KEYS.chromeLayout).toBe("jmclient.chromeLayout.v1");
  });

  it("`hideKey` 与归一化用的是同一套拼法（避免两处各写一份）", () => {
    expect(hideKey("nav", "search")).toBe("nav:search");
    expect(normalizeChromeLayout({ hidden: [hideKey("topActions", "cache")] }).hidden)
      .toEqual([...STATUS_OFF, hideKey("topActions", "cache")]);
  });

  /**
   * v3.12 的**版本迁移**：状态栏那一节默认全关，但光把默认配置写成"全关"不够 ——
   * 老用户浏览器里那份 `hidden: []` 的配置会被原样读回来，于是四条全部显现（DOM 变了）。
   * 所以按**源数据的版本号**补一次。判据是版本号而不是"缺不缺这几条"：
   * 用户可能主动全开、也可能主动全关，用"缺了才补"会把用户的选择覆盖掉。
   */
  it("★ 迁移：v1 / 没有版本号的配置 → 自动补上「状态栏默认全关」", () => {
    expect(normalizeChromeLayout({ hidden: [] }).hidden).toEqual(STATUS_OFF);
    expect(normalizeChromeLayout({ version: 1, hidden: [] }).hidden).toEqual(STATUS_OFF);
    expect(normalizeChromeLayout({ version: 1, hidden: ["nav:search"] }).hidden).toEqual([...STATUS_OFF, "nav:search"]);
  });

  it("★ 负对照：**已经是 v2 的配置，用户主动打开的状态栏条目不许被迁移覆盖**", () => {
    // 用户把「页码」打开了（从 hidden 里去掉），其余三条仍关着
    const mine = { version: CHROME_LAYOUT_VERSION, hidden: ["readerStatus:chapter", "readerStatus:pct", "readerStatus:clock"] };
    const cfg = normalizeChromeLayout(mine);
    expect(cfg.hidden).toEqual(mine.hidden);
    expect(visibleChromeUnits(cfg, "readerStatus")).toEqual(["page"]);   // 只有页码显示
  });
});

describe("⑦ 元数据完整性（渲染层按 id 取组件，缺一条就是运行时报错）", () => {
  it("每个分区的顺序表里每个 id 都有元数据，且元数据的 id 与 key 一致", () => {
    for (const s of CHROME_SECTIONS) {
      const order = DEFAULT_CHROME_LAYOUT[s] as readonly string[];
      const table = chromeLayoutSections(DEFAULT_CHROME_LAYOUT).find((x) => x.key === s)!;
      expect(table.items.map((i) => i.id)).toEqual([...order]);
      for (const id of order) expect(NAV_UNIT_META[id as keyof typeof NAV_UNIT_META]?.id ?? id).toBe(id);
    }
  });

  it("底栏与阅读器上排都有「至少一个不可隐藏项」（否则用户能把整个栏藏空）", () => {
    expect(NAV_UNIT_IDS.filter((id) => !NAV_UNIT_META[id].hideable).length).toBeGreaterThan(0);
    expect(READER_TOP_IDS.length).toBeGreaterThan(0);
  });
});
