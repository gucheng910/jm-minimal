import type { CSSProperties } from "react";
import { UI_KEYS } from "./constants";
import type { ChapterFilter, ChapterOrder } from "./series";

/**
 * 详情页**版面样式**参数层（「自定义 UI → 详情页」选中模块后的配置）。
 *
 * 与 core/detailLayout.ts 的分工：
 *   · `detailLayout` 管**结构** —— 哪些区块出现、什么顺序；
 *   · `detailStyle`（本文件）管**观感** —— 封面多大、标题多大、简介几行、多疏、多圆。
 * 两者分开存：用户常常只想改一个，不该因为改了字号就把结构配置也重置掉。
 *
 * ── v2：尺寸类三项从「档位」升级为「有界数值」（滑块）────────────────
 * v1 全是三档（小/中/大），用户反馈"不够精细"。v2 把尺寸类三项换成有界滑块
 * （封面宽度 / 标题字号 / 简介行数），语义类两项（疏密 / 圆角）保持档位 ——
 * 档位语义用滑块反而难选准。
 * 仍然是**有界**的（Home Assistant："built-in minimum and maximum size"；Mihon 的 0~25 滑块）：
 * 可调 ≠ 任意，滑块两端就是安全边界。旧 v1 字符串值（s/m/l、"2"/"3"/"4"/"all"）
 * 在 normalize 里自动迁移，用户无感。
 *
 * ── 数值走内联 style，档位走 CSS 属性选择器 ─────────────────────────
 * 连续值没法"每档写一条完整声明"，而 `var()` 传数字在 WebView 57 上行为不确定
 * （报告 §4.3 实测），所以数值直接写内联 style（width / font-size / line-clamp，
 * 都是普通盒属性，没有 §3.4 那条比例盒特异度冲突）。档位两项（疏密 / 圆角）
 * 维持 v1 的 `data-dl-*` 属性选择器 + 完整声明。
 * `data-dl-*` 属性对数值项**仍然输出**，但只作为测试 / 验收 / 调试的观测钩子。
 *
 * ── 默认值下不产生任何 DOM 差异 ─────────────────────────────────────
 * `detailStyleAttrs()` 只输出**非默认**的属性；`coverBoxStyle/titleStyle/descStyle`
 * 只在非默认时给内联 style。所以不改设置的用户，详情页渲染出来的 DOM
 * 与本层引入之前**逐字一致** —— 这条有单测锁着。
 */

export type Density = "compact" | "normal" | "roomy";
export type Radius = "none" | "sm" | "md" | "lg";
/** 登场人物一行的字号档位（该元素被 `.d-meta` 的 `font-size: !important` 保护，只能走属性选择器） */
export type ActorSize = "sm" | "md" | "lg";
/**
 * 目录（章节列表）的**排法**：单列列表（默认）↔ 两列网格。
 *
 * 出处（调研 TOP8 第 2 条）：五家实测的章节行形态各不相同（bilibili 网格 42px / 快看 50px /
 * MangaDex 52px / Webtoon 75px），而 Mihon 与 Kotatsu 都把它做成了**用户设置**
 * （`onDisplayModeChanged` / `list_mode` + `grid_size`）—— 说明这是用户真会去调的轴，不只是厂商口味。
 * 为什么值得做：146 话的作品里，找"第 90 话"在单列列表要滚很久，两列网格一屏能看到两倍的行。
 *
 * ⚠️ 为什么挂在**样式轴**而不是 `detail` 块的形态轴（`DETAIL_BLOCK_FORMS`）：
 * `detail` 的形态（标签页 / 折叠三行）管的是"目录/评论/相关 三个面板怎么摆"，
 * 而目录**内部**还有一层排法 —— 两者是**正交**的（折叠形态里同样可以要两列网格），
 * 塞进同一个 `forms` 只会互相顶掉（一个块只能有一个形态值）。
 * 样式轴本来就管"怎么显示"（`density` 就是同一类），而且注册表 / 存储 / 面板 / `data-dl-*`
 * 四件事都能直接复用 —— 新增一条轴的成本只有几十行。
 */
