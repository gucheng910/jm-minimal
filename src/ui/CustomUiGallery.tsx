import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import AlbumDetail from "../pages/AlbumDetail";
import { AlbumGrid } from "./AlbumGrid";
import PageThumb from "./PageThumb";
import { CANVAS_DETAIL_PROPS, CANVAS_LIST_PROPS } from "./customUiCanvasProps";
import { isDetailStyleModified } from "../core/detailStyle";
import type { DetailStyleConfig } from "../core/detailStyle";
import { resetDetailLayout, visibleBlocks } from "../core/detailLayout";
import type { DetailLayoutConfig } from "../core/detailLayout";
import { DEFAULT_LIST_LAYOUT, loadListLayout } from "../core/listLayout";
import { loadChromeLayout, resetChromeLayout } from "../core/chromeLayout";
import { isReaderStyleModified, loadReaderStyle } from "../core/readerStyle";
import type { ReaderStyleConfig } from "../core/readerStyle";
import type { ChromeLayoutConfig } from "../core/chromeLayout";
import { BarsPreview, ReaderChromePreview } from "./chrome/ChromePreview";
import { cardLeft, frontIndex, pagerGeom, restX, rubberX, snapIndex } from "./galleryPager";

/**
 * 「自定义 UI」的**入口屏**：可自定义页面的画廊。
 *
 * ── v3.6：隐喻换掉了（用户第 5 条「画廊的交互和展示依然一塌糊涂」）──────────
 * 上一版把两张卡**缩小后相叠**（后卡缩到 1/(1+0.42)≈0.704、从前卡右侧露出 106px
 * = 42% 卡宽）。结果露出的是**被裁切的半截内容**：切掉的标题、**半个黑色「立即阅读」
 * 按钮**、断句的文字 —— 屏幕中间的裁切没有"还有更多"的语义，只有"渲染坏了"的语义。
 *
 * Android Recents / M3 Carousel **不叠卡**：它们是**单轨 pager + 间距**，邻居卡尺寸不变、
 * 被**视口边缘**裁切。AOSP quickstep 里就写着 `overview_minimum_next_prev_size = 50dp`、
 * `overview_page_spacing = 16dp`（父代理在抓下来的源码里逐字核过）；Swiper 的 cards effect
 * 更是**主动把后卡往外推**，目的就是"只露边缘"。
 *
 * 所以这一版是 **单轨 peek 轮播**（手机）+ **静态两栏**（宽屏，两页都完整可见）：
 *   · 卡片**完全不缩放**（纵深只靠前卡的投影 + 后卡的极淡遮罩）→ 没有"缩到 0.44 后
 *     正文变成 5.8px"那种没有产出的中间态；
 *   · 邻居露出 `PEEK = clamp(40, 0.16×卡宽, 56)`，裁切**永远在视口边缘**；
 *   · 翻页 = 轨道位移 + 吸附（**距离过半** 或 **速度 ≥ 0.3 px/ms**）；
 *   · 手势**定轴**（前 10px 内横位移必须 > 1.5×竖位移），一旦判为竖向，本次手势**永不接管**
 *     → 竖滚不会被抢走；
 *   · 两端**阻尼**（`pow(over, 0.7)`）—— 只有两页，会一直在边界；
 *   · 页名放在**轨道上方的分段控件**里（不再靠被裁切的后卡去认），点它也能跳页。
 *
 * **几何与吸附规则全在 `ui/galleryPager.ts`**（纯函数 + 单测）：那里的自检等式
 * `卡宽 + 间距 + 露出 === 轨道宽` 是可执行的 —— 调研报告曾把这条算错（内边距减了两次）。
 *
 * **为什么用 JS transform 而不是 CSS scroll-snap**：规范版 `scroll-snap-type` 要 Chrome 69，
 * 本项目的 WebView 57 只有 2015 年的老语法 —— 无吸附的横向滚动比原生纵向滚动更糟，
 * 所以不押注它，自己用指针位移驱动 transform（`touch-action: pan-y` 把竖向留给原生滚动）。
 */

