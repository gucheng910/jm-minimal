import { UI_KEYS } from "./constants";
import { moveInList, moveToInList, orderize } from "./layoutOrder";
import type { LayoutSection } from "./layoutOrder";

/**
 * 详情页「展示编排」参数层。
 *
 * 定位：**把详情页的版面从 JSX 里搬进数据**——哪些区块出现、以什么顺序出现、
 * 四宫格放哪几个字段，全部由这里的配置描述；AlbumDetail.tsx 只负责按配置渲染。
 *
 * 为什么要有这一层（而不是继续在 JSX 里手写顺序）：
 *   · 详情页 v6→v7.1 那次改版，本质就是"把模块重排一遍"——也就是说**版面配置这件事
 *     已经在发生，只不过存在代码里**。这一层把它变成数据，于是它可以被持久化、被界面编辑。
 *   · 详情页是**有限页面**（不像首页/分类/搜索是无限滚动网格），高度由固定内容决定，
 *     所以"编排"这件事对它成立；这是选择它做第一个页面而不是首页的原因。
 *
 * 与 core/tapZones.ts 同构（那是本项目已有的先例）：类型 + 默认值 + 纯函数 + load/save + 单测。
 *
 * ⚠️ 本层**只管"顺序与显隐"，不管像素**。
 *   位置模型刻意选「分区 + 顺序」而不是 {x,y,w,h}：Grafana 用 gridPos 网格单位、
 *   Home Assistant 用 grid size picker、Android 用 targetCellWidth——成熟产品没有一个
 *   让用户给页面元素填像素（理由见 docs 调研报告）。
 */

// ────────────────────────────────────────────────
// 顶层区块：.detail-card 的直接子块，顺序 = 渲染顺序
// ────────────────────────────────────────────────
export type DetailBlockId =
  /** 返回（.d-head） */
  | "back"
  /** 主视觉：封面 + 标题 / 四宫格 / 数据条（.d-hero） */
  | "hero"
  /** 登场人物（.d-actors） */
  | "actors"
  /** 标签胶囊（.d-tags） */
  | "tags"
  /**
   * 付费提示（.d-locked）—— **v3.4 起不再是区块**（已并入动作区主按钮）。
   * 保留在类型里只为"老存档读得出来"，见 `DETAIL_BLOCK_IDS` 的注释。
   */
  | "notice"
  /** 动作区：购买 / 阅读 + 收藏（.actrow） */
  | "action"
  /** 简介 + 展开（.d-desc + .d-more） */
  | "desc"
  /** 横栏标签及其面板：目录 / 评论 / 相关漫画（.d-tabs + 面板） */
  | "detail";

/** 主视觉的左右两栏（.d-hero 的两个直接子元素），顺序 = 左右顺序 */
export type HeroSlotId = "cover" | "info";

/** 主视觉右栏内的纵向顺序（.d-hero-info 的子元素） */
export type HeroInfoSlotId = "title" | "facts" | "stat";

/** 四宫格字段（.d-facts 内，2×2 行优先） */
export type FactId = "author" | "chapCount" | "jmId" | "addDate";

/**
 * `detail`（目录 / 评论 / 相关漫画）这一块**内部**的三个面板（v3.5）。
 *
 * 为什么现在把它们拆开：用户原话「目录评论相关漫画模块**不仅可以隐藏其中的一个或两个**」——
 * 在此之前它们是**互斥 tab**，配置里根本没有它们各自的开关，用户无法"只留目录"。
 *
 * ⚠️ 拆开的是**配置与显隐**，不是"三个可以摆放的区块"：
 *   画布上仍然是**一个** `detail` 块（用户同一轮明确要求内层一律在配置栏里调，
 *   而不是都做成可点选的模块）。所以它们只进 `panels` 这张表，不进 `blocks`。
 */
export type DetailPanelId = "dir" | "cmt" | "rel";

/** 任意层级的节点 id —— hidden 是扁平的一份名单 */
export type DetailNodeId = DetailBlockId | HeroSlotId | HeroInfoSlotId | FactId | DetailPanelId;

/**
 * v3「流式槽位」的跨格数：12 列网格里**有界的几档**。
 *
 * 为什么是档位而不是 1~12 的滑块：12 列里"看起来合理"的跨格数是离散的几个
 * （12 独占一行 / 8 宽 + 4 / 6 两个并排 / 4 三个并排 / 3 四个并排），
 * 滑块会产生 7、5、11 这种凑不满一行、语义也说不清的值。
 * 与 stylekeys 的"有界旋钮"同一条设计原则（调研 §2.2：成熟产品全是档位）。
 */
export type SlotSpan = 12 | 9 | 8 | 6 | 4 | 3;

export interface DetailLayoutConfig {
  /** 结构版本号；将来换结构时用它做迁移（normalize 会把旧数据补齐成新结构） */
  version: number;
  blocks: DetailBlockId[];
  /**
   * v3：每块的跨格数。**缺省 = 12（满宽）**，所以默认配置里它是 `{}` ——
   * "从没配过"与"配过但全是满宽"因此走**同一条**渲染路径（红线的前提，见 `isSlotted`）。
   */
  spans: Partial<Record<DetailBlockId, SlotSpan>>;
  /**
   * v3.4：每块在**行内的起始列**（0~12-span），缺省 = 0 = 顶格。
   *
   * 用户要的是"1/2 宽的块可以停在行中间而不是必须顶格"，于是宽度之外还需要**位置**。
   * 只有不满宽的块才有位置可言（满宽块 offset 恒为 0，normalize 会把它丢掉），
   * 所以 `offsets` 非空 ⇒ `spans` 非空 ⇒ `isSlotted` 为真，"默认零差异"这条不受影响。
   */
  offsets: Partial<Record<DetailBlockId, number>>;
  /**
   * v3.5：每块的**形态** —— 同一块的不同呈现方式（如 `detail` 的「标签页」/「折叠三行」）。
   *
   * 与 `spans` / `offsets` 同一套不变量：**只有"非默认形态"才写**（默认 = 注册表第一项），
   * 所以从没配过形态的用户这里恒为 `{}`，渲染路径一条都没变（红线）。
   *
   * ⚠️ 形态与 v3 的网格**无关**：改形态**不升 `version`**（升版是"改过宽度"的专属动作），
   * 否则"只想要折叠形态"的用户会连带被切进网格渲染。
   */
  forms: Partial<Record<DetailBlockId, string>>;
  heroSlots: HeroSlotId[];
  heroInfoSlots: HeroInfoSlotId[];
  facts: FactId[];
  /** v3.5：`detail` 内部三个面板的顺序（显隐走 `hidden`，与其它内层节点同一套） */
  panels: DetailPanelId[];
  /** 隐藏的节点（任意层级）。放进这里的必须是 DETAIL_NODE_META 里 hideable 的节点 */
  hidden: DetailNodeId[];
}

