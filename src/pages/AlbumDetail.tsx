// 详情页卡片：作者/标签可点搜索、章节切换、收藏/购买/阅读入口、评论区
// 纯展示组件——数据与动作全部由 ContentView 提供（状态迁移见后续批次）
import CommentList from "../ui/CommentList";
import { AlbumGrid } from "../ui/AlbumGrid";
import { albumTags, authorNames, parsePaid } from "../core/albumMeta";
import { isSeriesWork } from "../core/series";
import type { AlbumDetail as AlbumDetailData, AlbumSummary, ForumPayload } from "../core/types";

interface Props {
  detail: AlbumDetailData;
  logged: boolean;
  busy: boolean;
  comments: ForumPayload | null;
  commentText: string;
  backLabel: string;
  onBack: () => void;
  onCopyId: () => void;
  onOpenAuthor: (name: string) => void;
  onOpenTag: (tag: string) => void;
  /** 登场人物（走 search_type=character 的只读搜索页） */
  onOpenActor: (name: string) => void;
  /** 相关漫画点击 → 打开该漫画详情 */
  onOpenRelated: (a: AlbumSummary) => void;
  onSwitchChapter: (id: string) => void;
  onBuy: () => void;
  onToggleFavorite: () => void;
  onRead: () => void;
  onCommentChange: (v: string) => void;
  onSubmitComment: () => void;
}

export default function AlbumDetail({
  detail,
  logged,
  busy,
  comments,
  commentText,
  backLabel,
  onBack,
  onCopyId,
  onOpenAuthor,
  onOpenTag,
  onOpenActor,
  onOpenRelated,
  onSwitchChapter,
  onBuy,
  onToggleFavorite,
  onRead,
  onCommentChange,
  onSubmitComment
}: Props) {
  const locked = parsePaid(detail);
  const authors = authorNames(detail);
  const tags = albumTags(detail);
  const actors = Array.isArray(detail.actors) ? detail.actors.filter(Boolean).map((x) => String(x)) : [];
  const related = Array.isArray(detail.related_list) ? detail.related_list : [];
  return (
    <div className="card">
      <button className="ghost" onClick={onBack}>{backLabel}</button>
      <h2>{detail.name}</h2>
      <p className="muted">JM号：{String(detail.id)}
        <button className="ghost" style={{ marginLeft: 8 }} onClick={onCopyId}>复制</button>
      </p>
      <p className="muted">作者：{authors.length > 0
        ? authors.map((a, i) => (
          <span key={"au" + i}>
            {i > 0 && <span className="meta-sep"> / </span>}
            <button className="link" onClick={() => onOpenAuthor(a)}>{a}</button>
          </span>
        ))
        : "-"} · {isSeriesWork(detail)
          // 连载的 total_photos 不是本话页数（实测 47 页显示 5905），改显示话数
          ? "共 " + String(detail.series!.length) + " 话"
          : "页数：" + String(detail.total_photos ?? "-")}</p>
      <p className="muted">标签：{tags.length > 0
        ? tags.map((t, i) => (
          <span key={"tg" + i}>
            {i > 0 && <span className="meta-sep">、</span>}
            <button className="link" onClick={() => onOpenTag(t)}>{t}</button>
          </span>
        ))
        : "-"}</p>
      {actors.length > 0 && (
        <p className="muted">登场人物：{actors.map((a, i) => (
          <span key={"ac" + i}>
            {i > 0 && <span className="meta-sep">、</span>}
            <button className="link" onClick={() => onOpenActor(a)}>{a}</button>
          </span>
        ))}</p>
      )}
      {Array.isArray(detail.series) && detail.series.length > 1 && (
        <div className="row">
          <label>选择话数</label>
          <select value={String(detail.id)} onChange={(e) => onSwitchChapter(e.target.value)}>
            {detail.series.map((s) => <option key={String(s.id)} value={String(s.id)}>{"#" + String(s.sort ?? "") + " " + (s.name || "")}</option>)}
          </select>
        </div>
      )}
      <p>{detail.description}</p>
      {locked && !logged && <p className="err">官方付费内容：请先登录，再通过官方会员中心购买（本客户端不做绕过）</p>}
      {locked && logged && <div className="row"><button disabled={busy} onClick={onBuy}>使用官方 JCoin 购买</button></div>}
      {!locked && (
        <div className="row action-row">
          {logged && <button className="ghost" disabled={busy || Boolean(detail.is_favorite)} onClick={onToggleFavorite}>{detail.is_favorite ? "已收藏" : "☆ 收藏"}</button>}
          <button disabled={busy} onClick={onRead}>立即阅读</button>
        </div>
      )}
      {related.length > 0 && (
        <div className="related-block">
          <h3>相关漫画</h3>
          <AlbumGrid items={related} onOpen={onOpenRelated} />
        </div>
      )}
      <CommentList
        comments={comments}
        text={commentText}
        busy={busy}
        logged={logged}
        onTextChange={onCommentChange}
        onSubmit={onSubmitComment}
      />
    </div>
  );
}