export type CanvasPage = "list" | "detail" | "chrome" | "reader";

/**
 * 可自定义的四个页面（v3.13 从两个扩到四个）。
 *
 * 顺序 = 画廊里从左到右的顺序，也是"离用户日常动线由近到远"的顺序：
 * 列表页 → 详情页（内容页，最常看）→ 顶栏和底栏（外壳）→ 阅读器（沉浸页）。
 * 「顶栏和底栏」是一个页面而不是两个：它们共用同一份配置（`chromeLayout` 的
 * topLeft/topActions/nav 三节），拆成两页只会让"顶栏的设置藏在哪一页"变成一道猜谜题。
 */
export const GALLERY_PAGES: { key: CanvasPage; label: string }[] = [
  { key: "list", label: "列表页" },
  { key: "detail", label: "详情页" },
  { key: "chrome", label: "顶栏和底栏" },
  { key: "reader", label: "阅读器" }
];

/** 量不到轨道宽之前用的兜底（390 手机：390 − 2×16 padding） */
const FALLBACK_W = 358;
/** 定轴：横位移至少这么多像素、且必须大于竖位移的这么多倍，才接管本次手势 */
const LOCK_PX = 10;
const LOCK_RATIO = 1.5;
/** 拖动结束后的那次 click 视为余波、吞掉 */
const CLICK_SUPPRESS_MS = 400;

/** 详情页是否被改过：结构（顺序/显隐/跨格）或观感（样式键）任一动过就算 */
function detailChanged(layout: DetailLayoutConfig, style: DetailStyleConfig): boolean {
  if (isDetailStyleModified(style)) return true;
  const d = resetDetailLayout();
  if (JSON.stringify(visibleBlocks(layout)) !== JSON.stringify(visibleBlocks(d))) return true;
  if (layout.hidden.length > 0) return true;
  return Object.keys(layout.spans).length > 0;
}

/** 列表页是否被改过（字段顺序 / 显隐 / 列数） */
function listChanged(): boolean {
  try {
    return JSON.stringify(loadListLayout()) !== JSON.stringify(DEFAULT_LIST_LAYOUT);
  } catch {
    return false; // 隐私模式等读不到盘：当作没改过，不影响进编辑
  }
}

/** `hidden` 里属于某几个分区的条目（比较"改没改过"时分页各算各的） */
function hiddenOf(cfg: { hidden: string[] }, sections: readonly string[]): string {
  return cfg.hidden
    .filter((k) => sections.some((s) => k.indexOf(s + ":") === 0))
    .sort()   // 集合语义：顺序不算改动
    .join(",");
}
const BAR_SECTIONS = ["topLeft", "topActions", "nav"] as const;
const READER_SECTIONS = ["readerTop", "readerTools", "readerStatus"] as const;

/** 顶栏和底栏是否被改过（三个分区的顺序或显隐） */
function barsChanged(): boolean {
  try {
    const c = loadChromeLayout();
    const d = resetChromeLayout();
    return JSON.stringify([c.topLeft, c.topActions, c.nav, hiddenOf(c, BAR_SECTIONS)])
      !== JSON.stringify([d.topLeft, d.topActions, d.nav, hiddenOf(d, BAR_SECTIONS)]);
  } catch {
    return false;
  }
}

/** 阅读器是否被改过（三个分区的顺序或显隐，或观感两项） */
function readerChanged(): boolean {
  try {
    const c = loadChromeLayout();
    const d = resetChromeLayout();
    if (JSON.stringify([c.readerTop, c.readerTools, c.readerStatus]) !== JSON.stringify([d.readerTop, d.readerTools, d.readerStatus])) return true;
    if (hiddenOf(c, READER_SECTIONS) !== hiddenOf(d, READER_SECTIONS)) return true;
    return isReaderStyleModified(loadReaderStyle());
  } catch {
    return false;
  }
}