// ────────────────────────────────────────────────
// 节点元数据：配置面板要用的显示名 + 是否允许隐藏
// ────────────────────────────────────────────────
export interface DetailNodeMeta {
  /** 配置面板里显示的名字 */
  label: string;
  /**
   * 是否允许隐藏。
   * 只把「藏了会让用户走不出去」的**动作区**钉死（阅读 / 收藏是唯一出口）。
   * 其余一律允许——用户想藏什么都行，藏错了有"恢复默认"。
   *
   * v3.3：**返回**由钉死改为可隐藏（用户要求：「手机上其实一些用户用不上」）。
   * 藏了不会把人困住：编辑器自己有顶栏返回，系统返回键也仍能退出。
   */
  hideable: boolean;
  /** 分组，配置面板按它分节 */
  group: "区块" | "主视觉" | "四宫格" | "详情面板";
}

export const DETAIL_NODE_META: Record<DetailNodeId, DetailNodeMeta> = {
  back: { label: "返回", hideable: true, group: "区块" },
  hero: { label: "主视觉（封面 / 标题）", hideable: true, group: "区块" },
  actors: { label: "登场人物", hideable: true, group: "区块" },
  tags: { label: "标签", hideable: true, group: "区块" },
  /**
   * v3.4（Wave I）：**「付费提示」区块已下线**。
   *
   * 用户第 3 条要求"付费提示与阅读按钮共用一个按钮"，内容已搬进动作区的主按钮
   * （`core/actionButton.ts`），页面不再渲染任何独立元素 —— 于是这个 id 从
   * `DETAIL_BLOCK_IDS` 里移走，编辑画布不再为它渲染一个**点进去只有装饰**的空块。
   *
   * 这里保留 meta 是**为了老存档读得出来**（`DetailBlockId` 类型也保留）：
   * 老配置里可能写着它，`normalizeDetailLayout` 必须静默丢弃而不是抛异常。
   *
   * `hideable: false` 是刻意选的：老存档里若写着 `hidden: ["notice"]`，
   * 这条会让 `normalize` 顺手把它清掉。否则那个"已隐藏"条目既没有渲染对象、
   * 也没有取消隐藏的入口，只会让"这一页改过"的圆点永远亮着 —— 又一种哑状态。
   */
  notice: { label: "付费提示", hideable: false, group: "区块" },
  action: { label: "动作区（阅读 / 收藏）", hideable: false, group: "区块" },
  desc: { label: "简介", hideable: true, group: "区块" },
  detail: { label: "目录 / 评论 / 相关漫画", hideable: true, group: "区块" },

  /**
   * v3.5：`detail` 块内部的三个面板 —— 终于能**各自隐藏**了（用户第 4 条）。
   *
   * 它们的入口在**点「目录 / 评论 / 相关漫画」那块之后的配置栏里**（`NodeOrderList`），
   * 画布上不点选、不拖拽（用户同轮要求内层一律在配置栏里调）。
   *
   * ⚠️ 三个**不许全关**（全关 = 区块变空盒）：`setDetailNodeHidden` 与 `normalize` 都会拒绝，
   *    并且界面会给一行说明而不是静默吞掉 —— 见 `MIN_VISIBLE_PANELS` 的注释。
   */
  dir: { label: "目录", hideable: true, group: "详情面板" },
  cmt: { label: "评论", hideable: true, group: "详情面板" },
  rel: { label: "相关漫画", hideable: true, group: "详情面板" },

  cover: { label: "封面", hideable: true, group: "主视觉" },
  info: { label: "信息栏", hideable: false, group: "主视觉" },
  title: { label: "标题", hideable: true, group: "主视觉" },
  facts: { label: "四宫格", hideable: true, group: "主视觉" },
  stat: { label: "数据条（浏览 / 喜欢）", hideable: true, group: "主视觉" },

  author: { label: "作者", hideable: true, group: "四宫格" },
  chapCount: { label: "话数 / 页数", hideable: true, group: "四宫格" },
  jmId: { label: "JM号", hideable: true, group: "四宫格" },
  addDate: { label: "收录", hideable: true, group: "四宫格" }
};

// ────────────────────────────────────────────────
// 默认值 —— **必须与改造前的实际版面逐字一致**（这是本次重构的验收线）
// ────────────────────────────────────────────────
/**
 * 顶层区块的**完整清单**（顺序 = 默认渲染顺序）。
 *
 * ⚠️ v3.4（Wave I）起**不含 `notice`**：付费提示已并入动作区主按钮，不再是一个区块。
 * 它曾被列在这里，导致编辑画布为它渲染一个空块、点进去只有一个改不动任何东西的
 * 滑块（用户最恨的"哑控件"）。`detailLayout` 的其余部分都用本数组当白名单/顺序表，
 * 所以从这里移走 = 五件事一起生效：默认顺序、normalize 的过滤、跨格/偏移的白名单、
 * 编辑画布的块集合、"共 N 块"的计数。
 *
 * `notice` 仍在 `DetailBlockId` 与 `DETAIL_NODE_META` 里，只是不再被渲染。
 */
export const DETAIL_BLOCK_IDS: readonly DetailBlockId[] = [
  "back", "hero", "actors", "tags", "action", "desc", "detail"
];
export const HERO_SLOT_IDS: readonly HeroSlotId[] = ["cover", "info"];
export const HERO_INFO_SLOT_IDS: readonly HeroInfoSlotId[] = ["title", "facts", "stat"];
export const FACT_IDS: readonly FactId[] = ["author", "chapCount", "jmId", "addDate"];
/**
 * `detail` 内部三个面板的**完整清单与默认顺序**（顺序 = 横栏从左到右）。
 *
 * ⚠️ 与 `DETAIL_BLOCK_IDS` 不同：这三个**不是**顶层区块，不进 `blocks`、不参与 12 列网格、
 * 画布上不可点选 —— 它们是 `detail` 这一块的**内部**结构，入口在那块的配置栏里。
 */
export const DETAIL_PANEL_IDS: readonly DetailPanelId[] = ["dir", "cmt", "rel"];

/**
 * `detail` 的三个面板**至少留一个**（v3.5）。
 *
 * 全关 = 区块变空盒（横栏没了、面板内容也没有，只剩一块空白高度），所以模型层直接拒绝：
 * `setDetailNodeHidden` 原样返回、`normalizeDetailLayout` 对手改过的数据自愈。
 *
 * ⚠️ 但"拒绝"**必须被解释**（用户原话的脾气：「要解释，不要哑掉」）——
 *    界面在用户点到最后一个时给一行说明，见 `ui/NodeOrderList` 的 `minVisible` / `refuseHint`。
 */
