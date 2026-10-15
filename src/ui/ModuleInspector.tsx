import {
  DEFAULT_DETAIL_STYLE,
  DETAIL_STYLE_META,
  STYLE_RANGE,
  isDetailStyleKeyDefault,
  resetDetailStyleKey,
  setDetailStyle
} from "../core/detailStyle";
import type { DetailStyleConfig, DetailStyleKey, StyleControl } from "../core/detailStyle";
import { SPAN_DEFAULT, SPAN_OPTIONS } from "../core/detailLayout";
import type { DetailFormOption, DetailNodeId, SlotSpan } from "../core/detailLayout";

/**
 * 「自定义 UI」画布的**选中模块专属检查器** —— 点到哪个块，就只弹那个块的配置。
 *
 * v2 的核心诉求（用户原话）：「不应该是点到哪个 UI 才弹出那个 UI 的单独的
 * 精细化一点的配置吗，比如滑块控制大小啥的」。所以这里不再常驻一篇全局档位表：
 *   · 每个块有自己的**专属键**（BLOCK_STYLE_KEYS），没有专属键的块只给动作行；
 *   · 尺寸类是**有界滑块**（core/detailStyle.STYLE_RANGE 就是两端的安全边界）；
 *   · 共享动作行（▲▼ / 显隐）永远在 —— 排序与显隐是每个块都有的能力。
 *
 * 保留 v1 两条从 Webstudio 抄来的交互：单项复位 ↺（只在被改过时画）与
 * 「改过」圆点（只在该块的键被改过时点）。
 *
 * ⚠️ 回调一律包箭头函数再交给 onClick / onChange（不包的话事件会当成第一个实参
 *    灌进调用方，报告 §14.3 真踩过）。
 */

/**
 * 每个顶层块的专属配置键。没列出来的块 = 没有专属样式，只剩动作行。
 *
 * ⚠️ 语义澄清（防误解）：`detailStyle` 的键是**全局一份值**，不是"每个块各自的字号"。
 * 这张表表达的是「**选中这个块时，检查器里显示哪几项**」。所以 hero 里调「数据条字号」
 * 只影响数据条本身（那个键只挂在 `.d-stat` 上），不会串到别的块；但同一项被选两次永远是同一个值。
 * 将来若要做"每块独立值"，需要另建每块配置存储 —— 不在本表的能力范围内。
 *
 * v3：把 tags / actors / action / detail 四个原本"点进去空空"的块填上，
 * 并给 hero / desc 各补强（明细与安全论证见工作台 jm-stylekeys-plan.md）。
 *
 * ⚠️ v3.4（Wave I）：**`notice` 这一行已删除**。付费提示不再是一个区块（并入动作区
 * 主按钮），而它在这里只剩「提示字号」一个滑块 —— 那块本来就不渲染任何东西，
 * 于是滑块改不动任何东西 = 用户最恨的**哑控件**。区块本身也从 `DETAIL_BLOCK_IDS`
 * 移走了，所以这张表里再留着它既进不去也不该进去。
 */
export const BLOCK_STYLE_KEYS: Partial<Record<DetailNodeId, DetailStyleKey[]>> = {
  hero: ["cover", "heroLayout", "title", "statFont", "factFont"],
  desc: ["desc", "descFont", "descLine", "descAll"],
  tags: ["tagSize"],
  actors: ["actorSize"],
  action: ["actionPadY", "actionFont"],
  detail: ["tabGap", "chapLayout", "chapOrder", "chapFilter", "chapFont"]
  // back 不列 → 保持"只有动作行"（它是导航件，且 .backtxt 的字号是全站返回按钮的统一语言）
};

