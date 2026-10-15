// 详情页 v7.2：版面改为「由数据驱动」——区块的显隐与顺序不再写死在 JSX 里，
// 而是取自 core/detailLayout.ts 的配置（默认值与 v7.1 逐字一致）。
// 纯展示组件——数据与动作全部由 ContentView 提供。
//
// 这一版改了什么（只有一件事）：
//   · v7.1 的版面是**手写在 JSX 里的顺序**；v7.2 把这份顺序搬进 core/detailLayout，
//     页面变成「按配置遍历渲染」。**DOM 输出与 v7.1 完全一致**（Fragment 不产生节点）。
//   · 于是版面可以被持久化、被配置面板编辑——而配置面板不需要再改这个文件。
//
// 版面约定（对照图：工作台 jm-detail-layout-proposal）：
//   · 封面回到详情页：列表→详情不再“封面消失、只剩文字”；浏览/喜欢组成数据条（接口字段早就有，一直闲置）；
//   · 作者 / 话数（页数） / JM号 / 收录 组成标题下的四宫格（2×2，每列齐头）：JM号是常用信息，和作者并列；
//   · 「目录 / 评论 / 相关漫画」用与分类页同一套 UnderlineTabs（横栏 + 滑动下划线），默认停在「目录」：
//     详情页是“话”级页面，目录就是话列表；146 话塞原生 select 不可用，选话改点目录行（v6 的 selectrow 退役）；
//   · 阅读按钮：足迹里读过**当前话**才叫「继续阅读」，否则「立即阅读」——详情页一次只代表一话，
//     不能把“上次读到第 N 话”强加给用户正打开的这一话；“上次读到”改在目录行上标注，点那一行即可跳过去。
//
// ⚠️ 给后来者：区块顺序由数据决定，**不要再把顺序写回 JSX**（那会让配置失效）。
//    新加一个区块 = ① 在 detailLayout.ts 的 DETAIL_BLOCK_IDS / DETAIL_NODE_META 里登记
//    ② 在下面的 blockNodes 里补一条渲染。老用户的配置会自动补上它（normalize 会把缺失项补到尾部）。
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import UnderlineTabs from "../ui/UnderlineTabs";
import CommentList from "../ui/CommentList";
import { AlbumGrid } from "../ui/AlbumGrid";
import { HeartIcon } from "../ui/icons";
import { albumCoverUrl } from "../ui/AlbumCard";
import { useSheetTransition } from "../hooks/useSheetTransition";
import { albumTags, authorNames, parsePaid, priceOf } from "../core/albumMeta";
import { actionButtonSpec } from "../core/actionButton";
import { loadHistory } from "../core/history";
import { bookIdOf, isSeriesWork, visibleChapters } from "../core/series";
import { chapterLabel } from "../core/offlineMeta";
import { scanCachedChapters } from "../core/offline";
import { fmtCount, fmtDate } from "../core/fmt";
import { on } from "../core/bus";
import {
  DETAIL_NODE_META,
  blockForm,
  blockSpan,
  isSlotted,
  loadDetailLayout,
  packedVisibleRows,
  visibleBlocks,
  visibleFacts,
  visibleHeroInfoSlots,
  visibleHeroSlots,
  visiblePanels
} from "../core/detailLayout";
import {
  actionBtnStyle,
  chapRowStyle,
  coverBoxStyle,
  descFontStyle,
  descLineStyle,
  descStyle,
  detailStyleAttrs,
  factValStyle,
  loadDetailStyle,
  statStyle,
  tabsStyle,
  tagChipStyle,
  titleStyle
} from "../core/detailStyle";
import type { DetailStyleConfig } from "../core/detailStyle";
import EdBlock from "../ui/EdBlock";
import { PLAIN_BIND } from "../ui/EdSlot";
import type { SlotBind } from "../ui/EdSlot";
import type {
  DetailBlockId,
  DetailLayoutConfig,
  DetailNodeId,
  DetailPanelId,
  FactId,
  HeroInfoSlotId,
  HeroSlotId
} from "../core/detailLayout";
import type { AlbumDetail as AlbumDetailData, AlbumSummary, ForumPayload } from "../core/types";

/**
 * 合并若干内联样式；**全空时返回 `undefined`**。
 *
 * 为什么必须兜这一层：`core/detailStyle` 的助手在默认值下返回 `undefined`（那是"零 DOM 差异"红线的
 * 实现方式），但把 undefined 展开进空对象会得到 `{}` —— 空对象的 style 仍可能被 React 渲染成属性，
 * 那就等于"什么都没改却变了 DOM"。所以统一由这里收口：一个属性都没有 → 连 style 属性都不出现。
 */