export const MIN_VISIBLE_PANELS = 1;

export const DETAIL_LAYOUT_VERSION = 1;

/**
 * v3 结构版本号：**只有用户显式改过宽度（`setDetailBlockSpan`）才写它**。
 *
 * 这条是「线上 DOM 逐字不变」红线的守门人：`normalize` **不会**把老配置升到 3，
 * 所以"进过一次编辑器"≠"版面变了"。迁移必须是**显式动作**，不能靠"读一次就升级"。
 */
export const DETAIL_LAYOUT_VERSION_SLOTS = 3;

/** 允许的跨格数（白名单：非法值一律**丢弃**，不夹取 —— 坏值该回落默认，而不是产生用户没选过的宽度） */
export const SPAN_ALLOWED: readonly SlotSpan[] = [12, 9, 8, 6, 4, 3];

/** 缺省跨格数 = 满宽 = 现状的纵向流 */
export const SPAN_DEFAULT: SlotSpan = 12;

/**
 * 宽度控件的档位文案：**UI 与测试共用这一份**，避免"选项表"与"白名单"两处漂移。
 * 文案是给用户看的语义（满宽 / 2/3 …），不是像素也不是格子数。
 *
 * v3.4 加 3/4（9 列）：用户点名要的档位。9 与 3 刚好凑满一行（9+3），
 * 与 8+4 / 6+6 / 4+4+4 / 3×4 一样属于"能凑满"的组合，所以它是有语义的档位，
 * 不是一个凑数的中间值。
 */
export const SPAN_OPTIONS: ReadonlyArray<{ span: SlotSpan; label: string; hint: string }> = [
  { span: 12, label: "满宽", hint: "独占一行（默认）" },
  { span: 9, label: "3/4", hint: "占 9/12 列，可与一个 1/4 的块并排" },
  { span: 8, label: "2/3", hint: "占 8/12 列，可与一个 1/3 的块并排" },
  { span: 6, label: "1/2", hint: "占一半，与另一个 1/2 的块并排" },
  { span: 4, label: "1/3", hint: "占三分之一，三个并排" },
  { span: 3, label: "1/4", hint: "占四分之一，四个并排" }
];

export const DEFAULT_DETAIL_LAYOUT: DetailLayoutConfig = {
  version: DETAIL_LAYOUT_VERSION,
  blocks: [...DETAIL_BLOCK_IDS],
  spans: {},
  offsets: {},
  forms: {},
  heroSlots: [...HERO_SLOT_IDS],
  heroInfoSlots: [...HERO_INFO_SLOT_IDS],
  facts: [...FACT_IDS],
  panels: [...DETAIL_PANEL_IDS],
  hidden: []
};

/**
 * 「形态」注册表（v3.5）：某个区块可以有哪些**呈现方式**。
 *
 * 用户原话：「可以为部分模块增加更多的形态，比如……也可以**切换成折叠起来的三行的形态**」。
 * 所以这是一个**会继续长的维度**，用注册表而不是给 `detail` 写死一个布尔：
 * 给别的块加形态 = **只加数据**（这里加一段 + 渲染里加一个分支），归一化 / 复位 / UI 都不用动。
 *
 * 两条不变量：
 *   · 每个数组的**第一项就是默认形态** = 改造前的既有形态 = **不写进配置**（与 spans/offsets 的
 *     "默认不写"同一条：没配过的用户 `forms` 恒为 `{}`，渲染路径一条都没变）；
 *   · 只有长度 > 1 的块才在配置栏里出现"形态"那一行 —— 只有一个形态 = 没得选 = 哑控件。
 */
export interface DetailFormOption {
  /** 形态 id（写进 `forms`）；必须与渲染分支的名字一致 */
  id: string;
  /** 档位按钮上的文案 */
  label: string;
  /** 这一档长什么样（一行说明，给用户看） */
  hint: string;
  /**
   * 这个形态**只在哪些宽度档下可用**（缺省 = 任何宽度都可用）。
   *
   * 为什么要有这条（调研点出的轴冲突①）：形态与宽度会打架 ——
   * 例如"信息区排成两列 label:value 紧凑表"在 3 列宽（≈91px）下根本放不下，
   * 而"大图封面"在 6 列宽下会把整块占满。没有这条过滤时，用户能选出一个**必然难看**的组合，
   * 然后以为是 bug。
   *
   * ⚠️ 两条纪律：
   *   ① **注册表第一项（默认档）不许声明 `spans`** —— 默认档必须任何宽度都可用，
   *      否则 `blockForm` 的回落链就没有终点（有单测钉这条不变量）；
   *   ② 已经选了、但当前宽度不支持的形态 → **读时回落**到默认档（不静默改配置值，
   *      与"配置里写着已删形态"同一口径）。宽度改回去，原来的形态会自己回来。
   */
  spans?: readonly SlotSpan[];
}

export const DETAIL_BLOCK_FORMS: Partial<Record<DetailBlockId, readonly DetailFormOption[]>> = {
  detail: [
    { id: "tabs", label: "标签页", hint: "横栏切换，一次看一个（默认）" },
    { id: "folded", label: "折叠三行", hint: "目录 / 评论 / 相关漫画各占一行，点一下展开" }
  ],
  /**
   * 标签：**折行**（默认）↔ **横滑一行**。
   *
   * 出处（调研 TOP8 第 3 条）：Mihon 同一个模块有两态（收起时 LazyRow 横滑、展开时 FlowRow 折行）；
   * Comick 把 18 个 chip 塞进一个 max-height 的滚动盒。
   * 为什么值得做：窄屏 + 标签多的作品（18 个标签）折行会占掉 5~6 行、把目录挤下去；
   * 横滑一行固定只占 1 行。**只改容器类，不改结构**（chip 还是那些 chip）。
   */
  tags: [
    { id: "wrap", label: "折行", hint: "标签铺满一行后换行（默认；标签多时占几行）" },
    { id: "scroll", label: "横滑一行", hint: "一行放不下就横向滑动，永远只占一行" }
  ],
  /**
   * 主视觉的信息区（作者 / 话数 / JM号 / 收录）：**逐项**（默认）↔ **紧凑两列表**。
   *
   * 出处（调研 TOP8 第 5 条）：Marvel 把元信息排成两列 label:value，**每行 21px**
   * （同一页的章节行是 52px）；Kotatsu 直接有一个 `layout_details_table`。
   * 我们现在的 `.d-facts` 是"2 列卡片、label 在 value 上方"（每项占约 37px）——
   * 换成"两列 label:value 表"后一屏能多放一行信息。**只改容器类，不改结构**（`.fact` 里本来就是 `k` + `v`）。
   */
  hero: [
    { id: "cards", label: "逐项卡片", hint: "作者 / 话数 / JM号 / 收录 各占一格，label 在值上方（默认）" },
    { id: "infoTable", label: "紧凑两列表", hint: "label 与值同一行并排，一屏能多放一行信息", spans: [6, 8, 9, 12] }
  ]
};

