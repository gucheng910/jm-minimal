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
    if (typeof ResizeObserver !== "undefined") {
      // RO 回调里同步 setState 会立刻改外层 .collapse 的高度，可能在同一帧再产生一次尺寸通知，
      // 浏览器随即抛 "ResizeObserver loop completed with undelivered notifications"（底部红条来源之一）。
      // 推迟一帧执行，把布局写入挪出通知投递过程。
      let raf = 0;
      const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); });
      ro.observe(el);
      return () => { ro.disconnect(); cancelAnimationFrame(raf); };
    }
    // 老内核没有 ResizeObserver（Chrome 64 才引入，而 compat 包要跑到 WebView 57）：
    // 高度只在「展开这一瞬」量一次，之后封面图加载完、评论异步到达都会把内容撑高，
    // 而 .collapse 是 overflow:hidden → 多出来的部分被**永久裁掉**。
    // 实测（2026-09-13）：详情页展开「相关漫画」时面板量到 523px，图片加载后内容 691px，
    // 底部 168px 一直看不到，且不会自愈。
    // 补两个「内容变高了」的信号：图片 load（load 不冒泡，必须用捕获）+ DOM 变动（评论追加），
    // 再加几次延迟重测，兜住"布局比图片事件更晚到"的情况。
    const timers = [150, 500, 1500, 3000].map((ms) => window.setTimeout(measure, ms));
    el.addEventListener("load", measure, true);
    let mo: MutationObserver | undefined;
    if (typeof MutationObserver !== "undefined") {
      mo = new MutationObserver(measure);
      mo.observe(el, { childList: true, subtree: true });
    }
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      el.removeEventListener("load", measure, true);
      mo?.disconnect();
    };
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
