import {
  LIST_COLUMN_OPTIONS,
  LIST_FIELD_META,
  LIST_FORM_OPTIONS,
  LIST_TITLE_OPTIONS,
  formUsesColumns,
  isListFieldHidden,
  moveListField,
  saveListLayout,
  setListColumns,
  setListFieldHidden,
  setListForm,
  setListTitleLines
} from "../core/listLayout";
import type { ListFieldId, ListLayoutConfig } from "../core/listLayout";
import { useListLayout } from "../hooks/useListLayout";
import { emit } from "../core/bus";

/**
 * 列表页画布里「卡片」的配置（v3.3）。
 *
 * ── 为什么有它 ──────────────────────────────────────────────────────
 * 用户第 3 条要求删掉「排布总表」。而列表页的配置（副标题字段顺序 / 显隐 / 每行列数）
 * 原先**只**存在于那张总表里 —— 删掉它就必须让"点画布里的区块进入配置"这条路对列表页也成立，
 * 否则这些配置项会**没有入口**（简报点名的硬不变量）。
 *
 * 列表页能配的东西比详情页少（刻意的，见 core/listLayout.ts 的说明）：无限流网格里
 * "工具行 / 错误卡 / 网格 / 加载中"重排没有意义，真正值得配的是**卡片副标题那一行小字**
 * 与每行列数。所以这里就是这两件。
 *
 * 与 NodeOrderList 的分工：那个管**详情页内层**（主视觉内序 / 四宫格字段），
 * 这个管**列表页卡片**。两者都遵循同一条：顺序用 ▲▼（配置表里没有可拖的抓手），
 * 显隐用开关。
 */
interface Props {
  /** 右上角「完成」 */
  onClose?: () => void;
}

export default function ListCardInspector({ onClose }: Props) {
  const cfg = useListLayout();

  /** 落地：写盘 + 广播（`useListLayout` 订阅了广播，所以画布与本面板会一起刷新） */
  function apply(next: ListLayoutConfig) {
    saveListLayout(next);
    emit("jm:listLayout");
  }

  const fields = cfg.fields;

  return (
    <div className="ed-listcard" data-module="list-card">
      <div className="ed-modbar">
        <p className="grpname">
          卡片
          <em className="dl-from">列表里每张卡片的样式</em>
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
        形态（v3.14）：最粗的一层，所以排在最前面。
        它是**外观**不是内容 —— 与详情页区块的「形态」同一个词、同一层意思。
      */}
      <div className="dl-style ed-width" data-width-key="list-form">
        <p className="grpname">
          卡片形态
          <em className="dl-from">同一张内容的不同外观</em>
        </p>
        <div className="seg-choice ed-span" aria-label="卡片形态">
          {LIST_FORM_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={cfg.form === o.value ? "on" : ""}
              aria-pressed={cfg.form === o.value}
              aria-label={"卡片形态 " + o.label}
              title={o.hint}
              onClick={() => apply(setListForm(cfg, o.value))}
            >{o.label}</button>
          ))}
        </div>
      </div>

      <div className="dl-style ed-width" data-width-key="list-columns">
        <p className="grpname">
          每行列数
          <em className="dl-from">跟随屏幕宽度，或固定列数</em>
        </p>
        {/*
          ⚠️ 轴冲突（v3.14）：单列行形态恒为 1 列 —— 此时**这一组整组不画**，
          只留一行说明。理由与详情页的 `formsFor` 完全一致：
          画一个点了不生效的控件比不画更糟（"面板上看得见的 == 读出来生效的"）。
          对照：`listColumnsClass` 在同一条件下也返回空串，两边是同一条判据。
        */}
        {formUsesColumns(cfg) ? (
          /* ⚠️ `aria-label` 是 e2e 契约（driver.js 的 COL_SEL 按它选档位按钮），
              与已删除的旧面板保持同一口径。刻意**不写** role="group"：
              oxlint 的 jsx-a11y(prefer-tag-over-role) 会为它记一条告警，而告警基线是"不许涨"的。 */
          <div className="seg-choice ed-span" aria-label="每行列数">
            {LIST_COLUMN_OPTIONS.map((o) => (
              <button
                key={String(o.value)}
                type="button"
                className={cfg.columns === o.value ? "on" : ""}
                aria-pressed={cfg.columns === o.value}
                aria-label={"每行列数 " + o.label}
                title={o.hint}
                onClick={() => apply(setListColumns(cfg, o.value))}
              >{o.label}</button>
            ))}
          </div>
        ) : (
          <p className="dl-hint">单列行形态下恒为 1 列 —— 要调列数，先切回「海报」或「封面压字」。</p>
        )}
      </div>

      <div className="dl-style ed-width" data-width-key="list-titlelines">
        <p className="grpname">
          标题行数
          <em className="dl-from">卡片标题最多几行</em>
        </p>
        <div className="seg-choice ed-span" aria-label="标题行数">
          {LIST_TITLE_OPTIONS.map((o) => (
            <button
              key={String(o.value)}
              type="button"
              className={cfg.titleLines === o.value ? "on" : ""}
              aria-pressed={cfg.titleLines === o.value}
              aria-label={"标题行数 " + o.label}
              title={o.hint}
              onClick={() => apply(setListTitleLines(cfg, o.value))}
            >{o.label}</button>
          ))}
        </div>
      </div>

      <p className="grpname">
        卡片副标题
        <em className="dl-from">卡片标题下面那一行小字，从上到下拼成一句</em>
      </p>
      <div className="dl-rows">
        {fields.map((id) => {
          const meta = LIST_FIELD_META[id];
          const hidden = isListFieldHidden(cfg, id);
          const vi = fields.filter((f) => !isListFieldHidden(cfg, f)).indexOf(id);
          return (
            <div className={"ditem" + (hidden ? " dl-off" : "")} key={id} data-node={id}>
              <span className="dl-label">{meta.label}</span>
              <span className="dl-ctl">
                <button
                  type="button" className="dl-step"
                  disabled={hidden || vi <= 0}
                  aria-label={"上移：" + meta.label} title="上移"
                  onClick={() => apply(moveListField(cfg, id as ListFieldId, -1))}
                >▲</button>
                <button
                  type="button" className="dl-step"
                  disabled={hidden}
                  aria-label={"下移：" + meta.label} title="下移"
                  onClick={() => apply(moveListField(cfg, id as ListFieldId, 1))}
                >▼</button>
                {meta.hideable && (
                  <button
                    type="button"
                    className={"switch" + (hidden ? "" : " on")}
                    aria-pressed={!hidden}
                    aria-label={(hidden ? "显示：" : "隐藏：") + meta.label}
                    title={hidden ? "已隐藏，点一下显示" : "显示中，点一下隐藏"}
                    onClick={() => apply(setListFieldHidden(cfg, id as ListFieldId, !hidden))}
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