export type ChapLayout = "list" | "grid2";
/**
 * 主视觉（封面 + 标题 / 信息区）的**排布**：左小图 + 右信息（默认，= 现状）↔ 封面居中、信息在下。
 *
 * 出处（调研 TOP8 第 7 条）：三种封面形态都有实例（左小图 / 大图居中 / 模糊铺满），
 * 而 390px 窄屏**必须保留"小图"档**（"大图吃整屏"）—— 所以我们把它做成**可选项**，默认仍是小图那一档。
 *
 * ⚠️ 两点刻意的取舍（写在这里，免得后人以为是漏做）：
 *   ① **不做"模糊铺满"**：调研自己标注"manga 里无实例"，而且要在深浅两套主题上都保证文字不糊，
 *      得额外加一层 scrim —— 收益小、风险大；
 *   ② **这一档不改封面大小**：封面尺寸是「封面大小」那条轴的事。一个档位只表达一件事，
 *      "大图"靠用户把封面大小拖大即可（两轴可组合）。名字因此叫「封面居中」而不是「大图居中」。
 *
 * 与 `chapLayout` 同一个理由挂在样式轴（而不是 `hero` 块的形态轴）：`hero` 的形态行
 * 已经被"信息区怎么排"（逐项卡片 / 紧凑两列表）占用，一个块只能有一个形态值，塞进去会互相顶掉。
 */
export type HeroLayout = "left" | "center";

/**
 * v3 新增的键 —— 让「点进去空空」的块（tags / actors / action / detail）
 * 各自有真实可调项，并给 hero / desc 补强。
 *
 * ⚠️ v3.4（Wave I）：原第 11 个键 `noticeSize`（付费提示字号）**已删除** ——
 * 付费提示不再是区块，那个滑块成了唯一改不动任何东西的控件（哑控件）。
 * 删键而不只是藏起来，是因为 `DEFAULT_DETAIL_STYLE` 是"这一项被改过没有"的比对基准：
 * 老存档里留着 `noticeSize` 却又没有复位入口时，"页面设置"上的圆点会永远亮着。
 *
 * 两条必须守住的纪律（踩过就是静默失效）：
 *  1. **默认值 = 现状 CSS 值**，且默认下 helper 一律返回 `undefined` → 未改配置的用户 DOM 逐字不变；
 *  2. 落在被 `!important` 保护的元素上（`.d-meta`）的键**绝不能走内联** —— author `!important`
 *     高于内联普通声明，用户拖了滑块页面会毫无反应且不报错。那种元素走属性选择器（见 `actorSize`）。
 */
export interface DetailStyleConfig {
  /** 结构版本号，将来换结构时用来迁移（normalize 会把旧数据补齐成新结构） */
  version: number;
  /** 封面宽度 px（3:4 等比，高度由宽度算出 —— 比例盒只支持改宽，报告 §3.4） */
  cover: number;
  /** 标题字号 px */
  title: number;
  /** 简介默认显示几行（descAll 为 true 时不截断，此项失效） */
  desc: number;
  /** 简介显示全部（不截断） */
  descAll: boolean;
  /** 版面密度：区块之间的疏密 */
  density: Density;
  /** 卡片圆角 */
  radius: Radius;
  /** 标签胶囊字号 px（现状 `.tagchip { font-size: 12px }`，最小高度与内边距由它派生） */
  tagSize: number;
  /** 登场人物字号档位（现状 `.d-meta { font-size: 13px }` = `md`） */
  actorSize: ActorSize;
  /** 付费提示字号 px —— **v3.4 已删键**：付费提示不再是区块，见文件头注释 */
  /** 动作区按钮上下内边距 px（现状 `.actrow .btn { padding: 14px 18px }` 的上下值） */
  actionPadY: number;
  /** 动作区按钮字号 px（现状 `.btn { font-size: 14px }`） */
  actionFont: number;
  /** 横栏标签容器的上方间距 px（现状 `.d-tabs { margin-top: 18px }`） */
  tabGap: number;
  /** 目录行字号 px（现状 `.chap-row { font-size: 14px }`；逐行内联，不靠继承） */
  chapFont: number;
  /** 数据条字号 px（现状 `.d-stat { font-size: 11px }`） */
  statFont: number;
  /** 四宫格「值」字号 px（现状 `.d-facts .v { font-size: 12px }`） */
  factFont: number;
  /** 简介正文字号 px（现状 `.d-desc { font-size: 14px }`） */
  descFont: number;
  /** 简介行距（无单位倍率，现状 `.d-desc { line-height: 1.7 }`）—— ⚠️ 与 descStyle 的 maxHeight 系数联动 */
  descLine: number;
  /** 目录排法：单列列表（默认，= 现状）↔ 两列网格。见 `ChapLayout` 的说明 */
  chapLayout: ChapLayout;
  /**
   * 目录顺序：正序（默认，= 服务端给的顺序 = 现状）↔ 倒序（新话在前）。
   * 与 `chapLayout` 同样是**目录**那一块的轴，但管的是"哪些话、按什么次序"（数据层），不是排法。
   */
  chapOrder: ChapterOrder;
  /** 目录筛选：全部（默认）↔ 只看本地已缓存的话。缓存由 `core/offline.scanCachedChapters` 扫出来 */
  chapFilter: ChapterFilter;
  /** 主视觉排布：左小图 + 右信息（默认，= 现状）↔ 封面居中、信息在下。见 `HeroLayout` */
  heroLayout: HeroLayout;
}