/** 某块的默认形态 id（注册表第一项）；没有形态可选的块返回空串 */
export function defaultFormOf(id: DetailBlockId): string {
  const list = DETAIL_BLOCK_FORMS[id];
  return list && list.length ? list[0].id : "";
}

/**
 * 某块**在当前宽度档下可选**的形态列表（缺省 = 注册表全量）。
 *
 * 面板按它渲染档位按钮、`blockForm` 按它回落 —— 两处共用同一个口径，
 * 所以"面板上看得见的"与"读出来生效的"永远一致（不会出现"面板不给选、读出来却是它"）。
 *
 * ⚠️ 第一项（默认档）永远在列表里：注册表的不变量是"默认档不许声明 `spans`"
 * （有单测钉着）。有这条，回落链才有终点，`blockForm` 也就不可能返回一个当前宽度下不可用的值。
 */
export function formsFor(cfg: DetailLayoutConfig, id: DetailBlockId): DetailFormOption[] {
  const list = DETAIL_BLOCK_FORMS[id];
  if (!list || !list.length) return [];
  const span = blockSpan(cfg, id);
  return list.filter((f) => !f.spans || f.spans.indexOf(span) >= 0);
}

/**
 * 某块当前生效的形态。
 *
 * 两种情况都**读时回落**到默认档（不改写配置值）：
 *   · 配置里写着一个**已经不在注册表里**的值（将来删掉某个形态）；
 *   · 写着的形态**在当前宽度档下不可用**（轴冲突①：例如 3 列宽选不了"紧凑两列表"）。
 * 回落而不是改写，是为了"宽度改回去，原来选的形态自己回来"——
 * 静默改写会让用户"改了下宽度，我的选择就永久丢了"。
 */
export function blockForm(cfg: DetailLayoutConfig, id: DetailBlockId): string {
  const all = DETAIL_BLOCK_FORMS[id];
  if (!all || !all.length) return "";
  const v = cfg.forms ? cfg.forms[id] : undefined;
  if (v === undefined) return all[0].id;
  return formsFor(cfg, id).some((f) => f.id === v) ? v : all[0].id;
}

/**
 * 设某块的形态。传**默认形态** = 从 `forms` 里删掉（"默认不写"这条不变量要能往返）。
 *
 * 未知形态 **原样返回**（不静默改成别的、也不抛）：静默改会变成"点了却什么都没发生"，
 * 而那正是用户最恨的哑控件；这里的调用点只会传注册表里的值（界面按注册表渲染按钮）。
 */
export function setDetailBlockForm(cfg: DetailLayoutConfig, id: DetailBlockId, form: string): DetailLayoutConfig {
  const list = DETAIL_BLOCK_FORMS[id];
  if (!list || !list.length) return cfg;
  if (!list.some((f) => f.id === form)) return cfg;
  if (blockForm(cfg, id) === form) return cfg;      // 值没变 → 原样返回（连带省掉整次重渲染）
  const forms: Partial<Record<DetailBlockId, string>> = { ...cfg.forms };
  if (form === list[0].id) delete forms[id];
  else forms[id] = form;
  // ⚠️ 不动 `version`：形态与 12 列网格无关，"只换形态"不该把用户切进网格渲染
  return { ...cfg, forms };
}

// ────────────────────────────────────────────────
// 归一化：对脏数据 / 旧版本数据自愈
// ────────────────────────────────────────────────
/**
 * 把任意输入收成一个**合法**配置。规则：
 *   1. 未知 id 丢掉（旧版本删掉的模块不会让页面渲染出 undefined）；
 *   2. 缺失 id **补到尾部**（新版本新增的模块，老配置里没有 → 自动出现，不用迁移脚本）；
 *   3. 重复 id 去重；
 *   4. 不允许隐藏的节点强制取消隐藏（用户改坏了数据也走不出去）。
 *
 * 第 2 条是关键：**将来给详情页加一个新模块，老用户的配置会自动带上它**，
 * 否则新模块对老用户永远不出现，是个很隐蔽的 bug。
 * （1 / 2 / 3 的实现在 core/layoutOrder.ts，与列表页那层共用同一份。）
 */
