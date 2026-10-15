import { Sheet } from "../blocks";
import { NO_SEAM } from "../../core/constants";

/**
 * 阅读器「阅读设置」弹层：模式 / 去条纹 / 跳页（原来内联在 Reader.tsx 的 1331-1408）。
 *
 * 两条容易被改坏的规则，跟代码一起搬过来了：
 *   · `NO_SEAM` 是**构建期常量**（老安卓包整块摇掉了去条纹），所以「显示」这一小节
 *     和老安卓包里的去条纹按钮都要靠它判断——不是运行期开关；
 *   · **「翻页方向」只对单页模式有意义**：连续滚动是上下滚，没有左右分区。
 *     所以它只在 `mode === "single"` 时出现（原来无条件渲染，连续滚动下也显示，而那儿它什么也不影响）。
 */

export type ReaderMode = "continuous" | "single";

export interface ReaderSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  mode: ReaderMode;
  onMode: (m: ReaderMode) => void;
  /** 离线阅读：不显示「去条纹」（去条纹要重新解码原图，离线路径不走它） */
  offline: boolean;
  deseam: boolean;
  /**
   * 去条纹回调。**可选**：`NO_SEAM` 构建（老安卓包）里整个功能被摇掉，
   * 调用方会传 undefined —— 那样连它里面的文案也一起摇掉（见 Reader.tsx 的说明）。
   */
  onToggleDeseam?: () => void;
  /** 左右点击分区是否反转（左手 / 右起翻页）。持久化由调用方负责 */
  tapInvert: boolean;
  onTapInvert: (invert: boolean) => void;
  current: number;
  total: number;
  jumpInput: string;
  onJumpInput: (v: string) => void;
  onJumpTo: (page: number) => void;
  /**
   * v3.12：状态栏要显示哪几条（**默认空数组 = 一条都不显示**）。
   *
   * 为什么入口放在这个抽屉里、而不是等那个大的「自定义 UI」编辑器：
   * 阅读器的状态条目是**阅读器自己的设置**（跟模式 / 去条纹 / 翻页方向同级），
   * 放在这里用户当场就能用；大的编辑器将来读的是同一份配置（`jmclient.chromeLayout.v1`），
   * 两处写的是同一份真值，不会分叉。
   */
  statusOn: string[];
  onToggleStatus: (id: string) => void;
}

export function ReaderSettingsSheet({
  open, onClose, mode, onMode, offline, deseam, onToggleDeseam,
  tapInvert, onTapInvert, current, total, jumpInput, onJumpInput, onJumpTo,
  statusOn, onToggleStatus
}: ReaderSettingsSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="阅读设置"
      showClose
      backdropClassName="reader-sheet-backdrop"
      panelClassName="reader-sheet"
    >
      <p className="muted">阅读模式</p>
      <div className="sheet-list">
        <button
          className={"sheet-row" + (mode === "continuous" ? " active" : "")}
          onClick={() => onMode("continuous")}
        >
          <div><div className="title">连续滚动</div><div className="muted">上下滚动，图片铺满整宽</div></div>
          <span className={"badge" + (mode === "continuous" ? " sel" : "")}>{mode === "continuous" ? "✓" : ""}</span>
        </button>
        <button
          className={"sheet-row" + (mode === "single" ? " active" : "")}
          onClick={() => onMode("single")}
        >
          <div><div className="title">单页</div><div className="muted">点左右两侧翻页</div></div>
          <span className={"badge" + (mode === "single" ? " sel" : "")}>{mode === "single" ? "✓" : ""}</span>
        </button>
      </div>
      {!NO_SEAM && <p className="muted">显示</p>}
      {/* ⚠️ 这三行**不能**用 `.sheet-actions`：那条规则是
          `.sheet-actions button:last-child { flex:1; background: var(--brand-deep); color:#fff }`，
          为「取消 / 确定」这种动作行设计的，会把**末位**按钮无条件画成实心黑主按钮。
          2026-09 在「翻页方向」上已经踩过一次（见 index.css 里 .seg-choice 的说明：
          「两个按钮都是实心黑、宽度 91 vs 289」），但后来加的这三行又用回了它 ——
          实测后果：状态栏 4 个 chip 里末位「时间」被拉成 350px 且是黑底、
          去条纹这个**开关**被画成全宽黑主按钮、跳页行的「下一页」比「上一页」宽 3 倍。
          现在统一走 `.settings-actions`（等宽、浅灰底、选中才用墨色实心）。 */}
      <div className="row settings-actions">
        {!offline && !NO_SEAM && (
          <button
            className={deseam ? "btn-deseam on" : ""}
            onClick={() => onToggleDeseam?.()}
            title="通过简单算法尝试去除部分漫画中的条纹（本地处理，不消耗额外流量）；亮=显示修复后，灭=显示原图"
          >
            {deseam ? "去条纹 ✓" : "去条纹"}
          </button>
        )}
      </div>
      {/* 翻页方向只对单页模式有意义，见文件头说明。样式走 .seg-choice，不复用 .sheet-actions —— 见 index.css */}
      {mode === "single" && (
        <>
          <p className="muted">翻页方向（点左右两侧时哪边是上一页）</p>
          <div className="seg-choice" role="group" aria-label="翻页方向">
            <button
              className={tapInvert ? "" : "on"}
              aria-pressed={!tapInvert}
              onClick={() => onTapInvert(false)}
              title="左侧点一下上一页，右侧点一下下一页（默认）"
            >
              左←上一页
            </button>
            <button
              className={tapInvert ? "on" : ""}
              aria-pressed={tapInvert}
              onClick={() => onTapInvert(true)}
              title="左右反转：适合左手持机 / 从右往左翻的阅读习惯"
            >
              右←上一页
            </button>
          </div>
        </>
      )}
      {/* v3.12 状态栏条目：进度条下面那一行读数显示什么。默认全关（一条都不显示）——
          开了哪几条就显示哪几条，顺序固定为 章节名 / 页码 / 百分比 / 时间。 */}
      <p className="muted">状态栏显示（进度条下面那一行）</p>
      <div className="row settings-actions">
        {([
          ["chapter", "章节名"],
          ["page", "页码"],
          ["pct", "百分比"],
          ["clock", "时间"]
        ] as const).map(([id, label]) => {
          const on = statusOn.indexOf(id) >= 0;
          return (
            <button
              key={id}
              className={on ? "on" : ""}
              aria-pressed={on}
              onClick={() => onToggleStatus(id)}
              title={on ? "点一下隐藏这一条" : "点一下在状态栏显示这一条"}
            >
              {label}{on ? " ✓" : ""}
            </button>
          );
        })}
      </div>
      <p className="muted">跳到第几页</p>
      {/* .page-jump：这一行有输入框、还可能多出「回到开头」，按钮不能像 chip 那样等分 */}
      <div className="row settings-actions page-jump">
        <button disabled={current <= 1} onClick={() => onJumpTo(current - 1)}>上一页</button>
        <input
          className="page-input mono-num"
          value={jumpInput}
          onChange={(e) => onJumpInput(e.target.value)}
          inputMode="numeric"
          onKeyDown={(e) => { if (e.key === "Enter") onJumpTo(Number(jumpInput)); }}
        />
        <span className="muted mono-num">/{total}</span>
        <button disabled={current >= total} onClick={() => onJumpTo(current + 1)}>下一页</button>
        {current > 1 && <button onClick={() => onJumpTo(1)}>回到开头</button>}
      </div>
    </Sheet>
  );
}
