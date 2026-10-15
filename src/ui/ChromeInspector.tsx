import {
  CHROME_BAR_SECTIONS,
  CHROME_SECTION_HINT,
  CHROME_SECTION_LABEL,
  READER_CHROME_SECTIONS,
  chromeMetaOf,
  isChromeHidden,
  moveChromeUnitVisible,
  toggleChromeUnit
} from "../core/chromeLayout";
import type { ChromeLayoutConfig, ChromeSection, ChromeUnitMeta } from "../core/chromeLayout";
import {
  READER_AUTOHIDE_OPTIONS,
  READER_SCROLLBAR_OPTIONS,
  isReaderStyleKeyDefault,
  resetReaderStyleKey,
  setReaderStyle
} from "../core/readerStyle";
import type { ReaderStyleConfig } from "../core/readerStyle";

/**
 * 「顶栏和底栏」/「阅读器」两页的**配置面板**（v3.13）。
 *
 * ── 为什么这两页不像详情页那样"点画布上的区块才弹配置" ─────────────────
 * 详情页的块是**版面**（点它 → 调它的样式，位置关系一眼可见），而这里是**单元清单**：
 * 一个栏里就 2~4 个按钮，全列出来比"点了才知道有哪些"更省事，也保证**每个配置项都有入口**
 * （本项目最硬的不变量：删掉一个入口就必须在别处给一个新的）。
 * 画布仍然有用：点画布上的按钮 → 清单里对应的那一行会高亮（`ed-unitsel`），
 * 于是"画布上这个是哪个"不用猜。
 *
 * ── ▲▼ 用**可见顺序**而不是原始数组 ──────────────────────────────────
 * 隐藏项还占着表里的位置，在原始数组上换位会出现"点了没反应"（详见
 * `core/chromeLayout.moveChromeUnitVisible` 的说明）。这里与详情页 `NodeOrderList` 同一口径。
 */
interface Props {
  /** 这一页管哪几个分区（由 core/chromeLayout 的分区清单决定，UI 里不重写一份） */
  page: "chrome" | "reader";
  cfg: ChromeLayoutConfig;
  apply: (next: ChromeLayoutConfig) => void;
  /** 阅读器观感（只有 `page === "reader"` 时渲染那一块） */
  style: ReaderStyleConfig;
  onStyle: (next: ReaderStyleConfig) => void;
  /** 画布上选中的单元，形如 `"nav:search"`（用于高亮对应那一行） */
  selected: string | null;
}