/** 走滑块（有界数值）的键 —— `STYLE_RANGE` 必须覆盖它们全部 */
export type NumericStyleKey =
  | "cover" | "title" | "desc"
  | "tagSize" | "actionPadY" | "actionFont"
  | "tabGap" | "chapFont" | "statFont" | "factFont"
  | "descFont" | "descLine";

export type DetailStyleKey = keyof Omit<DetailStyleConfig, "version">;

/** 数值项的滑块边界（有界旋钮：可调 ≠ 任意） */
export const STYLE_RANGE: Record<NumericStyleKey, { min: number; max: number; step: number }> = {
  /** 80 = v1 的"小"，200 再往上封面会压过信息栏 */
  cover: { min: 80, max: 200, step: 4 },
  /** 14 = v1 的"小"；30 是"标题比封面还抢眼"的下限 */
  title: { min: 14, max: 30, step: 1 },
  /** 2 = 现状默认；8 行再长就该点「展开」了 */
  desc: { min: 2, max: 8, step: 1 },
  /** 10 是胶囊还能看清的下限；16 再大就盖过标题 */
  tagSize: { min: 10, max: 16, step: 1 },
  /** 10 = 紧凑；22 是"按钮像块砖"的上限（点按手感主要来自它） */
  actionPadY: { min: 10, max: 22, step: 1 },
  actionFont: { min: 12, max: 18, step: 1 },
  /** 8 = 贴着上一块；28 是"两块之间空一大截" */
  tabGap: { min: 8, max: 28, step: 2 },
  chapFont: { min: 12, max: 16, step: 1 },
  statFont: { min: 10, max: 14, step: 1 },
  factFont: { min: 11, max: 16, step: 1 },
  descFont: { min: 13, max: 19, step: 1 },
  /** 行距倍率；1.4 偏紧、2.0 很松。step 0.05 会踩浮点残差，snapNum 里已做消抖 */
  descLine: { min: 1.4, max: 2.0, step: 0.05 }
};

export const DEFAULT_DETAIL_STYLE: DetailStyleConfig = {
  version: 3,
  cover: 104,
  title: 16,
  desc: 2,
  descAll: false,
  density: "normal",
  radius: "md",
  // ── v3：以下 10 项的默认值**逐个等于现状 CSS 里的实际值**（行号见 jm-stylekeys-plan.md §2）
  //    默认值下对应 helper 返回 undefined、detailStyleAttrs 不输出属性 → DOM 逐字不变
  tagSize: 12,
  actorSize: "md",
  actionPadY: 14,
  actionFont: 14,
  tabGap: 18,
  chapFont: 14,
  statFont: 11,
  factFont: 12,
  descFont: 14,
  descLine: 1.7,
  // v3.8（调研 TOP8 第 2 条）：目录排法。默认 `list` = **逐字等于现状**（单列列表）
  //   ⇒ 默认值下 `detailStyleAttrs` 不输出 `data-dl-chap`、DOM 与加这一项之前一字不差。
  chapLayout: "list",
  // v3.9（调研 TOP8 第 4 条）：目录顺序 + 筛选。默认档同样**逐字等于现状**
  //   （`asc` = 服务端顺序、`all` = 全都显示）。
  chapOrder: "asc",
  chapFilter: "all",
  // v3.10（调研 TOP8 第 7 条）：主视觉排布。默认 `left` = 左小图 + 右信息 = **逐字等于现状**
  heroLayout: "left"
};