function mergeStyle(...parts: Array<CSSProperties | undefined>): CSSProperties | undefined {
  const merged = Object.assign({}, ...parts) as CSSProperties;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

interface Props {
  detail: AlbumDetailData;
  logged: boolean;
  busy: boolean;
  comments: ForumPayload | null;
  /** 官方返回的评论总数（标签页显示它，而不是"已加载条数"） */
  commentTotal: number;
  commentHasMore: boolean;
  commentLoadingMore: boolean;
  commentText: string;
  backLabel: string;
  onBack: () => void;
  onCopyId: () => void;
  onOpenAuthor: (name: string) => void;
  onOpenTag: (tag: string) => void;
  /** 登场人物（走 search_type=character 的只读搜索页） */
  onOpenActor: (name: string) => void;
  /** 相关漫画点击 → 打开该漫画详情 */
  onOpenRelated: (a: AlbumSummary) => void;
  onSwitchChapter: (id: string) => void;
  onBuy: () => void;
  onToggleFavorite: () => void;
  onRead: () => void;
  onCommentChange: (v: string) => void;
  onSubmitComment: () => void;
  onLoadMoreComments: () => void;
  /**
   * 编辑态：**只在「自定义 UI」的画布里传 true**。
   *
   * 为 false（默认，也就是线上路径）时本组件渲染出来的 DOM 与没有这一层时**逐字一致** ——
   * 上面那些区块仍然用 `React.Fragment` 包（Fragment 不产生 DOM 节点），一个盒子都不多。
   * 这条是硬约束：报告 §3.3-④ 说过，多一个 wrapper 就可能让 compat 包的 `> * + *` 间距全塌。
   * （已核实详情页只被 `.actrow > * + *` 影响一条，而 `.actrow` 是整块不拆的顶层块，
   *   所以编辑态给**顶层块**套框不影响它。）
   *
   * 为 true 时每个顶层块套一层 `.ed-blk`，带上拖拽手柄 / 序号 / 选中描边。
   */
  editMode?: boolean;
  /**
   * **占位渲染**：只在「自定义 UI」的画布与画廊缩略图里传 true。
   *
   * 用户原话（v3.5）：「卡片展示包括进入卡片后的编辑展示**不要用真实作品**吧，
   * 渲染骨架加上一些占位就行了……直接用『示例作品1』等文字以**失败回退**的表现放到封面上」。
   *
   * 背景：样例数据里的 id（900100+）在真实图床里是**存在的**，`albumCoverUrl` 会照规则拼出
   * `…/media/albums/900100_3x4.jpg` → 画布里真的加载出**别的作品的封面**（编辑器不该出现
   * 不属于它的内容，而且拖慢缩略图）。为 true 时：
   *   · 详情页封面**不生成 URL、不渲染 `<img>`** → 只留 `.d-cover-ph` 的文字兜底（=失败回退的样子）；
   *   · 相关漫画的网格同样走占位（透传给 `AlbumGrid`）。
   *
   * 默认 false → **线上路径一个字节都不变**（不传这个 prop 的调用点行为与改造前逐字一致）。
   */
  skeleton?: boolean;
  /**
   * 画布里当前选中的**块或内嵌槽位**（v3 内嵌可拖起放宽到 `DetailNodeId`）。
   *
   * 名字里的 "Block" 是历史叫法：三个回调对**五张表**（顶层块 / heroSlots /
   * heroInfoSlots / facts）一视同仁 —— 谁被拖就传谁的 id，下标是**它所属列表**里的
   * 可见顺序下标（折算见 `core/detailLayout.moveVisibleNodeTo`）。
   */
  selectedBlock?: DetailNodeId | null;
  onSelectBlock?: (id: DetailNodeId) => void;
  /** 画布里把项拖到它所属列表的第几位（**可见顺序**下标，同分区内） */
  onMoveBlockTo?: (id: DetailNodeId, index: number) => void;
  /**
   * 编辑态**受控版面**：由「自定义 UI」把拖动中的内存态传下来。
   *
   * 传了就以它为准，并且**不再订阅** `jm:detailLayout` —— 画布跟着父级的内存状态走。
   * 这是"拖动中不写 localStorage、不广播"能做成的关键：以前拖动每帧落盘 + 广播，
   * 画布再回读 localStorage 重渲染，中端安卓上就是用户说的"卡"。
   * 线上路径（editMode=false）不传，行为与以前逐字一致。
   */
  layoutOverride?: DetailLayoutConfig;
  /** 编辑态受控样式（同上：父级内存态优先，也不再订阅 jm:detailStyle） */
  styleOverride?: DetailStyleConfig;
  /** 一次拖拽收尾（松手 / 手势取消）—— 父级据此落盘 + 广播**各一次** */
  onMoveBlockEnd?: () => void;
  /**
   * 一次拖拽**开始**（长按确认那一帧）—— 父级据此收起已唤起的配置栏
   * （用户第 2 条：「拖动时已唤起的模块的配置不会自动缩起来，界面也乱跑」）。
   * 线上路径不传，行为与以前逐字一致。
   */
  onDragStart?: () => void;
  /**
   * **行内落位**（v3.5.1）：把独占一行的块拖进它那一行的某个空位
   * （用户第 2 条反馈：「1/2 宽度的放正中间，1/3 大小的放正中间，或者右侧」）。
   * `col` 是 12 列制的行内起始列（0 ~ 12−span）。只对**顶层块**触发；上层接
   * `setDetailBlockOffset`（预览通道，松手随 `onMoveBlockEnd` 一次落盘）。
   */
  onMoveBlockCol?: (id: DetailNodeId, col: number) => void;
}

/**
 * 横栏标签 / 折叠行里的面板 id（目录 / 评论 / 相关漫画）。
 *
 * v3.5 起直接复用配置层的 `DetailPanelId` —— 原来这里是本地又写一遍的 `"dir" | "cmt" | "rel"`，
 * 而这两个 id 集合现在都进了配置模型与 `DETAIL_NODE_META`，各写一份必然漂移。
 */
type DetailTab = DetailPanelId;

/** 目录先给 8 行，剩下的收进「查看全部」（146 话全铺会把评论/相关挤没） */
const CHAP_PREVIEW = 8;

export default function AlbumDetail({
  detail,
  logged,
  busy,
  comments,
  commentTotal,
  commentHasMore,
  commentLoadingMore,
  commentText,
  backLabel,
  onBack,
  onCopyId,
  onOpenAuthor,
  onOpenTag,
  onOpenActor,
  onOpenRelated,
  onSwitchChapter,
  onBuy,
  onToggleFavorite,
  onRead,
  onCommentChange,
  onSubmitComment,
  onLoadMoreComments,
  editMode = false,
  skeleton = false,
  selectedBlock = null,
  onSelectBlock,
  onMoveBlockTo,
  layoutOverride,
  styleOverride,
  onMoveBlockEnd,
  onDragStart,
  onMoveBlockCol
}: Props) {
  const [tab, setTab] = useState<DetailTab>("dir");
  /**
   * 折叠形态（v3.5）里**展开的那一行**。
   *
   * 一次只展开一个：这三个面板本来就互斥（原来是 tab），同时铺开会把页面拉得很长，
   * 而且"再点一下收起"在同一次交互里就能完成。
   */
  const [foldOpen, setFoldOpen] = useState<DetailPanelId | null>(null);
  const [chapAll, setChapAll] = useState(false);
  const [descOpen, setDescOpen] = useState(false);
  const [descClamped, setDescClamped] = useState(false);
  /** 展开时量到的完整高度（折叠态是 2 行 max-height，展开过渡到这个值） */
  const [descH, setDescH] = useState(0);
  /** 收起动画播完前保持 line-clamp 解除，否则文字会先跳回 2 行再收框 */
  const descAnim = useSheetTransition(descOpen, 240);
  const descRef = useRef<HTMLParagraphElement | null>(null);

  /**
   * 展示编排。初值同步读（不放在 effect 里）——否则首帧会用默认版面渲染一次再跳成用户版面。
   * 配置面板改完后 emit("jm:detailLayout")，这里重读并重渲染（与 jm:deseam 同一套做法）。
   *
   * v3：画布（编辑态）改走 `layoutOverride` **受控**——真值在 CustomUiPage 的内存里，
   * 拖动中不回读 localStorage。没传 override 时（线上路径）行为与以前完全一致。
   */
  const [localLayout, setLocalLayout] = useState<DetailLayoutConfig>(() => loadDetailLayout());
  useEffect(() => {
    if (layoutOverride) return; // 受控：真值在父级，别再自己读盘（拖动中每次读盘就是"卡"的来源）
    return on("jm:detailLayout", () => setLocalLayout(loadDetailLayout()));
  }, [layoutOverride]);
  const layout = layoutOverride || localLayout;

  /**
   * 版面**样式**（封面大小 / 标题字号 / 简介行数 / 疏密 / 圆角）。
   * 与上面的 layout 分开存、分开订阅：用户常常只想改字号，不该连结构配置一起动。
   * 出口有两条：档位项（疏密 / 圆角）挂 data-dl-* 由 CSS 属性选择器接管；
   * 数值项（封面 / 标题 / 简介）走 coverBoxStyle/titleStyle/descStyle 的**内联 style**
   * （连续值没法逐档预写声明，var() 传数字在 WebView 57 上又不确定）。
   * 两者都只在**非默认**时输出 —— 不改设置的用户 DOM 逐字不变。
   */
  const [localStyle, setLocalStyle] = useState<DetailStyleConfig>(() => loadDetailStyle());
  useEffect(() => {
    if (styleOverride) return; // 受控：同上
    return on("jm:detailStyle", () => setLocalStyle(loadDetailStyle()));
  }, [styleOverride]);
  const style = styleOverride || localStyle;

  /**
   * 「展开」只在简介真的被截断时出现。
   * 不能用字符数猜（44~60 字的简介在窄屏上已经被 clamp 掉，却没有展开入口 = 静默丢内容），
   * 直接量 scrollHeight / clientHeight。
   */
  useLayoutEffect(() => {
    if (descOpen) return; // 展开状态下不重算，保留「收起」入口
    const el = descRef.current;
    if (!el) return;
    setDescClamped(el.scrollHeight > el.clientHeight + 1);
    // 行数 / 显示全部变了截断情况就变了，必须重测（自定义 UI 里边拖滑块边看效果）
  }, [descOpen, detail.id, detail.description, style.desc, style.descAll]);

  /** 展开/收起简介：展开前先量出完整高度，交给 max-height 过渡 */
  function toggleDesc() {
    const el = descRef.current;
    if (!descOpen && el) setDescH(el.scrollHeight);
    setDescOpen((o) => !o);
  }

  const locked = parsePaid(detail);
  /** 应付 JCoin（仅展示用；已购判断只看 purchased，见 core/albumMeta.isPurchased） */
  const price = priceOf(detail);
  const authors = authorNames(detail);
  const tags = albumTags(detail);
  const actors = Array.isArray(detail.actors) ? detail.actors.filter(Boolean).map((x) => String(x)) : [];
  const related = Array.isArray(detail.related_list) ? detail.related_list : [];
  const series = Array.isArray(detail.series) ? detail.series : [];
  /**
   * v3.9 目录两轴（顺序 / 筛选）。`cachedChaps` 只在**用户真的开了「只看已缓存」**时才去扫
   * （`scanCachedChapters` 是异步 I/O）—— 没开这一档的绝大多数用户**一次 I/O 都不会多**。
   * 扫描只针对本书的话 id（传 ids 走的是 `has(id)` 快路径，不会全库扫）。
   */
  const [cachedChaps, setCachedChaps] = useState<ReadonlyMap<string, { pages: number }>>(() => new Map());
  /**
   * `series` 走 **ref** 而不是进依赖数组：它是渲染期新造出来的数组（`detail.series` 或 `[]`），
   * 每次渲染引用都不同 ⇒ 进了依赖就是**每次渲染都重扫一遍本地缓存**（I/O 风暴）。
   * 与 App.tsx 里 `openSourceRef` 同一个手法（那里的理由也是"直接闭包会捕获首次渲染的值"）。
   * 于是这个 effect 只在**这一档被打开**或**换了一话所在的书**时跑一次。
   */
  const seriesRef = useRef(series);
  seriesRef.current = series;
  useEffect(() => {
    if (style.chapFilter !== "cached") return;
    let alive = true;
    const ids = seriesRef.current.map((s) => String(s.id));
    void scanCachedChapters(ids).then((m) => { if (alive) setCachedChaps(m); }).catch(() => { /* 扫不到就当没缓存 */ });
    return () => { alive = false; };
  }, [style.chapFilter, detail.id]);
  /** 目录**实际要显示的**列表：先筛选再排序（纯函数，见 core/series.visibleChapters） */
  const chapList = visibleChapters(series, style.chapOrder, style.chapFilter, cachedChaps);
  const desc = String(detail.description || "").trim();
  // 折叠行/标签页显示的是**官方返回的总数**（原来用 comments.list.length = 已加载条数，
  // 官方每页 10 条，478 条评论的漫画会显示成"评论 10"，看着像只有 10 条）
  const commentLoaded = comments && Array.isArray(comments.list) ? comments.list.length : 0;
  const commentCount = commentTotal > 0 ? commentTotal : commentLoaded;

  // 数据条：浏览 / 喜欢（types.ts 里一直有这俩字段，之前没露出过）
  const views = fmtCount(detail.total_views);
  const likes = fmtCount(detail.likes);
  const addDate = fmtDate(detail.addtime);

  /**
   * 封面：与阅读器书级元数据同一套取图规则（连载作品用书 id 取封面）。
   * ⚠️ `skeleton` 时**直接空串**：连 URL 都不拼（样例 id 在真实图床里存在，
   *    拼出来会真的拉取别的作品封面 —— 编辑器里不该出现这种内容）。
   */
  const coverUrl = useMemo(
    () => (skeleton ? "" : albumCoverUrl({ id: bookIdOf(detail), name: detail.book_name || detail.name, update_at: detail.addtime })),
    [detail, skeleton]
  );

  /** 足迹里这本书读到哪（只用于「继续阅读」与目录标注，不参与渲染数据） */
  const resume = useMemo(
    () => loadHistory().find((e) => String(e.bookId) === String(bookIdOf(detail))),
    [detail]
  );
  /** 读过**当前这一话**才叫继续阅读（详情页是话级页面，见文件头注释） */
  const resumedThis = Boolean(resume && String(resume.id) === String(detail.id));

  /**
   * 动作区**主按钮**的文案与行为（v3.3 合并「付费提示」之后）——
   * 免费 → 立即/继续阅读；付费已登录 → 官方 JCoin 购买（带金额）；付费未登录 → 登录后购买。
   * 三态写在一个纯函数里（core/actionButton.ts）并有单测：样例作品是免费内容，
   * 画布上**永远看不到付费态**，只能靠单测证明它是对的。
   */
  const actionBtn = actionButtonSpec({ locked, logged, price, resumedThis });

  /**
   * ── `detail` 这一块的**形态**与**内部面板**（v3.5）────────────────────────
   *
   * 形态（用户第 4 条）：`tabs`（默认 = 现状的横栏）或 `folded`（折叠成三行，点一下展开）。
   * 注册表在 `core/detailLayout.DETAIL_BLOCK_FORMS` —— 以后再给**别的**块加形态**只加数据**，
   * 这里的分支结构不用动（这就是"形态这个维度可扩展"的落地方式）。
   *
   * 面板：目录 / 评论 / 相关漫画 现在**各自可隐藏、可排序**（它们进了配置模型的 `panels`）。
   * 在此之前它们是三个互斥 tab，配置层根本没有它们各自的开关。
   */
  const detailForm = blockForm(layout, "detail");
  /**
   * v3.8 形态（第一批，来自调研 TOP8）：两个**容器级**形态 —— 只改类名、不改结构。
   *   ① 标签：折行 ↔ 横滑一行（窄屏 + 标签多时省 5~6 行）
   *   ② 主视觉信息区：逐项卡片 ↔ 紧凑两列表（label 与值同一行）
   * 默认档不加任何类 ⇒ 从没配过的用户 DOM 与加这一层之前**逐字一致**。
   * `blockForm` 已经处理了"存着但在当前宽度下不可用 → 回落默认"（见 core/detailLayout）。
   */
  const tagForm = blockForm(layout, "tags");
  const heroForm = blockForm(layout, "hero");
  const panels = visiblePanels(layout);
  /**
   * 当前展示的面板。
   *
   * ⚠️ 不能直接用 `tab`：面板是**运行时**可隐藏的 —— 用户可能把正在看的那个关掉，
   * 于是 `tab` 指向一个不再渲染的 id → 横栏没了、内容也没了 = 区块空盒。
   * 所以从"可见列表"里派生一次（还可见就留着，否则退回第一个）。
   * **不改 state**：派生比"用 effect 同步 state"少一次渲染，也不会在配置来回切时抖。
   */
  const activePanel: DetailPanelId =
    (panels.indexOf(tab as DetailPanelId) >= 0 ? (tab as DetailPanelId) : panels[0]) || "dir";
  /** 折叠行的计数（用户给的样子：「目录 146 话」「评论 478」「相关漫画 12」） */
  const panelCount = (p: DetailPanelId): string => {
    if (p === "dir") return chapList.length > 0 ? chapList.length + " 话" : "";
    if (p === "cmt") return commentCount > 0 ? String(commentCount) : "";
    return related.length > 0 ? String(related.length) : "";
  };
  /** 折叠行文案：显示名取自配置层（不在 UI 里重写第二份中文名），有数据才缀计数 */
  const foldLabel = (p: DetailPanelId): string => {
    const c = panelCount(p);
    return DETAIL_NODE_META[p].label + (c ? " " + c : "");
  };

  /**
   * 横栏标签。文案与拆分之前**逐字一致**（目录不带计数、评论/相关有数据才带）——
   * 这是"默认形态 DOM 逐字节不变"的一部分：默认形态下横栏渲染的就是这几个串。
   */
  const tabs = panels.map((p) => ({
    key: p,
    label: p === "dir"
      ? "目录"
      : p === "cmt"
        ? (commentCount > 0 ? "评论 " + commentCount : "评论")
        : (related.length > 0 ? "相关漫画 " + related.length : "相关漫画"),
    // data-related-toggle 是 e2e 钩子（driver.js / driver-scrollleak.js 按它点开相关漫画）
    ...(p === "rel" ? { attrs: { "data-related-toggle": "1" } } : {})
  }));

  const shownChaps = chapAll ? chapList : chapList.slice(0, CHAP_PREVIEW);

  /**
   * 渲染一个**内层元素**（主视觉内部：封面/信息栏、标题/四宫格/数据条、四宫格字段）。
   *
   * ── v3.5（用户第 3 条）：内层**不再可点选、也不再可拖** ─────────────────
   * 用户原话：「**主视觉是一个大模块**，封面信息栏和四宫格等等也是在主视觉的配置里设置，
   * **而不是也都做成可点击的模块**」。
   *
   * 所以编辑态与线上态**共用同一个空绑定**（`PLAIN_BIND`）—— 内层 DOM 因此与线上**逐字一致**
   * （比 v3 的「把类名/属性/手势注入既有元素」更严格：那时候至少还多两个类名）。
   * 画布上只有**顶层块**能被选中；内层的顺序/显隐改在配置栏里调
   * （`ui/NodeOrderList`，入口点在「主视觉」的配置栏里）。
   *
   * 为什么保留这个助手（而不是把 `render(PLAIN_BIND)` 抄十遍）：元素结构只写一处，
   * 两种模式不会漂移；而且它仍然不能套 wrapper（`.d-hero` 是 flex、`.d-facts` 是 grid，
   * 套一层会塌；`display:contents` 在 compat 内核 WebView 57 上不支持）。
   */
  const withSlot = (_id: DetailNodeId, render: (b: SlotBind) => ReactNode): ReactNode => render(PLAIN_BIND);

  // ── 主视觉四宫格的四个字段（顺序由配置给，见 detailLayout.visibleFacts）──
  const factNodes: Record<FactId, ReactNode> = {
    author: withSlot("author", (b) => (
      <div className={"fact" + b.cls} {...b.attrs} ref={b.ref} {...b.handlers}>
        {b.gap}
        <span className="k">作者</span>
        <span className="v" style={factValStyle(style)}>{authors.length > 0
          ? authors.map((a, i) => (
            <span key={"au" + i}>
              {i > 0 && <span className="meta-sep"> / </span>}
              <button className="link" onClick={() => onOpenAuthor(a)}>{a}</button>
            </span>
          ))
          : "-"}</span>
      </div>
    )),
    chapCount: withSlot("chapCount", (b) => (
      <div className={"fact" + b.cls} {...b.attrs} ref={b.ref} {...b.handlers}>
        {b.gap}
        <span className="k">{isSeriesWork(detail) ? "话数" : "页数"}</span>
        <span className="v" style={factValStyle(style)}>{isSeriesWork(detail)
          // 连载的 total_photos 不是本话页数（实测 47 页显示 5905），改显示话数
          ? "共 " + String(series.length) + " 话"
          : String(detail.total_photos ?? "-") + " 页"}</span>
      </div>
    )),
    jmId: withSlot("jmId", (b) => (
      <div className={"fact" + b.cls} {...b.attrs} ref={b.ref} {...b.handlers}>
        {b.gap}
        <span className="k">JM号</span>
        <span className="v" style={factValStyle(style)}>
          <b className="mono-num">{String(detail.id)}</b>
          <button type="button" className="d-copy-btn" onClick={onCopyId}>复制</button>
        </span>
      </div>
    )),
    addDate: withSlot("addDate", (b) => (
      <div className={"fact" + b.cls} {...b.attrs} ref={b.ref} {...b.handlers}>
        {b.gap}
        <span className="k">收录</span>
        <span className="v" style={factValStyle(style)}>{addDate || "-"}</span>
      </div>
    ))
  };

  /**
   * 内嵌列表容器：**只在编辑态**挂 `data-drag-list`
   * （`useCanvasDrag` 靠它反查"我属于哪个列表"，见 hooks 里的 `begin()`）。
   * 线上态一个属性都不加 —— 与 `editMode=false` DOM 逐字不变的红线一致。
   */
  const listAttr = editMode ? { "data-drag-list": "" } : {};

  /**
   * 选中的是不是**主视觉内部的槽位**：是的话给 `.d-hero` 挂 `ed-open`，
   * 让内嵌槽位的描边显形（渐进披露，见 index.css 里 `.ed-slot` 那段的说明）。
   * 这个判断只能由 JS 做 —— 本项目的老内核没有 CSS `:has()`（Chrome 105+ 才有）。
   */
  const heroOpen = editMode && selectedBlock !== null && (
    visibleHeroSlots(layout).indexOf(selectedBlock as HeroSlotId) >= 0 ||
    visibleHeroInfoSlots(layout).indexOf(selectedBlock as HeroInfoSlotId) >= 0 ||
    visibleFacts(layout).indexOf(selectedBlock as FactId) >= 0
  );

  // ── 主视觉右栏：标题 / 四宫格 / 数据条（顺序由配置给）──
  const heroInfoNodes: Record<HeroInfoSlotId, ReactNode> = {
    title: withSlot("title", (b) => (
      <h2 className={"d-title" + b.cls} style={titleStyle(style)} {...b.attrs} ref={b.ref} {...b.handlers}>{b.gap}{detail.name}</h2>
    )),
    facts: withSlot("facts", (b) => (
      // `.d-facts` 一身两职：既是"信息栏内的一项"（槽位），又是四宫格字段的**容器**（列表）
      <div className={"d-facts" + b.cls + (heroForm === "infoTable" ? " d-facts-table" : "")} {...listAttr} {...b.attrs} ref={b.ref} {...b.handlers}>
        {b.gap}
        {visibleFacts(layout).map((f) => <Fragment key={f}>{factNodes[f]}</Fragment>)}
      </div>
    )),
    stat: (views || likes) ? withSlot("stat", (b) => (
      // ⚠️ **条件渲染**：浏览/喜欢都为 0 时这一项不渲染，于是 DOM 下标 ≠ 配置下标
      // （配置恒为 [title, facts, stat]）。落位折算靠 `moveVisibleNodeTo` 的**顺序语义**
      // 处理（取"移除被拖项之后的第 p 个"），不受少一项的影响。
      <p className={"d-stat" + b.cls} style={statStyle(style)} {...b.attrs} ref={b.ref} {...b.handlers}>
        {b.gap}
        {views && <span>{views} 浏览</span>}
        {views && likes && <span className="meta-sep"> · </span>}
        {likes && <span>{likes} 喜欢</span>}
      </p>
    )) : null
  };

  // ── 主视觉左右两栏：封面 / 信息栏（顺序由配置给，可把封面换到右边）──
  const heroSlotNodes: Record<HeroSlotId, ReactNode> = {
    cover: withSlot("cover", (b) => (
      <span className={"d-cover-box" + (coverUrl ? "" : " empty") + b.cls} style={coverBoxStyle(style)} {...b.attrs} ref={b.ref} {...b.handlers}>
        {b.gap}
        {coverUrl && (
          <img
            className="d-cover"
            src={coverUrl}
            alt={detail.name}
            loading="lazy"
            decoding="async"
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
        )}
        <span className="d-cover-ph"><span>{detail.name}</span></span>
      </span>
    )),
    info: withSlot("info", (b) => (
      // 同 `.d-facts`：`.d-hero-info` 既是左右两栏之一（槽位），又是信息栏内三项的容器（列表）
      <div className={"d-hero-info" + b.cls} {...listAttr} {...b.attrs} ref={b.ref} {...b.handlers}>
        {b.gap}
        {visibleHeroInfoSlots(layout).map((s) => <Fragment key={s}>{heroInfoNodes[s]}</Fragment>)}
      </div>
    ))
  };

  /**
   * 一个面板的**内容**：目录 / 评论 / 相关漫画（v3.5）。
   *
   * 为什么抽成函数：`detail` 这一块现在有**两种形态**（横栏 / 折叠三行），
   * 而两种形态展示的是**同样这三个面板**。各写一份一定会漂移（改了一处忘了另一处），
   * 所以内容只写一处，形态只决定"怎么摆"。元素本身逐字来自拆分之前 →
   * 默认形态（横栏）渲染出来的 DOM 与拆分前**完全一致**（红线）。
   */
  const panelBody = (p: DetailPanelId): ReactNode => {
    if (p === "dir") {
      return (
        <div className="chap-list">
          {series.length === 0 && (
            <div className="chap-row static" style={chapRowStyle(style)}>
              <span className="chap-name">全一话{detail.total_photos != null ? " · " + String(detail.total_photos) + " 页" : ""}</span>
            </div>
          )}
          {/**
            * v3.9：**筛选把目录筛空了**要给一句人话，不能只留个空盒子。
            * 这是"只看已缓存"最容易踩到的状态（没缓存过任何一话），
            * 也是调研里 Mihon 那类 TriState 筛选必须配的空态。
            * 与上面 `series.length === 0`（单本作品 = 全一话）是**两种不同的空**，不能合并。
            */}
          {series.length > 0 && chapList.length === 0 && (
            <div className="chap-row static" style={chapRowStyle(style)}>
              <span className="chap-name">本地没有缓存的话</span>
            </div>
          )}
          {shownChaps.map((s) => {
            const id = String(s.id);
            const isCur = id === String(detail.id);
            const isLast = !isCur && Boolean(resume) && id === String(resume!.id);
            return (
              <button
                key={id}
                type="button"
                className={"chap-row" + (isCur ? " on" : "")}
                style={chapRowStyle(style)}
                onClick={isCur ? undefined : () => onSwitchChapter(id)}
                aria-current={isCur ? "true" : undefined}
              >
                <span className="chap-name">{chapterLabel(s) || "第 " + String(s.sort ?? "") + " 话"}</span>
                {isCur && <span className="chap-tag now">在读</span>}
                {isLast && <span className="chap-tag last">上次读到</span>}
              </button>
            );
          })}
          {chapList.length > CHAP_PREVIEW && (
            <button type="button" className="chap-more" onClick={() => setChapAll((v) => !v)}>
              {chapAll ? "收起" : "查看全部 " + chapList.length + " 话"}
            </button>
          )}
        </div>
      );
    }
    if (p === "cmt") {
      return (
        <CommentList
          comments={comments}
          total={commentCount}
          hasMore={commentHasMore}
          loadingMore={commentLoadingMore}
          text={commentText}
          busy={busy}
          logged={logged}
          onTextChange={onCommentChange}
          onSubmit={onSubmitComment}
          onLoadMore={onLoadMoreComments}
        />
      );
    }
    return (
      <div className="related-block">
        {/* h3 留给读屏与 e2e（driver.js 会读它的文案），视觉上由标签页标题承担 */}
        <h3 className="sr-only">相关漫画</h3>
        {related.length > 0
          ? <AlbumGrid items={related} onOpen={onOpenRelated} skeleton={skeleton} />
          : <p className="muted">暂无相关漫画</p>}
      </div>
    );
  };

  // ── 顶层区块表：id → 渲染。顺序由 layout.blocks 决定，本文件不再规定先后 ──
  // ⚠️ 每个区块必须是「自足的整块」：不要为了排版在外面再包一层 div，
  //    老内核的间距靠 .actrow > * + * 这类直接子选择器补（见 index.css 的 @supports not (gap:1px)），
  //    多一层 wrapper 会让 compat 包的间距塌成 0，而现代内核上看不出来。
  const blockNodes: Record<DetailBlockId, ReactNode> = {
    back: (
      <div className="d-head">
        <button className="backtxt" onClick={onBack} aria-label={backLabel}>
          <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          返回
        </button>
      </div>
    ),

    hero: (
      // `data-drag-list`（仅编辑态）：主视觉左右两栏的**容器**，内嵌拖拽靠它反查列表。
      // `ed-open` 同理只在编辑态加：选中主视觉内部的槽位时，内层描边才显形（降噪）。
      <div className={"d-hero" + (heroOpen ? " ed-open" : "")} {...listAttr}>
        {visibleHeroSlots(layout).map((s) => <Fragment key={s}>{heroSlotNodes[s]}</Fragment>)}
      </div>
    ),

    actors: actors.length > 0 ? (
      <p className="muted d-meta d-actors">登场人物 {actors.map((a, i) => (
        <span key={"ac" + i}>
          {i > 0 && <span className="meta-sep"> · </span>}
          <button className="link" onClick={() => onOpenActor(a)}>{a}</button>
        </span>
      ))}</p>
    ) : null,

    // 标签改胶囊：可扫读、可横滚，与首页热词胶囊同一套语言
    tags: tags.length > 0 ? (
      <div className={"d-tags" + (tagForm === "scroll" ? " d-tags-scroll" : "")}>
        {tags.map((t) => (
          <button key={t} type="button" className="tagchip" style={tagChipStyle(style)} onClick={() => onOpenTag(t)}>{t}</button>
        ))}
      </div>
    ) : null,

    /*
      v3.3：**「付费提示」区块与阅读按钮已合并**（用户第 3 条：需要付费时原阅读按钮那儿
      显示的就是付费）。以前付费内容是"一段提示文字（notice） + 一个购买按钮（action）"，
      现在只剩动作区里的**一个**主按钮，三态文案/行为见 core/actionButton.ts（有单测）。

      v3.4（Wave I）：它已从 `DETAIL_BLOCK_IDS` 移走 —— 也就是说**编辑画布不再为它渲染
      一个空块**（以前"共 8 块"里算它一个，点进去只有一个改不动任何东西的「提示字号」滑块，
      正是用户最恨的哑控件）。这条 `notice: null` 保留是因为 `DetailBlockId` 里仍有它
      （老存档要读得出来），而这里的 map 类型是 `Record<DetailBlockId, ReactNode>`；
      它永远不会被渲染，因为渲染循环走的是 `DETAIL_BLOCK_IDS`。
    */
    notice: null,

    action: (
      <div className="actrow">
        {/* 主按钮：立即/继续阅读 · 使用官方 JCoin 购买 · 登录后购买 —— 由纯函数按三态决定 */}
        <button
          className="btn primary"
          style={actionBtnStyle(style)}
          disabled={busy}
          title={actionBtn.title || undefined}
          onClick={actionBtn.kind === "buy" ? onBuy : onRead}
        >{actionBtn.label}</button>
        {/* 收藏只在"已登录且内容不需要购买"时出现：
            付费未购买时收藏没有意义，这与合并前的行为逐字一致（旧收藏按钮只出现在非付费分支）。 */}
        {logged && !locked && (
          <button
            className={"btn soft fav" + (detail.is_favorite ? " on" : "")}
            style={actionBtnStyle(style)}
            /* 只有请求在飞时禁用：已收藏也要能点（点一下 = 取消收藏） */
            disabled={busy}
            onClick={onToggleFavorite}
            aria-pressed={Boolean(detail.is_favorite)}
            title={detail.is_favorite ? "点一下取消收藏" : "加入官方收藏"}
          >
            <HeartIcon size={18} filled={Boolean(detail.is_favorite)} />
            {detail.is_favorite ? "已收藏" : "收藏"}
          </button>
        )}
      </div>
    ),

    desc: desc ? (
      <>
        <p ref={descRef} className={"d-desc" + (descAnim.mounted ? " open" : "")}
          /* 展开态只给量出来的完整高度（不带 clamp，否则内联 line-clamp 压过 .open 的解除规则）；
             折叠态才用 descStyle 的行数样式。
             v3：字号与行距**两个分支都要带上** —— 否则"展开"那一刻字号会跳回默认；
             行距还必须与 descStyle 的 maxHeight 系数同源（见 core/detailStyle.descStyle 的注释）。 */
          style={mergeStyle(
            descOpen && descH > 0 ? { maxHeight: descH } : descStyle(style),
            descFontStyle(style),
            descLineStyle(style)
          )}>{desc}</p>
        {(descClamped || descOpen) && (
          <button className="d-more" onClick={toggleDesc}>{descOpen ? "收起" : "展开"}</button>
        )}
      </>
    ) : null,

    /**
     * ── `detail`：**形态**决定这一块长什么样（v3.5）────────────────────────
     *
     * · `tabs`（默认 = 改造前的样子）：横栏 + 当前面板。结构、类名、文案**逐字未变** ——
     *   没配过形态、没隐藏过面板的用户，这里渲染出来的 DOM 与拆分之前完全一样（红线）。
     * · `folded`：三个面板各占一行（带计数），点一下展开 —— 用户要的"折叠起来的三行"。
     *
     * ⚠️ 折叠形态在**编辑态不可交互**：画布上这一整块是一个"可选中单元"
     *   （点 = 选中该区块、长按 = 拖动排序），所以编辑态渲染的是**静态行**（div，不是 button）
     *   且内容永不展开。"点一下展开"是**预览模式**（`editMode=false`，也就是线上路径）的行为。
     *
     * 只剩一个可见面板时**不再画横栏**（一个 tab 的横栏纯属白占一行高度）——
     * 用户要的正是"可以隐藏其中一个或两个"，那就得容忍只剩一个时的样子。
     */
    detail: detailForm === "folded" ? (
      <div className="d-fold">
        {panels.map((p) => {
          const open = !editMode && foldOpen === p;
          const head = (
            <>
              <span className="d-fold-name">{foldLabel(p)}</span>
              <span className={"d-fold-caret" + (open ? " on" : "")} aria-hidden="true">›</span>
            </>
          );
          return (
            <div className={"d-fold-item" + (open ? " on" : "")} key={p} data-fold={p}>
              {editMode ? (
                /* 编辑态：静态行 —— 点它应当**选中区块**（冒泡到 EdBlock），而不是展开 */
                <div className="d-fold-head static">{head}</div>
              ) : (
                <button
                  type="button"
                  className="d-fold-head"
                  aria-expanded={open}
                  data-fold-toggle={p}
                  onClick={() => setFoldOpen(open ? null : p)}
                >{head}</button>
              )}
              {open && <div className="d-fold-body">{panelBody(p)}</div>}
            </div>
          );
        })}
      </div>
    ) : (
      <>
        {panels.length > 1 && (
          <div className="d-tabs" style={tabsStyle(style)}>
            <UnderlineTabs items={tabs} value={activePanel} onChange={(k) => setTab(k as DetailTab)} />
          </div>
        )}

        {activePanel === "dir" && panelBody("dir")}
        {activePanel === "cmt" && panelBody("cmt")}
        {activePanel === "rel" && panelBody("rel")}
      </>
    )
  };

  /** v3 门控：只有「配置显式是 v3」且「真有窄块」才切网格（理由见 core/detailLayout.isSlotted） */
  const slotted = isSlotted(layout);
  /** 网格项的跨格数属性：满宽(12) 是默认，一个属性都不写（保 DOM 最小差异） */
  const spanAttr = (id: DetailBlockId): Record<string, string> => {
    const s = blockSpan(layout, id);
    return s < 12 ? { "data-span": String(s) } : {};
  };

  /**
   * v3.4 行内位置：把"块 + 它前面要留的空列"摊平成一串渲染项。
   *
   * 空占位格是**网格项**（`grid-column: span N`），不是绝对定位的浮层 —— 这样
   * ① 它真的占住那几列（1/2 的块因此能停在行中间而不是被顶到最左）；
   * ② 落点判定用的矩形与视觉位置一致（`dropIndex` 读的就是网格项的真实 offset）。
   *
   * 线上态与编辑态**共用同一份排位**（`packedVisibleRows`），所以"编辑器里看到的"
   * 与"线上渲染的"是同一个布局；行尾那些空占位只在编辑态渲染（线上看不见，白加 DOM）。
   *
   * ⚠️ offset 全为 0（默认 = 今天所有用户）时 lead 全为 0、行尾空位也不渲染
   * → 产生不出任何额外节点，DOM 与加这一层之前**逐字节相同**（红线）。
   */
  type SlotItem = { kind: "gap"; key: string; width: number } | { kind: "block"; key: string; id: DetailBlockId };
  const slotItems: SlotItem[] = [];
  if (slotted) {
    packedVisibleRows(layout).forEach((row, ri) => {
      let cursor = 0;
      row.slots.forEach((s) => {
        if (s.col > cursor) slotItems.push({ kind: "gap", key: "gap-" + ri + "-" + cursor, width: s.col - cursor });
        slotItems.push({ kind: "block", key: s.id, id: s.id });
        cursor = s.col + s.span;
      });
      if (editMode && cursor < 12) slotItems.push({ kind: "gap", key: "gap-" + ri + "-tail", width: 12 - cursor });
    });
  }

  return (
    /**
     * `data-drag-list` 只在编辑态加：拖拽手柄靠它反查"我属于哪个列表"
     * （见 hooks/useDragReorder.ts）。不编辑时不加，DOM 与没有这一层时逐字一致。
     *
     * ── v3 流式槽位（`data-slots` / `data-span`）────────────────────────
     * 三个属性都只在**用户显式改过宽度**时才出现（`isSlotted` 门控，见 core/detailLayout），
     * 所以"从没配过 / 配过但全是满宽"的用户 DOM 一个字节都不变 —— 这条红线是设计文档 §4.2 的核心。
     *
     * ⚠️ 网格项（grid item）在两种模式下**不是同一个元素**，`data-span` 必须挂在真正当网格项的那个上面，
     * 否则会出现"编辑态并排、线上不并排"（或反之）：
     *   · 编辑态：每块被 `EdBlock` 包住 → 网格项是 `.ed-blk`，`data-span` 交给 EdBlock 渲染；
     *   · 线上态：块根元素是直接子级，但 `blockNodes` 里既有单元素（hero/tags/…）也有 **Fragment**（desc/detail）
     *     和 `null`（条件块）→ 没法统一用 `cloneElement` 注属性，所以这里统一包一层 `.d-slot` 当网格项。
     *     多出来的这一层**不破坏**老内核那 59 条兄弟选择器补丁：`.d-head > * + *` / `.actrow > * + *`
     *     都是**块内部**间距，`.detail-card` 上没有直接子选择器（已核）；各块的行间距来自各自的
     *     `margin-top`（无 margin-bottom），包一层后仍是同样的纵向节奏。
     */
    <div
      className="card detail-card"
      {...detailStyleAttrs(style)}
      {...(editMode ? { "data-drag-list": "" } : {})}
      {...(slotted ? { "data-slots": "1" } : {})}
    >
      {slotted ? slotItems.map((it) => (
        it.kind === "gap" ? (
          /* 空占位格：真的占住那几列（参与网格布局），编辑态给一条虚线让它看得见 */
          <div key={it.key} className="d-gap" aria-hidden="true" style={{ gridColumn: "span " + it.width }} />
        ) : editMode ? (
          <EdBlock
            key={it.key}
            id={it.id}
            span={blockSpan(layout, it.id)}
            selected={selectedBlock === it.id}
            onSelect={(x) => onSelectBlock?.(x as DetailNodeId)}
            onMoveTo={(x, to) => onMoveBlockTo?.(x as DetailNodeId, to)}
            onMoveColTo={(x, col) => onMoveBlockCol?.(x as DetailNodeId, col)}
            onDragEnd={onMoveBlockEnd}
            onDragStart={onDragStart}
          >{blockNodes[it.id]}</EdBlock>
        ) : (
          /**
           * 线上态 + 用户启用了并排：包一层 `.d-slot` 当**网格项**（`blockNodes` 里既有单元素
           * 也有 Fragment 与 null，没法统一 `cloneElement` 注属性，所以统一包一层）。
           * 这一层只在 slotted 时存在 —— 没配过宽度的用户走下面那个 Fragment 分支。
           */
          <div key={it.key} className="d-slot" {...spanAttr(it.id)}>{blockNodes[it.id]}</div>
        )
      )) : visibleBlocks(layout).map((id) => (
        editMode ? (
          /**
           * 编辑态：每块套一层 `EdBlock`（长按整块拖动 + 选中描边，全部绝对定位）。
           * 线上路径走下面那两个分支，DOM 一个盒子都不多（见 Props 里 editMode 的说明）。
           */
          <EdBlock
            key={id}
            id={id}
            span={blockSpan(layout, id)}
            selected={selectedBlock === id}
            onSelect={(x) => onSelectBlock?.(x as DetailNodeId)}
            onMoveTo={(x, to) => onMoveBlockTo?.(x as DetailNodeId, to)}
            onMoveColTo={(x, col) => onMoveBlockCol?.(x as DetailNodeId, col)}
            onDragEnd={onMoveBlockEnd}
            onDragStart={onDragStart}
          >{blockNodes[id]}</EdBlock>
        ) : (
          /**
           * 线上态但没有窄块（`isSlotted` 为假）：不包任何盒子 —— 与本层不存在时逐字一致。
           */
          <Fragment key={id}>{blockNodes[id]}</Fragment>
        )
      ))}
    </div>
  );
}