export function normalizeDetailLayout(raw: unknown): DetailLayoutConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<DetailLayoutConfig>;

  // v3 的槽位**只在配置里显式写着 3 时才认**：老配置（version 缺失/1）读到就是 1，
  // 于是"进过一次编辑器"不会把版面变成网格（红线）。升版只发生在用户真的改宽度那一刻。
  const slotsOn = src.version === DETAIL_LAYOUT_VERSION_SLOTS;
  const version = slotsOn ? DETAIL_LAYOUT_VERSION_SLOTS : DETAIL_LAYOUT_VERSION;

  // 跨格数：白名单过滤 + 丢掉等于默认(12)的项（保持"默认 = {}"这条不变量）
  const spans: Partial<Record<DetailBlockId, SlotSpan>> = {};
  if (slotsOn && src.spans && typeof src.spans === "object") {
    const rawSpans = src.spans as Record<string, unknown>;
    for (const id of DETAIL_BLOCK_IDS) {
      const v = rawSpans[id];
      if (SPAN_ALLOWED.indexOf(v as SlotSpan) >= 0 && v !== SPAN_DEFAULT) spans[id] = v as SlotSpan;
    }
  }

  // 行内起始列：同样只在 v3 配置里认；范围按**该块自己的跨格数**夹（offset ≤ 12 - span）。
  // 满宽块（offset 上限 0）与等于 0 的项都不入表 —— 保持"顶格 = 不写"这条不变量。
  const offsets: Partial<Record<DetailBlockId, number>> = {};
  if (slotsOn && src.offsets && typeof src.offsets === "object") {
    const rawOffsets = src.offsets as Record<string, unknown>;
    for (const id of DETAIL_BLOCK_IDS) {
      const span = spans[id];
      if (span === undefined) continue;                 // 满宽块没有位置可言
      const v = rawOffsets[id];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const off = Math.max(0, Math.min(12 - span, Math.floor(v)));
      if (off > 0) offsets[id] = off;
    }
  }

  const hidden = new Set<DetailNodeId>();
  if (Array.isArray(src.hidden)) {
    for (const id of src.hidden) {
      if (typeof id !== "string") continue;
      if (!(id in DETAIL_NODE_META)) continue;                 // 未知 id 丢掉
      if (!DETAIL_NODE_META[id as DetailNodeId].hideable) continue; // 关键节点不许藏
      hidden.add(id as DetailNodeId);
    }
  }

  /**
   * 形态（v3.5）：**刻意不随 `version` 门控**。
   *
   * `spans` / `offsets` 要在 v3 配置里才认（它们会把版面切成网格，红线要求"升版必须是
   * 用户的显式动作"）；形态与网格无关，只换一个块内部的呈现方式，所以任何时候都认。
   * 三件事一起丢：未知区块 id、未知形态 id、**等于默认形态的项**（"默认不写"要能往返）。
   */
  const forms: Partial<Record<DetailBlockId, string>> = {};
  if (src.forms && typeof src.forms === "object") {
    const rawForms = src.forms as Record<string, unknown>;
    for (const id of DETAIL_BLOCK_IDS) {
      const list = DETAIL_BLOCK_FORMS[id];
      if (!list || !list.length) continue;                     // 这一块没有形态可选
      const v = rawForms[id];
      if (typeof v !== "string") continue;
      if (!list.some((f) => f.id === v)) continue;             // 未知形态丢掉
      if (v === list[0].id) continue;                          // 默认形态不写
      forms[id] = v;
    }
  }

  // `detail` 的面板（v3.5）：与其它内层列表同一套 orderize（缺的补到尾部、未知的丢掉）。
  const panels = orderize(src.panels, DETAIL_PANEL_IDS);
  // 「至少留一个」在这里也要成立：手改过的存档可能三个全藏着。
  // 保留的是**用户自己排序后的第一个**（尊重他的顺序），而不是硬塞回「目录」——
  // 硬塞会让他"明明关掉的那个又自己回来了"，那比空盒更难理解。
  if (panels.every((id) => hidden.has(id))) hidden.delete(panels[0]);

  return {
    version,
    blocks: orderize(src.blocks, DETAIL_BLOCK_IDS),
    spans,
    offsets,
    forms,
    heroSlots: orderize(src.heroSlots, HERO_SLOT_IDS),
    heroInfoSlots: orderize(src.heroInfoSlots, HERO_INFO_SLOT_IDS),
    facts: orderize(src.facts, FACT_IDS),
    panels,
    hidden: [...hidden]
  };
}

// ────────────────────────────────────────────────
// 查询（纯函数，页面直接用）
// ────────────────────────────────────────────────
export function isHidden(cfg: DetailLayoutConfig, id: DetailNodeId): boolean {
  return cfg.hidden.indexOf(id) >= 0;
}

/** 顶层区块：按配置顺序，过滤掉隐藏的 */
export function visibleBlocks(cfg: DetailLayoutConfig): DetailBlockId[] {
  return cfg.blocks.filter((id) => !isHidden(cfg, id));
}

/** 网格总列数（12 列制） */
export const GRID_COLS = 12;

/** 某块的跨格数（缺省 = 12 = 满宽） */
export function blockSpan(cfg: DetailLayoutConfig, id: DetailBlockId): SlotSpan {
  const v = cfg.spans ? cfg.spans[id] : undefined;
  return v === undefined ? SPAN_DEFAULT : v;
}

/** 某块的行内起始列（0-based；缺省 = 0 = 顶格）。满宽块恒为 0。 */
export function blockOffset(cfg: DetailLayoutConfig, id: DetailBlockId): number {
  const span = blockSpan(cfg, id);
  const v = cfg.offsets ? cfg.offsets[id] : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(GRID_COLS - span, Math.floor(v)));
}

/** 一行里某个块的落位 */
export interface RowSlot {
  id: DetailBlockId;
  /** 起始列（0-based） */
  col: number;
  span: SlotSpan;
}

/** 打包好的一行：真实块 + 本行没被占用的列区间 */
export interface PackedRow {
  slots: RowSlot[];
  /** 空列区间（编辑态据此画"空占位"，见 AlbumDetail） */
  gaps: Array<{ col: number; width: number }>;
}

/**
 * 把块摊成**行**（v3.4 行内位置）。
 *
 * 为什么要自己算一遍行，而不是交给浏览器的 auto-placement：
 *   ① 用户要"1/2 的块停在行中间"，这需要**显式列起点**（偏移），而显式与自动混用时
 *      浏览器的排布规则（sparse packing、显式项不回退光标）很容易产生"两块叠在一起"，
 *      且各内核行为细节不同 —— 自己算一遍就没有歧义；
 *   ② 编辑态要画"空占位"，就得知道每行剩了哪几列 —— 这份信息只有排布算法自己有。
 *
 * 算法 = CSS Grid `grid-auto-flow: row` + sparse packing 的等价实现（**不回头**）：
 * 光标只能往前；放不下就换行；显式起点落在光标之前时按光标放（与浏览器一致）。
 * 这条等价性有单测钉住（`packRows` 的用例同时给出"浏览器会怎么放"的期望）。
 *
 * ⚠️ offset=0（默认，也就是今天所有用户）时，每个块的落位与旧版 auto-placement
 * **逐项相同** → 线上 DOM 与几何都不变（红线）。
 */
export function packRows(cfg: DetailLayoutConfig, ids: readonly DetailBlockId[]): PackedRow[] {
  const rows: PackedRow[] = [];
  let slots: RowSlot[] = [];
  let col = 0;
  const flush = () => {
    if (slots.length === 0) return;
    const gaps: Array<{ col: number; width: number }> = [];
    let cursor = 0;
    for (const s of slots) {
      if (s.col > cursor) gaps.push({ col: cursor, width: s.col - cursor });
      cursor = Math.max(cursor, s.col + s.span);
    }
    if (cursor < GRID_COLS) gaps.push({ col: cursor, width: GRID_COLS - cursor });
    rows.push({ slots, gaps });
    slots = [];
  };
  for (const id of ids) {
    const span = blockSpan(cfg, id);
    const off = blockOffset(cfg, id);
    let start = Math.max(off, col);
    if (start + span > GRID_COLS) {
      flush();
      col = 0;
      start = off;
    }
    slots.push({ id, col: start, span });
    col = start + span;
  }
  flush();
  return rows;
}

/** 便利包装：按当前配置的可见块打包 */
export function packedVisibleRows(cfg: DetailLayoutConfig): PackedRow[] {
  return packRows(cfg, visibleBlocks(cfg));
}