interface Props {
  /**
   * 选中的**块或内嵌槽位**（v3 内嵌可拖起放宽到 `DetailNodeId`）。
   *
   * 内嵌槽位（title / facts / author…）目前在 `BLOCK_STYLE_KEYS` 里没有专属样式键
   * → 只显示"位置 + 动作行"（▲▼ / 显隐）。它们的主要能力是**顺序**（内嵌可拖），
   * 而不是样式 —— 这是刻意的，不是漏做。
   */
  blockId: DetailNodeId;
  /** 显示名（来自 detailLayout 的 DETAIL_NODE_META） */
  label: string;
  /** 当前是第几块（0 起）/ 共几块，给「上移 / 下移」画禁用态 */
  index: number;
  total: number;
  hidden: boolean;
  /** 能不能隐藏（返回 / 动作区钉死） */
  canHide: boolean;
  cfg: DetailStyleConfig;
  onStyle: (next: DetailStyleConfig) => void;
  /**
   * 滑块专用通道（收尾波）：**滑动中**只动内存，由调用方防抖后再落盘 + 广播一次。
   * 不传就退回 `onStyle`（每次改动立即落盘）—— 语义上仍是安全的，只是手机上会卡。
   */
  onStyleLive?: (next: DetailStyleConfig) => void;
  /** 松手立刻收尾（把 live 通道挂起的那次提交立刻落盘，不等防抖到期） */
  onStyleFlush?: () => void;
  onToggleHidden: () => void;
  /**
   * v3：这一块在 12 列网格里占几格（12 = 满宽 = 独占一行）。
   * **只有顶层块有宽度** —— 内嵌槽位（左右两栏 / 信息栏内 / 四宫格字段）不参与网格，
   * 调用方对它们不传这两个 prop，宽度整行随之不渲染（而不是显示一个假的"独占一行"）。
   */
  span?: SlotSpan;
  onSpan?: (span: SlotSpan) => void;
  /**
   * v3.4 **行内位置**：这一块从第几列起（0-based，`0 ~ 12-span`）。
   *
   * 用户要的是「1/2 宽的块可以固定在该行中间，而不是必须顶格」，所以宽度之外还要位置。
   * 与宽度同一套门控：只有顶层块传，且只有不满宽时这一行才出现（满宽块没有位置可言）。
   */
  offset?: number;
  onOffset?: (offset: number) => void;
  /**
   * v3.5 **形态**：这一块可以有哪些呈现方式（注册表 `core/detailLayout.DETAIL_BLOCK_FORMS`）。
   *
   * 只有长度 > 1 时才渲染那一行 —— 只有一个形态 = 没得选 = 又一个哑控件。
   * 用**档位**而不是开关：形态是会继续增加的维度（`detail` 之后还会有别的块加），
   * 开关只能表达两个状态，第三个形态一进来语义就崩。
   */
  forms?: readonly DetailFormOption[];
  /** 当前生效的形态 id（缺省 = 注册表第一项 = 默认形态） */
  form?: string;
  onForm?: (id: string) => void;
  /** v3.3：关闭本配置栏（右上角「完成」）。不传则不渲染那个按钮。 */
  onClose?: () => void;
}

