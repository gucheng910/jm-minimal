// 下划线标签行（分类行 / 二级行 / 搜索类型都用它）
// 选中态 = 深色文字 + 2px 圆角下划线（滑过去，220ms），没有色块、没有加粗
import { useEffect, useLayoutEffect, useRef, useState } from "react";

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

/** scrollTo(options) 字典签名在 WebView < 61 上不存在（会抛异常）；探测一次后缓存结果 */
let scrollOptionsOk: boolean | null = null;

export default function UnderlineTabs({ items, value, onChange, scroll, className }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [ind, setInd] = useState({ left: 0, width: 0 });

  const measure = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const el = wrap.querySelector<HTMLElement>('[data-on="1"]');
    if (!el) { setInd({ left: 0, width: 0 }); return; }
    setInd({ left: el.offsetLeft, width: el.offsetWidth });
  };

  useLayoutEffect(measure, [value, items]);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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
    // 老内核（WebView < 61）没有 scrollTo(options) 字典签名，调用会直接抛错 —— 先探测一次并缓存结果
    if (scrollOptionsOk === null) {
      try { wrap.scrollTo({ left: wrap.scrollLeft }); scrollOptionsOk = true; }
      catch { scrollOptionsOk = false; }
    }
    if (scrollOptionsOk) wrap.scrollTo({ left: target, behavior: "smooth" });
    else wrap.scrollLeft = target;
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
