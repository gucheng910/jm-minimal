// 评论区（官方 forum 接口）：纯展示，提交/加载由父级处理
import { sanitizeCommentHtml } from "../core/commentRich";
import type { ForumPayload } from "../core/types";

interface Props {
  comments: ForumPayload | null;
  text: string;
  busy: boolean;
  logged: boolean;
  onTextChange: (v: string) => void;
  onSubmit: () => void;
}

export default function CommentList({ comments, text, busy, logged, onTextChange, onSubmit }: Props) {
  return (
    <div className="comments">
      <h3>评论区（官方 forum?aid=）</h3>
      {!comments && <p className="muted">加载中…</p>}
      {comments && comments.list.length === 0 && <p className="muted">暂无评论</p>}
      {comments?.list.map((c) => (
        <div key={String(c.CID || c.id || Math.random())} className="comment-item">
          <b>{String(c.nickname || c.username || "?")}</b>
          <span className="muted"> · {String(c.update_at || c.addtime || "")}</span>
          {String(c.spoiler) === "1" && <span className="tag-spoiler">含剧透</span>}
          <div className="comment-body" dangerouslySetInnerHTML={{ __html: sanitizeCommentHtml(String(c.content || "")) }} />
        </div>
      ))}
      {logged && (
        <div className="comment-box">
          <textarea value={text} onChange={(e) => onTextChange(e.target.value)} placeholder="发表评论（真实动作，请谨慎）" rows={3} />
          <div className="row"><button disabled={busy || !text.trim()} onClick={onSubmit}>发送评论（官方 /comment）</button></div>
        </div>
      )}
      {!logged && <p className="muted">登录后可评论</p>}
    </div>
  );
}
