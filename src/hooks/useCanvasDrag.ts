import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { dragStep, groupRows, initialState } from "../core/dropIndex";
import type { DragSnapshot, DragState, DropBox } from "../core/dropIndex";
import { GRID_COLS, rowOffsetFromCentre } from "../core/detailLayout";

/**
 * 可拖项的选择器（v3 内嵌可拖）：**顶层块 `.ed-blk`** 与**内嵌槽位 `.ed-slot`**。
 *
 * ── 为什么内嵌槽位用另一个类名，而不是复用 `.ed-blk` ──────────────────────
 * 整个 e2e 套件里有近 20 处 `.ed-canvas .ed-blk` 的计数/顺序断言（`driver.js` 直接
 * 断言"顶层块数 === 8"）。若让内嵌槽位共用 `.ed-blk`，这些断言会一起变成
 * "8 → 17"的红灯，必须逐个改写成"列表作用域"才不假红。
 * 而"数 `.ed-blk` = 数**顶层块**"本身是个好语义 —— 值得保住。
 * 于是：顶层 `.ed-blk`、内嵌 `.ed-slot`，**共享同一套手势 / 落点 / 描边 / 镜像逻辑**。
 */
export const ITEM_SEL = ".ed-blk, .ed-slot";

/**
 * 「自定义 UI」画布块的**拖拽手势**（v2：长按抓整块 + 实时换位）。
 *
 * 与 useDragReorder 的分工：
 *   · `useDragReorder` —— 面板**列表行**的排序（只有 ⠿ 手柄起拖），排布总表还在用它；
 *   · 本文件 —— 画布**块**的拖拽，两种起拖方式：
 *       ① ⠿ 手柄：按下立即拖（精确路径，永远可用）；
 *       ② 整块：**长按 280ms**（触摸）/ **位移 > 4px**（鼠标）才起拖。
 *
 * 为什么触摸要长按、而不是按下就拖 —— 滚动冲突：
 *   画布是可滚动区（.ed-stage）。触摸"按下就拖"会和"上下滚画布"打架，
 *   这正是 v1 只给 ⠿ 手柄的原因（useDragReorder 头注释里记着这笔账）。
 *   长按给出了一条互不侵犯的分界线：**没长按就动 = 滚动**（取消计时，不碰手势），
 *   **按住不动 280ms 再动 = 拖拽**。起拖前不 preventDefault、不抢 touch-action。
 *
 * ── v3：触摸怎么把滚动手势抢过来（真机"拖不动"的病根）────────────────
 *   旧版只靠 Pointer 事件：`.ed-blk` 没有 `touch-action`，手势一开始浏览器就按
 *   默认值把**竖向平移判给滚动**；280ms 到点、手指一动，`.ed-stage` 跟着滚，
 *   同时 `pointercancel` 一发 —— 拖拽当场暴毙。合成事件测不出这个
 *   （它不经过浏览器的原生手势仲裁），所以旧版 e2e 全绿也是假安全。
 *
 *   解法的物理基础：**长按期间手指没动过 → 浏览器还没开始滚动**。于是我们在块上
 *   挂一个**非被动**的原生 `touchmove`（React 的 onTouchMove 是按 passive 注册的，
 *   里面 preventDefault 无效）：**一旦已经抓起（activeRef），每个 touchmove 都
 *   preventDefault** —— 滚动就没机会开始。没抓起时一个都不挡，滚动照常
 *   （用户要的"该滚滚、该拖拖"）。`touchcancel` 则把待命的长按计时清掉
 *   （浏览器判定了要滚，别跟它抢）。
 *
 *   ⠿ 手柄（静态 `touch-action: none`）**永远保留**，作为手势被系统抢走时的退路 ——
 *   与 ▲▼ 按钮是拖拽失灵的退路同一条设计原则。真机验收项 `longpress-drag` 覆盖它。
 *
 * ── 落盘时机：拖动中只动内存，松手才提交 ──────────────────────────────
 * `onMoveTo` 在拖动中是**每帧**触发的，所以它必须只是"改内存里的顺序"；
 * 真正要写 localStorage / 广播的操作放在 `onDragEnd` 里，**一次拖拽只跑一次**。
 * 早期版本在每帧的 onMoveTo 里就落盘 + 广播，结果是每次指针事件都要同步写盘、
 * 三个订阅方各重读一次 localStorage 并整页重渲染 —— 中端安卓上就是用户说的"卡"。
 *
 * 其余四条纪律与 useDragReorder 相同：实时换位只回调"最终下标"、越界夹住、
 * ref 存手势态（不走 state，pointermove 是高频事件）、pointercancel 必须复位。
 */

const LONG_PRESS_MS = 280;
/** 鼠标不需要长按：位移超过它就算拖（点击与拖拽靠位移区分，m3e 桌面端同款） */
const MOUSE_PX = 4;
/** 长按计时中移动超过它 = 用户想滚动，取消长按（别劫持手势） */
const CANCEL_PX = 12;
/** 跟手缓动系数：每帧把镜像往指针方向逼近的比例（m3e："a little lag reads as weight"） */
const FOLLOW_EASE = 0.35;
/** 抓起镜像的放大倍数：轻微抬起，不夸张（1 = 不放大） */
const GHOST_LIFT = 1.03;

/**
 * 全画布同一时刻只允许**一次**拖拽（审计 S-1 的加固）。
 *
 * 为什么需要模块级的锁、而不只是实例内的 `activeRef`：本 hook 是**每块一个实例**的
 * （`EdBlock` 里直接调用）。单靠实例内的守卫挡得住"同一块被两根手指按"，却挡不住
 * "两根手指按住**两个不同的块**" —— 那会同时抬起两个镜像、两路 `onMoveTo` 去抢
 * 同一张列表的顺序，界面变成互相打架。
 */
let globalDragOwner: string | null = null;
/** 驱动本次拖拽的指针 id（模块级：窗口级兜底要按它判断"那根手指是不是已经离开屏幕了"） */
let ownerPointerId: number | null = null;
/** 当前占用者的"彻底收尾"入口（实例自己的收尾若被漏掉，模块级兜底能把它拉回来） */
let ownerTeardown: ((release?: { x: number; y: number }) => void) | null = null;
/** 屏幕上活着的手指（模块级，只挂一次）—— 用来识别"驱动拖拽的那根手指已经不在了" */
const livePointers = new Set<number>();
let liveWatchBound = false;

/**
 * 窗口级兜底（v3.1 修复用户实测的"拖拽卡死"）。
 *
 * ── 病根：换位会移动 DOM 节点，而节点一移动，指针捕获就没了 ─────────────
 * 拖动中 React 用 `insertBefore` 移动 `.ed-blk` 节点完成换位；节点被移动的瞬间，
 * 指针捕获（触摸是浏览器**隐式**给的捕获）会被释放。此后 `pointermove` /
 * `pointerup` 不再派发给"被拖的那个块"，而是派给"此刻手指底下那个元素"。
 * 于是用户看到的三连全都成立：
 *   ① 镜像不再跟手（事件没到原块）→「组件悬着动不了」
 *   ② 坑（虚线框）没人清 →「黑框还在原地」
 *   ③ 那次拖拽的 `globalDragOwner` 永不释放 → 之后所有拖拽被守卫挡掉
 *      →「拖拽失效了」
 * 这也解释了为什么它只在**小幅晃动**时出现：晃动会越过相邻块中线触发换位，
 * 而原先的 e2e 用例是"长按后移动 160px"、`orderKept: true`，**压根没触发换位**。
 *
 * ── 对策 ──────────────────────────────────────────────────────────
 * 别再依赖"事件会回到那个块"：跟手走 **window 级** `pointermove`（见 attachDragListeners），
 * 收尾在 window 上兜一层 —— **驱动指针一消失就强制收尾**（本函数）。两者都不关心
 * DOM 节点有没有被移动过。
 */