/**
 * 是否启用**网格槽位渲染**（`AlbumDetail` 据此给 `.detail-card` 挂 `data-slots`）。
 *
 * 两个条件同时成立才切，缺一不可：
 *   ① 配置显式是 v3（用户真的改过宽度）；
 *   ② 至少有一块不是满宽（真的会出现并排）。
 *
 * 第②条容易被忽略但很关键：`display:block → grid` 会改变相邻 margin 的折叠行为，
 * 而"只改过顺序、块全是满宽"的用户不该替一个他用不上的能力承担这个差异。
 */
export function isSlotted(cfg: DetailLayoutConfig): boolean {
  if (cfg.version < DETAIL_LAYOUT_VERSION_SLOTS) return false;
  return visibleBlocks(cfg).some((id) => blockSpan(cfg, id) < SPAN_DEFAULT);
}

/** 主视觉左右两栏：按配置顺序，过滤掉隐藏的 */
export function visibleHeroSlots(cfg: DetailLayoutConfig): HeroSlotId[] {
  return cfg.heroSlots.filter((id) => !isHidden(cfg, id));
}

/** 主视觉右栏内部顺序 */
export function visibleHeroInfoSlots(cfg: DetailLayoutConfig): HeroInfoSlotId[] {
  return cfg.heroInfoSlots.filter((id) => !isHidden(cfg, id));
}

/** 四宫格字段顺序（2×2 行优先） */
export function visibleFacts(cfg: DetailLayoutConfig): FactId[] {
  return cfg.facts.filter((id) => !isHidden(cfg, id));
}

/**
 * `detail` 内部三个面板的**可见顺序**（= 横栏从左到右，也是折叠形态的行序）。
 *
 * 只剩一个时"横栏要不要画"由渲染方决定（`panels.length > 1`）—— 那是版面的决定，
 * 不该藏在模型里；模型只回答"哪些可见、什么顺序"。
 */
export function visiblePanels(cfg: DetailLayoutConfig): DetailPanelId[] {
  // 防御性读法（与 `blockForm` 同一口径）：画布的**内存态**可能来自老版本配置对象，
  // 少一个字段不该让整页白 —— 缺了就按"三个都可见、默认顺序"理解。
  const list = cfg.panels as DetailPanelId[] | undefined;
  return (list && list.length ? list : DETAIL_PANEL_IDS).filter((id) => !isHidden(cfg, id));
}

/**
 * 某个节点**所属列表**的可见顺序（= 它在画布上的顺序）。
 *
 * 检查器的"第 N / 共 M"与 ▲▼ 的禁用态必须按**它所属的那个列表**算：
 * 内嵌槽位（title / facts / author…）不属于顶层 `blocks`，拿顶层下标去显示会得到
 * "第 -1 块 / 共 8 块"这种胡话（v3 内嵌可拖之后才会发生）。
 * 找不到归属（理论上不会）时返回空数组，调用方据此自行兜底。
 */
export function visibleListOf(cfg: DetailLayoutConfig, id: DetailNodeId): DetailNodeId[] {
  const has = (list: readonly string[]) => list.indexOf(id) >= 0;
  if (has(cfg.blocks)) return visibleBlocks(cfg);
  if (has(cfg.heroSlots)) return visibleHeroSlots(cfg);
  if (has(cfg.heroInfoSlots)) return visibleHeroInfoSlots(cfg);
  if (has(cfg.facts)) return visibleFacts(cfg);
  if (has(cfg.panels)) return visiblePanels(cfg);
  return [];
}

/**
 * 配置面板用的"分区视图"：把 4 个有序列表连同它们的标题/说明一起交出去。
 *
 * 为什么要有它：`moveDetailNode` 的语义是"在**它所属的那个列表**里前后移"，
 * 所以面板必须按列表分区呈现，不能把 17 个节点摊成一个平表
 * （那会让"主视觉"里的 cover 和"信息栏"里的 title 看起来像同级，而它们其实在不同容器里）。
 * 有了这个函数，面板只管遍历渲染，**新增可配置节点时不需要改面板**。
 *
 * 返回的是 core/layoutOrder.ts 里的通用 `LayoutSection` —— 列表页那层产出同样的东西，
 * 于是两个页面可以共用同一个面板组件。
 */
export function detailLayoutSections(cfg: DetailLayoutConfig): LayoutSection[] {
  const sec = (key: string, label: string, hint: string, ids: DetailNodeId[]): LayoutSection => ({
    key,
    label,
    hint,
    items: ids.map((id) => ({
      id,
      label: DETAIL_NODE_META[id].label,
      hideable: DETAIL_NODE_META[id].hideable
    }))
  });
  return [
    sec("blocks", "页面区块", "从上到下（返回 → 主视觉 → … → 目录/评论/相关）", [...cfg.blocks]),
    sec("heroSlots", "主视觉左右", "封面 ↔ 信息栏，可互换", [...cfg.heroSlots]),
    sec("heroInfoSlots", "信息栏内", "从上到下（标题 / 四宫格 / 数据条）", [...cfg.heroInfoSlots]),
    sec("facts", "四宫格字段", "2×2 行优先，可把 JM号 挪到前面", [...cfg.facts]),
    // v3.5：`detail` 内部三个面板（可各自隐藏，至少留一个）
    sec("panels", "目录区面板", "目录 / 评论 / 相关漫画（至少留一个）", [...cfg.panels])
  ];
}

// ────────────────────────────────────────────────
// 变更（纯函数：入参不改，返回新对象）
// ────────────────────────────────────────────────
/**
 * 把某个节点在它所属的列表里前后移动。
 * 越界时原样返回（配置面板的"上移/下移"到头了就按不动，不需要额外判断）。
 */
export function moveDetailNode(cfg: DetailLayoutConfig, id: DetailNodeId, delta: number): DetailLayoutConfig {
  for (const key of ["blocks", "heroSlots", "heroInfoSlots", "facts", "panels"] as const) {
    const list = cfg[key] as unknown as string[];
    const next = moveInList(list, id, delta);
    if (next === null) continue;        // 不在这一张表里，换下一张
    if (next === list) return cfg;      // 在这一张表里，但已经到头 → 不动
    return { ...cfg, [key]: next } as DetailLayoutConfig;
  }
  return cfg;
}

/**
 * **拖拽**排序：把某个节点拖到它所属列表的第 index 位。
 *
 * 与 `moveDetailNode` 完全同构（同样是"逐张表找归属"），只是位移方式不同：
 * ▲▼ 是 ±1，拖拽是一次跳多位。`index` 是**该列表内**的下标 —— 面板里每个分区
 * 有自己的行容器，拖拽手势算出来的下标天然是分区内的，跨分区不会串。
 */