/**
 * 每个配置项的元数据：控件类型 + 显示名 + 为什么有它。
 * 配置界面完全由这张表生成 —— 加一项不用改 UI 代码。
 */
export type StyleControl =
  | { kind: "slider"; key: NumericStyleKey; label: string; why: string; unit: string }
  | { kind: "switch"; key: "descAll"; label: string; why: string }
  | {
      kind: "options"; key: "density" | "radius" | "actorSize" | "chapLayout" | "chapOrder" | "chapFilter" | "heroLayout"; label: string; why: string;
      options: Array<{ value: string; label: string }>;
      /**
       * 这个档位项属于哪一层：
       *   · `"page"`（默认）= 「页面设置」里的全局项（疏密 / 圆角）；
       *   · `"block"` = 只该出现在**选中某个块**时的模块检查器里（登场人物字号）。
       * PageStyleSheet 按它过滤，否则 actorSize 会在「页面设置」里多冒一份（v3 踩点）。
       */
      scope?: "page" | "block";
    };

export const DETAIL_STYLE_META: StyleControl[] = [
  {
    kind: "slider", key: "cover", label: "封面大小", why: "主视觉那张封面的宽度（3:4 等比）", unit: "px"
  },
  {
    /**
     * v3.10（调研 TOP8 第 7 条）：主视觉排布。三种封面形态在调研里都有实例，
     * 但 390px 下"大图居中"会把首屏占满 ⇒ 做成可选项、默认仍是小图那一档。
     * 挂 `scope: "block"`：它只对主视觉那一块有意义。
     *
     * ⚠️ 位置刻意紧跟「封面大小」：**显示顺序跟着这张表的声明顺序**（不是 BLOCK_STYLE_KEYS），
     * 而这两项是一对（排布 + 尺寸），分开放会让人以为「封面居中」自己会放大封面。
     */
    kind: "options", key: "heroLayout", label: "封面排布", scope: "block",
    why: "默认「左图右文」省地方；「封面居中」是展示派版式（封面大小仍由上面「封面大小」决定，可配合拖大）",
    options: [
      { value: "left", label: "左图右文" },
      { value: "center", label: "封面居中" }
    ]
  },
  {
    kind: "slider", key: "title", label: "标题字号", why: "作品名的字号", unit: "px"
  },
  {
    kind: "slider", key: "desc", label: "简介行数", why: "没展开时简介占几行", unit: "行"
  },
  {
    kind: "slider", key: "descFont", label: "简介字号", why: "简介正文的字号", unit: "px"
  },
  {
    kind: "slider", key: "descLine", label: "简介行距", why: "简介正文的行高倍率（与行数联动）", unit: ""
  },
  {
    kind: "switch", key: "descAll", label: "简介显示全部", why: "不截断，一次显示完整简介"
  },
  {
    kind: "options", key: "density", label: "版面疏密", why: "区块之间隔多开", scope: "page",
    options: [
      { value: "compact", label: "紧凑" },
      { value: "normal", label: "标准" },
      { value: "roomy", label: "宽松" }
    ]
  },
  {
    kind: "options", key: "radius", label: "圆角", why: "封面 / 按钮 / 标签的圆角", scope: "page",
    options: [
      { value: "none", label: "直角" },
      { value: "sm", label: "小" },
      { value: "md", label: "中" },
      { value: "lg", label: "大" }
    ]
  },
  // ── v3：下面 9 项按「选中哪个块就显示哪几项」挂进 ModuleInspector（BLOCK_STYLE_KEYS）──
  {
    kind: "slider", key: "tagSize", label: "标签大小", why: "标签胶囊的字号（高度与内边距按它等比派生）", unit: "px"
  },
  {
    kind: "options", key: "actorSize", label: "人物字号", why: "登场人物一行的字号", scope: "block",
    options: [
      { value: "sm", label: "小" },
      { value: "md", label: "标准" },
      { value: "lg", label: "大" }
    ]
  },
  {
    kind: "slider", key: "actionPadY", label: "按钮高矮", why: "动作区按钮的上下内边距（点按手感）", unit: "px"
  },
  {
    kind: "slider", key: "actionFont", label: "按钮字号", why: "动作区按钮里的文字大小", unit: "px"
  },
  {
    kind: "slider", key: "tabGap", label: "标签栏上距", why: "横栏标签与上一块之间的距离", unit: "px"
  },
  {
    kind: "slider", key: "chapFont", label: "目录字号", why: "每一话那一行的字号", unit: "px"
  },
  {
    /**
     * v3.8（调研 TOP8 第 2 条）：目录排法。Mihon / Kotatsu 都把它做成用户设置，
     * 五家实测的章节行形态也各不相同 —— 是"用户真会调的轴"。
     * 挂 `scope: "block"`：它只对目录那一块有意义，出现在"页面设置"里会让人以为是全页的。
     */
    kind: "options", key: "chapLayout", label: "目录排法", scope: "block",
    why: "长目录（上百话）用两列网格一屏能看到两倍的行；细看话名还是单列舒服",
    options: [
      { value: "list", label: "单列" },
      { value: "grid2", label: "两列" }
    ]
  },
  {
    /**
     * v3.9（调研 TOP8 第 4 条）：目录顺序。倒序对**长连载**是刚需 ——
     * 146 话的作品里"最新一话"在列表最底部，每次都要滚到底；
     * Mihon / Kotatsu 都把目录顺序做成设置项（`sortDescending` 一类），是用户真会调的轴。
     */
    kind: "options", key: "chapOrder", label: "目录顺序", scope: "block",
    why: "长连载用倒序：最新一话在最上面，不用每次滚到底",
    options: [
      { value: "asc", label: "正序" },
      { value: "desc", label: "倒序" }
    ]
  },
  {
    /**
     * v3.9：目录筛选。Mihon 用 TriState（含 / 不含 / 忽略）做这件事；
     * 我们本地只有一种可靠状态（**已缓存**，即离线能读的），所以先做这一个。
     * ⚠️ 判据是"有页的缓存"（只有封面的目录读不了，见 core/series.visibleChapters 判据③）。
     */
    kind: "options", key: "chapFilter", label: "目录筛选", scope: "block",
    why: "只看手机上已经缓存好的话（离线能读的那些）；没缓存过的话用它会看到空列表",
    options: [
      { value: "all", label: "全部" },
      { value: "cached", label: "只看已缓存" }
    ]
  },
  {
    kind: "slider", key: "statFont", label: "数据条字号", why: "浏览 / 喜欢那一行的字号", unit: "px"
  },
  {
    kind: "slider", key: "factFont", label: "四宫格字号", why: "作者 / 话数 / JM号 / 收录 的字号", unit: "px"
  }
];