interface Props {
  /** 当前版面配置 —— 缩略图要显示"你改过的样子"，所以由父级传**受控**配置而不是让它自己读盘 */
  layout: DetailLayoutConfig;
  style: DetailStyleConfig;
  /**
   * 「顶栏和底栏」「阅读器」两页的配置（v3.15）。
   *
   * ⚠️ 这两张缩略图以前渲染的是一张**普通列表网格**（因为分支里只区分了 detail / 其它），
   * 于是画廊上"顶栏和底栏"和"阅读器"两张卡的预览与真页面完全不符 —— 用户直接反馈过。
   * 现在各自渲染与画布**同源**的那一份（`BarsPreview` / `ReaderChromePreview`）。
   */
  chrome: ChromeLayoutConfig;
  readerStyle: ReaderStyleConfig;
  onPick: (page: CanvasPage) => void;
}

interface DragState {
  id: number;
  x0: number;
  y0: number;
  /** 0 = 还没定轴，1 = 本次手势归我们（横滑），-1 = 让给浏览器（竖滚） */
  lock: 0 | 1 | -1;
  /** 定轴那一刻的轨道位置 */
  base: number;
  moved: boolean;
  lastX: number;
  lastT: number;
  /** 最近一次采样的速度（px/ms，正 = 向右） */
  v: number;
}
const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

