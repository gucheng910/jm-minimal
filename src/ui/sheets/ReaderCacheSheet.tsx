import { Sheet } from "../blocks";
import { chapterLabel } from "../../core/offlineMeta";
import { cachedPagesText } from "./chapterText";
import type { BookChapter, ChapterMeta } from "../../core/offlineMeta";
import type { CachedChapterInfo } from "../../core/offline";

/**
 * 阅读器「选择要缓存的话数」弹层（原来内联在 Reader.tsx 的 1472-1516）。
 *
 * 三条容易被改坏的规则：
 *   · **已缓存的话勾上且不可动**（`checked` 恒真 + `input.disabled`），不是"看起来没选中"；
 *   · 缓存进行中（busy）时点遮罩**不关**弹层 —— 那正是最需要看到进度的时候；
 *   · 一个都没选时「确认开始缓存（0）」不可点。
 */
export interface ReaderCacheSheetProps {
  open: boolean;
  onClose: () => void;
  chapters: BookChapter[];
  /** 当前话 id：用来标「（当前）」 */
  albumId: string | number;
  cachedIds: Map<string, CachedChapterInfo>;
  chapterMetas: ChapterMeta[];
  /** 缓存任务进行中：整层不可操作、关闭按钮禁用、点遮罩也不关 */
  busy: boolean;
  /** 用户勾选的话 id（已缓存的不在其中——它们由 cachedIds 决定） */
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onInvert: () => void;
  onConfirm: () => void;
}

export function ReaderCacheSheet({
  open, onClose, chapters, albumId, cachedIds, chapterMetas,
  busy, selected, onToggle, onSelectAll, onInvert, onConfirm
}: ReaderCacheSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="选择要缓存的话数"
      showClose
      closeDisabled={busy}
      /* 缓存进行中点了遮罩也不关：用户正需要看"加入中…"的进度 */
      onBackdrop={() => { if (!busy) onClose(); }}
      backdropClassName="reader-sheet-backdrop"
      panelClassName="reader-sheet"
    >
      <p className="muted">已缓存的话不可重复选择</p>
      <div className="list sheet-list">
        {chapters.map((c) => {
          const id = String(c.id);
          const label = chapterLabel(c) || ("#" + id);
          const info = cachedIds.get(id);
          const cached = Boolean(info);
          const rec = chapterMetas.find((m) => m.chapterId === id);
          return (
            <label key={id} className={"sheet-row check-row" + (cached ? " disabled" : "")}>
              <input
                type="checkbox"
                checked={cached || selected.has(id)}
                disabled={cached || busy}
                onChange={() => onToggle(id)}
              />
              <span className="check-main">
                <span className="title">{label}{id === String(albumId) ? "（当前）" : ""}</span>
                <span className="muted">{cachedPagesText(info, rec)}</span>
              </span>
              {cached && <span className="badge ok">✓</span>}
            </label>
          );
        })}
      </div>
      <div className="row sheet-actions">
        <button disabled={busy} onClick={() => onSelectAll()}>全选</button>
        <button disabled={busy} onClick={() => onInvert()}>反选</button>
        <button disabled={busy || selected.size === 0} onClick={() => onConfirm()}>
          {busy ? "加入中…" : "确认开始缓存（" + selected.size + "）"}
        </button>
      </div>
    </Sheet>
  );
}