// ────────────────────────────────────────────────
// 归一化（脏数据自愈 + v1 → v2 迁移）与持久化
// ────────────────────────────────────────────────
/** v1 的档位字符串 → v2 数值（等于当年那几档的实际像素/行数）。只有这三个键有历史档位值 */
const LEGACY_NUM: Partial<Record<NumericStyleKey, Record<string, number>>> = {
  cover: { s: 80, m: 104, l: 140 },
  title: { s: 14, m: 16, l: 19 },
  desc: { "2": 2, "3": 3, "4": 4 }
};

/**
 * 夹到 [min,max] 并吸附到 step 网格（以 min 为锚）。
 *
 * ⚠️ 末尾的 `toFixed(4)` 不是装饰：`descLine` 的 step 是 0.05，`(1.7-1.4)/0.05*0.05+1.4`
 * 在 IEEE754 下会得到 `1.7000000000000002`。残差会让"默认值 ≠ 归一化后的默认值"，
 * 于是 `isDetailStyleKeyDefault` 判 false → 默认配置也会写出内联样式，直接破"DOM 逐字不变"的红线。
 */
function snapNum(v: number, r: { min: number; max: number; step: number }): number {
  const clamped = Math.min(r.max, Math.max(r.min, v));
  const snapped = Math.round((clamped - r.min) / r.step) * r.step + r.min;
  return Number(snapped.toFixed(4));
}

