// 下划线标签行（分类行 / 二级行 / 搜索类型都用它）
// 选中态 = 深色文字 + 2px 圆角下划线（滑过去，220ms），没有色块、没有加粗
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { scrollToLeft } from "../core/dom";
import { isLowFx } from "../core/lowfx";

export interface UnderlineTab {
  key: string;
  label: string;
}

interface Props {
  items: UnderlineTab[];
  value: string;
  onChange: (key: string) => void;
  /** 选中项变化时把它滚到可视区中央（分类行很长） */
  scroll?: boolean;
  className?: string;
}

export default function UnderlineTabs({ items, value, onChange, scroll, className }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [ind, setInd] = useState({ left: 0, width: 0 });

  /**
   * 量测当前选中项相对标签行的位置。
   * 用 getBoundingClientRect 而不是 offsetLeft/offsetWidth：老内核上标签之间是 margin 补的间距
   * （gap 不支持），rect 才包含 margin；另外它不依赖 offsetParent，滚动容器里也算得准。
   */
  const measure = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const el = wrap.querySelector<HTMLElement>('[data-on="1"]');
    if (!el) { setInd({ left: 0, width: 0 }); return; }
    const wr = wrap.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const left = er.left - wr.left + wrap.scrollLeft;
    if (!isFinite(left) || !isFinite(er.width)) return;
    setInd({ left: Math.round(left * 100) / 100, width: Math.round(er.width * 100) / 100 });
  };

  useLayoutEffect(measure, [value, items]);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    // 老设备首帧字体/布局可能还没落定，补两次量测，避免下划线停在前一个位置上
    const t1 = window.setTimeout(measure, 150);
    const t2 = window.setTimeout(measure, 700);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!scroll) return;
    const wrap = wrapRef.current;
    const el = wrap && wrap.querySelector<HTMLElement>('[data-on="1"]');
    if (!wrap || !el) return;
    /**
     * ⚠️ 这里绝对不能用 el.scrollIntoView()：它会把「所有可滚动祖先」一起滚，window 也在内。
     * 从详情页返回列表时，滚动位置刚被 useLayoutEffect 恢复（可能几千 px），
     * 本组件若在此刻挂载/变化，scrollIntoView({block:"nearest"}) 会把整页平滑滚回顶部
     * —— 即「分类页下滑进详情，返回后回到列表开头」的真机 bug（2026-09-11 定位）。
     * 只计算标签行自身需要的横向位移，纵向位置完全不动。
     */
    const target = Math.max(0, Math.min(
      el.offsetLeft - (wrap.clientWidth - el.offsetWidth) / 2,
      wrap.scrollWidth - wrap.clientWidth
    ));
    if (Math.abs(target - wrap.scrollLeft) < 1) return;
    // 低配模式不做平滑滚动（动效全关）；老内核连 Element.scrollTo 都没有，由 scrollToLeft 兜底赋值
    scrollToLeft(wrap, target, !isLowFx());
  }, [value, scroll]);

  return (
    <div className={"tabs" + (className ? " " + className : "")} ref={wrapRef}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <button
            key={it.key || "__all"}
            type="button"
            data-on={on ? "1" : "0"}
            className={"tk" + (on ? " on" : "")}
            onClick={() => onChange(it.key)}
          >
            {it.label}
          </button>
        );
      })}
      <span className="ind" style={{ transform: "translateX(" + ind.left + "px) scaleX(" + ind.width + ")" }} aria-hidden="true" />
    </div>
  );
}
