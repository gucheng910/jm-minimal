import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import AlbumDetail from "../pages/AlbumDetail";
import { AlbumGrid } from "./AlbumGrid";
import CustomUiGallery, { GALLERY_PAGES } from "./CustomUiGallery";
import type { CanvasPage } from "./CustomUiGallery";
import { CANVAS_DETAIL_PROPS, CANVAS_LIST_PROPS } from "./customUiCanvasProps";
import ModuleInspector from "./ModuleInspector";
import NodeOrderList from "./NodeOrderList";
import ListCardInspector from "./ListCardInspector";
import ChromeInspector from "./ChromeInspector";
import PageStyleSheet from "./PageStyleSheet";
import { BarsPreview, ReaderChromePreview } from "./chrome/ChromePreview";
import { MoreIcon } from "./icons";
import { emit, on } from "../core/bus";
import { useBackHandler } from "../hooks/useBackHandler";
import { ITEM_SEL } from "../hooks/useCanvasDrag";
import {
  formsFor,
  DETAIL_NODE_META,
  MIN_VISIBLE_PANELS,
  blockForm,
  blockOffset,
  blockSpan,
  detailLayoutSections,
  loadDetailLayout,
  moveVisibleNodeTo,
  resetDetailLayout,
  saveDetailLayout,
  setDetailBlockForm,
  setDetailBlockOffset,
  setDetailBlockSpan,
  setDetailNodeHidden,
  isHidden,
  visibleBlocks,
  visibleListOf
} from "../core/detailLayout";
import type { DetailBlockId, DetailLayoutConfig, DetailNodeId } from "../core/detailLayout";
import { loadDetailStyle, resetDetailStyle, saveDetailStyle } from "../core/detailStyle";
import type { DetailStyleConfig } from "../core/detailStyle";
import { resetListLayout, saveListLayout } from "../core/listLayout";
import { loadChromeLayout, resetChromeLayout, saveChromeLayout } from "../core/chromeLayout";
import type { ChromeLayoutConfig, ChromeSection } from "../core/chromeLayout";
import { loadReaderStyle, resetReaderStyle, saveReaderStyle } from "../core/readerStyle";
import type { ReaderStyleConfig } from "../core/readerStyle";

/**
 * 「自定义 UI」—— **一个专门的编辑器页**（不是弹层）。
 *
 * 界面解剖直接照抄成熟产品（调研见报告 §19.2）：
 *
 * | 我们这里 | 抄自 | 出处 |
 * |---|---|---|
 * | **画布**：真实渲染的页面 | GrapesJS 的 canvas / Webstudio 的画布 | [GrapesJS](https://grapesjs.com/docs/getting-started.html#start-from-the-canvas) |
 * | **编辑 / 预览** 两种模式 | Webstudio 的 **Modes**（Design / Content / Preview） | [modes](https://docs.webstudio.is/university/foundations/modes.md) |
 * | **收起编辑器看效果** | Webstudio 的 **Hide UI**（`Ctrl+\`，鼠标移到顶边临时露顶栏） | [Hide UI](https://docs.webstudio.is/university/foundations/anatomy-of-the-webstudio-builder.md#hide-ui) |
 * | **编辑态描边 + 总开关（默认开）** | GrapesJS 的 `sw-visibility` / `.btn-toggle-borders`（`active:true`） | [panels-buttons](https://grapesjs.com/docs/getting-started.html#panels-buttons) |
 * | **画布宽度档位** | ~~Webstudio 的 Breakpoints~~ **← 这条当年抄错了，v3.2 已删**，见下 | — |
 * | **检查器分组 + 「这组被改过」圆点** | Webstudio 的 **Style panel** | [sections](https://docs.webstudio.is/university/foundations/style-panel.md#sections) |
 * | **单项复位 ↺** | Webstudio 的 Alt 点击样式值 = 复位 | [shortcuts](https://docs.webstudio.is/university/foundations/shortcuts.md) |
 * | **块上的序号** | GrapesJS 的 Layer Manager（结构的树形概览） | [layers](https://grapesjs.com/docs/getting-started.html#layers) |
 *
 * ⚠️ **一处更正（v3.2）**：上表那条"画布宽度档位 ← Webstudio Breakpoints"是**抄错了**。
 * Webstudio 的 Breakpoints 是"**按断点写样式**"的模型（在某断点改的值层叠到更小断点），
 * 而我们当年做成了"改画布盒子的 `max-width`"—— 两件事根本不是一回事，而且那个控件
 * **对预览完全无效**：列表页列数全部由**视口** `@media` 决定（`index.css` 的 640/900/1320
 * 断点），容器宽度不可能触发它们（`@container` 是 Chrome 105+，WebView 57 没有）。
 * 于是手机上三档零可见差异、桌面上面板变窄但仍是 6 列，而提示文案还写着"窄＝列表 2 列"
 * —— **一个骗人的控件**。v3.2 已把它删除，换成真正有用的「宽屏预览」开关
 * （见下面 `.ed-preview-wide` 的说明）。真要做"按断点预览"，唯一办法是 iframe，代价太大，不做。
 *
 * **一条"别做"**（同样来自调研）：不做画布拖边框改尺寸。Webstudio 官方明确不做
 * （"Resize an element: Set its width and height in the Style Panel's Size section"），
 * GrapesJS 用数字+单位+min，Home Assistant 做了拖拽后仍用滑块。
 * 而且拖边框是连续多帧，在本项目会撞上滚动锚定那条"边拖边跳"。
 * 所以「大小」一律在检查器里用**有界档位**给。
 *
 * ── 画布渲染的是**真组件** ─────────────────────────────────────────
 * 不是"画个示意图"。详情页画布就是 `<AlbumDetail editMode />`，列表页画布就是 `<AlbumGrid />`。
 * 所以画布里看到的就是真页面 —— 预览才是真的预览。
 * 代价是给 `AlbumDetail` 加了 `editMode`：**false（线上路径）时 DOM 逐字不变**，见该文件的说明。
 */

type Mode = "edit" | "preview";
/**
 * 外壳的两屏（v3.2）：
 *   · `gallery` —— 「选择页面」屏：可自定义页面的画廊（近期任务式卡片）；
 *   · `editor`  —— 「编辑」屏：画布 + 检查器。
 * 进入编辑器默认停在画廊；点卡片才进编辑屏，所以**返回键要分两层**（见下面的 useBackHandler）。
 */
type Screen = "gallery" | "editor";