/** 把任意输入收成合法配置：非法值一律回落默认，缺的字段补上；v1 字符串自动迁移 */
export function normalizeDetailStyle(raw: unknown): DetailStyleConfig {
  const src = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const num = (key: NumericStyleKey): number => {
    const v = src[key];
    if (typeof v === "number" && Number.isFinite(v)) return snapNum(v, STYLE_RANGE[key]);
    const legacy = LEGACY_NUM[key];
    if (typeof v === "string" && legacy && legacy[v] !== undefined) return legacy[v];
    return DEFAULT_DETAIL_STYLE[key];
  };
  const pick = (key: "density" | "radius" | "actorSize" | "chapLayout" | "chapOrder" | "chapFilter" | "heroLayout"): string => {
    const meta = DETAIL_STYLE_META.find((m) => m.key === key) as Extract<StyleControl, { kind: "options" }> | undefined;
    const v = src[key];
    return meta && typeof v === "string" && meta.options.some((o) => o.value === v)
      ? v
      : DEFAULT_DETAIL_STYLE[key];
  };
  return {
    version: DEFAULT_DETAIL_STYLE.version,
    cover: num("cover"),
    title: num("title"),
    desc: num("desc"),
    // v1 的 desc:"all" 就是 v2 的 descAll
    descAll: src.descAll === true || src.desc === "all",
    density: pick("density") as Density,
    radius: pick("radius") as Radius,
    // v3：新增的键。老配置里没有它们 → 一律回落默认值（所以加键不扰动 v1→v2 的迁移结果）
    // v3.4：`noticeSize` 已删 → 老配置里那份值在这里被**丢弃**（不是留着不用），
    //       否则"改过没有"的比对基准会为它永久点亮一个圆点。
    tagSize: num("tagSize"),
    actorSize: pick("actorSize") as ActorSize,
    actionPadY: num("actionPadY"),
    actionFont: num("actionFont"),
    tabGap: num("tabGap"),
    chapFont: num("chapFont"),
    statFont: num("statFont"),
    factFont: num("factFont"),
    descFont: num("descFont"),
    descLine: num("descLine"),
    chapLayout: pick("chapLayout") as ChapLayout,
    chapOrder: pick("chapOrder") as ChapterOrder,
    chapFilter: pick("chapFilter") as ChapterFilter,
    heroLayout: pick("heroLayout") as HeroLayout
  };
}

export function loadDetailStyle(): DetailStyleConfig {
  try {
    const raw = localStorage.getItem(UI_KEYS.detailStyle);
    if (!raw) return { ...DEFAULT_DETAIL_STYLE };
    return normalizeDetailStyle(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DETAIL_STYLE };
  }
}

export function saveDetailStyle(cfg: DetailStyleConfig): void {
  try { localStorage.setItem(UI_KEYS.detailStyle, JSON.stringify(cfg)); } catch { /* 隐私模式：本次会话内仍然生效 */ }
}

// ────────────────────────────────────────────────
// 变更（纯函数：入参不改，返回新对象）
// ────────────────────────────────────────────────
export function setDetailStyle<K extends DetailStyleKey>(
  cfg: DetailStyleConfig,
  key: K,
  value: DetailStyleConfig[K]
): DetailStyleConfig {
  if (cfg[key] === value) return cfg;   // 没变就返回原引用，避免无谓的重渲染
  return { ...cfg, [key]: value };
}

/** 单项复位（调研里最值得抄的一条：Webstudio 的 Alt 点击样式值 = 单项复位） */
export function resetDetailStyleKey(cfg: DetailStyleConfig, key: DetailStyleKey): DetailStyleConfig {
  return setDetailStyle(cfg, key, DEFAULT_DETAIL_STYLE[key]);
}

export function resetDetailStyle(): DetailStyleConfig {
  return { ...DEFAULT_DETAIL_STYLE };
}

export function isDetailStyleKeyDefault(cfg: DetailStyleConfig, key: DetailStyleKey): boolean {
  return cfg[key] === DEFAULT_DETAIL_STYLE[key];
}

/** 有任何一项被改过 → 标题上点个圆点（调研：Style panel 用它表达"这组设过值"） */
export function isDetailStyleModified(cfg: DetailStyleConfig): boolean {
  return (Object.keys(DEFAULT_DETAIL_STYLE) as Array<keyof DetailStyleConfig>)
    .filter((k) => k !== "version")
    .some((k) => !isDetailStyleKeyDefault(cfg, k as DetailStyleKey));
}