function bindLivePointerWatch() {
  if (liveWatchBound || typeof window === "undefined") return;
  liveWatchBound = true;
  window.addEventListener("pointerdown", (e: PointerEvent) => {
    livePointers.add(e.pointerId);
  }, true);
  const release = (e: PointerEvent) => {
    livePointers.delete(e.pointerId);
    // 拖拽的驱动指针松手/被取消：无论事件有没有回到原块，都必须收尾。
    // ⚠️ 这条是 window **capture** 阶段，**先于**元素上的 React 处理器执行 ——
    // 所以"松手点"必须**从这里**带给收尾函数：否则 `finishDrag` 拿到的是空松手点，
    // "松手时按松手点补算行内列"那一步就永远不生效（实测踩过：补算一次都没跑）。
    if (globalDragOwner !== null && ownerPointerId === e.pointerId && ownerTeardown) {
      ownerTeardown({ x: e.clientX, y: e.clientY });
    }
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
}

/**
 * 取指针坐标：兼容 PointerEvent / TouchEvent / 字段缺失。
 * 取不到就返回 `null` —— 调用方必须忽略该帧，**绝不能把 NaN 写进 transform**
 * （NaN 会让镜像彻底不可见且再也回不来，表现与"卡死"无从区分）。
 */
function coordsOf(e: { clientX?: unknown; clientY?: unknown; touches?: TouchList | null }): { x: number; y: number } | null {
  const x = e.clientX;
  const y = e.clientY;
  if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  const list = e.touches;
  const t = list && list.length > 0 ? list[0] : null;
  if (t && Number.isFinite(t.clientX) && Number.isFinite(t.clientY)) return { x: t.clientX, y: t.clientY };
  return null;
}

/**
 * 列表里当前的可拖项（顺序 = 可见顺序）：顶层块 `.ed-blk` + 内嵌槽位 `.ed-slot`。
 *
 * ⚠️ 必须只数**列表项**：跟手镜像也挂在同一个列表里，不过滤的话它会当成一项
 * 参与落点判定，结果会整体歪一格。`list.children`（而非 querySelectorAll）保证
 * 只取**直接子级** —— 内嵌槽位在更深的层级，天然不参与外层列表的落点判定。
 */
function listBlocks(list: HTMLElement): HTMLElement[] {
  return Array.from(list.children).filter((c) => c.matches(ITEM_SEL)) as HTMLElement[];
}

/**
 * 拖动开始时的**几何快照**（v3.5）。
 *
 * ── 为什么要有它（用户第 1 条：「太灵敏了，稍微动一下就变化许多」）──────────
 * 旧实现 `dropIndexAtList()` **每次判定都重新测量**所有块的 `offset*`。于是：
 *   判定 → 换位 → DOM 重排 → 下一帧测到**新几何** → 又有邻居"碰到" → 再换一次 → 连锁。
 * 成熟库全部避开这条（rbd 只用起拖时测的几何；dnd-kit 默认 `WhileDragging` 只测一次；
 * Android 用起拖点 + 方向符号）。所以这里也改成**起拖时测一次**，拖动期间只用它。
 *
 * ⚠️ 唯一允许重建的时机：**容器几何真的变了**（配置栏收起/展开改了画布宽度、画布滚动、
 * 窗口尺寸变化）。重建时把判定原点搬到**当前镜像中心**（不跳变），落点保持不变。
 * 这也是 Android / dnd-kit 的做法 —— 不重建会在滚动后拿过期几何判定。
 */
interface DragGeom {
  /** 每个块的布局矩形（列表局部坐标，顺序 = DOM 顺序） */
  boxes: readonly DropBox[];
  /** 被拖块在 `boxes` 里的下标（-1 = 找不到） */
  from: number;
  /** offsetParent 的视口原点：把客户端矩形换算进 `boxes` 的坐标系 */
  refLeft: number;
  refTop: number;
  /**
   * **画布**（`.ed-canvas`）的宽度 —— 重建快照的第三个信号。
   *
   * ⚠️ 这里刻意**不**用被拖列表自己的尺寸：换位会让列表高度变化（块高低不同），
   * 那是**拖动自己造成的**、**必须被忽略**的信号（忽略它正是"不连锁"的全部意义）。
   * 用它当触发条件会造成"每换一格 → 重建快照 → 死区重新计 → 再换一格"的**棘轮**，
   * 实测把块一路棘到列表顶端（e2e `slot-layout` 用例⑦ 撞到）。
   * 画布宽度只会被**外层布局**改动（宽屏下配置栏收起 = 340px 右栏消失），正是我们想捕获的那种变化。
   */
  canvasW: number;
  /**
   * 每块的 `data-span`（v3.5.1 行内落位用）：**顶层块才写**这个属性（满宽块不写）。
   * 与 `boxes` 同下标；没有属性的块记 12（满宽）。内嵌槽位（`.ed-slot`）不参与
   * 12 列网格，恒按 12 处理 —— 行内落位只对顶层块有意义。
   */
  spans: readonly number[];
  /**
   * **行的左缘**（与 `boxes` 同一坐标系）＝ 被拖列表自身在该坐标系里的左边缘。
   *
   * 行内落位的基准必须是"行从哪儿开始"，**不能**用被拖块自己的左缘 —— 后者会让
   * "已经居中的块一抓就掉回最左"（v3.5.2 修，实测）。
   */
  rowLeft: number;
  /**
   * **真实列距**（px）＝ `(内容宽 − 11×column-gap) / 12 + column-gap`。
   *
   * 旧实现用 `canvasW / 12`：那是"画布宽 ÷ 12"，既含了画布内边距、又没算 grid 的
   * `column-gap`，实测偏 ~2.7%（6 列累计约 5px）。`column-gap` 在建快照时读一次
   * `getComputedStyle`（**不是每帧**），代价可忽略、精度直接对齐真实网格。
   */
  pitch: number;
}

/**
 * 测一次几何，建快照。
 *
 * ⚠️ 用 `offset*` 而**不是** `getBoundingClientRect()`：后者**含 transform**，
 * 而拖动中每次换位都会给兄弟块挂 150ms 的 FLIP 让位动画 —— 用 rect 会读到"正在滑动中的位置"，
 * 横向/纵向中线跟着漂，指针停在两块交界附近时落点会反复翻面（审计 M-1）。
 * `offset*` 是布局值，不受动画影响，而且比每帧 `getComputedStyle` 读矩阵便宜得多。
 * `refRect` 是 offsetParent 的客户端原点，**只在建快照/重建时**读一次。
 */
function snapshotOf(list: HTMLElement, id: string): DragGeom | null {
  const items = listBlocks(list);
  if (items.length === 0) return null;
  const ref = (items[0].offsetParent as HTMLElement | null) || document.body;
  const refRect = ref.getBoundingClientRect();
  const deltas = new Map<HTMLElement, { dx: number; dy: number }>();
  const boxes: DropBox[] = items.map((el) => {
    const op = (el.offsetParent as HTMLElement | null) || ref;
    let d = deltas.get(op);
    if (!d) {
      const r = op.getBoundingClientRect();
      d = { dx: r.left - refRect.left, dy: r.top - refRect.top };
      deltas.set(op, d);
    }
    return { left: el.offsetLeft + d.dx, top: el.offsetTop + d.dy, width: el.offsetWidth, height: el.offsetHeight };
  });
  const from = items.findIndex((el) => el.getAttribute("data-blk") === id);
  const canvas = list.closest(".ed-canvas") as HTMLElement | null;
  /**
   * 行左缘 + 真实列距（v3.5.2）：行内落位的两个基准量，**每次建快照只算一次**。
   *   · 行左缘：列表自身的左边缘在 `boxes` 坐标系里的位置（换算方式与 `boxes` 相同）；
   *   · 列距：12 列 + 11 个 `column-gap`，直接从计算样式读 gap（不猜）。
   * 读不到（jsdom / 未排布）时 pitch 记 0 —— 行内落位会自己回顶格，不产生假列。
   */
  const listRect = list.getBoundingClientRect();
  const contentW = list.clientWidth || listRect.width;
  let gap = 0;
  try {
    const g = window.getComputedStyle(list).columnGap || window.getComputedStyle(list).gap || "";
    const n = parseFloat(g);
    if (Number.isFinite(n) && n >= 0) gap = n;
  } catch { /* jsdom / 老内核读不到就按 0：pitch 退化成 contentW/12 */ }
  const pitch = contentW > 0 ? (contentW - (GRID_COLS - 1) * gap) / GRID_COLS + gap : 0;
  return {
    boxes,
    from,
    refLeft: refRect.left,
    refTop: refRect.top,
    canvasW: canvas ? canvas.offsetWidth : list.offsetWidth,
    rowLeft: listRect.left - refRect.left,
    pitch,
    spans: items.map((el) => {
      const v = el.getAttribute("data-span");
      const n = v === null ? NaN : Number(v);
      return Number.isFinite(n) && n > 0 ? n : 12;
    })
  };
}

type Handlers = {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
};

export interface CanvasDragApi {
  /** 正在拖（调用方据此加视觉态：拖动态描边 + 插入缝） */
  dragging: boolean;
  /**
   * 绑到**可拖元素本体**：顶层块是 `<div className="ed-blk">`，内嵌槽位是既有元素
   * （`<h2 className="d-title ed-slot">` / `<span className="d-cover-box ed-slot">` …）。
   * 跟手镜像是这个元素的克隆，所以 hook 必须拿得到它 —— 手柄路径下事件源是 ⠿ 而不是本体。
   *
   * ⚠️ 是**回调 ref** 而不是 `RefObject<HTMLDivElement>`：内嵌槽位要绑在
   * `<h2>` / `<span>` / `<p>` 上，而 `RefObject<HTMLDivElement>` 在类型上绑不上去
   * （React 的 ref 类型是元素具体类型，而槽位元素类型各不相同）。
   */
  blockRef: (el: HTMLElement | null) => void;
  /** 绑到 ⠿ 手柄：按下立即拖 */
  gripProps: Handlers;
  /** 绑到整块：长按（触摸）/ 位移阈值（鼠标）起拖 */
  blockProps: Handlers;
}

export function useCanvasDrag(
  onMoveTo: (id: string, index: number) => void,
  id: string,
  /**
   * 一次拖拽**收尾**（松手或手势被取消，且本次确实拖过）。
   * 调用方在这里做"落盘 + 广播"——每帧的 onMoveTo 只管内存态。
   */
  onDragEnd?: () => void,
  /**
   * 拖动**真正开始**的那一帧（长按确认 / 鼠标越过阈值之后），一次拖动只回调一次。
   *
   * 上层用它收起已经唤起的配置栏（用户第 2 条：「拖动时已唤起的模块的配置不会自动缩起来，
   * 界面也乱跑」）。⚠️ 上层若因此改了画布尺寸，`updateDrop` 会在下一帧检测到几何变化、
   * **重建快照并把原点搬到当前镜像中心** —— 落点不会平白跳一格。
   */
  onDragStart?: () => void,
  /**
   * **行内落位**（v3.5.1，用户第 2 条反馈）：把块拖进**它自己那一行**的某个空位。
   *
   * 只在"被拖块**独占一行**且不满宽（`data-span < 12`）"时触发；`col` 是 12 列制
   * 的行内起始列（`0 ~ 12−span`）。纯顺序拖动（纵向换行 / 并排行换序）不会回调它，
   * 两种落位语义互不抢手指。上层接 `setDetailBlockOffset`（走预览通道，松手一次提交）。
   */
  onMoveColTo?: (id: string, col: number) => void
): CanvasDragApi {
  const [dragging, setDragging] = useState(false);
  const activeRef = useRef(false);
  const listRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef({ x: 0, y: 0 });
  /**
   * 嵌套守卫（v3 内嵌可拖）：本元素要不要**整场忽略**这一次手势。
   * 判定与理由见 `blockProps.onPointerDown`（必须连同 move/up/cancel 一起守，见那里的说明）。
   */
  const skipRef = useRef(false);

  /**
   * 本次拖拽由**哪根指针**驱动（审计 S-1）。
   * 多指时第二根手指的 pointermove 会把 `pointRef` 改写成它的坐标、把落点劫走，
   * 所以拖动中只接受这个 pointerId 的事件。
   */
  const activePointerRef = useRef<number | null>(null);

  /**
   * 回调放 ref：原生 `touchmove` / `touchcancel` 监听器**只挂一次**（`[]` 依赖），
   * 闭包会一直活着；而 `onMoveTo` / `onDragEnd` 是上层**每次渲染新建**的箭头函数
   * （AlbumDetail 的接线就是内联箭头）。直接捕获会调到**陈旧**的那一份。
   */
  const cbRef = useRef({ onMoveTo, onDragEnd, onDragStart, onMoveColTo });

  /** 本块的 id（ref 化：卸载兜底那个 effect 只挂一次，不能依赖渲染期的闭包值） */
  const idRef = useRef(id);

  /**
   * "收尾"的 ref 外壳（审计 M-3）。
   *
   * 触摸监听 effect 只挂一次，却必须能用上收尾逻辑。直接引用函数体会带来一个
   * **隐式**约束：`finishDrag` 必须声明在那个 effect **之前**（声明在后虽然靠函数提升
   * 能跑，但 React Compiler 的 immutability 规则会判 error）—— 唯一防线是 lint，
   * 将来有人挪动函数顺序、或加了 disable 注释，就会静默失守。
   * 经 ref 间接调用后声明位置自由。
   */
  const finishRef = useRef<(release?: { x: number; y: number }) => void>(() => { /* 首次渲染后立即被赋值 */ });

  /** 撤掉待命的长按计时（三条路都走它：动太多 = 滚动、手势被取消、收尾） */
  function clearTimer() {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  // ── 跟手镜像（ghost）：被抓起来的那一个 ──────────────────────────────
  /** 被拖元素本体（镜像的克隆源）。手柄路径下事件源是那根 ⠿，不能拿它克隆 */
  const blockElRef = useRef<HTMLElement | null>(null);
  /** 暴露给调用方的回调 ref（见接口注释：必须能绑到任意 HTMLElement 上） */
  const blockRef = useCallback((el: HTMLElement | null) => { blockElRef.current = el; }, []);
  /** 跟手的镜像元素。`position: fixed` + 内联 transform，完全脱离文档流 */
  const ghostRef = useRef<HTMLElement | null>(null);
  /** 镜像挂在哪个容器里：收尾兜底要按它清掉残留镜像（`listRef` 那时可能已被清空） */
  const ghostHostRef = useRef<HTMLElement | null>(null);
  const rafRef = useRef<number | null>(null);
  /** 最近一次指针位置（pointermove 是高频事件：只存 ref，绝不走 state） */
  const pointRef = useRef({ x: 0, y: 0 });
  /** 抓取点 = 指针相对块左上角的偏移。镜像全程保持它，手感才是"抓在哪就在哪" */
  const grabRef = useRef({ x: 0, y: 0 });
  /** 镜像当前显示位置（每帧朝目标缓动逼近，不刚性贴合） */
  const posRef = useRef({ x: 0, y: 0 });
  /**
   * 落点判定状态（v3.5）：**几何快照**（起拖时测一次）+ 判定状态（纯函数
   * `core/dropIndex.dragStep` 自己不存状态，由本 hook 持有并逐帧回传）。
   *
   * 每一次拖动都是一次全新的判定：`begin()` 建快照，`stopGhost()` 清掉。
   */
  const geomRef = useRef<DragGeom | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  /**
   * 行内落位（v3.5.1）：本 hook 记的"当前已应用列"。
   * 只用于挡重复回调（同列不重发）；每次拖动在 `begin()` 里重置为 null。
   * 初始列不在这里记（上层 `setDetailBlockOffset` 自带判等），所以起拖后第一次
   * 判定哪怕与配置相同也会回调一次 —— 上层判等会把它原样挡掉，无副作用。
   */
  const colRef = useRef<number | null>(null);

  // ── 窗口级拖动监听（v3.1 修复"卡死"的核心）────────────────────────────
  /**
   * 起拖后把 move / up / cancel 挂到 **window** 上，收尾时摘掉。
   *
   * 为什么必须挂 window 而不是继续靠元素级处理器：换位会**移动 DOM 节点**，
   * 节点一移动指针捕获就释放（实测 `lostcapture: 1`），此后事件投递给"手指下方
   * 当前的元素"（实测：12 个 move 只有 3 个命中被拖块，其余落在 `d-title` /
   * `d-hero-info`）。窗口级监听不受捕获丢失、节点被移动、指针移出元素影响。
   *
   * 元素级处理器从此**只负责起拖**（pointerdown + 长按计时）。
   */
  const winMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const winTouchMoveRef = useRef<((e: TouchEvent) => void) | null>(null);
  const winEndRef = useRef<((e: PointerEvent) => void) | null>(null);
  const winTouchEndRef = useRef<((e: TouchEvent) => void) | null>(null);
  const winBlurRef = useRef<(() => void) | null>(null);
  const winVisRef = useRef<(() => void) | null>(null);

  /**
   * 移动处理经 ref 暴露给"只挂一次"的监听器（与审计 M-3 的 `finishRef` 同款做法）：
   * 函数体只读 ref，挂载期闭包永不陈旧；于是声明位置自由，也不受 immutability 规则限制。
   */
  const applyRef = useRef<(c: { x: number; y: number }) => void>(() => { /* 首帧后立即赋值 */ });

  /**
   * 移除宿主列表里**所有**跟手镜像（当前 `ghostRef` 持有那个除外 —— 它有自己的删除路径）。
   *
   * 抽出来是因为两个调用点都要它：`startGhost` 起拖前**清场**（多指重入时前一个镜像
   * 会因 `ghostRef` 被覆盖而永远失去引用），`stopGhost` 收尾**兜底**（异常路径残留的孤儿）。
   * 孤儿镜像的后果是用户可见的：一个不动的半透明克隆永远留在画布上，看起来像"界面坏了"。
   */
  function removeStrayGhosts(host: HTMLElement | null) {
    if (!host) return;
    const stale = host.querySelectorAll(".ed-ghost");
    for (let i = 0; i < stale.length; i++) {
      const n = stale[i];
      if (n !== ghostRef.current && n.parentNode) n.parentNode.removeChild(n);
    }
  }

  /**
   * 克隆一块做"跟手镜像"。
   *
   * 三条清理都是必须的，每条都对应一个具体的坑：
   *   · 摘掉 `.ed-blk` / `.ed-slot` 与 `data-blk`：FLIP 快照、`dropIndexAtList` 落点判定、
   *     e2e 的顺序断言全靠它们数项 —— 镜像带着这些标记就会被当成"又多了一项"，
   *     顺序与落点全体歪掉；
   *   · 摘掉手柄 / 序号 / 插入缝：镜像是纯视觉替身，编辑痕迹不该跟着被复制；
   *   · 摘掉 id：克隆出重复 id 会污染 document.getElementById（也污染读屏与 e2e）。
   */
  function makeGhost(el: HTMLElement): HTMLElement {
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.classList.remove("ed-blk", "ed-slot", "ed-sel", "ed-drag", "ed-badge");
    ghost.classList.add("ed-ghost");
    ghost.removeAttribute("data-blk");
    ghost.removeAttribute("id");
    const junk = ghost.querySelectorAll(".ed-badge, .ed-gap");
    for (let i = 0; i < junk.length; i++) {
      const n = junk[i];
      if (n.parentNode) n.parentNode.removeChild(n);
    }
    const withId = ghost.querySelectorAll("[id]");
    for (let i = 0; i < withId.length; i++) withId[i].removeAttribute("id");
    return ghost;
  }

  /** 把镜像放到 (x,y)：只写内联 transform（合成属性，不触发布局，也不碰 FLIP 的地盘） */
  function writeGhost(x: number, y: number) {
    const g = ghostRef.current;
    if (!g) return;
    // 坐标取不到时绝不写 NaN：NaN 的 transform 会让镜像不可见且再也回不来，
    // 表现与"卡死"无从区分（所以上游 coordsOf 返回 null 时必须跳过该帧）
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    g.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px) scale(" + GHOST_LIFT + ")";
  }

  /**
   * 起拖：把镜像抬起来。
   *
   * 原块**留在文档流里**当"坑"（CSS 把它的内容藏掉、给一条品牌描边），镜像脱离
   * 文档流跟指针走。关键取舍：我们**不给原块写 transform** —— 原块的 transform
   * 归 CustomUiPage 的 FLIP 让位动画用，两者井水不犯河水（这就是它跟 v2 的
   * "块在格子里乱跳" 的区别：跳的是坑，跟手的是镜像）。
   */
  function startGhost(el: HTMLElement) {
    const host = listRef.current || el.parentElement;
    if (!host) return;
    removeStrayGhosts(host); // 清场：先前的残留镜像一律移除（多指重入 / 异常收尾的孤儿）
    ghostHostRef.current = host;
    const r = el.getBoundingClientRect();
    const ghost = makeGhost(el);
    ghost.style.width = r.width + "px";
    ghost.style.height = r.height + "px";
    host.appendChild(ghost); // 挂进列表（克隆体没有 .ed-blk，不会被当成一块）
    ghostRef.current = ghost;
    grabRef.current = { x: pointRef.current.x - r.left, y: pointRef.current.y - r.top };
    posRef.current = { x: r.left, y: r.top };
    writeGhost(r.left, r.top); // 先从原位起步，避免起拖瞬间弹一下
    if (typeof window.requestAnimationFrame === "function") {
      rafRef.current = window.requestAnimationFrame(follow);
    }
  }

  /**
   * 推进一步缓动：把镜像朝"指针 − 抓取偏移"逼近 FOLLOW_EASE 的比例。
   *
   * 用缓动而不是刚性贴合，是为了那点"重量感"（m3e 的 "a little lag reads as weight"）。
   * 差量不到半像素就不写 transform —— 指针停住时别白白制造合成帧。
   *
   * 两条驱动路径都调它：rAF 每帧一次（流畅），`pointermove` 也直接来一次
   * （rAF 在某些环境会被节流 —— 无头浏览器 / 后台标签页 —— 这时仍要跟手）。
   */
  function stepGhost() {
    if (!activeRef.current) return;
    const p = posRef.current;
    const dx = pointRef.current.x - grabRef.current.x - p.x;
    const dy = pointRef.current.y - grabRef.current.y - p.y;
    if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5) return;
    p.x += dx * FOLLOW_EASE;
    p.y += dy * FOLLOW_EASE;
    writeGhost(p.x, p.y);
  }

  /**
   * 取"被拖块矩形"（client 坐标）= **指针位置 − 抓取偏移 + 块自身尺寸**。
   *
   * ⚠️ v3.5.2 起这里**不再取缓动后的镜像位置**（`posRef`）。
   *
   * 为什么（机器级实测 + 三路调研同一结论）：
   *   · 缓动位置相对手指**恒定滞后**（本机实测 2~6px，且随事件密度 / 帧率漂移）；
   *     把它喂进死区、影子带、目标选择，等于**把滞后直接加进阈值**；
   *   · 更糟：手指停住之后镜像还在追，落点会在**停手之后**再变一格；
   *   · 业界 13 个实现（dnd-kit / Muuri / swapy / SortableJS / RGL / GridStack）、
   *     原生四家（Android / calvin / Flutter）**没有一家**把缓动位置喂给判定；
   *   · 用户的标杆 m3e 也一样：spring 只挂被拖 overlay，判定用
   *     `findSnap(item, pt.x − offX, …)`（原始指针）——
   *     **"视觉用弹簧、判定用指针"**，两者不矛盾。
   *
   * `posRef` 从此只服务 `writeGhost`（画）。尺寸仍取镜像（尺寸不参与缓动）。
   */
  function ghostRect(): DropBox | null {
    const g = ghostRef.current;
    if (!g) return null;
    // 量不到尺寸时退化成 1×1，而**不是**放弃判定：环境没有布局（jsdom / 尚未排布）时
    // 尺寸恒为 0，若直接 return null，整套拖动会静默失效（单测立刻红 5 条，就是这个原因）。
    // 1×1 让"最近块 + 运动方向"这两条判据仍可用，只是失去"接触"那条（尺寸为 0 时本就无从谈起）。
    const width = g.offsetWidth || 1;
    const height = g.offsetHeight || 1;
    const p = pointRef.current;
    const left = p.x - grabRef.current.x;
    const top = p.y - grabRef.current.y;
    // 指针坐标不可用时的兜底（异常路径 / 尚未收到过指针坐标）：退回缓动位置，
    // 绝不产生 NaN 落点（NaN 会让判定整个失效，表现与"拖不动"无从区分）。
    if (!Number.isFinite(left) || !Number.isFinite(top) || Math.abs(left) > 1e5 || Math.abs(top) > 1e5) {
      return { left: posRef.current.x, top: posRef.current.y, width, height };
    }
    return { left, top, width, height };
  }

  /**
   * 用当前镜像位置重算一次落点并上报（`onMoveTo`）。
   *
   * 两条路径都调它：`pointermove`（跟手）与 rAF 缓动（镜像还在往目标逼近时，
   * 判定必须跟着收敛 —— 否则"快速一甩就松手"会按一个**滞后一格**的位置落盘）。
   * 落点没变时 `moveToInList` 返回同引用，连重渲染都不会有（见 applyPointer 注释）。
   */
  function updateDrop() {
    const list = listRef.current;
    if (!list) return;
    const rect = ghostRect();
    if (!rect) return;
    let geom = geomRef.current;
    const st0 = dragStateRef.current;
    if (!geom || !st0) return;

    /**
     * 几何还作数吗？——**只在它真的变了**的时候重建快照。
     *
     * 三种会让快照过期的情况：① 画布宽度变了（发起拖动时上层收起配置栏 —— 用户第 2 条，
     * 窄屏是检查器高度变化、宽屏是 340px 右栏消失）；② 画布/页面滚动；③ 窗口尺寸变化。
     * 前两种都会让 `offsetParent` 的客户端原点移动，所以一次 `getBoundingClientRect()` 全能看出来
     * （这就是每帧唯一的布局读取；旧实现每帧要读 N 个块的 `offset*`）。
     *
     * 重建时把**判定原点搬到当前镜像中心**：死区从当前位置重新量，落点不会因为
     * "配置栏收起"而平白跳一格（那正是用户说的"界面也乱跑"）。
     */
    const items = listBlocks(list);
    const ref = ((items[0] && items[0].offsetParent) || document.body) as HTMLElement;
    const rr = ref.getBoundingClientRect();
    const canvasEl = list.closest(".ed-canvas") as HTMLElement | null;
    const canvasW = canvasEl ? canvasEl.offsetWidth : list.offsetWidth;
    if (
      Math.abs(rr.left - geom.refLeft) > 0.5 ||
      Math.abs(rr.top - geom.refTop) > 0.5 ||
      canvasW !== geom.canvasW
    ) {
      const rebuilt = snapshotOf(list, idRef.current);
      if (!rebuilt) return;
      geomRef.current = rebuilt;
      geom = rebuilt;
      dragStateRef.current = {
        axis: 0,
        dir: 0,
        index: st0.index,
        origin: {
          x: rect.left - rebuilt.refLeft + rect.width / 2,
          y: rect.top - rebuilt.refTop + rect.height / 2
        }
      };
    }

    const geomNow = geomRef.current;
    const st = dragStateRef.current;
    if (!geomNow || !st) return;
    const local: DropBox = {
      left: rect.left - geomNow.refLeft,
      top: rect.top - geomNow.refTop,
      width: rect.width,
      height: rect.height
    };
    const snap: DragSnapshot = { boxes: geomNow.boxes, from: geomNow.from };
    /* 指针也要换算到同一个坐标系：并排行的"左半 / 右半"用它判（见 core/dropIndex.insertPosOf
       —— 被拖块常常比目标宽得多，用矩形中心会把"落在左半"判成"之后"）。 */
    const pointerLocal = {
      x: pointRef.current.x - geomNow.refLeft,
      y: pointRef.current.y - geomNow.refTop
    };
    const next = dragStep(snap, local, st, pointerLocal);
    if (next !== st) {
      dragStateRef.current = next;
      if (geomNow.from < 0) return;
      cbRef.current.onMoveTo(idRef.current, next.index);
      return;
    }

    /**
     * 行内落位（v3.5.1，用户第 2 条反馈）—— `dragStep` 说"这一帧落点不变"时的补充语义：
     * 被拖块**独占一行**且不满宽时，横向拖动 = 把它拖进**自己那一行**的空位。
     *
     * 判定条件逐条的理由：
     *   · `geomNow.spans[from] < 12` —— 满宽块没有行内空位可言（模型层 offset 恒 0）；
     *   · **独占一行**（该行 `groupRows` 只剩它一个；行分组由快照几何算出）—— 行里有
     *     别的块时横向拖动是**换序**语义（并排行的左/右半边），两种语义不能抢同一根手指；
     *     独占一行时行尾只剩空占位格（`d-gap`），横向怎么拖都不碰邻居；
     *   · `dragStep` 返回 `st` 本身 —— 顺序没动。纵向它正忙着换行/被死区按住；横向在
     *     独占行里它永远没有换序候选（行里只有自己），所以"落点不变"在独占行里恰好
     *     等于"手势空闲"，拿来做行内列判定不会与换序打架；
     *   · 目标列与 `colRef`（本 hook 记的**当前已应用列**）不同才回调 —— 上层
     *     `setDetailBlockOffset` 对同值返回同引用，但这里早一帧挡掉可以连 setState 都省。
     *
     * ⚠️ 列变化会让**行几何**变化（块挪到行中间 = 左右各多一个空占位格），但这不破坏
     * "快照不重测"的纪律：换列只影响水平方向，行分组（垂直重叠）不变、块的 top 不变、
     * `dragStep` 的纵向判定仍用旧快照 —— 下一帧若真发生了跨行拖动，几何变化检测
     * （offsetParent 原点 / 画布宽）不会命中，快照保持稳定；用户松手后一切落定。
     */
    if (cbRef.current.onMoveColTo && geomNow.from >= 0) {
      const span = geomNow.spans[geomNow.from];
      if (span > 0 && span < 12) {
        const rows = groupRows(geomNow.boxes);
        const row = rows.find((r) => r.indexOf(geomNow.from) >= 0);
        if (row && row.length === 1) {
          /**
           * 行内落位（v3.5.2）：输入是**被拖块自己的中心**（`local` 来自未缓动的
           * 指针矩形，见 `ghostRect`），基准是**行的左缘 + 真实列距**（都在快照里）。
           * 旧实现吃指针绝对位置、拿被拖块左缘当行起点 → 抓右缘起拖即跳 3 列、居中块一抓掉回最左。
           */
          const col = rowOffsetFromCentre(
            { left: geomNow.rowLeft, pitch: geomNow.pitch },
            span as 3 | 4 | 6 | 8 | 9,
            local.left + local.width / 2
          );
          if (col !== colRef.current) {
            colRef.current = col;
            cbRef.current.onMoveColTo(idRef.current, col);
          }
        }
      }
    }
  }

  function follow() {
    if (!activeRef.current) return;
    stepGhost();
    updateDrop(); // 缓动每推进一帧就重判一次（判定跟着镜像收敛，见 updateDrop）
    rafRef.current = window.requestAnimationFrame(follow);
  }

  /**
   * 推进一帧：更新指针位置 → 推进一步缓动 → 重算落点。
   *
   * 三条输入路径共用（元素级 pointermove / 窗口级 pointermove / 窗口级 touchmove）。
   * 重复推进同一坐标是幂等的：落点没变时 `moveToInList` 返回同引用，连重渲染都不会有。
   *
   * ⚠️ 必须声明在"刷新 ref 的 effect"**之前**：那个 effect 会 `applyRef.current = applyPointer`，
   * 声明在后会被 `react(immutability)` 判 "read during its own initialization"（实测踩过）。
   */
  function applyPointer(c: { x: number; y: number }) {
    pointRef.current = c; // 跟手要连续坐标，不只是判定用的 clientY
    if (!activeRef.current) return;
    stepGhost(); // 立刻推进一步（rAF 被节流时的兜底；正常也让它更跟手）
    // 落点判定是**二维**的（core/dropIndex）：并排后同一行有两块，
    // 只比 clientY 的中线判据在那里没有意义。v3.4 起判的还从"指针"换成了"被拖块矩形"。
    updateDrop();
  }

  /** 撤走镜像并停掉跟手循环（松手 / 手势取消 / 组件卸载三条路都走它） */
  function stopGhost() {
    // 快照与判定状态按"每次拖动"重置：下一次拖动重新测一次几何（v3.5）
    geomRef.current = null;
    dragStateRef.current = null;
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const g = ghostRef.current;
    ghostRef.current = null;
    if (g && g.parentNode) g.parentNode.removeChild(g);
    // 兜底：不只删 ref 里那一个 —— 任何残留镜像都清掉（多指 / 上一次异常收尾留下的孤儿）。
    removeStrayGhosts(ghostHostRef.current);
    ghostHostRef.current = null;
  }

  /**
   * 起拖后挂上**窗口级**监听（跟手 + 收尾 + 失焦兜底）。
   *
   * 这是"卡死"的根本修法：不再要求"事件回到被拖的那个块"。窗口级监听对
   * 捕获丢失 / DOM 节点被移动 / 指针移出元素**全都免疫**。
   *
   * ⚠️ 归属校验照旧（审计 S-1）：只响应驱动本次拖拽的那根指针，第二根手指不能劫持。
   * window 级 `touchmove` 必须非被动、且**只在拖动态**才 preventDefault ——
   * 否则会把整个应用的滚动能力一起吃掉。
   */
  function attachDragListeners() {
    if (typeof window === "undefined" || winMoveRef.current) return;

    const onPointerMove = (e: PointerEvent) => {
      if (!activeRef.current) return;
      if (activePointerRef.current !== null && e.pointerId !== activePointerRef.current) return;
      const c = coordsOf(e);
      if (c) applyRef.current(c);
    };
    // 触摸路径并行驱动：某些内核在接管触摸后可能不再派发 pointermove，
    // 只靠 pointer 路径的镜像就会"悬着不动"。两条路推进同一份状态，重复推进幂等。
    const onTouchMove = (e: TouchEvent) => {
      if (!activeRef.current) return;
      if (e.cancelable) e.preventDefault(); // 非被动监听器里此刻才抢得回滚动
      if (e.touches.length > 1) return;     // 第二根手指不算驱动
      const c = coordsOf(e);
      if (c) applyRef.current(c);
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (activePointerRef.current !== null && e.pointerId !== activePointerRef.current) return;
      finishRef.current({ x: e.clientX, y: e.clientY });
    };
    // 「所有手指离开屏幕」才算结束：别的指头抬起不该打断还在按住的那根
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length > 0) return;
      finishRef.current();
    };
    // 切页 / 下拉通知栏 / 来电 / 切窗口都会让指针事件断流 —— 兜底收尾，不留悬挂态
    const onBlur = () => { finishRef.current(); };
    const onVis = () => { if (document.visibilityState === "hidden") finishRef.current(); };

    winMoveRef.current = onPointerMove;
    winTouchMoveRef.current = onTouchMove;
    winEndRef.current = onPointerEnd;
    winTouchEndRef.current = onTouchEnd;
    winBlurRef.current = onBlur;
    winVisRef.current = onVis;

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
  }

  /**
   * 摘掉窗口级监听（收尾 / 卸载各一次；重复调用无害）。
   *
   * ⚠️ `lostpointercapture` **不是**结束信号：捕获丢了但手指还在动，
   * 拖拽必须继续（window 监听接着驱动）。所以这里不为它做任何收尾。
   */
  function detachDragListeners() {
    if (typeof window === "undefined") return;
    const pm = winMoveRef.current;
    const tm = winTouchMoveRef.current;
    const pe = winEndRef.current;
    const te = winTouchEndRef.current;
    const bl = winBlurRef.current;
    const vi = winVisRef.current;
    winMoveRef.current = null;
    winTouchMoveRef.current = null;
    winEndRef.current = null;
    winTouchEndRef.current = null;
    winBlurRef.current = null;
    winVisRef.current = null;
    if (pm) window.removeEventListener("pointermove", pm);
    if (pe) { window.removeEventListener("pointerup", pe); window.removeEventListener("pointercancel", pe); }
    if (tm) window.removeEventListener("touchmove", tm);
    if (te) { window.removeEventListener("touchend", te); window.removeEventListener("touchcancel", te); }
    if (bl) window.removeEventListener("blur", bl);
    if (vi) document.removeEventListener("visibilitychange", vi);
  }

  /**
   * 收尾：**幂等**。
   * 同一个手势可能有两条事件流各报一次取消（`pointercancel` 与 `touchcancel`），
   * 而"落盘 + 广播"必须只跑一次 —— 靠 activeRef 兜住：第一次跑完它已经是 false。
   *
   * ⚠️ 顺序不再敏感（审计 M-3）：触摸监听 effect 经 `finishRef` 间接调用本函数 ——
   * 原先"必须声明在 effect 之前"只由 lint 兜着（声明在后 React Compiler 会判 error），
   * 将来有人挪动函数顺序、或加了 disable 注释就会静默失守；现在声明位置自由。
   */
  /**
   * 松手时按**松手点**再补算一次行内列（v3.5.2）。
   *
   * 为什么需要：拖动中的判定只认"最后一次收到的事件"。真机（尤其快速抬手）与合成事件里
   * 都可能丢掉/合并最后几个 `pointermove` —— e2e 实测：驱动发了 8 次 move，页面只收到 7 次
   * （每次两路 = 计数 14），落点因此停在前一帧算出的列上、差一整列。
   * 松手点是用户**最后一次表达意图**的位置，用它补算一次就能纠回，而且是**幂等**的：
   * 事件没丢时算出的列与拖动最后一帧相同，结果不变。
   */
  function recomputeColAtRelease(x: number) {
    const list = listRef.current;
    if (!list || !cbRef.current.onMoveColTo) return;
    const g = snapshotOf(list, idRef.current);
    if (!g || g.from < 0) return;
    const span = g.spans[g.from];
    if (!(span > 0 && span < 12)) return;
    const rows = groupRows(g.boxes);
    const row = rows.find((r) => r.indexOf(g.from) >= 0);
    if (!row || row.length !== 1) return; // 只对"独占一行"启用，与拖动中的口径一致
    const gEl = ghostRef.current;
    const w = gEl ? gEl.offsetWidth || 0 : 0;
    if (!(w > 0)) return;
    const left = x - grabRef.current.x - g.refLeft;
    const col = rowOffsetFromCentre(
      { left: g.rowLeft, pitch: g.pitch },
      span as 3 | 4 | 6 | 8 | 9,
      left + w / 2
    );
    if (col !== colRef.current) {
      colRef.current = col;
      cbRef.current.onMoveColTo(idRef.current, col);
    }
  }

  function finishDrag(release?: { x: number; y: number }) {
    const wasDragging = activeRef.current;
    clearTimer();
    activeRef.current = false;
    activePointerRef.current = null;
    detachDragListeners(); // 窗口级监听随拖拽一起收（否则会跨拖拽泄漏、越挂越多）
    // 只释放**自己**持有的全局占用（别的块在拖时，它的 lock 不能被我们清掉）
    if (globalDragOwner === idRef.current) {
      globalDragOwner = null;
      ownerPointerId = null;
      ownerTeardown = null;
    }
    // ★ 松手点补算：必须在 `listRef` 置空、镜像撤走**之前**（它要用这两样）
    if (wasDragging && release) recomputeColAtRelease(release.x);
    listRef.current = null;
    stopGhost(); // 镜像撤走；原块（"坑"）此刻已经停在落点上
    setDragging(false);
    if (wasDragging) {
      // 收尾提交：**一次**拖拽只在这里落盘 + 广播一次（拖动中各帧都不碰 localStorage）
      cbRef.current.onDragEnd?.();
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(10); // 落位反馈
    }
  }

  /** Pointer 路径的收尾：先还掉指针捕获，再走共用的 finishDrag */
  function end(e: ReactPointerEvent) {
    // 多指守卫（S-1）：驱动本次拖拽的那根手指才有资格收尾 ——
    // 否则第二根手指一松就会把还在进行的拖拽提前结束掉。
    if (activeRef.current && activePointerRef.current !== null && e.pointerId !== activePointerRef.current) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    finishDrag({ x: e.clientX, y: e.clientY });
  }

  // 卸载兜底：拖到一半退出编辑器 / 切页，镜像绝不能留在页面上
  useEffect(() => {
    bindLivePointerWatch(); // 模块级：window 上兜一层"驱动指针一消失就强制收尾"
    return () => {
      stopGhost();
      detachDragListeners();
      if (globalDragOwner === idRef.current) { // 别把全局占用标记带走
        globalDragOwner = null;
        ownerPointerId = null;
        ownerTeardown = null;
      }
    };
  }, []);

  // 每次渲染后刷新回调 ref（原生 / 窗口级监听器读它，所以那些闭包永远不会陈旧）
  useEffect(() => {
    cbRef.current = { onMoveTo, onDragEnd, onDragStart, onMoveColTo };
    idRef.current = id;
    finishRef.current = finishDrag;
    applyRef.current = applyPointer;
  });

  // ── v3：原生触摸监听 —— 真机上把滚动手势抢过来（见文件头"触摸怎么把滚动抢过来"）──
  /**
   * 两个监听器**故意只挂一次**（`[]`）：块在列表里被 React 复用（keyed DOM 节点不重建），
   * 挂一次就够；一旦带上依赖，每次渲染都要拆挂一遍，反而可能在拖动中途把监听摘掉。
   */
  useEffect(() => {
    const el = blockElRef.current;
    if (!el) return;

    function onTouchMove(e: TouchEvent) {
      // 多指 = 缩放 / 系统手势：把待命的长按撤掉，别跟系统抢
      if (e.touches.length > 1) { clearTimer(); return; }
      // 已经抓起 → 这个手势归我们。**非被动**监听器里的 preventDefault 才能把
      // "竖向平移"从滚动手里夺回来；滚动一旦开始就晚了，所以每一次都要挡。
      if (activeRef.current && e.cancelable) e.preventDefault();
    }

    function onTouchCancel() {
      // 浏览器判定"这是滚动/系统手势"并要求我们收手：待命的长按立刻作废，
      // 已经抓起的也收尾（后面 pointercancel 还会来一发，finishDrag 是幂等的）
      clearTimer();
      finishRef.current(); // 经 ref 调用，免得 effect 直接依赖函数的声明位置（审计 M-3）
    }

    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchcancel", onTouchCancel);
    return () => {
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchcancel", onTouchCancel);
    };
  }, []);

  function begin(el: HTMLElement, pointerId: number) {
    /**
     * 重入守卫（审计 S-1）：已经在拖了就不许再开一次。
     * 不加的话，第二根手指按住同一块满 280ms 会**再克隆一个镜像**，而 `ghostRef`
     * 只记得最后一个 —— 前一个就成了永远清不掉的孤儿节点。
     */
    // 自己以为在拖，但驱动它的那根指针其实已经不在屏幕上了 → 上一次收尾被漏掉，先强制收尾
    if (activeRef.current) {
      const pid = activePointerRef.current;
      if (pid !== null && livePointers.has(pid)) return; // 真·第二根手指按住同一块：忽略
      finishDrag();
    }
    // 全画布同一时刻只允许一次拖拽：别的块正在拖时礼让；但若它的驱动指针已经消失
    // = 它卡死了 → 接管（否则用户会撞上"拖拽失效了"，且只能重启应用）
    if (globalDragOwner !== null && globalDragOwner !== idRef.current) {
      if (ownerPointerId !== null && livePointers.has(ownerPointerId)) return;
      if (ownerTeardown) ownerTeardown();
    }
    globalDragOwner = idRef.current;
    ownerPointerId = pointerId;
    ownerTeardown = finishDrag;
    attachDragListeners(); // 起拖即挂 window 级 move/up/cancel：正确性不再依赖指针捕获
    /**
     * 从**父元素**往上找所属列表（而不是从 `el` 自身）。
     *
     * 差别在**一身两职**的元素上：`.d-facts` 既是"信息栏内的一项"（自身是可拖槽位），
     * 又是四宫格字段的容器（自身带 `data-drag-list`）。从 `el` 自身 `closest` 会命中的
     * 是**它自己** → `listBlocks()` 数出的是它的 4 个子字段，而 `from` 在子字段里找不到它
     * → 落点判定整盘错位。从父元素起步就正确地落在**外层**列表（`.d-hero-info`）上。
     */
    listRef.current = (el.parentElement ? el.parentElement.closest("[data-drag-list]") : null) as HTMLElement | null;
    activeRef.current = true;
    activePointerRef.current = pointerId;
    setDragging(true);
    try { el.setPointerCapture(pointerId); } catch { /* 老内核无此 API / 合成事件：退化成不捕获 */ }
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(8); // 抓起反馈
    // 镜像要克隆**整个可拖元素**：手柄路径下 el 是那根 ⠿，克隆它只会得到一根手柄
    const block = blockElRef.current;
    if (block) startGhost(block);
    /**
     * 快照 + 初始判定状态（v3.5）。必须在 `startGhost` **之后**：镜像此刻正压在"坑"上，
     * 于是原点 = 坑中心，死区从"手指起点的块中心"开始量。
     */
    geomRef.current = listRef.current ? snapshotOf(listRef.current, idRef.current) : null;
    colRef.current = null; // 行内落位按"每次拖动"重新计（见 colRef 的说明）
    const g0 = ghostRect();
    const geom0 = geomRef.current;
    if (geom0 && g0) {
      dragStateRef.current = initialState(
        { boxes: geom0.boxes, from: geom0.from },
        { left: g0.left - geom0.refLeft, top: g0.top - geom0.refTop, width: g0.width, height: g0.height }
      );
    } else {
      dragStateRef.current = null;
    }
    /**
     * 通知上层「拖动开始了」（上层据此收起配置栏）。
     * 放在快照之后：即便收起动作改了画布尺寸，下一帧的几何变化检测会重建快照并重设原点。
     */
    cbRef.current.onDragStart?.();
  }

  function move(e: ReactPointerEvent) {
    // 多指守卫（S-1）：拖动中只认驱动本次拖拽的那根指针 —— 否则第二根手指一动，
    // pointRef 就被改写成它的坐标，落点与镜像一起跳到它那儿去。
    if (activeRef.current && activePointerRef.current !== null && e.pointerId !== activePointerRef.current) return;
    const c = coordsOf(e);
    if (c) applyRef.current(c);
  }

  // ── ⠿ 手柄：按下立即拖（不 preventDefault 的话长按会弹系统放大镜）──
  const gripProps: Handlers = {
    onPointerDown: (e) => {
      e.preventDefault();
      startRef.current = { x: e.clientX, y: e.clientY };
      pointRef.current = { x: e.clientX, y: e.clientY };
      begin(e.currentTarget as HTMLElement, e.pointerId);
    },
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end
  };

  // ── 整块 / 内嵌槽位：长按 / 阈值起拖 ──
  const blockProps: Handlers = {
    onPointerDown: (e) => {
      const el = e.currentTarget as HTMLElement;
      const src = e.target as HTMLElement;
      /**
       * ── 嵌套守卫（v3 内嵌可拖）────────────────────────────────────────
       * 内嵌槽位（`.ed-slot`）在 DOM 上是**顶层块的后代**，React 合成事件会把它上面的
       * pointerdown 一路冒到顶层块的 handler。不挡的话父块也会排上一个 280ms 长按。
       *
       * 判据：事件源所在的**最近**可拖项不是本元素 → 手指落在更内层的槽位里，本元素整场退出。
       * 本元素自己的 ⠿ 手柄是直接子元素，`closest` 命中的就是本元素 → 不受影响 ✓。
       *
       * ── 实测过的边界（别把这条守卫说成"防双 ghost 的唯一防线"）──────────
       * e2e 的 negative control（`tools/e2e/driver.js` 的 `nested-drag` 步骤）**摘掉本守卫
       * 仍然全绿**：因为审计 S-1 的模块级 `globalDragOwner` 锁在正常路径上已经让父块礼让了
       * （内层先抢到锁，父块到点看到"锁被持有且驱动指针还活着"就 return）。
       * 本守卫真正兜住的是**锁失效**的那条路径：窗口级"驱动指针还活着"的记录（`livePointers`）
       * 一旦丢失，父块的 `begin()` 会走 `ownerTeardown()` 把内层的拖拽**直接掐掉并接管**
       * —— 单测 `src/ui/EdSlot.test.ts` 里有一条专门模拟这个场景的判别性用例（摘掉守卫即红）。
       * 另外它顺带避免给祖先平白排一个计时器。
       *
       * ⚠️ 必须连同 move / up / cancel 一起守：**只堵 pointerdown 不够** ——
       * 鼠标分支（下面的 `dx + dy > MOUSE_PX`）不依赖"有没有排过长按计时"，
       * 只让 pointerdown 提前返回的话，父块的 `startRef` 会停在**旧值**，
       * 鼠标一动超过 4px 父块照样 `begin()`。
       */
      if (src.closest(ITEM_SEL) !== el) { skipRef.current = true; return; }
      skipRef.current = false;
      /**
       * v3.4（Wave I）备注：抓手（`.ed-grip`）已随用户第 5 条**整体删除**，
       * 所以这一句如今恒为 false —— 它是一段**死守卫**。
       *
       * 刻意**留着**：它在"起拖"这条已经用真机 + CDP 验证过的路径上，删掉它
       * 对今天的行为零影响（没有元素带那个类），但万一将来有人再给块加一个
       * "自己管自己"的手柄，这里就是那句防重复起拖的兜底。不为洁癖动核心拖拽路径。
       */
      if (src.closest(".ed-grip")) return; // 手柄自己管自己（当前无此元素，见上）
      startRef.current = { x: e.clientX, y: e.clientY };
      pointRef.current = { x: e.clientX, y: e.clientY };
      if (e.pointerType === "mouse") return; // 鼠标看位移阈值，点击仍然是点击
      const pointerId = e.pointerId;
      clearTimer(); // 审计 L-3：多指时第二次按下会覆盖 timerRef，先清掉前一个计时器（否则它失去引用、永不清除）
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        begin(el, pointerId);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e) => {
      if (skipRef.current) return; // 这一次手势属于更内层的槽位（见 onPointerDown 的说明）
      // 长按计时期间也要更新指针位置：计时到点时镜像要从"手指最后所在处"起步
      pointRef.current = { x: e.clientX, y: e.clientY };
      if (activeRef.current) { move(e); return; }
      const dx = Math.abs(e.clientX - startRef.current.x);
      const dy = Math.abs(e.clientY - startRef.current.y);
      if (timerRef.current != null) {
        // 计时没到就动了：是滚动，不是拖拽 —— 取消长按，手势还给画布
        if (dx + dy > CANCEL_PX) clearTimer();
        return;
      }
      if (e.pointerType === "mouse" && dx + dy > MOUSE_PX) {
        begin(e.currentTarget as HTMLElement, e.pointerId);
        move(e);
      }
    },
    onPointerUp: (e) => {
      if (skipRef.current) { skipRef.current = false; return; } // 不是我的手势，别去收尾
      end(e);
    },
    onPointerCancel: (e) => {
      if (skipRef.current) { skipRef.current = false; return; }
      end(e);
    }
  };

  return { dragging, blockRef, gripProps, blockProps };
}