export function moveDetailNodeTo(cfg: DetailLayoutConfig, id: DetailNodeId, index: number): DetailLayoutConfig {
  for (const key of ["blocks", "heroSlots", "heroInfoSlots", "facts", "panels"] as const) {
    const list = cfg[key] as unknown as string[];
    const next = moveToInList(list, id, index);
    if (next === null) continue;        // 不在这一张表里，换下一张
    if (next === list) return cfg;      // 已经在那个位置 → 不动
    return { ...cfg, [key]: next } as DetailLayoutConfig;
  }
  return cfg;
}

/**
 * 把**任意层级的节点**拖到它所属列表的**可见顺序**第 index 位（画布拖拽专用，v3 内嵌可拖）。
 *
 * 两层口径必须都折算对，本函数一次做完：
 *   ① **可见空间 → 原始数组**：画布下标来自 DOM，而 DOM 里滤掉了隐藏节点
 *      （`visibleBlocks` / `visibleHeroSlots` / `visibleHeroInfoSlots` / `visibleFacts`
 *      是同一套 `hidden` 过滤）。用户只要藏过任意一个，两个空间就错开一位，
 *      表现是"拖到这儿它却落到隔壁"。
 *   ② **"移除被拖项之后"**：`core/dropIndex.dropIndexAt` 的返回值与 `moveToInList` 的 `to`
 *      都是这个语义（先 splice 掉被拖项再插入），所以这里也必须按"移除后"的数组取锚点 ——
 *      两边同一套折算，才不会"往下拖一格、实际落了两格"。
 *
 * ⚠️ 它同时消掉了**条件渲染**造成的错位：`heroInfoSlots` 里的 `stat` 在
 * `views || likes` 都为 0 时**不渲染**，于是 DOM 里可能只有 `[title, facts]`
 * 而配置恒为 `[title, facts, stat]`。因为锚点取的是"**移除被拖项之后的第 p 个**"
 * （纯顺序语义、与绝对下标无关），少一个未渲染的项仍然落在正确的位置上。
 *
 * 五张表共用同一套逻辑（`moveDetailNodeTo` 也是"逐张表找归属"），所以顶层块、内嵌槽位
 * 与 `detail` 的三个面板都走本函数 —— 差别只在它们各自属于哪张表。
 */
export function moveVisibleNodeTo(cfg: DetailLayoutConfig, id: DetailNodeId, visibleIndex: number): DetailLayoutConfig {
  for (const key of ["blocks", "heroSlots", "heroInfoSlots", "facts", "panels"] as const) {
    const raw = cfg[key] as unknown as DetailNodeId[];
    if (raw.indexOf(id) < 0) continue;                  // 不在这一张表里，换下一张
    const vis = raw.filter((x) => !isHidden(cfg, x));    // = 该列表的可见顺序（= 画布上的顺序）
    if (vis.indexOf(id) < 0) return cfg;                 // 自己被隐藏了：画布不该拖它
    const rest = vis.filter((x) => x !== id);            // = moveToInList 移除被拖项后的数组
    const p = Math.max(0, Math.min(rest.length, Math.round(visibleIndex)));
    const anchor = p < rest.length ? rest[p] : null;     // null（p === rest.length）= 追加到末尾
    const rawRest = raw.filter((x) => x !== id);
    const to = anchor ? rawRest.indexOf(anchor) : rawRest.length;
    const next = moveToInList(raw as unknown as string[], id, to);
    if (next === null || next === raw) return cfg;       // 位置没变 → 原样返回（连带省掉整次重渲染）
    return { ...cfg, [key]: next } as DetailLayoutConfig;
  }
  return cfg;
}

/**
 * 把**顶层区块**拖到可见顺序的第 index 位。
 *
 * 保留这个具名入口是因为它的语义（"只处理顶层块"）在调用点读起来更清楚；
 * 实现完全委托给 `moveVisibleNodeTo`（同一套折算，避免两条实现日久漂移）。
 */
export function moveVisibleBlockTo(cfg: DetailLayoutConfig, id: DetailBlockId, visibleIndex: number): DetailLayoutConfig {
  return moveVisibleNodeTo(cfg, id, visibleIndex);
}

/**
 * 设定某个顶层区块的**宽度档位**（12 列制）。
 *
 * ⚠️ 这是"把配置升到 v3"的**唯一**入口。
 * 用户不动宽度，配置就永远停在 v1，线上版面就**逐字不变**。
 * 传 `SPAN_DEFAULT`(12) 会把该项从 `spans` 里删掉 —— 全部满宽时 `spans` 回到 `{}`，
 * 版面随之退回纵向流（与"从没配过"完全同一条路径，不残留 v3 痕迹）。
 */
export function setDetailBlockSpan(cfg: DetailLayoutConfig, id: DetailBlockId, span: SlotSpan): DetailLayoutConfig {
  if (blockSpan(cfg, id) === span) return cfg;          // 值没变 → 原样返回（也不升版本）
  const spans: Partial<Record<DetailBlockId, SlotSpan>> = { ...cfg.spans };
  if (span === SPAN_DEFAULT) delete spans[id];
  else spans[id] = span;
  // 变回满宽时把行内位置一起清掉：满宽块没有"位置"可言，留着会变成脏数据
  // （normalize 也会丢，但写的时候就丢更干净 —— 存档里不留自相矛盾的字段）
  const offsets: Partial<Record<DetailBlockId, number>> = { ...cfg.offsets };
  if (span === SPAN_DEFAULT || (offsets[id] !== undefined && offsets[id]! > GRID_COLS - span)) {
    delete offsets[id];
  }
  return { ...cfg, version: DETAIL_LAYOUT_VERSION_SLOTS, spans, offsets };
}

/**
 * 设置某块的**行内起始列**（v3.4）。范围按该块自己的跨格数夹在 `0 ~ 12-span`。
 * 传 0 会把该项从 `offsets` 删掉（"顶格 = 不写"，与 spans 同一套不变量）。
 */
export function setDetailBlockOffset(cfg: DetailLayoutConfig, id: DetailBlockId, offset: number): DetailLayoutConfig {
  const span = blockSpan(cfg, id);
  const next = Math.max(0, Math.min(GRID_COLS - span, Math.floor(offset)));
  if (blockOffset(cfg, id) === next) return cfg;
  const offsets: Partial<Record<DetailBlockId, number>> = { ...cfg.offsets };
  if (next === 0) delete offsets[id];
  else offsets[id] = next;
  return { ...cfg, version: DETAIL_LAYOUT_VERSION_SLOTS, offsets };
}

