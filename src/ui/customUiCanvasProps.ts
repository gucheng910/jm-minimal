import type { ComponentProps } from "react";
import AlbumDetail from "../pages/AlbumDetail";
import { AlbumGrid } from "./AlbumGrid";
import { SAMPLE_DETAIL, SAMPLE_LIST } from "./customUiSample";

/**
 * 「自定义 UI」的**样例 props** —— 编辑画布与画廊缩略图**共用同一份**。
 *
 * 为什么要抽出来（editor shell 设计 §6.1 的前置依赖）：
 * 原来这份 no-op props 写死在 `CustomUiPage.tsx` 里，只服务画布。v3.2 的画廊要给
 * **每个页面**渲染一张真实缩略图，如果各自抄一份，就会出现"改了一处忘了另一处"
 * 的漂移（画布能点、缩略图报错，或反之）。
 *
 * 两个刻意的点：
 *   1. **模块级常量而不是渲染里造对象**：`AlbumGrid` 是 `memo` 的，回调引用稳定才
 *      真的省下重渲染；每次渲染新建一个 `onOpen` 会让 memo 白做。
 *   2. 类型用 `Omit<ComponentProps<typeof AlbumDetail>, …编辑器专属>`：把"画布/缩略图
 *      共用的"与"只有编辑画布才有的"（editMode / 选中 / 受控 override / 拖动回调）
 *      在**类型层**分开。AlbumDetail 将来新增必填 prop 时，这里会当场报错，
 *      而不是等到运行时白屏。
 *
 * 里面的回调全部是 no-op：样例页面只看不导航、不请求、不写任何状态。
 */

type AlbumDetailProps = ComponentProps<typeof AlbumDetail>;

/** 画布/缩略图共用的那部分（编辑器专属的受控 props 由调用点自己传） */
export type CanvasDetailProps = Omit<
  AlbumDetailProps,
  "editMode" | "selectedBlock" | "onSelectBlock" | "layoutOverride" | "styleOverride" | "onMoveBlockTo" | "onMoveBlockEnd"
>;

export const CANVAS_DETAIL_PROPS: CanvasDetailProps = {
  detail: SAMPLE_DETAIL,
  /**
   * ⚠️ 这里**必须是 true**（v3.5 修正的真实缺陷）。
   *
   * 动作行的收藏按钮在 `AlbumDetail` 里是 `{logged && (…)}` 条件渲染的 —— 原来写 false，
   * 于是画布/缩略图里只有「立即阅读」、**右边的收藏按钮凭空消失**，用户直接点出来了
   * （原话：「连继续阅读右侧的收藏按钮都没了」）。
   * 画布应当展示**一个真实用户会看到的页面**（登录态是绝大多数人的常态），
   * 所以这里改成 true。副作用已逐条核过：`locked = parsePaid(SAMPLE_DETAIL) === false`
   * （样例没有 price）→ 付费提示与购买分支都不会出现，动作行稳定落在「阅读 + 收藏」。
   */
  logged: true,
  /** 占位渲染：不加载任何真实封面（用户要求「不要用真实作品」），见 AlbumDetail 的 skeleton */
  skeleton: true,
  busy: false,
  comments: null,
  commentTotal: 0,
  commentHasMore: false,
  commentLoadingMore: false,
  commentText: "",
  backLabel: "返回",
  onBack: () => { /* 样例页不真的返回 */ },
  onCopyId: () => { /* 样例页 */ },
  onOpenAuthor: () => { /* 样例页 */ },
  onOpenTag: () => { /* 样例页 */ },
  onOpenActor: () => { /* 样例页 */ },
  onOpenRelated: () => { /* 样例页 */ },
  onSwitchChapter: () => { /* 样例页 */ },
  onBuy: () => { /* 样例页 */ },
  onToggleFavorite: () => { /* 样例页 */ },
  onRead: () => { /* 样例页 */ },
  onCommentChange: () => { /* 样例页 */ },
  onSubmitComment: () => { /* 样例页 */ },
  onLoadMoreComments: () => { /* 样例页 */ }
};

export const CANVAS_LIST_PROPS: ComponentProps<typeof AlbumGrid> = {
  items: SAMPLE_LIST,
  /** 同详情页：画布/缩略图里的列表卡片只给"失败回退"式文字占位，不拉真实封面 */
  skeleton: true,
  onOpen: () => { /* 样例页 */ }
};
