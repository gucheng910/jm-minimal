import { AlbumGrid } from "../AlbumGrid";
import { CANVAS_LIST_PROPS } from "../customUiCanvasProps";
import { visibleChromeUnits } from "../../core/chromeLayout";
import {
  NAV_UNITS,
  READER_STATUS_UNITS,
  READER_TOOL_UNITS,
  READER_TOP_UNITS,
  TOP_ACTION_UNITS,
  TOP_LEFT_UNITS,
  renderChromeUnits
} from "./units";
import type {
  ChromeLayoutConfig,
  ChromeSection
} from "../../core/chromeLayout";
import type {
  NavCtx,
  ReaderStatusCtx,
  ReaderToolCtx,
  ReaderTopCtx,
  TopBarCtx
} from "./units";

/**
 * 「自定义 UI → 顶栏和底栏 / 阅读器」两页的**画布**（v3.13）。
 *
 * ── 为什么这两个画布画的是"真的单元"而不是示意图 ─────────────────────
 * 与详情页/列表页画布同一条纪律：画布里跑的就是线上那套渲染（`renderChromeUnits` +
 * `ui/chrome/units` 的注册表），所以"看到的"就是"装上去的样子" ——
 * 顺序、显隐、每个按钮的图标 / 文案 / 尺寸全部同源，不存在"预览与线上漂移"。
 *
 * ── 与线上唯一的差别：点按钮**不触发动作** ───────────────────────────
 * 画布里点「菜单」不该真的把抽屉拉出来（那会把编辑器盖住），点「设置」也不该跳到别页。
 * 所以这里给的 ctx 回调**一律只做选中**（`editMode` 时才回调上层；非编辑态就是空操作）。
 * 这与详情页画布给 `AlbumDetail` 传 `editMode` 是同一手法：
 * **只影响编辑器，线上路径根本不经过这个文件**。
 *
 * ── 阅读器画布上的滚动条是"真的" ─────────────────────────────────────
 * 阅读器观感的 `scrollbar` 档位最终写在 `<html data-jm-rsb>` 上（连续模式滚的是整个文档，
 * 见 core/readerStyle.ts）。画布里没有文档级滚动条，所以这里把同一份 CSS 也用
 * `data-jm-rsb` 挂在画布自己的滚动容器上（选择器见 index.css），
 * 于是"选细条 / 常显"在画布里**立刻看得见**，而不是只有一个名字。
 */

export interface ChromePreviewProps {
  cfg: ChromeLayoutConfig;
  /** 编辑态：点单元只"选中"，不触发动作（见上面的说明） */
  editMode?: boolean;
  /** 选中回调，key 形如 `"nav:search"`（与配置层 hidden 的写法同一套） */
  onPick?: (section: ChromeSection, id: string) => void;
}

// ────────────────────────────────────────────────
// 顶栏 + 底栏
// ────────────────────────────────────────────────
export function BarsPreview({ cfg, editMode, onPick }: ChromePreviewProps) {
  /** 画布上的一切点击都只落到这里：编辑态才上报选中，非编辑态什么也不做 */
  function pick(section: ChromeSection, id: string) {
    if (editMode && onPick) onPick(section, id);
  }

  const topCtx: TopBarCtx = {
    onToggleMenu: () => pick("topLeft", "menu"),
    onOpenCache: () => pick("topActions", "cache"),
    onSearch: () => pick("topActions", "search"),
    onOpenSource: () => pick("topActions", "source")
  };
  const navCtx: NavCtx = {
    // 画布固定演示"首页"这一档：底栏的 active 态是**运行时**状态（当前在哪个 tab），
    // 不是配置项 —— 与其编一个假的，不如固定成最常见的那个并说明。
    tab: "home",
    onHome: () => pick("nav", "home"),
    onCategories: () => pick("nav", "categories"),
    onSearch: () => pick("nav", "search"),
    onSettings: () => pick("nav", "settings")
  };

  return (
    <div className="ed-appframe" data-preview="bars">
      {/* 真的顶栏：类名 / 结构 / 单元顺序全部来自线上那套 */}
      <header className="top-bar">
        <div className="top-left">
          {renderChromeUnits(visibleChromeUnits(cfg, "topLeft"), TOP_LEFT_UNITS, topCtx, "topLeft")}
        </div>
        <div className="top-actions">
          {renderChromeUnits(visibleChromeUnits(cfg, "topActions"), TOP_ACTION_UNITS, topCtx, "topActions")}
        </div>
      </header>
      {/* 中间垫一屏样例内容：没有它，两个栏会贴在一起，看不出"顶栏/底栏"的关系 */}
      <div className="ed-appbody">
        <AlbumGrid {...CANVAS_LIST_PROPS} />
      </div>
      <nav className="bottom-nav">
        {renderChromeUnits(visibleChromeUnits(cfg, "nav"), NAV_UNITS, navCtx, "nav")}
      </nav>
    </div>
  );
}

