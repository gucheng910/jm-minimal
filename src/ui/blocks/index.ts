/**
 * 展示模块池（blocks）。
 *
 * 定位：**列表/内容页共用的展示件集中放在这里**，各处按需 import：
 *
 *   import { AlbumFeed, FeedToolRow } from "../ui/blocks";
 *
 * 为什么要集中（而不是各页面自己写、或一个个散在 ui/ 下）：
 *   1. 这些模块在改造前是**逐字重复**的（无限滚动三份、结果区三份、工具行两份），
 *      集中后"改一处"就是改全部，不会再出现"只改了一个列表页"的隐性不一致；
 *   2. 它们是**自定义布局的候选单元**——详情页已经证明「一个自足的展示模块 = 一个可配置单元」
 *      （见 core/detailLayout.ts）。把重复的展示件先收敛成独立模块，是把同一套能力
 *      推广到列表页的前置条件：可配置的对象必须先存在。
 *
 * 约定：
 *   · 这里的组件只管"怎么展示"，**不发请求、不持有业务状态**（状态仍由各页面的 hook 持有）；
 *   · 组件的 props 用"已经算好的值"（如 FeedToolRow 的 label），
 *     不把常量表/格式化逻辑搬进来——那是 core/ 的事；
 *   · 新增模块时顺手在这里导出，避免各处写深层路径。
 */
export { AlbumFeed } from "./AlbumFeed";
export type { AlbumFeedProps } from "./AlbumFeed";

export { FeedError } from "./FeedError";

export { FeedToolRow } from "./FeedToolRow";
export type { FeedToolRowProps } from "./FeedToolRow";

export { Sheet } from "./Sheet";
export type { SheetProps } from "./Sheet";