export default function ChromeInspector({ page, cfg, apply, style, onStyle, selected }: Props) {
  const sections = page === "reader" ? READER_CHROME_SECTIONS : CHROME_BAR_SECTIONS;

  return (
    <div className="ed-chromeinsp">
      <p className="grpname">{(page === "reader" ? "阅读器" : "顶栏和底栏") + " · 单元"}</p>
      <p className="dl-hint">
        点画布上的按钮，下面会高亮到对应那一行。带「必需」的单元不可隐藏；
        其余的顺序与显隐都由你定。
      </p>

      {/* 阅读器：先说清"你正在调的是哪个界面"。**默认与常用模式是连续滚动**
          （上下滚、图片铺满整宽），单页模式是少数派 —— 以前页面里默认拿单页模式的样子演，
          与实际不符（用户反馈过"预览与实际不符"）。这句话 + 画布都按连续滚动来。 */}
      {page === "reader" && (
        <p className="dl-hint">
          阅读器默认是「连续滚动」（上下滚、图片铺满整宽）。这一页调的就是那个界面上的两条控制条与滚动观感 ——
          单页模式用的是同一批单元，所以这里改完两边都生效。
        </p>
      )}

      {/* 阅读器观感：两个档位轴。放在单元清单**之前** —— 它调的是"整个阅读器看起来怎么样"，
          比"哪个按钮在哪"更粗一层。 */}
      {page === "reader" && <ReaderStyleBlock cfg={style} onStyle={onStyle} />}

      {sections.map((section) => (
        <SectionTable
          key={section}
          section={section}
          cfg={cfg}
          apply={apply}
          selected={selected}
        />
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────
// 一个分区的单元表
// ────────────────────────────────────────────────
function SectionTable({
  section, cfg, apply, selected
}: {
  section: ChromeSection;
  cfg: ChromeLayoutConfig;
  apply: (next: ChromeLayoutConfig) => void;
  selected: string | null;
}) {
  const ids = cfg[section] as readonly string[];
  const table = chromeMetaOf(section) as Record<string, ChromeUnitMeta | undefined>;
  /** 可见顺序（隐藏项不占位）——▲▼ 的可用性与位移都按它算 */
  const vis = ids.filter((id) => !isChromeHidden(cfg, section, id));

  return (
    <div className="ed-nodelist" data-section={section}>
      <div className="ed-modbar">
        <p className="grpname">
          {CHROME_SECTION_LABEL[section]}
          <em className="dl-from">{CHROME_SECTION_HINT[section]}</em>
        </p>
      </div>
      <div className="dl-rows">
        {ids.map((id) => {
          const m = table[id];
          if (!m) return null;                        // 未知 id（归一化本来就该丢掉）：不画，不抛
          const hidden = isChromeHidden(cfg, section, id);
          const vi = vis.indexOf(id);
          const key = section + ":" + id;
          const note = m.need ? (m.note ? m.note + "｜" + m.need : m.need) : m.note;
          return (
            <div
              className={"ditem" + (hidden ? " dl-off" : "") + (selected === key ? " ed-unitsel" : "")}
              key={key}
              data-unit-row={key}
            >
              <span className="dl-label">
                {m.label}
                {!m.hideable && <em className="ed-req">必需</em>}
                {note && <em className="dl-note">{note}</em>}
              </span>
              <span className="dl-ctl">
                <button
                  type="button" className="dl-step"
                  disabled={hidden || vi <= 0}
                  aria-label={"上移：" + m.label} title="上移"
                  onClick={() => apply(moveChromeUnitVisible(cfg, section, id, -1))}
                >▲</button>
                <button
                  type="button" className="dl-step"
                  disabled={hidden || vi < 0 || vi >= vis.length - 1}
                  aria-label={"下移：" + m.label} title="下移"
                  onClick={() => apply(moveChromeUnitVisible(cfg, section, id, 1))}
                >▼</button>
                {/* 必需单元**连开关都不画**：画一个点了没反应的开关比不画更糟
                    （与 core/chromeLayout 的纪律②一致，也是详情页 NodeOrderList 的做法）。 */}
                {m.hideable && (
                  <button
                    type="button"
                    className={"switch" + (hidden ? "" : " on")}
                    aria-pressed={!hidden}
                    aria-label={(hidden ? "显示：" : "隐藏：") + m.label}
                    title={hidden ? "已隐藏，点一下显示" : "显示中，点一下隐藏"}
                    onClick={() => apply(toggleChromeUnit(cfg, section, id))}
                  ><i /></button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────
// 阅读器观感（档位轴）
// ────────────────────────────────────────────────
function ReaderStyleBlock({ cfg, onStyle }: { cfg: ReaderStyleConfig; onStyle: (next: ReaderStyleConfig) => void }) {
  const groups = [
    { key: "scrollbar" as const, label: "滚动条", hint: "连续模式下滚的是整页，这条就是个位置指示器", options: READER_SCROLLBAR_OPTIONS },
    { key: "autoHide" as const, label: "控制条自动隐藏", hint: "点一下画面浮出上下两条，过一会儿自己收起", options: READER_AUTOHIDE_OPTIONS }
  ];
  return (
    <>
      {groups.map((g) => (
        <div className="dl-style" data-style-key={"reader-" + g.key} key={g.key}>
          <p className="grpname">
            {g.label}
            <em className="dl-from">{g.hint}</em>
            {!isReaderStyleKeyDefault(cfg, g.key) && (
              <button
                type="button" className="dl-reset"
                aria-label={"恢复默认：" + g.label}
                title="恢复这一项的默认值"
                onClick={() => onStyle(resetReaderStyleKey(cfg, g.key))}
              >↺</button>
            )}
          </p>
          {/*
            ⚠️ 用 `<fieldset aria-label>` 而不是 `<div role="group" aria-label>`：
            后者会让 oxlint 的 `jsx-a11y(prefer-tag-over-role)` 多记一条 warning
            （项目基线 71 条不能涨），而 fieldset 本身**就是** group —— 语义一样、零代价。
            视觉上靠 CSS 把 fieldset 的默认边框 / 内边距 / 外边距清掉（见 index.css 的 `fieldset.seg-choice`）。
          */}
          <fieldset className="seg-choice" aria-label={g.label}>
            {g.options.map((o) => (
              <button
                key={o.value}
                type="button"
                className={cfg[g.key] === o.value ? "on" : ""}
                aria-pressed={cfg[g.key] === o.value}
                title={o.hint}
                onClick={() => onStyle(setReaderStyle(cfg, g.key, o.value))}
              >{o.label}</button>
            ))}
          </fieldset>
        </div>
      ))}
    </>
  );
}