// ────────────────────────────────────────────────
// 挂到 DOM 上：数值 → 内联 style（几何）；data-* → 观测钩子
// ────────────────────────────────────────────────
const ATTR_OF: Record<DetailStyleKey, string> = {
  cover: "data-dl-cover",
  title: "data-dl-title",
  desc: "data-dl-desc",
  descAll: "data-dl-descall",
  density: "data-dl-density",
  radius: "data-dl-radius",
  // v3：新增键的观测钩子（同样只作测试 / 真机验收 / 调试用，不驱动几何）
  tagSize: "data-dl-tagsize",
  actorSize: "data-dl-actorsize",
  actionPadY: "data-dl-actionpady",
  actionFont: "data-dl-actionfont",
  tabGap: "data-dl-tabgap",
  chapFont: "data-dl-chapfont",
  statFont: "data-dl-statfont",
  factFont: "data-dl-factfont",
  descFont: "data-dl-descfont",
  descLine: "data-dl-descline",
  /** v3.8：目录排法。CSS 靠 `.detail-card[data-dl-chap="grid2"] .chap-list` 切网格 */
  chapLayout: "data-dl-chap",
  /** v3.9：目录顺序 / 筛选。纯数据层（列表内容变），属性只作观测钩子 */
  chapOrder: "data-dl-chaporder",
  chapFilter: "data-dl-chapfilter",
  /** v3.10：主视觉排布。CSS 靠 `.detail-card[data-dl-herolayout="center"] .d-hero` 换成竖排居中 */
  heroLayout: "data-dl-herolayout"
};

/**
 * 生成要挂在 `.detail-card` 上的 data-* 属性（含数值项的当前值）。
 *
 * **只输出非默认的项** —— 默认配置下一个属性都不加，所以没改过设置的用户
 * 看到的 DOM 与这层引入之前逐字一致（报告 §16.4「不选就不该出现属性」那条原则）。
 * 数值项的属性**不驱动几何**（几何走内联 style），只给测试 / 真机验收 / 调试当观测钩子。
 */
export function detailStyleAttrs(cfg: DetailStyleConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const meta of DETAIL_STYLE_META) {
    const key = meta.key;
    if (isDetailStyleKeyDefault(cfg, key)) continue;
    const v = cfg[key];
    out[ATTR_OF[key]] = v === true ? "1" : String(v);
  }
  return out;
}

/** 封面盒的内联样式（3:4 等比：高 = 宽 × 4/3 取整，与 v1 三档的 104×139 / 80×107 / 140×187 同一算法） */
export function coverBoxStyle(cfg: DetailStyleConfig): CSSProperties | undefined {
  if (isDetailStyleKeyDefault(cfg, "cover")) return undefined;
  return { width: cfg.cover, height: Math.round(cfg.cover * 4 / 3) };
}

/** 标题的内联字号 */
export function titleStyle(cfg: DetailStyleConfig): CSSProperties | undefined {
  if (isDetailStyleKeyDefault(cfg, "title")) return undefined;
  return { fontSize: cfg.title };
}

/**
 * 简介**折叠态**的行数样式（clamp 与折叠高度必须一起给 —— 折叠高度是按行数 × 行距算的，
 * 只改 clamp 不改 max-height 的话，文字被 max-height 切掉而 clamp 还没到）。
 *
 * ⚠️ v3 联动（本文件唯一一个踩雷点）：`maxHeight` 的系数是**行距** `cfg.descLine`，
 *    不再是硬编码的 1.7。而默认短路条件必须放宽成"行数**与**行距**同时**为默认"：
 *    只要行距被改过，即使行数还是默认 2，也必须写出 maxHeight ——
 *    因为 `index.css` 里那条 `max-height: 3.4em` 是按 1.7 算的，会对不上新行距，
 *    结果是**文字被截断而 line-clamp 尚未生效**：不报错、单测不写哨兵就测不出、只有截图能看出。
 *
 * ⚠️ 展开态**不要**用本函数：展开时 AlbumDetail 只给量出来的完整高度
 * （`{ maxHeight: descH }`），且必须不带 line-clamp，否则内联 clamp 压过
 * `.d-desc.open` 的解除规则，文字永远展不开。
 */
export function descStyle(cfg: DetailStyleConfig): CSSProperties | undefined {
  if (cfg.descAll) return { WebkitLineClamp: "unset", maxHeight: "none" };
  if (cfg.desc === DEFAULT_DETAIL_STYLE.desc && cfg.descLine === DEFAULT_DETAIL_STYLE.descLine) return undefined;
  // 去掉尾零：默认行距下 3 行仍是 "5.1em"（与改造前逐字一致），非默认行距才出现两位小数
  return { WebkitLineClamp: cfg.desc, maxHeight: String(Number((cfg.desc * cfg.descLine).toFixed(2))) + "em" };
}

