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
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
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
      <span className="ind" style={{ width: ind.width, transform: "translateX(" + ind.left + "px)" }} aria-hidden="true" />
    </div>
  );
}
