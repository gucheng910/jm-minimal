/**
 * 阅读器弹层池（sheets）。
 *
 * 从 `Reader.tsx` 里把 4 个弹层的**弹体**搬出来的产物。搬之前它们内联在 1590 行的 Reader 里，
 * 占了约 220 行；Reader 自己只该管"阅读状态与滚动"，不该管"设置面板长什么样"。
 *
 * 与 `src/ui/blocks/` 的分工：
 *   · `blocks/`  = **通用**外壳与列表件（Sheet / AlbumFeed / FeedError / FeedToolRow），任何页面都能用；
 *   · `sheets/`  = **阅读器专用**的弹层内容，只被 Reader 用。
 *
 * 约定（与 blocks 一致）：这里的组件**只管怎么展示**——不持有业务状态、不发请求；
 * 状态仍由 Reader 持有，通过 props 传进来。所以每个组件都是可单测的纯展示件。
 * 每个组件内部自己渲染 `<Sheet portal={false}>`：外层那一个 `createPortal` 仍由 Reader 提供，
 * 这样弹层挂到 `document.body` 的**位置与顺序**保持不变（不 portal 会被控制条的 fixed inset:0 压住）。
 */
export { ReaderSourceSheet } from "./ReaderSourceSheet";
export type { ReaderSourceSheetProps, ReaderSourceRow } from "./ReaderSourceSheet";

export { ReaderSettingsSheet } from "./ReaderSettingsSheet";
export type { ReaderSettingsSheetProps, ReaderMode } from "./ReaderSettingsSheet";

export { ReaderChapterSheet } from "./ReaderChapterSheet";
export type { ReaderChapterSheetProps } from "./ReaderChapterSheet";

export { ReaderCacheSheet } from "./ReaderCacheSheet";
export type { ReaderCacheSheetProps } from "./ReaderCacheSheet";

export { cachedPagesText } from "./chapterText";