// ────────────────────────────────────────────────
// v3：11 个新键的内联出口
// ────────────────────────────────────────────────
/**
 * 「字号」类键共用的最小助手：默认值返回 `undefined`（DOM 零差异的红线），否则给 `fontSize`。
 * 这些元素都没有 `!important` 保护，内联（特异度 1,0,0）必胜 —— 唯一的例外是 `.d-meta`：
 * 它的 `font-size` 带 `!important`，内联会被压掉，所以登场人物走属性选择器（见 index.css
 * 的 `[data-dl-actorsize]` 规则），**不经过本助手**。
 */
function fontSizeStyle(cfg: DetailStyleConfig, key: NumericStyleKey): CSSProperties | undefined {
  return isDetailStyleKeyDefault(cfg, key) ? undefined : { fontSize: cfg[key] };
}

/**
 * 标签胶囊：字号 + 由字号**等比派生**的最小高度与内边距。
 * 派生比例取自现状实装值（`.tagchip { font-size: 12px; min-height: 28px; padding: 5px 10px }`）：
 * N=12 → 28 / 5 / 10，即 7/3、5/12、10/12 —— 所以**默认值下本函数返回 `undefined`**（零内联）。
 * 测试里把 N=16 的期望值写死（37 / 7 / 13），防公式被悄悄改。
 */
export function tagChipStyle(cfg: DetailStyleConfig): CSSProperties | undefined {
  if (isDetailStyleKeyDefault(cfg, "tagSize")) return undefined;
  const n = cfg.tagSize;
  const padY = Math.round((n * 5) / 12);
  const padX = Math.round((n * 10) / 12);
  return {
    fontSize: n,
    minHeight: Math.round((n * 7) / 3),
    paddingTop: padY,
    paddingBottom: padY,
    paddingLeft: padX,
    paddingRight: padX
  };
}

/** 数据条字号 */
export function statStyle(cfg: DetailStyleConfig): CSSProperties | undefined {
  return fontSizeStyle(cfg, "statFont");
}

/** 四宫格「值」字号（只给属性，不动 `.d-facts` 的 grid 结构） */
export function factValStyle(cfg: DetailStyleConfig): CSSProperties | undefined {
  return fontSizeStyle(cfg, "factFont");
}

/** 目录行字号（必须**逐行**给：`.chap-row` 自带 `font: inherit; font-size: 14px`，靠容器继承会被它盖掉） */
export function chapRowStyle(cfg: DetailStyleConfig): CSSProperties | undefined {
  return fontSizeStyle(cfg, "chapFont");
}

/** 简介正文字号（与 descStyle / descLineStyle 并列使用，互不抢属性） */
export function descFontStyle(cfg: DetailStyleConfig): CSSProperties | undefined {
  return fontSizeStyle(cfg, "descFont");
}

/** 简介行距 —— 与 `descStyle()` 的 maxHeight 系数**同源**，两者必须一起用，否则字会被截断 */
export function descLineStyle(cfg: DetailStyleConfig): CSSProperties | undefined {
  return isDetailStyleKeyDefault(cfg, "descLine") ? undefined : { lineHeight: cfg.descLine };
}

/** 动作区按钮：两个键合成一份内联（上下内边距 = 点按手感；字号 = 文字大小） */
export function actionBtnStyle(cfg: DetailStyleConfig): CSSProperties | undefined {
  const pad = isDetailStyleKeyDefault(cfg, "actionPadY") ? undefined : cfg.actionPadY;
  const font = isDetailStyleKeyDefault(cfg, "actionFont") ? undefined : cfg.actionFont;
  if (pad === undefined && font === undefined) return undefined;
  const out: CSSProperties = {};
  if (pad !== undefined) {
    out.paddingTop = pad;
    out.paddingBottom = pad;
    // 左右内边距仍由 CSS 给（18px）：这里只动上下，别把按钮的横向呼吸也改掉
  }
  if (font !== undefined) out.fontSize = font;
  return out;
}

/** 横栏标签容器：只给上方间距（刻意不碰 `UnderlineTabs` 内部 —— 它同时被分类页使用，改内部会波及列表页） */
export function tabsStyle(cfg: DetailStyleConfig): CSSProperties | undefined {
  return isDetailStyleKeyDefault(cfg, "tabGap") ? undefined : { marginTop: cfg.tabGap };
}
