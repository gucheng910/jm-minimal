// 折叠面板：把「{open && <div/>}」的瞬间撑开改成高度 + 透明度过渡。
// 约定（来自动效评审）：
//   · 高度用 JS 量，不动画到 auto；内容自身变化时用 ResizeObserver 跟随（比如 DNS 卡里再展开一层）；
//   · 首次展开才挂载内容（保持原来的按需副作用：标签屏蔽/相关漫画都是展开后才请求/加载图片），
//     之后再收起只把高度归零，状态留着（再次展开不用重新拉数据）；
//   · 200ms：这是唯一逐帧触发布局的动画类别，短一点既省电也不拖沓。
//   · 收起时 inert + aria-hidden，键盘/读屏不会落到看不见的内容上。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface Props {
  open: boolean;
  children: ReactNode;
  className?: string;
}

export default function Collapse({ open, children, className }: Props) {
  const inner = useRef<HTMLDivElement | null>(null);
  const [h, setH] = useState(0);
  // 首次展开后才挂载内容
  const [ever, setEver] = useState(open);
  useEffect(() => { if (open) setEver(true); }, [open]);

  useLayoutEffect(() => {
    if (!ever) return;
    const el = inner.current;
    if (!el) return;
    const measure = () => setH(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ever, open]);

  return (
    <div
      className={"collapse" + (className ? " " + className : "")}
      data-open={open ? "" : undefined}
      style={{ height: open ? h : 0 }}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="collapse-inner" ref={inner}>{ever ? children : null}</div>
    </div>
  );
}
