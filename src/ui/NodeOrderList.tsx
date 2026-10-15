import { useState } from "react";
import {
  DETAIL_NODE_META,
  isHidden,
  moveVisibleNodeTo,
  setDetailNodeHidden
} from "../core/detailLayout";
import type { DetailLayoutConfig, DetailNodeId } from "../core/detailLayout";

/**
 * 「某一块**内部**的节点顺序 + 显隐」配置表（v3.3）。
 *
 * ── 为什么需要它（这是本波最硬的约束）────────────────────────────────
 * 用户第 3 条要求删掉「排布总表」，同时要求把内层字段的配置收进对应区块的配置里：
 * 「下面的信息栏内和四宫格字段就直接挪到点击信息栏进入的配置里吧，更合适」。
 * 总表里放着 `heroSlots` / `heroInfoSlots` / `facts` 这三层的顺序与显隐 ——
 * **删掉总表就必须给这些配置项一个新的入口**，否则会出现"某个配置项没有入口"
 * （简报里点名的硬不变量）。
 *
 * ── 顺序一律按「可见列表」算 ────────────────────────────────────────
 * 隐藏项不占位：`moveVisibleNodeTo(cfg, id, visibleIndex)` 的 visibleIndex 与画布
 * DOM 下标**同一个空间**（Slot-2 修过这个口径）。所以这里的 ▲▼ 与画布上拖出来的
 * 结果完全一致，不会出现"表里往上挪一格、画布上跳两格"。
 *
 * 为什么这里保留 ▲▼（而区块检查器里删掉了）：用户第 5 条要求的是**区块**的位置靠长按拖动，
 * 而内层字段在 v3.5 之后**画布上根本不可拖**（用户第 3 条：内层不做成可点选的模块）——
 * 所以这两个按钮是内层顺序**唯一**的入口，不是"重复的退路"。删掉它们 = 砍能力。
 */
interface Props {
  /** 表标题，如「信息栏内的顺序」 */
  title: string;
  /** 这一组的节点顺序（直接用配置里的那张表，尊重用户当前顺序） */
  ids: readonly DetailNodeId[];
  cfg: DetailLayoutConfig;
  apply: (next: DetailLayoutConfig) => void;
  /** 右上角「完成」（收起这一块配置） */
  onClose?: () => void;
  /**
   * 标题旁边那句小字（默认**不显示**）。
   *
   * ⚠️ v3.5：默认那句原来是"也可以在画布上直接长按拖动" —— 用户第 3 条要求内层**不再**
   * 做成可点选/可拖的模块（「主视觉是一个大模块，封面信息栏和四宫格等等也是在主视觉的
   * 配置里设置，而不是也都做成可点击的模块」），那句话从**所有**调用方起都是假的，
   * 所以默认值改成 `null`（不显示）。要写提示就显式传 `note="…"`。
   */
  note?: string | null;
  /**
   * 至少留几个可见（v3.5；`detail` 的三个面板用 1 —— 全关 = 区块空盒）。
   *
   * 点最后一个可见项的开关时：**不改配置**，而是显示 `refuseHint`。
   * 为什么不用 `disabled`：禁用的开关**不解释任何东西**，用户只会觉得"坏了"；
   * 而这里的口径是"要解释，不要哑掉" —— 所以能点、点了告诉你为什么不行。
   */
  minVisible?: number;
  /** 被拒绝时显示的那行说明（配合 `minVisible`） */
  refuseHint?: string;
}

export default function NodeOrderList({ title, ids, cfg, apply, onClose, note, minVisible, refuseHint }: Props) {
  /** 可见列表：隐藏项不占位，与画布下标同一口径 */
  const visible = ids.filter((id) => !isHidden(cfg, id));
  /** 上一次操作被"至少留一个"挡下了 → 把那行说明显示出来（不是静默吞掉） */
  const [refused, setRefused] = useState(false);

  /**
   * 点开关。隐藏动作会先问"还剩几个"——到下限就**只解释、不改配置**。
   * 判断放在这里而不是模型层：模型层没有"要显示一行字"的能力，
   * 而这一次拒绝必须**可见**（见 Props 里 minVisible 的说明）。
   */
  function toggle(id: DetailNodeId, hidden: boolean) {
    if (!hidden && minVisible !== undefined && visible.length <= minVisible) {
      setRefused(true);
      return;
    }
    setRefused(false);
    apply(setDetailNodeHidden(cfg, id, !hidden));
  }

  return (
    <div className="ed-nodelist">
      <div className="ed-modbar">
        <p className="grpname">
          {title}
          {note != null && (
            <em className="dl-from">{note}</em>
          )}
        </p>
        {onClose && (
          <button
            type="button"
            className="ed-paneldone"
            onClick={() => onClose()}
          >完成</button>
        )}
      </div>

      <div className="dl-rows">
        {ids.map((id) => {
          const meta = DETAIL_NODE_META[id];
          const hidden = isHidden(cfg, id);
          const vi = visible.indexOf(id);
          return (
            <div className={"ditem" + (hidden ? " dl-off" : "")} key={id} data-node={id}>
              <span className="dl-label">{meta.label}</span>
              <span className="dl-ctl">
                <button
                  type="button" className="dl-step"
                  disabled={hidden || vi <= 0}
                  aria-label={"上移：" + meta.label} title="上移"
                  onClick={() => apply(moveVisibleNodeTo(cfg, id, vi - 1))}
                >▲</button>
                <button
                  type="button" className="dl-step"
                  disabled={hidden || vi < 0 || vi >= visible.length - 1}
                  aria-label={"下移：" + meta.label} title="下移"
                  onClick={() => apply(moveVisibleNodeTo(cfg, id, vi + 1))}
                >▼</button>
                {meta.hideable && (
                  <button
                    type="button"
                    className={"switch" + (hidden ? "" : " on")}
                    aria-pressed={!hidden}
                    aria-label={(hidden ? "显示：" : "隐藏：") + meta.label}
                    title={hidden ? "已隐藏，点一下显示" : "显示中，点一下隐藏"}
                    onClick={() => toggle(id, hidden)}
                  ><i /></button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {/* 用 <output> 而不是 role="status"：后者会触发 jsx-a11y(prefer-tag-over-role)，
          把项目的告警基线抬上去（而这条本来就是"这条消息要念出来"的意思）。 */}
      {refused && refuseHint && <output className="dl-hint ed-refuse">{refuseHint}</output>}
    </div>
  );
}