export default function ModuleInspector({
  blockId, label, index, total, hidden, canHide, cfg, onStyle, onStyleLive, onStyleFlush, onToggleHidden,
  span, onSpan, offset, onOffset, forms, form, onForm, onClose
}: Props) {
  const keys = BLOCK_STYLE_KEYS[blockId] || [];
  const controls = DETAIL_STYLE_META.filter((m) => keys.indexOf(m.key) >= 0);
  /** 这一块自己的键被改过 → 标题点圆点 */
  const touched = keys.some((k) => !isDetailStyleKeyDefault(cfg, k));

  return (
    <div className="ed-module" data-module={blockId}>
      {/* 标题行 + 右上角「完成」（用户第 9 条：所有区块配置栏都要有个方便收起的地方） */}
      <div className="ed-modbar">
        <p className="grpname">
          {label}
          <em className="dl-from">第 {index + 1} 块 / 共 {total} 块</em>
          {touched && <i className="dl-dot" title="这一块被改过" aria-label="这一块被改过" />}
        </p>
        {onClose && (
          <button
            type="button"
            className="ed-paneldone"
            onClick={() => onClose()}
          >完成</button>
        )}
      </div>

      {/*
        v3.3：**显示 / 隐藏**挪到配置栏最上面（用户第 5 条「放到唤出的配置的最上面」），
        同时删掉了原先那一行的 ▲▼ —— 位置只靠**长按拖动**改（顺序不再是配置项）。
      */}
      {canHide && (
        <div className="dl-rows ed-showrow">
          <div className={"ditem" + (hidden ? " dl-off" : "")}>
            <span className="dl-label">{hidden ? "已隐藏" : "显示中"}</span>
            <span className="dl-ctl">
              <button
                type="button"
                className={"switch" + (hidden ? "" : " on")}
                aria-pressed={!hidden}
                aria-label={(hidden ? "显示：" : "隐藏：") + label}
                title={hidden ? "已隐藏，点一下显示" : "显示中，点一下隐藏"}
                onClick={() => onToggleHidden()}
              ><i /></button>
            </span>
          </div>
        </div>
      )}

      {/*
        v3 宽度档位（12 列制）。**并排是"配出来"的，不是系统强制的**：
        把两个块都设成 1/2，它们自然落进同一行；设成满宽则各占一行。
        用档位而不是滑块：12 列里合理的跨格数是离散几个（满宽/8/6/4/3），
        滑块会产生 7、5、11 这种凑不满一行也说不清语义的值（调研 §2.2）。
      */}
      {span !== undefined && onSpan && <div className="dl-style ed-width" data-width-key={blockId}>
        <p className="grpname">
          宽度
          <em className="dl-from">{span === SPAN_DEFAULT ? "独占一行" : "占 12 列中的 " + String(span) + " 列"}</em>
          {span !== SPAN_DEFAULT && (
            <button
              type="button" className="dl-reset"
              aria-label="恢复默认：宽度" title="恢复默认宽度（独占一行）"
              onClick={() => onSpan(SPAN_DEFAULT)}
            >↺</button>
          )}
        </p>
        {/* 不用 role="group"：会触发 jsx-a11y(prefer-tag-over-role)（项目基线 73 条 warning 不能再涨）。
            无障碍信息放在每个按钮自己的 aria-label 上 —— "1/2" 单独念出来没有含义，加上"宽度"前缀才有。 */}
        <div className="seg-choice ed-span">
          {SPAN_OPTIONS.map((o) => (
            <button
              key={o.span}
              type="button"
              className={span === o.span ? "on" : ""}
              aria-pressed={span === o.span}
              aria-label={"宽度 " + o.label}
              title={o.hint}
              onClick={() => onSpan(o.span)}
            >{o.label}</button>
          ))}
        </div>
        {span !== SPAN_DEFAULT && (
          // v3.3：窄屏降级已取消 —— 手机上就是按你设的宽度排，不再"自动改成堆叠"
          <p className="dl-hint ed-span-hint">窄屏也保持并排（不做降级）</p>
        )}
      </div>}

      {/*
        v3.4 行内位置（用户第 7 条）：1/2 宽的块不必顶格，可以停在行中间。
        三档「左 / 中 / 右」覆盖用户要的语义，旁边给一对 ◀ ▶ 做**逐列微调** ——
        模型里 offset 就是 0~12-span 的整数列，所以微调不需要新概念。
        只在不满宽时出现：满宽块 offset 恒为 0（模型层也强制），渲染这一行只会误导。
      */}
      {span !== undefined && span !== SPAN_DEFAULT && offset !== undefined && onOffset && (() => {
        const max = 12 - span;
        const mid = Math.floor(max / 2);
        const col = "从第 " + String(offset + 1) + " 列起";
        return (
          <div className="dl-style ed-offset" data-offset-key={blockId}>
            <p className="grpname">
              位置
              <em className="dl-from">{offset === 0 ? "顶格（默认）" : offset === mid && mid > 0 ? "居中" : col}</em>
              {offset !== 0 && (
                <button
                  type="button" className="dl-reset"
                  aria-label="恢复默认：位置" title="回到顶格"
                  onClick={() => onOffset(0)}
                >↺</button>
              )}
            </p>
            <div className="seg-choice ed-offsetseg">
              <button type="button" className={offset === 0 ? "on" : ""} aria-pressed={offset === 0}
                aria-label="位置 左（顶格）" onClick={() => onOffset(0)}>左</button>
              <button type="button" className={offset === mid && mid > 0 ? "on" : ""} aria-pressed={offset === mid && mid > 0}
                aria-label="位置 居中" disabled={mid === 0} onClick={() => onOffset(mid)}>中</button>
              <button type="button" className={offset === max ? "on" : ""} aria-pressed={offset === max}
                aria-label="位置 右（靠右）" onClick={() => onOffset(max)}>右</button>
            </div>
            <div className="ed-offsetnudge">
              <button type="button" className="dl-nudge" aria-label="左移一格" title="左移一格"
                disabled={offset <= 0} onClick={() => onOffset(offset - 1)}>◀</button>
              <output className="dl-out">{col}</output>
              <button type="button" className="dl-nudge" aria-label="右移一格" title="右移一格"
                disabled={offset >= max} onClick={() => onOffset(offset + 1)}>▶</button>
            </div>
          </div>
        );
      })()}

      {/*
        v3.5「形态」（用户第 4 条）：同一块的**不同呈现方式**。
        档位语言与「宽度 / 位置」一致（.seg-choice + ↺ 单项复位），
        当前这一档的说明直接写在下面 —— 用户不必点一遍才知道"折叠三行"是什么意思。
      */}
      {forms && forms.length > 1 && onForm && (() => {
        const cur = forms.find((f) => f.id === form) || forms[0];
        const isDefault = cur.id === forms[0].id;
        return (
          <div className="dl-style ed-form" data-form-key={blockId}>
            <p className="grpname">
              形态
              <em className="dl-from">{cur.label}</em>
              {!isDefault && (
                <button
                  type="button" className="dl-reset"
                  aria-label="恢复默认：形态" title="回到默认形态"
                  onClick={() => onForm(forms[0].id)}
                >↺</button>
              )}
            </p>
            <div className="seg-choice ed-formseg">
              {forms.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={f.id === cur.id ? "on" : ""}
                  aria-pressed={f.id === cur.id}
                  aria-label={"形态 " + f.label}
                  title={f.hint}
                  onClick={() => onForm(f.id)}
                >{f.label}</button>
              ))}
            </div>
            <p className="dl-hint ed-formhint">{cur.hint}</p>
          </div>
        );
      })()}

      {controls.map((m) => (
        <StyleRow key={m.key} meta={m} cfg={cfg} onStyle={onStyle} onStyleLive={onStyleLive} onStyleFlush={onStyleFlush} />
      ))}
    </div>
  );
}