/**
 * 「拖动落进行内空位」：给定**独占一行**的行几何与被拖块**中心**横坐标，算它该落到哪一列。
 *
 * ── 语义 ──────────────────────────────────────────────────────────
 *   · **离散列**：offset 是 0 ~ (12−span) 的整数列（模型层的定义），拖动预览逐列跳、
 *     不做亚列插值 —— 落点 = 松手值，所见即所得；
 *   · **就近吸附（50%）**：`round((centreX − rowLeft)/pitch − span/2)`，分界在两列中点。
 *     与 RGL `calcXY` / GridStack `Math.round(left / cellWidth)` 同一口径；
 *   · **有界**：夹在 `0 ~ 12−span`，越界 = 停在端点列（不产生非法值）；
 *   · **幂等**：只以当前块心算目标列（无历史），同一位置反复计算相同结果，可逐帧喂。
 *
 * ── 输入为什么是"块心"而不是"指针"（v3.5.2 修正，两个实测 bug）──────
 *   旧实现吃**指针的绝对位置**、并把**被拖块自己的左缘**当行起点，后果：
 *   ① 抓**右缘**起拖时指针已在块右端，`col` 立刻 = `12−span`，**手指没动块就跳走**
 *      （span=6 时跳 3 列 ≈ 91px，实测）；
 *   ② 块已经不在首列时，算出来的是"相对位移"而不是"绝对列"，于是"居中的块一抓就掉回最左"。
 *   块心对抓取点**不敏感**（抓哪儿都是同一个块心），行左缘由调用方传入 →
 *   两个 bug 一起消失，而且"拖到行正中就居中"这条语义保持不变。
 *
 * ── 为什么要求"独占一行"才启用 ─────────────────────────────────────
 * 行里有别的块时，横向拖动是**换序**语义（并排行的左/右半边决定插前插后，
 * 用户与 e2e 都按它验收）。两种语义抢同一根手指会打架；而"行内空位"只在
 * 独占一行时存在 —— 行里只有它 + 行尾空占位格，横向怎么拖都不碰邻居。
 *
 * 纯函数：不碰 DOM、不存状态。`centreX` 与 `row` 同一坐标系即可（列表局部坐标）。
 */
export function rowOffsetFromCentre(
  row: { left: number; pitch: number },
  span: SlotSpan,
  centreX: number
): number {
  const max = GRID_COLS - span;
  if (max <= 0) return 0;
  const pitch = row.pitch;
  if (!(pitch > 0)) return 0;                      // 列距量不到（未排布）：不猜，回顶格
  /**
   * 输入是**被拖块自己的中心**，不是指针 —— 这一条同时修掉两个实测 bug：
   *
   * ① **抓取点敏感**：旧实现用"指针的绝对位置"，于是抓**右缘**起拖时
   *    （指针已在块右端 ≈ span 列处）`col` 立刻等于 `12 − span`，**手指还没动块就跳走**
   *    （span=6 时跳 3 列 ≈ 91px，实测）。用块心就没有这个问题：抓哪儿都等于同一个块心。
   * ② **基准错**：旧实现的 `rowBox.left` 传的是**被拖块的左缘**（起拖快照里的），
   *    而公式要求的是**行的左缘** —— 块已经不在首列时，返回的是"相对位移"而不是"绝对列"，
   *    于是"已经居中的块一抓就掉回最左"。现在由调用方传入行的左缘。
   *
   * 量化是**就近（50%）吸附**：`round` —— 与 RGL 的 `calcXY`、GridStack 的
   * `Math.round(left / cellWidth)` 同一口径。旧实现是 `floor(rel − span/2 + 0.5)`，
   * 也就是用户感受到的"过列分界线才跳一列"。
   */
  const raw = (centreX - row.left) / pitch - span / 2;
  return Math.max(0, Math.min(max, Math.round(raw)));
}

/** 显隐某个节点。不允许隐藏的节点会被忽略（与 normalize 的口径一致） */
export function setDetailNodeHidden(cfg: DetailLayoutConfig, id: DetailNodeId, hidden: boolean): DetailLayoutConfig {
  const meta = DETAIL_NODE_META[id];
  if (!meta || !meta.hideable) return cfg;
  const has = cfg.hidden.indexOf(id) >= 0;
  if (has === hidden) return cfg;
  /**
   * 「至少留一个」（v3.5）：`detail` 的三个面板不许全关 —— 全关 = 区块变空盒。
   *
   * 拒绝方式是**原样返回**（不写配置、不抛异常）。界面必须把这次拒绝**显示出来**
   * （见 `ui/NodeOrderList` 的 minVisible / refuseHint）—— 否则用户看到的就是
   * "点了没反应"，与哑控件同罪。
   */
  if (hidden && DETAIL_PANEL_IDS.indexOf(id as DetailPanelId) >= 0 && visiblePanels(cfg).length <= MIN_VISIBLE_PANELS) {
    return cfg;
  }
  return { ...cfg, hidden: hidden ? [...cfg.hidden, id] : cfg.hidden.filter((x) => x !== id) };
}

/** 恢复默认版面（含 v3 的宽度 / v3.5 的形态：一起回到"从没配过"的状态） */
export function resetDetailLayout(): DetailLayoutConfig {
  return { ...DEFAULT_DETAIL_LAYOUT, blocks: [...DEFAULT_DETAIL_LAYOUT.blocks], spans: {}, offsets: {}, forms: {}, heroSlots: [...DEFAULT_DETAIL_LAYOUT.heroSlots], heroInfoSlots: [...DEFAULT_DETAIL_LAYOUT.heroInfoSlots], facts: [...DEFAULT_DETAIL_LAYOUT.facts], panels: [...DEFAULT_DETAIL_LAYOUT.panels], hidden: [] };
}

// ────────────────────────────────────────────────
// 持久化（与 theme / tapZones 同级：localStorage + 读时自愈）
// ────────────────────────────────────────────────
export function loadDetailLayout(): DetailLayoutConfig {
  try {
    const raw = localStorage.getItem(UI_KEYS.detailLayout);
    if (!raw) return resetDetailLayout();
    return normalizeDetailLayout(JSON.parse(raw));
  } catch {
    // JSON 坏了 / localStorage 被禁用（隐私模式）→ 回默认，绝不抛
    return resetDetailLayout();
  }
}

export function saveDetailLayout(cfg: DetailLayoutConfig): void {
  try {
    localStorage.setItem(UI_KEYS.detailLayout, JSON.stringify(normalizeDetailLayout(cfg)));
  } catch { /* ignore */ }
}
