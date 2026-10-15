import type { ReactNode } from "react";

/**
 * 列表加载失败卡片。
 *
 * 抽出来的原因：`<div className="card err">` 在 8 个文件里出现，形态是"错误文案 [+ 附加操作]"。
 * 三个列表页（首页/分类/搜索）的用法完全同构，首页多两个按钮（重新加载 / 去配 DNS）。
 *
 * 空 error 不渲染任何东西 —— 调用方因此可以写
 * `<FeedError error={items.length === 0 ? error : ""} />`，
 * 而不必在外面再套一层条件（与原来 `{items.length === 0 && error && (...)}` 等价）。
 */
export function FeedError({ error, children }: {
  error: string;
  /** 正文之后的附加操作（一般是 `<div className="row" style={{ marginTop: 8 }}>…</div>`） */
  children?: ReactNode;
}) {
  if (!error) return null;
  return (
    <div className="card err">
      {error}
      {children}
    </div>
  );
}
