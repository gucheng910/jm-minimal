import { Sheet } from "../blocks";
import { SkeletonRows } from "../SkeletonRows";
import { chapterLabel } from "../../core/offlineMeta";
import { cachedPagesText } from "./chapterText";
import type { BookChapter, ChapterMeta } from "../../core/offlineMeta";
import type { CachedChapterInfo } from "../../core/offline";

/**
 * 阅读器「换话」弹层（原来内联在 Reader.tsx 的 1410-1470）。
 *
 * 两个容易漏的行为：
 *   · 顶部「下一话」按钮：连续看的时候不用回列表里翻找，一话读完直接点它。
 *     最后一话时它变成不可点的「已是最后一话」（不是隐藏）；
 *   · 未缓存的话在**离线**下要标「离线不可读」——在线时这句不出现。
 */
export interface ReaderChapterSheetProps {
  open: boolean;
  onClose: () => void;
  chapters: BookChapter[];
  /** 书名：标题拼成「切换话数：<书名>」；没有就不拼 */
  bookName?: string;
  /** 当前话 id：用来标「（当前）」并高亮那一行 */
  albumId: string | number;
  /** 当前话的显示名（顶部「当前 第N话」用） */
  curLabel: string;
  /** 离线阅读：未缓存的话标「离线不可读」 */
  offline: boolean;
  cachedIds: Map<string, CachedChapterInfo>;
  chapterMetas: ChapterMeta[];
  /** 有切换在途：整个列表禁用（避免连点压多层） */
  switchBusy: boolean;
  /** 正在切换的那一话 id（该行转圈 + 「正在加载这一话…」） */
  switchKey: string | null;
  /** 下一话；为 null 表示已是最后一话 */
  nextChapter: { chapter: BookChapter } | null;
  /** 「下一话」按钮上的文案 */
  nextChapterText: string;
  onSwitch: (c: BookChapter) => void;
}

export function ReaderChapterSheet({
  open, onClose, chapters, bookName, albumId, curLabel, offline, cachedIds, chapterMetas,
  switchBusy, switchKey, nextChapter, nextChapterText, onSwitch
}: ReaderChapterSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={"切换话数" + (bookName ? "：" + bookName : "")}
      showClose
      backdropClassName="reader-sheet-backdrop"
      panelClassName="reader-sheet"
    >
      <p className="muted">共 {chapters.length} 话 · 当前 {curLabel || "第1话"}</p>
      {/* 「下一话」：× 之下、话列表之上。连续看的时候不用回列表里翻找，一话读完直接点它 */}
      <button
        type="button"
        className="chap-next"
        disabled={switchBusy || !nextChapter}
        aria-busy={nextChapter && switchKey === String(nextChapter.chapter.id) ? "true" : undefined}
        onClick={() => { const n = nextChapter; if (n) onSwitch(n.chapter); }}
      >
        {nextChapter
          ? (
            <>
              {switchKey === String(nextChapter.chapter.id) && <span className="row-spin" aria-hidden="true" />}
              <span>{nextChapterText}</span>
              <span className="chev" aria-hidden="true">›</span>
            </>
          )
          : <span>已是最后一话</span>}
      </button>
      <div className="list sheet-list">
        {chapters.length === 0 && <SkeletonRows count={6} />}
        {chapters.map((c) => {
          const id = String(c.id);
          const label = chapterLabel(c) || ("#" + id);
          const isCur = id === String(albumId);
          const info = cachedIds.get(id);
          const cached = Boolean(info);
          const rec = chapterMetas.find((m) => m.chapterId === id);
          const pagesText = cachedPagesText(info, rec);
          return (
            <button
              key={id}
              className={"sheet-row" + (isCur ? " active" : "")}
              disabled={switchBusy}
              aria-busy={switchKey === id ? "true" : undefined}
              onClick={() => onSwitch(c)}
            >
              <div>
                <div className="title">{label}{isCur ? "（当前）" : ""}</div>
                <div className="muted">
                  {switchKey === id ? "正在加载这一话…" : [pagesText, !cached && offline ? "离线不可读" : ""].filter(Boolean).join(" · ")}
                </div>
              </div>
              {switchKey === id
                ? <span className="row-spin" aria-hidden="true" />
                : <span className={"badge" + (cached ? " ok" : "")}>{cached ? "✓" : ""}</span>}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
