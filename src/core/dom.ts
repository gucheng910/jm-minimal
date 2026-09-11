/**
 * 老内核 DOM 兼容工具。
 *
 * 关键事实：`Element.prototype.scrollTo` / `scrollBy` 是 Chrome 61 才有的方法，
 * WebView 57（小米 4W / 老鸿蒙内核）上**方法本身不存在**——`el.scrollTo(...)` 直接抛
 * "e.scrollTo is not a function"，在 React 里会一路冒泡到错误边界，表现为
 * 「页面渲染出错（内容）」（2026-09-11 点作者/标签打开搜索结果页就命中这条）。
 * 之前只把字典签名换成两参数是不够的：方法不存在，两种签名都会抛。
 */

/** 把容器滚回顶部（老内核退化成 scrollTop 赋值） */
export function scrollToTop(el: HTMLElement | null): void {
  if (!el) return;
  try {
    if (typeof el.scrollTo === "function") el.scrollTo(0, 0);
    else el.scrollTop = 0;
  } catch {
    el.scrollTop = 0;
  }
}

/** 横向滚动到指定位置；smooth 只在支持字典签名时使用（低配模式一律瞬时） */
export function scrollToLeft(el: HTMLElement | null, left: number, smooth: boolean): void {
  if (!el) return;
  if (smooth) {
    try {
      if (typeof el.scrollTo === "function") { el.scrollTo({ left, behavior: "smooth" }); return; }
    } catch { /* 老内核没有字典签名：落到下面的直接赋值 */ }
  }
  el.scrollLeft = left;
}
