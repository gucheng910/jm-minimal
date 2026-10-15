import {
  DETAIL_STYLE_META,
  isDetailStyleKeyDefault,
  isDetailStyleModified,
  resetDetailStyle,
  resetDetailStyleKey,
  setDetailStyle
} from "../core/detailStyle";
import type { DetailStyleConfig, StyleControl } from "../core/detailStyle";

/**
 * 详情页「页面设置」—— 版面疏密 / 圆角两个**语义档位** + 恢复默认。
 *
 * v1 的「样式与大小」整表拆成了两半：尺寸类进了 `ModuleInspector`
 * （选中哪个块就调哪个块，滑块），语义类留在这里（档位语义用滑块反而难选准）。
 * 从常驻整表变成「齿轮里按需展开」——用户不点它就不占画布空间。
 *
 * 两条从 Webstudio 抄来的交互保留：单项复位 ↺（只在被改过时画）与
 * 「改过」圆点。⚠️ 回调一律包箭头函数再交给 onClick。
 */

interface Props {
  cfg: DetailStyleConfig;
  onStyle: (next: DetailStyleConfig) => void;
}

export default function PageStyleSheet({ cfg, onStyle }: Props) {
  return (
    <div className="ed-pagestyle">
      <p className="grpname">
        页面设置
        {isDetailStyleModified(cfg) && <i className="dl-dot" title="有项被改过" aria-label="有项被改过" />}
      </p>
      <p className="dl-hint">只影响详情页。每一项都可以单独恢复默认。</p>

      {/*
        只列**页面级**的档位项（疏密 / 圆角）。
        v3 加了 `scope` 字段：登场人物的字号也是档位项，但它属于某个块，
        只该在「选中登场人物」时出现在模块检查器里 —— 不加这道过滤它会在
        「页面设置」里多冒一份，用户会以为那是全局字号。
        ⚠️ 谓词必须写全（`m is ...`）：条件从单一 `m.kind === "options"` 变成复合表达式后，
        TS 的推断式类型收窄不再生效，`m.options` 会报 "Property 'options' does not exist"。
      */}
      {DETAIL_STYLE_META.filter(
        (m): m is Extract<StyleControl, { kind: "options" }> => m.kind === "options" && m.scope !== "block"
      ).map((m) => {
        const isDefault = isDetailStyleKeyDefault(cfg, m.key);
        return (
          <div className="dl-style" data-style-key={m.key} key={m.key}>
            <p className="grpname">
              {m.label}
              <em className="dl-from">{m.why}</em>
              {!isDefault && (
                <button
                  type="button" className="dl-reset"
                  aria-label={"恢复默认：" + m.label}
                  title="恢复这一项的默认值"
                  onClick={() => onStyle(resetDetailStyleKey(cfg, m.key))}
                >↺</button>
              )}
            </p>
            <div className="seg-choice" role="group" aria-label={m.label}>
              {m.options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={cfg[m.key] === o.value ? "on" : ""}
                  aria-pressed={cfg[m.key] === o.value}
                  onClick={() => onStyle(setDetailStyle(cfg, m.key, o.value as DetailStyleConfig["density"] & DetailStyleConfig["radius"]))}
                >{o.label}</button>
              ))}
            </div>
          </div>
        );
      })}

      <div className="row sheet-actions">
        <button type="button" onClick={() => onStyle(resetDetailStyle())}>恢复默认样式</button>
      </div>
    </div>
  );
}