/**
 * 滑块防抖提交的等待时长（收尾波）。
 *
 * 为什么要有它：拖一根滑块时 `onChange` 的触发频率与指针事件同量级（约 60Hz），
 * 而每次 `applyStyle` 都会**同步写一次 localStorage + 广播一次**，广播还让
 * AlbumDetail / 本页自己 / 排布总表三方各重读一次并重渲染 —— 与当年"拖块每帧落盘"
 * 完全同源，手机上拖滑块就是卡。改成滑动中只动内存、停手后 **一次** 落盘 + **一次** 广播。
 *
 * 取值理由：300ms 够长到能跨过连续拖动的输入间隔（不会边拖边落盘），
 * 又够短到停手即落盘（不会让人以为"改了没保存"）。与拖动那套"松手才提交"的语义一致。
 */
const STYLE_COMMIT_MS = 300;

interface Props {
  open: boolean;
  onClose: () => void;
  entering?: boolean;
  closing?: boolean;
  /** 从设置页哪一行进来就预选哪一页（进画廊，点卡片时用这个作为高亮/默认页） */
  initialPage?: CanvasPage;
}

export default function CustomUiPage({ open, onClose, entering, closing, initialPage = "detail" }: Props) {
  const [screen, setScreen] = useState<Screen>("gallery");
  const [page, setPage] = useState<CanvasPage>(initialPage);
  const [mode, setMode] = useState<Mode>("edit");
  /**
   * 画布里当前选中的**块或内嵌槽位**（v3 内嵌可拖起放宽到 `DetailNodeId`）：
   * 选中的既可能是顶层块（hero/tags/…），也可能是主视觉内部的槽位
   * （cover/info/title/facts/stat/author/…）。
   */
  const [selected, setSelected] = useState<DetailNodeId | null>(null);
  /**
   * 列表页画布里选中的「卡片」（v3.3）。
   *
   * 为什么单独一个 state：它不属于 `detailLayout` 的任何节点（`DetailNodeId` 里没有"卡片"
   * 这种节点），而列表页的配置对象是 `ListLayoutConfig`。用一个布尔表达"列表页的卡片被选中"，
   * 比往 `DetailNodeId` 里塞一个假 id 干净。
   */
  const [listSel, setListSel] = useState(false);
  /**
   * 「顶栏和底栏」/「阅读器」两页里**画布上点中的那个单元**（v3.13），形如 `"nav:search"`。
   *
   * 为什么与 `selected`（详情页的块）分开两个 state：两者的 id 空间完全不同
   * （`DetailNodeId` 是封闭联合，单元 id 是"分区 + id"的字符串），
   * 塞进同一个 state 只会让类型变成 `string` 并丢掉详情页那边的收窄。
   */
  const [unitSel, setUnitSel] = useState<string | null>(null);
  /** 检查器里展开的折叠段（v2：样式表 / 排布总表都不再常驻，按需展开） */
  /**
   * 「页面设置」独立一屏的开合（v3.3）。
   *
   * v3.2 时它是检查器里的一个折叠段（还会把画布顶上去），用户第 8 条明确否掉了那种做法：
   * 「唤出它时应当和选择区块时一样下面单独出来一个页面」。现在它是**覆盖层**
   * （`.ed-sheetpage`）—— 独立成屏，但**不换 screen**，所以画布不卸载、
   * 滚动位置与选中态都不会丢。
   *
   * v3.3 起「排布总表」已删除，所以这里只剩 `style` 一个可选值。
   */
  const [openPanel, setOpenPanel] = useState<"none" | "style">("none");
  /**
   * 顶栏「⋯」次级菜单（v3.2 美化）。
   * 为什么要有它：原来「页面设置 / 排布总表」是**两条常驻折叠段**贴在检查器里，
   * 平时只占高度不干活（"挤"的来源之一），「恢复默认」又跟模式切换挤在同一条上。
   * 现在三件事一起收进这个菜单，检查器只剩"当前选中块的配置"。
   */
  const [menu, setMenu] = useState(false);

  const [layout, setLayout] = useState<DetailLayoutConfig>(() => loadDetailLayout());
  const [style, setStyle] = useState<DetailStyleConfig>(() => loadDetailStyle());
  /** 顶栏 / 底栏 / 阅读器控制条的单元编排（v3.13：终于有了配置入口） */
  const [chrome, setChrome] = useState<ChromeLayoutConfig>(() => loadChromeLayout());
  /** 阅读器观感（滚动条 / 控制条自动隐藏） */
  const [rdStyle, setRdStyle] = useState<ReaderStyleConfig>(() => loadReaderStyle());

  /** 常驻挂载：每次打开都回到**画廊**（用户要的入口形态），并重读配置（别处可能改过） */
  useEffect(() => {
    if (!open) return;
    setScreen("gallery");
    setPage(initialPage);
    setLayout(loadDetailLayout());
    setStyle(loadDetailStyle());
    setChrome(loadChromeLayout());
    setRdStyle(loadReaderStyle());
    setSelected(null);
    setUnitSel(null);
    setOpenPanel("none");
    setMenu(false);
  }, [open, initialPage]);

  // 详情页画布要跟着配置实时变（改了立即看到效果），所以自己订阅自己。
  // 但**自己刚 emit 的那一次要跳过**：真值就是我刚写下去的东西，重读一次 = 白跑一次读盘 + 多一次重渲染
  // （排布总表每次改动、以及拖动收尾都会触发）。外部改的（DetailLayoutPanel 等）照旧重读重渲染。
  // 注：core/bus 的 emit 是 window.dispatchEvent 同步派发，所以"先置标记再 emit"必然被自己的回调消费掉。
  useEffect(() => on("jm:detailLayout", () => {
    if (selfEmitRef.current) { selfEmitRef.current = false; return; }
    snapshotBlocks(); // FLIP 的 F：外部改了版面，让位动画照跑
    const next = loadDetailLayout();
    layoutRef.current = next;
    setLayout(next);
  }), []);
  useEffect(() => on("jm:detailStyle", () => {
    if (selfStyleEmitRef.current) { selfStyleEmitRef.current = false; return; }
    setStyle(loadDetailStyle());
  }), []);
  // 两个栏 / 阅读器同理（v3.13）：外部改了配置（例如将来的快捷开关）画布要跟着变。
  // ⚠️ 订阅回调里**不能**再调 setChrome(下次读盘的值) 而不做自emit 判定 —— 自己发的那一发
  // 会绕回来重读一次，白跑一趟读盘 + 一次整页重渲染（与上面两条同因）。
  useEffect(() => on("jm:chromeLayout", () => {
    if (selfChromeEmitRef.current) { selfChromeEmitRef.current = false; return; }
    setChrome(loadChromeLayout());
  }), []);
  useEffect(() => on("jm:readerStyle", () => {
    if (selfRdStyleEmitRef.current) { selfRdStyleEmitRef.current = false; return; }
    setRdStyle(loadReaderStyle());
  }), []);

  /** 画布 ref + FLIP 让位动画（拖拽时兄弟块滑开，v2 的"自动避让"） */
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const flipRef = useRef<Map<string, { x: number; y: number; px: number; py: number }> | null>(null);
  const flipCountRef = useRef(0);
  /**
   * FLIP 的**令牌**：每个元素一个自增号。
   * 过期的 `transitionend` 与兜底定时器据此判断"这一轮动画还是不是我那一轮" ——
   * 不判就会把**下一轮**正在跑的 transition 清掉（旧实现用固定 200ms 定时器，
   * 实测换位间隔 51/53/102ms 时反复命中，表现为"跳格"，见下面 useLayoutEffect 的注释）。
   */
  const flipTokenRef = useRef(new WeakMap<HTMLElement, number>());

  /**
   * 拖动中的**最新**版面（内存态）。
   * pointermove 的闭包可能滞后一帧，落盘必须用这个 ref，不能用渲染作用域里的 `layout`。
   */
  const layoutRef = useRef(layout);
  /** 本次拖拽是否真的动过 —— 长按了但没换位就不落盘、不广播 */
  const dragDirtyRef = useRef(false);
  /** 刚由**我自己** emit 的广播：订阅回调据此跳过"重读自己刚写的东西" */
  const selfEmitRef = useRef(false);
  const selfStyleEmitRef = useRef(false);
  const selfChromeEmitRef = useRef(false);
  const selfRdStyleEmitRef = useRef(false);

  /**
   * 滑块的内存态（收尾波，与 `layoutRef` 同一套模式）：
   *   · `styleRef`      —— 滑动中的**最新**样式值（防抖到期时落盘用它，别用可能滞后的闭包）；
   *   · `styleDirtyRef` —— 这一轮滑动是否真的改过（没改过就不落盘、不广播）；
   *   · `styleTimerRef` —— 防抖计时器（新一次输入把它顶掉；离散操作要主动取消它）。
   */
  const styleRef = useRef(style);
  const styleDirtyRef = useRef(false);
  const styleTimerRef = useRef<number | null>(null);

  // layout 由别处赋值（打开时重读 / 排布总表 / 恢复默认）时，把 ref 跟上
  useLayoutEffect(() => { layoutRef.current = layout; }, [layout]);
  // style 同理（打开时重读 / 总线外部改动 / 恢复默认）
  useLayoutEffect(() => { styleRef.current = style; }, [style]);

  /**
   * 卸载兜底：拖块或拖滑块拖到一半就退出编辑器 / 切页时，把手上的内存态补落一次，
   * 别让用户白拖一趟。正常路径不会走到这里（松手/防抖到期时已提交，dirty 已清零）。
   */
  useEffect(() => () => {
    if (dragDirtyRef.current) {
      dragDirtyRef.current = false;
      saveDetailLayout(layoutRef.current);
    }
    if (styleTimerRef.current != null) { clearTimeout(styleTimerRef.current); styleTimerRef.current = null; }
    if (styleDirtyRef.current) {
      styleDirtyRef.current = false;
      saveDetailStyle(styleRef.current);
    }
  }, []);

  /**
   * FLIP 的 F：记下每个可拖项的当前位置 —— 必须在布局变更**之前**调用。
   *
   * ⚠️ 同时记下**它所属列表**的位置。嵌套（v3 内嵌可拖）之后这是必需的：
   * 父块自己被 FLIP 平移时，它内部槽位的 `getBoundingClientRect()` 也会跟着变，
   * 于是内层会被算成"自己也移动了"并施加**反向补偿** —— 表现是内嵌槽位从块里
   * **飞出去**（嵌套 FLIP 的经典双补偿错误）。
   * 只补"相对自己列表的**残差**位移"就没这个问题：父块自己的 FLIP 已经把它一起带过去了。
   * 顶层项相对 `.detail-card` 的残差 = 原位移 → 行为与以前完全一致。
   */
  function snapshotBlocks() {
    const map = new Map<string, { x: number; y: number; px: number; py: number }>();
    const root = canvasRef.current;
    if (root) {
      root.querySelectorAll<HTMLElement>(ITEM_SEL).forEach((el) => {
        const key = el.getAttribute("data-blk");
        if (!key) return;
        const r = el.getBoundingClientRect();
        const pr = el.parentElement ? el.parentElement.getBoundingClientRect() : r; // 列表本身的位置
        map.set(key, { x: r.left, y: r.top, px: pr.left, py: pr.top });
      });
    }
    flipRef.current = map;
  }

  /**
   * FLIP 的 I + P：布局变更后，把每个项从旧位置**滑**到新位置。
   * 只动 `transform`（合成层，不碰文档流）—— 绝不改 top/margin 之类的布局属性，
   * 否则会撞 compat 包那几十条 `> * + *` 间距补丁（报告 §3.3-④）。
   * `data-flip` 是观测钩子：e2e / 真机验收靠它证明"让位动画真的跑过"。
   *
   * 位移取的是**相对自己列表的残差**（见 `snapshotBlocks` 的说明）：嵌套时父块的
   * 平移量要在内层身上扣掉，否则会双补偿。
   */
  useLayoutEffect(() => {
    const map = flipRef.current;
    const root = canvasRef.current;
    flipRef.current = null;
    if (!map || !root) return;

    /* ── 读批 → 写批 → **一次**强制回流（v3.5.2）─────────────────────────
       旧写法把"读 rect → 写 style → `void el.offsetWidth`"放在**同一个 forEach** 里，
       每个动过的块各强制一次同步布局。机器级实测：一次换位最多 **7 个元素**同时动
       （各块 margin-top 不同，互换两块会让下面整列各平移一小段）→ 7 次强制同步布局，
       读写交错 = layout thrashing。Muuri 的 ticker 用 LANE_READ / LANE_WRITE 两条泳道
       规避的正是这件事。

       ⚠️ 不能把强制回流整个删掉：不强制的话浏览器会把"设起点 transform"与"清 transform"
       合并进同一帧，动画根本不跑。所以是"每块一次 → 全体一次"，不是"不要"。 */
    const items = Array.from(root.querySelectorAll<HTMLElement>(ITEM_SEL));
    const moved: { el: HTMLElement; dx: number; dy: number }[] = [];
    for (const el of items) {
      const key = el.getAttribute("data-blk");
      const prev = key ? map.get(key) : undefined;
      if (!key || !prev) continue;
      const r = el.getBoundingClientRect();
      const pr = el.parentElement ? el.parentElement.getBoundingClientRect() : r;
      const dx = (prev.x - r.left) - (prev.px - pr.left);
      const dy = (prev.y - r.top) - (prev.py - pr.top);
      if (!dx && !dy) continue;
      moved.push({ el, dx, dy });
    }
    if (!moved.length) return;

    for (const m of moved) {
      m.el.style.transition = "none";
      m.el.style.transform = "translate(" + String(m.dx) + "px," + String(m.dy) + "px)";
    }
    void root.offsetWidth; // ← 唯一一次强制回流（原来每个块各一次）
    /* ──────────────────────────────────────────────────────────────── */

    /* ── 清理改成"动画自己的结束信号 + 令牌"（v3.5.2）─────────────────────
       旧写法是 `setTimeout(() => { el.style.transition = ""; }, 200)`。
       病根（机器级）：动画本身 150ms，而**上一轮的定时器会在下一轮动画中途到点**，
       把新一轮正在跑的 transition 清成 `""` → 元素**瞬间跳到终点**。
       实测换位间隔有 51 / 53 / 102ms（都 < 200ms），所以这条路径在正常拖动里反复命中 ——
       用户说的"跳格 / 抽搐"就是它。

       现在：`transitionend`（令牌校验，过期回调直接丢弃）+ **令牌保护的**兜底定时器
       （防"动画没跑起来"时 transition 永久留在内联样式上）。
       `transitionend` 在 WebView 57 上完全可用，没有引入任何新 API。 */
    for (const m of moved) {
      const el = m.el;
      const tokens = flipTokenRef.current;
      const token = (tokens.get(el) || 0) + 1;
      tokens.set(el, token);
      const done = () => {
        // 过期（新一轮动画已接管）就什么都别做 —— 这正是旧实现踩的那个坑
        if (tokens.get(el) !== token) return;
        el.style.transition = "";
      };
      // ⚠️ 不用 `{ once: true }`：子元素冒泡上来的 transitionend 会把监听器提前消耗掉，
      //    于是真正那次结束信号收不到。改成"自己摘 + 只认 target 与 propertyName"。
      const onEnd = (ev: TransitionEvent) => {
        if (ev.target !== el || ev.propertyName !== "transform") return;
        el.removeEventListener("transitionend", onEnd);
        done();
      };
      el.style.transition = "transform 150ms ease-out";
      el.style.transform = "";
      el.addEventListener("transitionend", onEnd);
      window.setTimeout(() => { el.removeEventListener("transitionend", onEnd); done(); }, 400);
    }

    flipCountRef.current += 1;
    root.setAttribute("data-flip", String(flipCountRef.current));
  }, [layout]);

  /**
   * 发一次"**我自己**改的"广播（审计 M-2 修法）。
   *
   * 订阅回调靠 `selfEmitRef` 跳过自己发的那一发，但标记必须保证**任何路径都不残留**：
   * `core/bus.emit` 在 `typeof window === "undefined"` 时会提前 return（根本不派发），
   * 那样标记会留成 true —— 下一次**外部**（排布总表 / 别的组件）改版面的广播就被误判成
   * "自己发的"而跳过重读，画布静默不跟着刷新，直到下次重进编辑器。
   * try/finally 把它清干净（依赖 `bus.emit` 是同步 `dispatchEvent` 这一已核实事实：
   * 派发时回调已把标记消费掉，这里再清一次是幂等的兜底）。
   */
  function emitSelf(ref: { current: boolean }, type: "jm:detailLayout" | "jm:detailStyle" | "jm:chromeLayout" | "jm:readerStyle") {
    ref.current = true;
    try {
      emit(type);
    } finally {
      ref.current = false;
    }
  }

  function applyLayout(next: DetailLayoutConfig) {
    if (next === layoutRef.current) return;
    snapshotBlocks(); // FLIP 的 F
    layoutRef.current = next;
    setLayout(next);
    saveDetailLayout(next);
    emitSelf(selfEmitRef, "jm:detailLayout"); // 这一发是我自己发的，别再重读回来
  }

  /**
   * 拖动**中**：只动内存 —— 不写 localStorage、不广播。
   *
   * 这是"不卡"的关键。以前每帧 pointermove 都走 applyLayout：
   * 同步落盘 1 次 + 广播 1 次，而广播会让 AlbumDetail / 本页自己 / 排布总表
   * 三个订阅方各重读一次 localStorage 并整页重渲染，外加 FLIP 全量测量。
   * 现在这些全部推迟到松手那一次（commitLayout），拖动中只剩"改内存 + 让位动画"。
   */
  function previewLayout(next: DetailLayoutConfig) {
    if (next === layoutRef.current) return; // 索引没变：连重渲染都省掉（拖动中最常见的情形）
    snapshotBlocks(); // FLIP 的 F：让位动画仍要逐帧跟手
    layoutRef.current = next;
    setLayout(next);
  }

  /** 一次拖拽收尾：**一次**落盘 + **一次**广播（由 useCanvasDrag 的 onDragEnd 调用） */
  function commitLayout() {
    if (!dragDirtyRef.current) return;
    dragDirtyRef.current = false;
    saveDetailLayout(layoutRef.current);
    emitSelf(selfEmitRef, "jm:detailLayout");
  }

  /**
   * 滑块**停手一次**：一次落盘 + 一次广播（防抖到期、或卸载兜底时调用）。
   * 幂等：没有待提交的改动就直接返回（离散操作提交后 dirty 已清零）。
   */
  function commitStyle() {
    if (styleTimerRef.current != null) { clearTimeout(styleTimerRef.current); styleTimerRef.current = null; }
    if (!styleDirtyRef.current) return;
    styleDirtyRef.current = false;
    saveDetailStyle(styleRef.current);
    emitSelf(selfStyleEmitRef, "jm:detailStyle");
  }

  /**
   * 滑块**滑动中**：只动内存 —— 不写 localStorage、不广播。
   * 这是"手机上拖滑块不卡"的关键，与 `previewLayout` 同一套语义（见 STYLE_COMMIT_MS 的说明）。
   */
  function previewStyle(next: DetailStyleConfig) {
    if (next === styleRef.current) return; // 值没变：连重渲染都省掉
    styleRef.current = next;
    styleDirtyRef.current = true;
    setStyle(next);
    if (styleTimerRef.current != null) clearTimeout(styleTimerRef.current);
    styleTimerRef.current = window.setTimeout(commitStyle, STYLE_COMMIT_MS);
  }

  /**
   * **离散**修改（档位 / 开关 / 单项复位 / 恢复默认）：立即落盘 + 立即广播。
   * 这些是单击，用户预期立刻生效、立刻持久。两条纪律：
   *   ① 先**取消挂起的防抖** —— 否则滑块那次还没到期的提交会在 300ms 后把新值覆盖回去；
   *   ② 用 `styleRef` 判等而不是渲染作用域里的 `style` —— 滑动中 ref 才是最新值。
   */
  function applyStyle(next: DetailStyleConfig) {
    if (next === styleRef.current) return;
    if (styleTimerRef.current != null) { clearTimeout(styleTimerRef.current); styleTimerRef.current = null; }
    styleDirtyRef.current = false;
    styleRef.current = next;
    setStyle(next);
    saveDetailStyle(next);
    emitSelf(selfStyleEmitRef, "jm:detailStyle");
  }

  /**
   * 两个栏 / 阅读器的修改**全是离散的**（开关 / 档位 / ▲▼），所以走"立即落盘 + 立即广播"，
   * 不挂防抖 —— 那些都是单击，用户预期立刻生效（与 `applyStyle` 的离散分支同一口径）。
   * 等值判断用渲染作用域的 `chrome` / `rdStyle` 就够：单击不像拖滑块那样一帧一次，
   * 不存在"闭包滞后一帧"的窗口。
   */
  function applyChrome(next: ChromeLayoutConfig) {
    if (next === chrome) return;
    setChrome(next);
    saveChromeLayout(next);
    emitSelf(selfChromeEmitRef, "jm:chromeLayout");
  }
  function applyRdStyle(next: ReaderStyleConfig) {
    if (next === rdStyle) return;
    setRdStyle(next);
    saveReaderStyle(next);
    emitSelf(selfRdStyleEmitRef, "jm:readerStyle");
  }
  /** 恢复默认：结构与观感一起（调研：HA 的 revert 就是**一个**按钮） */
  function resetAll() {
    applyLayout(resetDetailLayout());
    applyStyle(resetDetailStyle());
    // v3.3：「排布总表」删除后，列表页的配置（列数 / 副标题字段）也归到这一个入口 ——
    // 否则"恢复默认"对列表页就没有任何入口了（删面板的硬约束：每类配置都得有入口）。
    saveListLayout(resetListLayout());
    emit("jm:listLayout");
    // v3.13：两页新增的配置同样必须归口到这里 —— 四页各留一个"恢复默认"才是真的乱。
    applyChrome(resetChromeLayout());
    applyRdStyle(resetReaderStyle());
  }

  /**
   * 拖动**真正开始**那一帧：把已经唤起的配置收起来（用户第 2 条）。
   *
   * 三样都要收：选中的区块（检查器就是它弹出来的）、`openPanel`（「页面设置」是**独立一屏**
   * 的覆盖层，不收会压着画布拖）、列表页的 `listSel`。
   *
   * ⚠️ 不能让"收起"把落点搞乱：收起会改 `.ed-body` 的几何（窄屏 = 检查器高度，
   * 宽屏 = 340px 右栏），而拖拽快照是起拖时测一次的。`useCanvasDrag.updateDrop()`
   * 每帧比对 offsetParent 原点与容器尺寸，变化就**重建快照 + 把原点搬到当前镜像中心**
   * （`core/dropIndex` 的 `origin`），所以落点不会因为这次收起而跳一格。
   */
  function collapseForDrag() {
    setSelected(null);
    setOpenPanel("none");
    setListSel(false);
    setUnitSel(null);
  }

  /**
   * 画布与画廊缩略图共用的样例 props —— 已抽到 `customUiCanvasProps.ts`（v3.2）。
   * 抽出去的原因：画廊每张卡都要渲染同一份样例页，写死在组件里就没法复用，
   * 两处迟早漂移（设计文档 §6.1 的前置依赖）。
   */

  const editing = mode === "edit";
  const blocks = visibleBlocks(layout);
  /**
   * 选中项**所属列表**的可见顺序（检查器的"第 N / 共 M"、▲▼ 的禁用态都按它算）。
   * 内嵌槽位（title / facts / author…）不属于顶层 `blocks`，拿顶层下标去显示会得到
   * "第 -1 块 / 共 8 块"这种胡话（v3 内嵌可拖之后才会发生）。
   */
  const selectedList = useMemo(
    () => (selected ? visibleListOf(layout, selected) : []),
    [layout, selected]
  );
  /** 选中的是不是**顶层块** —— 决定检查器里要不要给"宽度"档位（宽度是 12 列网格的概念） */
  const selectedIsTop = selected !== null && (blocks as DetailNodeId[]).indexOf(selected) >= 0;
  /** 检查器收成一条：没选中任何块、也没有展开的折叠段（v2：不点就不占画布空间） */
  /**
   * ⚠️ v3.13：新增的「顶栏和底栏」/「阅读器」两页**永远不收**。
   * 它们的面板是一张"单元清单"（不是"某个块被选中后的配置"），收起 = 把全部入口一起藏掉，
   * 而"每类配置都得有入口"是本项目最硬的不变量。这两页也没有可拖的东西，不需要为拖动让位。
   */
  const slim = editing
    && page !== "chrome" && page !== "reader"
    && !(page === "detail" && selected) && !(page === "list" && listSel)
    && openPanel === "none";
  /** 节点 id → 显示名（用配置层已有的中文名，不在 UI 里重写一份） */
  const labelOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const sec of detailLayoutSections(layout)) for (const it of sec.items) m.set(it.id, it.label);
    return m;
  }, [layout]);

  /** 当前页在画廊清单里的名字 —— 编辑屏的标题用它（"详情页" / "列表页"） */
  const pageLabel = (GALLERY_PAGES.find((p) => p.key === page) || GALLERY_PAGES[0]).label;

  /**
   * 返回键分层 —— **只注册一个**处理函数（设计文档 §3.4）。
   *
   * `core/bus` 的 `on()` 用的是 `window.addEventListener`：**派发顺序 = 注册顺序**。
   * 如果用两个 `useBackHandler`（一个管"回画廊"、一个管"关编辑器"），谁先谁后就是
   * 一个隐式约定，会被后续改动悄悄破坏（而症状是"返回键偶尔直接退出编辑器"）。
   * 这里把分层写成一条判断，顺序问题从根上不存在。
   */
  useBackHandler(() => {
    if (screen === "editor") { setScreen("gallery"); return; } // 消费：退回画廊
    onClose(); return;                                         // 消费：关闭编辑器
  }, [screen, onClose]);

  /** 从画廊进编辑屏：清掉上一页留下的选中与折叠段 */
  function openPage(p: CanvasPage) {
    setPage(p);
    setSelected(null);
    setListSel(false);
    setUnitSel(null);
    setOpenPanel("none");
    setScreen("editor");
  }

  const shellProps = {
    className: "cache-overlay ed-page",
    "data-entering": entering ? "" : undefined,
    "data-closed": closing ? "" : undefined
  };

  /**
   * 顶栏（两屏共用一条）——
   * 画廊屏：返回 = 关编辑器，标题 = 自定义 UI；**不出现模式/复位**（那两件是"编辑屏"的事）。
   * 编辑屏：返回 = 回画廊（**不是**关编辑器），标题 = 当前页名。
   * 返回键分层见上面 useBackHandler 的注释（单一处理函数，不依赖注册顺序）。
   */
  const topBar = (
    <div className="ed-top">
      <button
        type="button"
        className="ed-back"
        onClick={() => { if (screen === "editor") setScreen("gallery"); else onClose(); }}
        aria-label={screen === "editor" ? "返回页面列表" : "返回"}
      >‹ 返回</button>
      <h2>{screen === "editor" ? pageLabel : "自定义 UI"}</h2>
      {screen === "editor" && (
        <>
          <div className="seg-choice ed-modeswitch" role="group" aria-label="编辑模式">
            {(["edit", "preview"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={mode === m ? "on" : ""}
                aria-pressed={mode === m}
                title={m === "edit" ? "显示描边与手柄，可拖动排序" : "隐藏所有编辑痕迹，看最终效果"}
                onClick={() => setMode(m)}
              >{m === "edit" ? "编辑" : "预览"}</button>
            ))}
          </div>
          {/*
            「⋯」（v3.2）——「页面设置 / 恢复默认」两件事的家。
            在此之前：前一件是检查器里**一条常驻折叠段**（平时只占高度、不干活，
            正是"挤"的来源之一），后一件是顶栏一个 `↺`（又跟模式切换挤在同一条上）。
            收进菜单后，顶栏只剩"模式 + 更多"，检查器只剩"当前选中块的配置"。
            ⚠️ v3.4（Wave I）：第三项「排布总表」已按用户第 3 条删除，
            所以 aria-label 里也**不能再提它** —— 读屏用户听到一个不存在的入口，
            和界面上放一个点了没反应的按钮是同一种毛病。
          */}
          <button
            type="button"
            className={"ed-more" + (menu ? " on" : "")}
            aria-expanded={menu}
            aria-haspopup="menu"
            aria-label="更多：页面设置 / 恢复默认"
            title="更多设置"
            onClick={() => setMenu(!menu)}
          ><MoreIcon size={18} /></button>
        </>
      )}
    </div>
  );

  // ── 画廊屏：可自定义页面的卡片（用户要的"像查看近期应用那样"）──
  // 进入编辑器默认停在这里；点卡片才进编辑屏（所以返回键也分两层）。
  if (screen === "gallery") {
    return (
      <div {...shellProps} data-screen="gallery">
        {topBar}
        <CustomUiGallery layout={layout} style={style} chrome={chrome} readerStyle={rdStyle} onPick={openPage} />
      </div>
    );
  }

  // ── 编辑屏 ──
  return (
    <div {...shellProps} data-screen="editor">
      {topBar}

      {/* ── 画布 + 检查器：宽屏左右分栏（m3e 的解剖），窄屏上下 ── */}
      <div className="ed-body">
        {/* 画布：真实组件，不是示意图 */}
        <div className="ed-stage" onClick={() => setSelected(null)}>
          <div
            ref={canvasRef}
            className={"ed-canvas" + (editing ? " ed-editing" : "")}
          >
            {page === "detail" ? (
              <AlbumDetail
                {...CANVAS_DETAIL_PROPS}
                editMode={editing}
                selectedBlock={selected}
                onSelectBlock={setSelected}
                // 受控：画布跟着本页的**内存态**走，拖动中不回读 localStorage（v3 的"不卡"）
                layoutOverride={layout}
                styleOverride={style}
                onMoveBlockTo={(id, to) => {
                  // 用 layoutRef 而不是渲染作用域里的 layout：pointermove 的闭包可能滞后一帧。
                  // 走 moveVisibleNodeTo：画布上的下标来自 DOM（**过滤了隐藏项**），与
                  // moveDetailNodeTo 的"原始数组下标"不是一个空间（Slot-2 修的病根）。
                  // v3 起它对**五张表**一视同仁 —— 顶层块与内嵌槽位（标题 / 四宫格 / 字段）
                  // 都从这条路过，口径只有一份。
                  const next = moveVisibleNodeTo(layoutRef.current, id, to);
                  if (next === layoutRef.current) return;
                  dragDirtyRef.current = true; // 真的动过，松手时值得落盘
                  previewLayout(next);
                }}
                onMoveBlockEnd={commitLayout}
                /**
                 * 行内落位（v3.5.1）：独占一行的块横向拖动 = 拖进自己那一行的空位。
                 * 与换序共用预览/提交两条通道：每帧 `setDetailBlockOffset` 只改内存
                 * （`previewLayout`，同值同引用零重渲染），落盘随 `commitLayout` 一次。
                 * 走配置模型而不是旁路，保证"编辑器里配的"与"检查器里显示的"是同一个值。
                 */
                onMoveBlockCol={(nid, col) => {
                  if (typeof nid !== "string") return;
                  const next = setDetailBlockOffset(layoutRef.current, nid as DetailBlockId, col);
                  if (next === layoutRef.current) return;
                  dragDirtyRef.current = true; // 真的动过：松手落盘（与换序同一条提交路）
                  previewLayout(next);
                }}
                /**
                 * 拖动**真正开始**那一帧：收起已经唤起的配置栏（用户第 2 条
                 * 「拖动时已唤起的模块的配置不会自动缩起来，界面也乱跑」）。
                 *
                 * 为什么必须连 `openPanel` 一起收：那是**独立一屏**的覆盖层
                 * （「⋯ → 页面设置」），不收就压着画布拖动。
                 *
                 * ⚠️ 收起会改变 `.ed-body` 的几何（窄屏是检查器高度、宽屏是 340px 右栏），
                 * 而拖拽栈的快照是"起拖时测一次"。这一层由 `useCanvasDrag.updateDrop()`
                 * 兜住：它每帧比对 offsetParent 原点与容器尺寸，**一发现变化就重建快照
                 * 并把判定原点搬到当前镜像中心** —— 所以收起动作不会让落点平白跳一格。
                 * e2e `editor-shell` 里有一条专门钉这件事（画布盒子与 scrollTop 不许变）。
                 */
                onDragStart={collapseForDrag}
              />
            ) : page === "list" ? (
              /**
               * 列表页的"可配区块"就是**卡片**（v3.3）。
               *
               * 「排布总表」删除后，列表页的配置（每行列数 / 副标题字段顺序与显隐）必须
               * 仍能"点画布上的区块进入配置"——这是本波最硬的约束（不许有配置项没有入口）。
               * 所以这里包一层可点选的外框，点它 → 检查器出现 ListCardInspector。
               *
               * 只影响编辑器画布：线上路径根本不经过 CustomUiPage（列表页自己渲染 AlbumGrid），
               * 所以这一层不会出现在生产 DOM 里。
               */
              <div
                className={"ed-listblk" + (listSel && editing ? " ed-sel" : "")}
                data-blk="list-card"
                role="button"
                tabIndex={0}
                aria-pressed={listSel}
                aria-label="选中区块：卡片"
                onClick={(e) => { e.stopPropagation(); setListSel(true); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    setListSel(true);
                  }
                }}
              >
                <AlbumGrid {...CANVAS_LIST_PROPS} />
              </div>
            ) : page === "chrome" ? (
              /**
               * 「顶栏和底栏」（v3.13）：画布是一个**缩小版 App** —— 真的顶栏 + 一屏样例内容 + 真的底栏。
               * 点画布上的按钮 → 面板里对应那一行高亮（`unitSel`），于是"画布上这个是哪个"不用猜。
               * ⚠️ 画布里的回调**不触发任何真实动作**：真弹抽屉 / 真跳页会把编辑器盖住或整页换掉。
               */
              <BarsPreview
                cfg={chrome}
                editMode={editing}
                onPick={(section: ChromeSection, id: string) => setUnitSel(section + ":" + id)}
              />
            ) : (
              /**
               * 「阅读器」：控制条是线上那套（上排 / 进度条 / 状态栏 / 工具行），
               * 底下垫一块**可滚动的样例页** —— 滚动条档位就是这么"看得见"的（见 index.css）。
               */
              <ReaderChromePreview
                cfg={chrome}
                editMode={editing}
                scrollbar={rdStyle.scrollbar}
                onPick={(section: ChromeSection, id: string) => setUnitSel(section + ":" + id)}
              />
            )}
          </div>
        </div>

        {/*
          检查器（v3.3）：**点到哪个块就弹那个块的配置**。
          · 「排布总表」已删除（用户第 3 条）→ 内层顺序/显隐搬进对应区块的配置里（NodeOrderList）；
          · 「页面设置」不再挤在这里，而是独立成一屏（见下面的 .ed-sheetpage，用户第 8 条）；
          · 列表页点卡片 → ListCardInspector（配置项必须有入口，这是硬不变量）。
          预览态整个检查器都不渲染（一个编辑痕迹都不留）。
        */}
        {editing && (
          <div className={"ed-inspector" + (slim ? " slim" : "")}>
            {slim ? (
              <div className="ed-slim">
                <span className="dl-hint">
                  {page === "detail" ? "点画布里的区块选中它，就能调那一块" : "点画布里的卡片，就能调卡片的样式"}
                </span>
                {/* 与顶栏「⋯」同一入口：收起态下也要有个看得见的去处（不然"页面设置藏哪了"要靠猜） */}
                <button type="button" className="ed-chip" onClick={() => setMenu(true)}>更多</button>
              </div>
            ) : page === "list" && listSel ? (
              <ListCardInspector onClose={() => setListSel(false)} />
            ) : page === "chrome" || page === "reader" ? (
              <ChromeInspector
                page={page === "reader" ? "reader" : "chrome"}
                cfg={chrome}
                apply={applyChrome}
                style={rdStyle}
                onStyle={applyRdStyle}
                selected={unitSel}
              />
            ) : selected ? (
              <>
                <ModuleInspector
                  blockId={selected}
                  label={labelOf.get(selected) || selected}
                  index={selectedList.indexOf(selected)}
                  total={selectedList.length}
                  hidden={isHidden(layout, selected)}
                  canHide={DETAIL_NODE_META[selected].hideable}
                  cfg={style}
                  onStyle={applyStyle}
                  // 滑块走**防抖提交**那条路（滑动中只动内存）：拖滑块不该每帧写盘 + 广播
                  onStyleLive={previewStyle}
                  // 松手立刻收尾（不让用户为"拖完还得等 300ms"买单）
                  onStyleFlush={commitStyle}
                  onToggleHidden={() => applyLayout(setDetailNodeHidden(layout, selected, !isHidden(layout, selected)))}
                  // v3 宽度档位：**只有顶层块有**（内嵌槽位不参与 12 列网格 → 不传，那一行不渲染）
                  span={selectedIsTop ? blockSpan(layout, selected as DetailBlockId) : undefined}
                  onSpan={selectedIsTop
                    ? (s) => applyLayout(setDetailBlockSpan(layout, selected as DetailBlockId, s))
                    : undefined}
                  // v3.4 行内位置：同样只有顶层块有（模型层也保证满宽块 offset 恒为 0）
                  offset={selectedIsTop ? blockOffset(layout, selected as DetailBlockId) : undefined}
                  onOffset={selectedIsTop
                    ? (n) => applyLayout(setDetailBlockOffset(layout, selected as DetailBlockId, n))
                    : undefined}
                  // v3.5 形态：**注册表驱动**（core/detailLayout.DETAIL_BLOCK_FORMS）——
                  // 没有形态可选的块传 undefined，那一行整行不渲染（只有一个形态 = 哑控件）。
                  // v3.8：传 `formsFor`（按当前宽度档过滤）—— 面板上看得见的 == 读出来生效的，
                  // 不会出现"面板不给选、读出来却是它"（轴冲突①，见 core/detailLayout 的说明）。
                  forms={selectedIsTop ? formsFor(layout, selected as DetailBlockId) : undefined}
                  form={selectedIsTop ? blockForm(layout, selected as DetailBlockId) : undefined}
                  onForm={selectedIsTop
                    ? (f) => applyLayout(setDetailBlockForm(layout, selected as DetailBlockId, f))
                    : undefined}
                  onClose={() => setSelected(null)}
                />

                {/*
                  v3.5（用户第 3 条）：**主视觉是一个大模块**。
                  「封面信息栏和四宫格等等也是在主视觉的配置里设置，**而不是也都做成
                   可点击的模块**」—— 所以画布上只有顶层块能被选中，内层的三层
                  （封面/信息栏 → 标题/四宫格/数据条 → 四宫格四个字段）**全部**挂在
                  「主视觉」的配置栏里。

                  ⚠️ 这不是"顺手挪个位置"，而是**硬不变量**：内层不再可点选之后，
                  "只有点中 info / title / facts 才会出现"的那些配置会变成**永远打不开**，
                  而门禁（单测 + e2e）不会因此变红 —— 典型的"命令绿、结果错"。
                  所以三层必须都从这里可达，并由一条端到端断言钉住
                  （只点 hero 就能改到"四宫格字段顺序"）。

                  `note` 不需要传：默认已经不显示任何提示（v3.5 起"也可以在画布上直接
                  长按拖动"对所有调用方都是假的，见 ui/NodeOrderList 的说明）。
                */}
                {selected === "hero" && (
                  <>
                    <NodeOrderList
                      title="左右栏（封面 / 信息栏）"
                      ids={layout.heroSlots}
                      cfg={layout}
                      apply={applyLayout}
                      onClose={() => setSelected(null)}
                    />
                    <NodeOrderList
                      title="信息栏内的顺序"
                      ids={layout.heroInfoSlots}
                      cfg={layout}
                      apply={applyLayout}
                      onClose={() => setSelected(null)}
                    />
                    <NodeOrderList
                      title="四宫格字段"
                      ids={layout.facts}
                      cfg={layout}
                      apply={applyLayout}
                      onClose={() => setSelected(null)}
                    />
                  </>
                )}

                {/*
                  v3.5（用户第 4 条）：`detail` 内部三个面板（目录 / 评论 / 相关漫画）
                  **终于能各自隐藏**了，顺序也能调。

                  放在配置栏里、而不是让它们变成画布上可点选的模块 —— 这是用户明确的方向
                  （"内层一律在配置里设置，而不是也都做成可点击的模块"）。

                  `minVisible=1`：不许三个全关（全关 = 区块变空盒）。点到最后一个时
                  **给一行说明**（`refuseHint`），不是静默吞掉 —— "要解释，不要哑掉"。
                  注意 `note={null}`：这组节点画布上不可选，所以不能沿用那句
                  "也可以在画布上直接长按拖动"（那是骗人）。
                */}
                {selected === "detail" && (
                  <NodeOrderList
                    title="目录 / 评论 / 相关漫画"
                    ids={layout.panels}
                    cfg={layout}
                    apply={applyLayout}
                    onClose={() => setSelected(null)}
                    note={null}
                    minVisible={MIN_VISIBLE_PANELS}
                    refuseHint="至少留一个：三个都关掉，这一块就是个空盒子。整块不要的话，用上面的「显示 / 隐藏」关掉它。"
                  />
                )}
              </>
            ) : (
              <p className="dl-hint">
                {page === "detail"
                  ? "点画布里的区块选中它，就能调那一块的样式（位置直接长按拖动）。"
                  : "点画布里的卡片，就能调卡片的样式。"}
              </p>
            )}
          </div>
        )}
      </div>

      {/*
        页面设置（v3.3，用户第 8 条）：**独立一屏**，不再挤在检查器里把画布顶上去。
        用覆盖层而不是换 screen：换 screen 会让画布卸载 → 滚动位置与选中态丢失
        （用户明确要求"从进入页面设置到返回，画布滚动位置与选中状态不丢"）。
        z-index 45 > 「⋯」菜单的 40 > 跟手镜像的 30。
      */}
      {openPanel === "style" && (
        <div className="ed-sheetpage" data-panel="style">
          <div className="ed-sheetbar">
            <b>页面设置</b>
            <em className="dl-from">疏密 · 圆角</em>
            <button
              type="button"
              className="ed-paneldone"
              onClick={() => setOpenPanel("none")}
            >完成</button>
          </div>
          <div className="ed-sheetbody">
            <PageStyleSheet cfg={style} onStyle={applyStyle} />
          </div>
        </div>
      )}

      {/*
        「⋯」菜单（v3.2）：浮在编辑器之上的底部小 sheet。
        z-index 40 > 跟手镜像 .ed-ghost 的 30 —— 菜单开着时不该被拖起来的块盖住。
        透明遮罩只吃点击（点空白关闭），不改观感。
        ARIA：不给容器加 role="menu"（会触发 jsx-a11y(prefer-tag-over-role)，项目基线
        warning 不能涨），无障碍信息放在每个按钮自己的文案与 aria-label 上。
      */}
      {menu && (
        <>
          {/*
            遮罩用 <button> 而不是 <div onClick>：项目 oxlint 的 a11y 规则会为
            "可见的非交互元素挂了 click" + "div 没有 role" 各记一条 warning
            （基线 71 条不能涨）。按钮天生可聚焦、可 Enter 触发，语义也对。
          */}
          <button type="button" className="ed-scrim" aria-label="关闭菜单" onClick={() => setMenu(false)} />
          <div className="ed-menu">
            {/* ⚠️ v3.13：「页面设置」是**详情页**的样式表（疏密 / 圆角，作用域只有 .detail-card）。
                在「顶栏和底栏」/「阅读器」两页上放它是**骗人的入口** —— 点了改的是另一个页面的东西。
                所以这两页不出现它（阅读器自己的观感就在它的面板里，不需要另开一屏）。 */}
            {page !== "chrome" && page !== "reader" && (
              <button
                type="button" className="ed-menuitem"
                onClick={() => { setOpenPanel("style"); setMenu(false); }}
              >页面设置<em>疏密 · 圆角</em></button>
            )}
            {/* v3.3：「排布总表」已按用户第 3 条删除 —— 顺序靠长按拖、显隐在区块配置里、
                内层字段在「信息栏」的配置里。这里不再有它的入口。 */}
            <button
              type="button" className="ed-menuitem danger"
              onClick={() => { resetAll(); setMenu(false); }}
            >恢复全部默认<em>四个页面 + 观感</em></button>
          </div>
        </>
      )}
    </div>
  );
}