// ────────────────────────────────────────────────
// 阅读器控制条
// ────────────────────────────────────────────────
export interface ReaderChromePreviewProps extends ChromePreviewProps {
  /** 「阅读器观感」里的滚动条档位（`"hidden"` = 不挂属性 = 与改造前一致） */
  scrollbar: string;
  /** 画布里的样例页高度（px）；调大就能看出滚动条真的在滚 */
  pageH?: number;
}

/**
 * 阅读器控制条 + 样例页。
 *
 * ⚠️ 画布**按连续滚动模式渲染**（v3.15）：本项目的默认与常用模式是连续滚动
 * （上下滚、图片铺满整宽），单页模式是少数。以前画布默认拿单页模式的样子去演，
 * 用户看到的是"点左边上一页"那种分区提示 —— 与实际使用不符（用户反馈"预览与实际不符"）。
 * 现在画布里就是一摞上下排列的样例页 + 那两条控制条，跟打开一本漫画看到的一样。
 */
export function ReaderChromePreview({ cfg, editMode, onPick, scrollbar, pageH = 150 }: ReaderChromePreviewProps) {
  function pick(section: ChromeSection, id: string) {
    if (editMode && onPick) onPick(section, id);
  }

  const topCtx: ReaderTopCtx = { onBack: () => pick("readerTop", "back"), title: "作品名（示例）", current: 12, total: 47 };
  const statusCtx: ReaderStatusCtx = { chapter: "第 3 话", current: 12, total: 47, pct: 26, clock: "21:30" };
  const toolCtx: ReaderToolCtx = {
    offline: false,                                  // 在线：四个工具都在（离线时"更快的源"由单元自己决定不渲染）
    testing: false,
    onOpenSourcePicker: () => pick("readerTools", "source"),
    chaptersCount: 3,                                // 多话作品：有「换话」
    switchBusy: false,
    curLabel: "第 3 话",
    onOpenChapters: () => pick("readerTools", "chapter"),
    allCached: false,                                // 未缓存：按钮是「缓存」而不是「已缓存」
    cacheTaskBusy: false,
    pagesCount: 47,
    task: null,
    onOpenCache: () => pick("readerTools", "cache"),
    noSeam: false,
    onOpenSettings: () => pick("readerTools", "settings")
  };
  const statusIds = visibleChromeUnits(cfg, "readerStatus");

  return (
    <div className="reader-wrap ed-readerstage" data-preview="reader" data-mode="continuous">
      {/* 样例页：纯色块，不请求任何图片（与列表画布同一手法）。
          它是**滚动容器**，`data-jm-rsb` 挂在它身上 —— 于是"细条 / 常显"在画布里立刻可见。
          连续滚动模式下页面是**铺满整宽**的一摞（见 index.css 的 `.ed-readerpage`）。 */}
      <div className="ed-readerpage" data-jm-rsb={scrollbar === "hidden" ? undefined : scrollbar} aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <i className="ed-rp" key={i} style={{ height: pageH + "px" }}>
            <span>示例第 {i + 1} 页</span>
          </i>
        ))}
      </div>
      {/* 控制条：线上是 position:fixed 浮层，画布里由 CSS 改成 absolute（.ed-readerstage 内） */}
      <div className="reader-toolbar show">
        <div className="rt-top">
          {renderChromeUnits(visibleChromeUnits(cfg, "readerTop"), READER_TOP_UNITS, topCtx, "readerTop")}
        </div>
        <div className="rt-bottom">
          <div className="rt-progress" aria-hidden="true"><i style={{ transform: "scaleX(0.26)" }} /></div>
          {statusIds.length > 0 && (
            <div className="rt-status">
              {renderChromeUnits(statusIds, READER_STATUS_UNITS, statusCtx, "readerStatus")}
            </div>
          )}
          <div className="rt-tools">
            {renderChromeUnits(visibleChromeUnits(cfg, "readerTools"), READER_TOOL_UNITS, toolCtx, "readerTools")}
          </div>
        </div>
      </div>
    </div>
  );
}