/** 一行配置控件：滑块（尺寸类）/ 开关（布尔）/ 档位（语义类，本检查器里目前没有） */
function StyleRow({ meta, cfg, onStyle, onStyleLive, onStyleFlush }: {
  meta: StyleControl;
  cfg: DetailStyleConfig;
  onStyle: (next: DetailStyleConfig) => void;
  onStyleLive?: (next: DetailStyleConfig) => void;
  onStyleFlush?: () => void;
}) {
  const key = meta.key;
  const isDefault = isDetailStyleKeyDefault(cfg, key);
  /** 连续输入（滑块）走 live 通道：滑动中只动内存，落盘交给上层防抖 —— 不传就退回立即落盘 */
  const live = onStyleLive || onStyle;
  return (
    <div className="dl-style" data-style-key={key}>
      <p className="grpname">
        {meta.label}
        <em className="dl-from">{meta.why}</em>
        {!isDefault && (
          <button
            type="button" className="dl-reset"
            aria-label={"恢复默认：" + meta.label}
            title="恢复这一项的默认值"
            onClick={() => onStyle(resetDetailStyleKey(cfg, key))}
          >↺</button>
        )}
      </p>

      {meta.kind === "slider" && (() => {
        const r = STYLE_RANGE[meta.key];
        return (
          <div className="dl-slider">
            <input
              type="range"
              min={r.min} max={r.max} step={r.step} value={cfg[meta.key]}
              aria-label={meta.label}
              // 「简介显示全部」开着时行数滑块没意义，禁掉但保留位置
              disabled={meta.key === "desc" && cfg.descAll}
              // 滑块是**连续输入**：走 live 通道（上层防抖后一次落盘），别每帧写盘 + 广播
              onChange={(e) => live(setDetailStyle(cfg, meta.key, Number(e.target.value)))}
              // 松手立刻收尾（不等防抖到期）：用户预期"拖完就生效、就保存"
              onPointerUp={() => onStyleFlush?.()}
            />
            <output className="dl-out">{String(cfg[meta.key])}{meta.unit}</output>
          </div>
        );
      })()}

      {meta.kind === "switch" && (
        <div className="dl-slider">
          <button
            type="button"
            className={"switch" + (cfg[meta.key] ? " on" : "")}
            aria-pressed={cfg[meta.key]}
            aria-label={meta.label}
            title={meta.label}
            onClick={() => onStyle(setDetailStyle(cfg, meta.key, !cfg[meta.key]))}
          ><i /></button>
        </div>
      )}

      {/*
        v3：档位项也要能在模块检查器里出现（登场人物的字号就是档位）。
        在此之前 StyleRow 只认 slider / switch，档位项会**静默什么都不渲染** ——
        用户点「登场人物」还是看不到东西。控件语言与「页面设置」里的疏密/圆角一致（.seg-choice）。
      */}
      {meta.kind === "options" && (
        /* 刻意不写 role="group"：oxlint 的 jsx-a11y(prefer-tag-over-role) 会为它加一条告警，
           而本项目的告警基线是 73 条（把它当"不许变差"的刻度）。这里的可读性由上方
           .grpname 那一行（"人物字号" + 说明）与每个按钮自己的文字 + aria-pressed 承担。 */
        <div className="seg-choice">
          {meta.options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={cfg[meta.key] === o.value ? "on" : ""}
              aria-pressed={cfg[meta.key] === o.value}
              onClick={() => onStyle(setDetailStyle(cfg, meta.key, o.value as DetailStyleConfig["density"] & DetailStyleConfig["radius"]))}
            >{o.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 供外部复用：默认值（例如给滑块画刻度端点文案） */
export const STYLE_DEFAULTS = DEFAULT_DETAIL_STYLE;
