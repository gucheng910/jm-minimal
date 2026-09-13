// 评论区（官方 forum 接口）：纯展示，提交/加载由父级处理
import { sanitizeCommentHtml } from "../core/commentRich";
import type { ForumPayload } from "../core/types";

interface Props {
  comments: ForumPayload | null;
  /** 官方返回的评论总数（不是已加载条数） */
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  text: string;
  busy: boolean;
  logged: boolean;
  onTextChange: (v: string) => void;
  onSubmit: () => void;
  onLoadMore: () => void;
}

export default function CommentList({
  comments, total, hasMore, loadingMore, text, busy, logged, onTextChange, onSubmit, onLoadMore
}: Props) {
  const loaded = comments?.list.length ?? 0;
  return (
    <div className="comments">
      <h3>
        评论区（官方 forum?aid=）
        {total > 0 && <span className="muted"> · 共 {total} 条，已加载 {loaded}</span>}
      </h3>
      {!comments && <p className="muted">加载中…</p>}
      {comments && loaded === 0 && <p className="muted">暂无评论</p>}
      {comments?.list.map((c, i) => (
        // key 不能掺 Math.random()：每次渲染都变 → React 把整列评论全部卸载重挂，
        // 滚动位置丢失、输入焦点被打断，而且每次重渲都白做一遍 sanitizeCommentHtml。
        // 官方 CID/id 缺失时退到列表下标（同一批数据下标是稳定的）。
        <div key={String(c.CID || c.id || "i" + i)} className="comment-item">
          <b>{String(c.nickname || c.username || "?")}</b>
          <span className="muted"> · {String(c.update_at || c.addtime || "")}</span>
          {String(c.spoiler) === "1" && <span className="tag-spoiler">含剧透</span>}
          <div className="comment-body" dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(String(c.content || "")) }} />
        </div>
      ))}
      {/* 官方每页 10 条：没有这个按钮时，478 条评论的漫画只能看到 10 条 */}
      {hasMore && (
        <div className="row comment-more">
          <button className="ghost" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "加载中…" : "加载更多评论（已加载 " + loaded + " / " + total + "）"}
          </button>
        </div>
      )}
      {comments && loaded > 0 && !hasMore && total > loaded && (
        <p className="muted comment-more">已显示全部 {loaded} 条</p>
      )}
      {logged && (
        <div className="comment-box">
          <textarea value={text} onChange={(e) => onTextChange(e.target.value)} placeholder="发表评论（真实动作，请谨慎）" rows={3} />
          <div className="row"><button disabled={busy || !text.trim()} onClick={onSubmit}>{busy ? "发送中…" : "发送评论（官方 /comment）"}</button></div>
        </div>
      )}
      {!logged && <p className="muted">登录后可评论</p>}
    </div>
  );
}
