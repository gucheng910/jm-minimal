import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * 画廊卡片里的**页面缩略图** —— 比例盒 + `transform: scale()` 的真实渲染 + 懒挂载 + 骨架兜底。
 *
 * ── 为什么是"真实渲染"而不是画一张示意图 ──────────────────────────────
 * 缩略图渲染的是 `customUiSample.ts` 的**样例数据**（与编辑画布同一份），不是真实网络
 * 数据，所以"详情页树很大、渲染两份会卡"在这里**不成立** —— 成本与画布里已经在跑的
 * 那一份同量级。所见即所得因此是真的：用户在画廊里看到的就是自己配的样子。
 *
 * ── 老内核（WebView 57）逐条约束 ─────────────────────────────────────
 *   · **没有 `aspect-ratio`** → 比例盒用 `height:0 + padding-top:150%`（抄
 *     `.skeleton-thumb-wrapper` 的既有手法）；
 *   · **没有 `ResizeObserver`** → 卡片宽只能"挂载后量一次 + window resize 再量"；
 *   · **没有 `inset`** → 覆盖层要逐条写 top/right/bottom/left（项目有
 *     `@supports not (inset: 0)` 兜底，说明这条踩过）；
 *   · `transform` / `IntersectionObserver`（Chrome 51+）**可用**，项目已在用后者。
 *
 * ── 一个必须靠 CSS 兜住的雷 ──────────────────────────────────────────
 * `transform` 元素会成为其后代的**包含块**：详情页里那些 `position: fixed` 的浮层
 * （toast / sheet / 缓存中心…，index.css 里约 13 处）放进缩略图后不再相对视口定位。
 * 这里不管它们（本组件只管几何），由 `.ed-thumb` 的 `overflow: hidden` +
 * `index.css` 里对浮层的作用域压制共同兜住，见 CSS 注释。
 *
 * `data-ready` 是**观测钩子**：e2e 靠它区分"还在骨架"与"真实渲染已接管"。
 */

/** 缩略图内部的布局宽度：按手机设计宽排版，再整体缩到卡片宽 */
const DESIGN_W = 390;

interface Props {
  /**
   * 渲染真实页面。**传函数而不是节点**：本组件要在"懒挂载/量到宽度"之后才真正渲染，
   * 把 `render()` 放到就绪分支里调用可以避免"先渲染再隐藏"的白跑。
   */
  render: () => ReactNode;
  /**
   * 卡片**布局宽**（已知时直接给，跳过自量宽）。
   *
   * 为什么要开这个口子（v3.6 实测到的真缺陷）：自量宽只在**挂载时 + window resize** 跑
   * （老内核没有 ResizeObserver），而画廊的卡宽会在**窗口尺寸没变**的情况下变 ——
   * 首次挂载时轨道还没量到宽、用的是兜底宽（358 → peek 卡宽 298），随后量到 768 切成
   * 宽屏两栏（卡宽 378）；自量宽不会重跑 → `k` 停在 0.764，缩略图只铺满 298/378，
   * **卡片右侧留白**，而"只缩小不放大（k ≤ 1）"那条断言照样通过（典型的假绿）。
   * 父级本来就知道卡宽（几何就是它算的），直接给它 → `k` 成为渲染期派生值，尺寸一变就跟着变。
   */
  width?: number;
}

export default function PageThumb({ render, width }: Props) {
  const boxRef = useRef<HTMLSpanElement | null>(null);
  /** 自量宽的缩放比：0 = 还没量到（此时不渲染真实页面，避免以 390px 原尺寸闪一下） */
  const [kMeasured, setKMeasured] = useState(0);
  const [mounted, setMounted] = useState(false);

  // 卡片宽 → 缩放比。用 window resize 代替 ResizeObserver（老内核没有后者）。
  useEffect(() => {
    if (width !== undefined && width > 0) return;   // 父级给了卡宽：不需要自量，也不会漏掉"尺寸变了"
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      /**
       * ⚠️ **必须量布局宽（offsetWidth），不能量 `getBoundingClientRect().width`**。
       *
       * `getBoundingClientRect()` 返回的是**经过祖先 transform 之后**的视觉宽度：
       * 卡片被 scale 到 0.48 时它会返回 ~172，于是 k=0.44、`.ed-thumb-inner` 只渲染成
       * 172 宽，再被外层压到 172 —— **双重缩放**，缩略图会小得像邮票。
       * `offsetWidth` 是**布局值**，不受 transform 影响，拿到的才是"卡片在 CSS 里有多宽"。
       * （同一条教训在拖拽栈的落点判定里也出现过：那里同样改用了 `offset*`。）
       */
      const w = el.offsetWidth;
      // ⚠️ 上限 1：缩略图**只允许缩小、不允许放大**。v3.3 之前卡片没有宽度上限，
      //    桌面 1280 上卡宽被拉到 618px → k = 1.59，页面被放大到比真机还大，
      //    "缩略图"的语义就没了（而且第二张卡还会被视口切掉）。
      if (w > 0) setKMeasured(Math.min(1, w / DESIGN_W));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [width]);

  /** 父级给了卡宽就用它（渲染期派生，尺寸一变立刻跟着变）；否则用自量值 */
  const k = width !== undefined && width > 0 ? Math.min(1, width / DESIGN_W) : kMeasured;

  // 懒挂载：进入视口才渲染。当前只有 2 张卡（都在首屏），但页面数会增加。
  // 没有 IntersectionObserver 时直接挂载 —— 宁可多渲染，也不要空着。
  useEffect(() => {
    if (mounted) return;
    const el = boxRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setMounted(true);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [mounted]);

  const ready = mounted && k > 0;

  return (
    <span className="ed-thumb" ref={boxRef} aria-hidden="true" data-ready={ready ? "1" : ""}>
      {ready ? (
        // scale 走内联 style：连续值没法逐档预写声明（项目结论，报告 §4.3）
        <span className="ed-thumb-inner" style={{ transform: "scale(" + String(k) + ")" }}>
          {render()}
        </span>
      ) : (
        <span className="ed-thumb-skel" />
      )}
    </span>
  );
}