export default function CustomUiGallery({ layout, style, chrome, readerStyle, onPick }: Props) {
  // 依赖 layout/style：编辑屏改完再回到画廊时，这里的「改过」标记要跟着变。
  // ⚠️ 四个页面**都要有键**：少一个 `changed[key]` 就是 undefined，会被渲染成「默认」——
  //    改过顶栏的用户回到画廊看到"默认"，比不显示标记更糟（四页时踩到过这个坑）。
  const changed = useMemo<Record<CanvasPage, boolean>>(
    () => ({ detail: detailChanged(layout, style), list: listChanged(), chrome: barsChanged(), reader: readerChanged() }),
    [layout, style]
  );

  const stackRef = useRef<HTMLDivElement | null>(null);
  /** 轨道可用宽（量一次 + window resize；老内核没有 ResizeObserver，与 PageThumb 同一手法） */
  const [stageW, setStageW] = useState(0);
  /** 当前在最前的是哪一页 */
  const [index, setIndex] = useState(0);
  /** 拖动中的轨道位移（null = 停在 `index` 的静息位置）。**只存拖动中的值**：窗口尺寸变化时静息位置会重算 */
  const [dragX, setDragX] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const indexRef = useRef(0);
  const dragXRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /** 「吞掉随后的那次 click」的时间戳（0 = 没有要吞的）。用时间窗而不是布尔标记：程序化 click 不会被重置 */
  const ateClickAtRef = useRef(0);

  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    const measure = () => {
      // ⚠️ 量**布局宽**（offsetWidth）而不是 getBoundingClientRect：卡片里到处有 transform，
      //    后者返回视觉宽，会把几何算错（同一条教训在 PageThumb 与拖拽栈里都出现过）。
      const w = el.offsetWidth;
      if (w > 0) setStageW(w);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const n = GALLERY_PAGES.length;
  const W = stageW > 0 ? stageW : FALLBACK_W;
  const g = useMemo(() => pagerGeom(W, n), [W, n]);
  const wide = g.wide;
  const cw = g.cw;
  const stackH = g.stackH;

  const x = dragX !== null ? dragX : restX(g, index);
  const frontIdx = frontIndex(g, x);

  const setTrack = useCallback((v: number | null) => {
    dragXRef.current = v;
    setDragX(v);
  }, []);

  const goTo = useCallback((k: number) => {
    indexRef.current = k;
    setIndex(k);
    setTrack(null);          // 静息位置由 restX 算 → 窗口尺寸变化也跟得上
  }, [setTrack]);

  // ── 拖动：定轴 → 轨道位移（两端阻尼）→ 松手吸附（距离过半或速度达标）──
  const detachRef = useRef<(() => void) | null>(null);

  const finish = useCallback((commit: boolean) => {
    if (detachRef.current) { detachRef.current(); detachRef.current = null; }
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!d) { setTrack(null); return; }
    if (d.moved) ateClickAtRef.current = Date.now();   // 吞掉紧随其后的那一次 click
    const start = indexRef.current;
    const target = commit && d.lock === 1
      ? snapIndex(g, start, dragXRef.current ?? restX(g, start), d.v)
      : start;
    goTo(target);
  }, [g, goTo, setTrack]);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (wide) return;                                  // 宽屏两栏：两页都在，没有翻页手势
    if (dragRef.current) finish(false);                // 上次没收干净（手势被系统抢走）先收尾
    dragRef.current = {
      id: e.pointerId, x0: e.clientX, y0: e.clientY, lock: 0,
      base: restX(g, indexRef.current), moved: false,
      lastX: e.clientX, lastT: nowMs(), v: 0
    };

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.id) return;         // 多指：只认驱动那根
      const dx = ev.clientX - d.x0;
      const dy = ev.clientY - d.y0;
      if (d.lock === 0) {
        /**
         * 定轴（AOSP 的 TOUCH_SLOP 8dp / Hammer pan.threshold 10 是同一手法）：
         * 横位移够大**且明显大于**竖位移才归我们；否则让给浏览器（`touch-action: pan-y`）。
         * 旧实现只看 `|dx| ≥ 6` 不看 `|dy|` → 用户想竖滚，第 6px 就被"拉开"抢走了。
         */
        if (Math.abs(dx) >= LOCK_PX && Math.abs(dx) > LOCK_RATIO * Math.abs(dy)) d.lock = 1;
        else if (Math.abs(dy) >= LOCK_PX) { d.lock = -1; return; }   // 本次手势永不接管
        else return;
      }
      if (d.lock !== 1) return;
      d.moved = true;
      setDragging(true);
      const t = nowMs();
      const dt = t - d.lastT;
      /**
       * 采样间隔太久（手指在屏幕上停住了）→ **速度归零**。
       * 不能"保留上一次采样"：那样"慢慢拖到最后停一下再松手"会沿用停手前那一下的速度，
       * 被当成甩动而翻页（e2e 实测抓到的真 bug：慢拖 55% 却被当成快划）。
       */
      d.v = dt > 0 && dt < 200 ? (ev.clientX - d.lastX) / dt : 0;
      d.lastX = ev.clientX; d.lastT = t;
      setTrack(rubberX(g, d.base + dx));                // 阻尼只影响视觉；提交阈值（两个静息位置的中点）永远落在范围内，所以判定用同一个值也等价
    };
    const onEnd = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== d.id) return;
      finish(true);
    };
    // 捕获阶段一并收：任何元素上的 up/cancel 都要能收尾（拖到卡片外面松手是最常见的情形）
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, true);
    window.addEventListener("pointercancel", onEnd, true);
    detachRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd, true);
      window.removeEventListener("pointercancel", onEnd, true);
    };
  }, [wide, finish, g, setTrack]);

  /** 卸载兜底：拖到一半组件没了，别把 window 监听器留着 */
  useEffect(() => () => { if (detachRef.current) { detachRef.current(); detachRef.current = null; } }, []);

  const pick = useCallback((page: CanvasPage) => {
    // 紧跟在滑动手势之后的那一次 click 是余波（松手会顺手把页面打开），吞掉；时间窗之外的点击一律放行
    if (Date.now() - ateClickAtRef.current < CLICK_SUPPRESS_MS) return;
    onPick(page);
  }, [onPick]);

  /** 拖动开始后立刻停掉过渡（否则过渡会"拖着"手指走），由 finish 恢复 */
  const stackCls = "ed-stack" + (dragging ? " ed-stack-drag" : "");

  return (
    <div className="ed-gallery" data-mode={wide ? "wide" : "peek"}>
      {/* 内层单独一层：画廊自己必须是**铺满的滚动容器**（背景通铺、滚动条在屏幕边），
          而卡片区要限宽 + 垂直居中 —— 后者靠内层的 `margin:auto`（理由见 index.css）。 */}
      <div className="ed-gallery-inner">
        {/* 页名分段控件（**只在 peek 模式**出现）：被裁切的后卡认不出名字，
            所以"有几页 / 另一页是什么 / 哪页改过"必须在**不滑动时**就能看见。
            宽屏两栏时两张卡都完整可见、各自带卡名，这一行就不需要了。 */}
        {!wide && (
          <div className="seg-choice ed-galtabs">
            {GALLERY_PAGES.map((p, i) => (
              <button
                key={p.key}
                type="button"
                className={i === index ? "on" : ""}
                aria-pressed={i === index}
                data-page={p.key}
                data-active={i === index ? "1" : ""}
                onClick={() => goTo(i)}
              >
                {p.label}
                {changed[p.key]
                  ? <i className="dl-dot" title="这一页改过" aria-label="这一页改过" />
                  : <em className="ed-carddefault">默认</em>}
              </button>
            ))}
          </div>
        )}

        <div
          className={stackCls}
          ref={stackRef}
          data-index={String(index)}
          /**
           * ⚠️ v3.13：宽屏下**不**输出行高/卡宽/位移的内联样式 ——
           * 那时候轨道是 CSS 网格（两列、按内容换行），尺寸与位置都归 CSS 管。
           * 内联的 `transform` 会压过 CSS（内联优先级更高且没有 !important），
           * 一旦留着就把网格里的卡又推成"一行并排"，正是要修的那个 183px 病。
           */
          style={wide ? undefined : { height: stackH > 0 ? stackH + "px" : undefined }}
          onPointerDown={onPointerDown}
        >
          {GALLERY_PAGES.map((p, i) => (
            // 卡片用 <button>：可键盘聚焦、可读屏，点整张卡进编辑（缩略图本身 pointer-events:none）
            <button
              key={p.key}
              type="button"
              className="ed-card"
              data-page={p.key}
              data-i={String(i)}
              data-front={frontIdx < 0 || frontIdx === i ? "1" : "0"}
              aria-label={"编辑" + p.label}
              style={wide ? undefined : {
                width: Math.round(cw) + "px",
                zIndex: String(frontIdx === i ? 2 : 1),
                transform: "translate3d(" + cardLeft(g, i, x).toFixed(1) + "px,0,0)"
              }}
              onClick={() => pick(p.key)}
            >
              <PageThumb
                width={Math.round(cw)}
                render={() => (
                  p.key === "detail" ? (
                    // 受控 override：缩略图跟着**当前内存态**走，也不订阅总线（少两个订阅方）
                    <AlbumDetail {...CANVAS_DETAIL_PROPS} editMode={false} layoutOverride={layout} styleOverride={style} />
                  ) : p.key === "chrome" ? (
                    // ⚠️ 与画布同源：屏幕缩略图要能一眼看出"顶栏和底栏被改成了什么样"
                    <BarsPreview cfg={chrome} />
                  ) : p.key === "reader" ? (
                    <ReaderChromePreview cfg={chrome} scrollbar={readerStyle.scrollbar} />
                  ) : (
                    <AlbumGrid {...CANVAS_LIST_PROPS} />
                  )
                )}
              />
              {/* 卡名只在**宽屏两栏**时挂在卡下：peek 模式下后卡只露 48px，
                  卡名会被裁成半截字 —— 那正是"看起来像坏了"的来源之一。 */}
              {wide && (
                <span className="ed-cardname">
                  {p.label}
                  {changed[p.key]
                    ? <i className="dl-dot" title="这一页改过" aria-label="这一页改过" />
                    : <em className="ed-carddefault">默认</em>}
                </span>
              )}
            </button>
          ))}
        </div>
        <p className="dl-hint ed-gallery-hint">
          {wide
            ? "点一张卡片开始编辑。改过的页面带圆点。"
            : "点一张卡片开始编辑；左右滑动切换页面（上面的页名也能点）。改过的页面带圆点。"}
        </p>
      </div>
    </div>
  );
}
