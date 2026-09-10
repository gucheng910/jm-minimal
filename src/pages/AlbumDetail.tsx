// 详情页：紧凑排版 + 收藏（有状态）+ 折叠的评论/相关漫画
// 纯展示组件——数据与动作全部由 ContentView 提供。
// 极简要点：标题 18/500、元信息 13px 行距 5、简介默认 2 行可展开、分组行用浅灰面而不是卡片边框、
// 页面下半部分刻意留空（不靠摊开间距把屏幕填满）。
import { useLayoutEffect, useRef, useState } from "react";
import CommentList from "../ui/CommentList";
import { AlbumGrid } from "../ui/AlbumGrid";
import { HeartIcon } from "../ui/icons";
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
  const [descOpen, setDescOpen] = useState(false);
  const [descClamped, setDescClamped] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const descRef = useRef<HTMLParagraphElement | null>(null);

  /**
   * 「展开」只在简介真的被截断时出现。
   * 不能用字符数猜（44~60 字的简介在窄屏上已经被 clamp 掉，却没有展开入口 = 静默丢内容），
   * 直接量 scrollHeight / clientHeight。
   */
  useLayoutEffect(() => {
    if (descOpen) return; // 展开状态下不重算，保留「收起」入口
    const el = descRef.current;
    if (!el) return;
    setDescClamped(el.scrollHeight > el.clientHeight + 1);
  }, [descOpen, detail.id, detail.description]);

  const locked = parsePaid(detail);
  const authors = authorNames(detail);
  const tags = albumTags(detail);
  const actors = Array.isArray(detail.actors) ? detail.actors.filter(Boolean).map((x) => String(x)) : [];
  const related = Array.isArray(detail.related_list) ? detail.related_list : [];
  const series = Array.isArray(detail.series) ? detail.series : [];
  const desc = String(detail.description || "").trim();
  const commentCount = comments && Array.isArray(comments.list) ? comments.list.length : 0;

  return (
    <div className="card detail-card">
      {/* 返回：横排两字「返回」，放在标题"前面"（同一行左侧）而不是标题上方占一整行。
          完整语义（返回列表 / 返回搜索结果）留给 aria-label，视觉上不占地方。 */}
      <div className="d-head">
        <button className="backtxt" onClick={onBack} aria-label={backLabel}>
          <svg className="ic sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          返回
        </button>
        <h2 className="d-title">{detail.name}</h2>
      </div>

      <p className="muted d-meta">作者 {authors.length > 0
        ? authors.map((a, i) => (
          <span key={"au" + i}>
            {i > 0 && <span className="meta-sep"> / </span>}
            <button className="link" onClick={() => onOpenAuthor(a)}>{a}</button>
          </span>
        ))
        : "-"}</p>

      <p className="muted d-meta">
        {isSeriesWork(detail)
          // 连载的 total_photos 不是本话页数（实测 47 页显示 5905），改显示话数
          ? "共 " + String(series.length) + " 话"
          : "页数 " + String(detail.total_photos ?? "-")}
        {detail.book_name && detail.book_name !== detail.name ? " · " + detail.book_name : ""}
        {" · JM号 " + String(detail.id)}
        <button className="link d-copy" onClick={onCopyId}>复制</button>
      </p>

      <p className="muted d-meta">标签 {tags.length > 0
        ? tags.map((t, i) => (
          <span key={"tg" + i}>
            {i > 0 && <span className="meta-sep"> · </span>}
            <button className="link" onClick={() => onOpenTag(t)}>{t}</button>
          </span>
        ))
        : "-"}</p>

      {actors.length > 0 && (
        <p className="muted d-meta">登场人物 {actors.map((a, i) => (
          <span key={"ac" + i}>
            {i > 0 && <span className="meta-sep"> · </span>}
            <button className="link" onClick={() => onOpenActor(a)}>{a}</button>
          </span>
        ))}</p>
      )}

      {desc && (
        <>
          <p ref={descRef} className={"d-desc" + (descOpen ? " open" : "")}>{desc}</p>
          {(descClamped || descOpen) && (
            <button className="d-more" onClick={() => setDescOpen((o) => !o)}>{descOpen ? "收起" : "展开"}</button>
          )}
        </>
      )}

      {locked && !logged && <p className="err d-locked">官方付费内容：请先登录，再通过官方会员中心购买（本客户端不做绕过）</p>}

      {locked && logged ? (
        <div className="actrow">
          <button className="btn primary" disabled={busy} onClick={onBuy}>使用官方 JCoin 购买</button>
        </div>
      ) : (
        <div className="actrow">
          <button className="btn primary" disabled={busy} onClick={onRead}>立即阅读</button>
          {logged && (
            <button
              className={"btn soft fav" + (detail.is_favorite ? " on" : "")}
              disabled={busy || Boolean(detail.is_favorite)}
              onClick={onToggleFavorite}
              aria-pressed={Boolean(detail.is_favorite)}
            >
              <HeartIcon size={18} filled={Boolean(detail.is_favorite)} />
              {detail.is_favorite ? "已收藏" : "收藏"}
            </button>
          )}
        </div>
      )}

      <div className="group d-group">
        {series.length > 1 && (
          <label className="grow selectrow">
            <span>选择话数</span>
            <select value={String(detail.id)} onChange={(e) => onSwitchChapter(e.target.value)} aria-label="选择话数">
              {series.map((s) => <option key={String(s.id)} value={String(s.id)}>{"#" + String(s.sort ?? "") + " " + (s.name || "")}</option>)}
            </select>
            <span className="chev">›</span>
          </label>
        )}
        <button className="grow" onClick={() => setCommentsOpen((o) => !o)} aria-expanded={commentsOpen}>
          <span>评论</span>
          <span className="v">{commentCount > 0 ? commentCount : ""}</span>
          <span className={"chev chev-toggle" + (commentsOpen ? " open" : "")}>›</span>
        </button>
        {related.length > 0 && (
          <button className="grow" onClick={() => setRelatedOpen((o) => !o)} aria-expanded={relatedOpen} data-related-toggle>
            <span>相关漫画</span>
            <span className="v">{related.length}</span>
            <span className={"chev chev-toggle" + (relatedOpen ? " open" : "")}>›</span>
          </button>
        )}
      </div>

      {!commentsOpen && !relatedOpen && (
        <p className="d-tail">话数、评论与相关漫画都在上面一行里，点开才占用屏幕。</p>
      )}

      {relatedOpen && (
        <div className="related-block">
          <h3>相关漫画</h3>
          <AlbumGrid items={related} onOpen={onOpenRelated} />
        </div>
      )}

      {commentsOpen && (
        <CommentList
          comments={comments}
          text={commentText}
          busy={busy}
          logged={logged}
          onTextChange={onCommentChange}
          onSubmit={onSubmitComment}
        />
      )}
    </div>
  );
}
