import type { CachedChapterInfo } from "../../core/offline";
import type { ChapterMeta } from "../../core/offlineMeta";

/**
 * 某一话的缓存状态文案：「已缓存 · N 页」/「已缓存 · N/M 页」/「未缓存」。
 *
 * 换话弹层与选话缓存弹层原来各写了一遍**完全相同**的表达式
 * （两次 `info ? "已缓存 · " + info.pages + " 页" + (rec && rec.total > info.pages ? "/" + rec.total : "") : "未缓存"`）。
 * `N/M` 里 M 是「这本书这一话总页数」：拆章缓存时 N 会小于 M，所以要显式写出来。
 */
export function cachedPagesText(info: CachedChapterInfo | undefined, rec: ChapterMeta | undefined): string {
  if (!info) return "未缓存";
  return "已缓存 · " + info.pages + " 页" + (rec && rec.total > info.pages ? "/" + rec.total : "");
}
