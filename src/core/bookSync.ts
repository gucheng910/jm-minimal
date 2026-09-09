// 书级元数据补全：本地缺失/不完整时联网拉一次（连载自动取书级 payload），写回 IndexedDB。
// 用途：旧版本（1.7.1 及以前）的缓存没有作者/标签/简介，「重下」或打开离线详情页时补齐。
import { client } from "./api";
import { bookMetaFromDetail, getBook, putBook, rebindBook, type BookMeta } from "./offlineMeta";
import { knownBookId } from "./series";

/** 本地记录是否「够用」：有目录且（有简介或作者） */
function usable(meta: BookMeta | null): meta is BookMeta {
  return Boolean(meta && meta.chapters.length > 0 && (meta.description || meta.author.length > 0));
}

/**
 * 补全某话所属书的元数据。
 * @param chapterId 任意一话 id（或书 id）；连载会自动取书级 payload
 * @param force 忽略本地已有记录，强制联网刷新
 * @returns 元数据；联网失败且本地也没有时返回 null
 */
export async function ensureBookMeta(chapterId: number | string, force = false): Promise<BookMeta | null> {
  const id = String(chapterId);
  const hint = knownBookId(id);
  if (!force) {
    const local = await getBook(hint);
    if (usable(local)) return local;
  }
  try {
    if (!client.apiBase) await client.init();
    const d = await client.getAlbumFull(id);
    const meta = bookMetaFromDetail(d);
    if (meta.bookId) {
      // 旧数据可能把话 id 当书 id（seriesMap 未收录时）：拿到真书 id 后改挂过去
      if (meta.bookId !== hint) await rebindBook(hint, meta.bookId);
      await putBook(meta);
    }
    return meta;
  } catch {
    return (await getBook(hint)) || null;
  }
}
