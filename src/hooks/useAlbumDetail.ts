// 详情页数据与动作：详情/评论/收藏/购买/章节切换/进入阅读器
// 页面编排（模式切换、页面栈、滚动位置、转场）留在 ContentView
import { useCallback, useRef, useState } from "react";
import { client } from "../core/api";
import { emit } from "../core/bus";
import { authorNames } from "../core/albumMeta";
import { bookIdOf, isSeriesWork, mergeBookMeta } from "../core/series";
import { saveHistory } from "../core/history";
import { pushToast } from "../ui/toast";
import type { AlbumDetail, ForumComment, ForumPayload, ReadPayload } from "../core/types";

/**
 * 评论分页合并（按 CID 去重后追加）。
 *
 * 为什么要去重：官方 `/forum?aid=` 每页固定 10 条（2026-09-13 实测：
 * aid=283429 total=478，page=1/2/3 各 10 条且互不重复），
 * 但对评论很少的专辑，请求超出范围的 page 会把第一页原样返回
 * （aid=1472364 total=1 时 page=2、page=3 返回的仍是同一条 CID）。
 * 不去重就会出现重复条目、而且 list.length 永远追不上 total。
 */
export function mergeCommentPage(prev: ForumPayload | null, next: ForumPayload): ForumPayload {
  const seen = new Set<string>();
  const list: ForumComment[] = [];
  for (const c of [...(prev?.list || []), ...(next.list || [])]) {
    const key = String(c.CID ?? c.id ?? "");
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    list.push(c);
  }
  return { ...next, list };
}

export interface AlbumDetailOptions {
  /** 详情数据变化（ContentView 用它同步搜索层背后的父详情） */
  onDetailChanged?: (next: AlbumDetail | null) => void;
  /** 阅读器是否仍在前台（决定加载失败时要不要切回详情） */
  isReaderActive?: () => boolean;
  /** 阅读数据加载失败（切回详情页） */
  onReadFail?: () => void;
}

export interface AlbumDetailApi {
  detail: AlbumDetail | null;
  read: ReadPayload | null;
  comments: ForumPayload | null;
  /** 官方返回的评论总数（不是已加载条数） */
  commentsTotal: number;
  /** 还有下一页没加载 */
  commentsHasMore: boolean;
  /** 正在加载下一页 */
  commentsLoadingMore: boolean;
  commentText: string;
  busy: boolean;
  error: string;
  setCommentText: (v: string) => void;
  setRead: (r: ReadPayload | null) => void;
  setComments: (v: ForumPayload | null) => void;
  loadComments: (aid: number | string) => Promise<void>;
  /** 加载下一页评论并追加（按 CID 去重） */
  loadMoreComments: () => Promise<void>;
  /** 乐观快照落地（打开详情/切章第一步），返回本次请求序号 */
  begin: (snapshot: AlbumDetail) => number;
  /** 拉完整详情 + 评论；期间又 begin/leave 过则丢弃回包 */
  load: (id: number | string, reqId?: number) => Promise<void>;
  /** 直接写入详情（购买后刷新、搜索结果恢复等） */
  set: (next: AlbumDetail | null) => void;
  /** 离开详情：作废在途回包 */
  leave: () => void;
  toggleFavorite: () => Promise<void>;
  buy: () => Promise<void>;
  switchChapter: (id: number | string) => Promise<void>;
  submitComment: () => Promise<void>;
  /** 立即阅读：先空数据切页，后台再拉图片列表 */
  startRead: () => void;
}

export function useAlbumDetail(opts: AlbumDetailOptions = {}): AlbumDetailApi {
  const [detail, setDetailState] = useState<AlbumDetail | null>(null);
  const [comments, setComments] = useState<ForumPayload | null>(null);
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [read, setRead] = useState<ReadPayload | null>(null);
  /** 评论已加载到第几页（1 起）；换专辑 / 切话时重置 */
  const [commentsPage, setCommentsPage] = useState(1);
  const [commentsLoadingMore, setCommentsLoadingMore] = useState(false);
  const reqIdRef = useRef(0);
  const detailRef = useRef<AlbumDetail | null>(null);
  detailRef.current = detail;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const commentsRef = useRef<ForumPayload | null>(null);
  commentsRef.current = comments;

  /** 落地第一页（换专辑 / 切话 / 发完评论重拉）：整体替换并回到第 1 页 */
  const applyFirstPage = useCallback((next: ForumPayload | null) => {
    setComments(next);
    setCommentsPage(1);
  }, []);

  const applyDetail = useCallback((next: AlbumDetail | null) => {
    setDetailState(next);
    optsRef.current.onDetailChanged?.(next);
  }, []);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const begin = useCallback((snapshot: AlbumDetail) => {
    const reqId = ++reqIdRef.current;
    applyDetail(snapshot);
    applyFirstPage(null);
    setError("");
    return reqId;
  }, [applyDetail, applyFirstPage]);

  /**
   * 拉详情（连载分两步）：先渲染话级回包（快），再用书级回包补作者/简介/标签/目录。
   * 实测话级 payload 的 author 为空数组、description 为空串，直接用会显示空作者。
   */
  const fetchDetail = useCallback(async (id: number | string, reqId: number): Promise<void> => {
    const d = await client.getAlbum(id).catch(() => null);
    if (reqIdRef.current !== reqId || !d) return;
    applyDetail(d);
    const bookId = bookIdOf(d);
    if (bookId === String(d.id)) return;
    const book = await client.getAlbum(bookId).catch(() => null);
    if (reqIdRef.current !== reqId || !book) return;
    applyDetail(mergeBookMeta(d, book));
  }, [applyDetail]);

  const load = useCallback(async (id: number | string, reqId = reqIdRef.current) => {
    try { if (!client.apiBase) await client.init(); } catch { /* 静默：详情页仍可用摘要数据 */ }
    const [c] = await Promise.allSettled([
      client.getAlbumComments(id, 1).catch(() => null),
      fetchDetail(id, reqId)
    ]);
    if (reqIdRef.current !== reqId) return; // 已离开/已切章
    if (c.status === "fulfilled" && c.value) applyFirstPage(c.value);
  }, [fetchDetail, applyFirstPage]);

  const leave = useCallback(() => {
    reqIdRef.current++;
    setBusy(false);
    setError("");
  }, []);

  /**
   * 收藏 / 取消收藏：官方 POST /favorite {aid} 本身就是切换，服务端用 type=add|remove 回话。
   * 原实现在 is_favorite 时直接 return（按钮又 disabled），导致收藏后再也取消不掉。
   */
  const toggleFavorite = useCallback(async () => {
    const cur = detailRef.current;
    if (!cur) return;
    const r = await run(() => client.toggleFavorite(cur.id));
    if (!r) { pushToast("收藏操作失败，请重试", "err"); return; }
    if (r.status !== "ok") { pushToast(String(r.msg || "收藏操作失败，请重试"), "err"); return; }
    const removed = r.type === "remove";
    applyDetail({ ...cur, is_favorite: !removed });
    pushToast(removed ? "已取消收藏" : "已加入官方收藏", "ok");
  }, [run, applyDetail]);

  /**
   * 购买（官方 JCoin 结算）：POST /coin_buy_comics {id}。
   *
   * 流程对齐官方（`pages/Comic/Detail.tsx:187-193`）：
   *   1) 跑接口 → 看返回的 **status === "ok"** 作为成功依据；
   *   2) 成功则**无条件重拉详情**，让 UI 自己收敛到"已购"态。
   *
   * 为什么不能用本地 parsePaid 来验收：那是**用被测对象验证自己**。
   * 旧实现在这里判 `!parsePaid(fresh)`，一旦判据有偏差（服务端已购后返回的形态
   * 与本地预期不符），钱已扣、权益已生效，却仍走"已提交购买，请稍后刷新确认"分支，
   * 按钮永远不消失 —— 真机反馈的根因之一。判据已在 core/albumMeta 修正，这里同时解耦。
   */
  const buy = useCallback(async () => {
    const cur = detailRef.current;
    if (!cur) return;
    let result: unknown = null;
    try {
      result = await client.purchaseAlbum(cur.id);
    } catch (err) {
      pushToast("购买失败：" + String(err).replace(/^Error: /, "").slice(0, 120), "err");
      return;
    }
    // 官方只认 status；msg 原样作为提示文案透传（兼容不同时期的响应形态）
    const r = (typeof result === "string" ? { msg: result } : result) as { status?: unknown; msg?: string } | null;
    const rawMsg = String((r && r.msg) || "");
    const ok = Boolean(r) && String(r!.status ?? "").toLowerCase() === "ok";
    // 非 ok：服务端明确答复过（可能 200 但余额不足 / 重复购买）→ 原样告知，不改本地态
    if (!ok) {
      pushToast(rawMsg || "购买未成功，请确认 JCoin 余额", "err");
      return;
    }
    // 成功：强制重取详情（refreshAlbum 会先失效 /album 的 30s 内存缓存）。
    // 不能直接用 getAlbumFull —— 它会命中购买**之前**那份快照，purchased 还是未购形态，
    // UI 于是永远切不到"已解锁"（这正是"付款后按钮不变、重进依旧"的直接原因）。
    const fresh = await client.refreshAlbum(cur.id);
    if (fresh) applyDetail(fresh);
    pushToast(rawMsg || "购买成功，已解锁，可立即阅读", "ok");
    emit("jm:coinChanged");
  }, [applyDetail]);

  const switchChapter = useCallback(async (id: number | string) => {
    const cur = detailRef.current;
    // 从当前 series 列表找到目标章节名做乐观快照，立刻展示
    const target = cur?.series?.find((s) => String(s.id) === String(id));
    if (target && cur) {
      applyDetail({ ...cur, id, name: target.name || cur.name } as unknown as AlbumDetail);
    }
    setError("");
    const reqId = ++reqIdRef.current;
    // 走 run()：切话期间 busy=true —— 详情页的「选择话数」会显示转圈并不可操作
    // （弱网下原来的切话没有任何反馈，看起来像"点了没反应"）
    await run(async () => {
      const [c] = await Promise.allSettled([
        client.getAlbumComments(id, 1).catch(() => null),
        fetchDetail(id, reqId)
      ]);
      if (reqIdRef.current !== reqId) return; // 离开详情后忽略过期回包
      if (c.status === "fulfilled" && c.value) applyFirstPage(c.value);
    });
  }, [applyDetail, fetchDetail, run, applyFirstPage]);

  const loadComments = useCallback(async (aid: number | string) => {
    const data = await run(() => client.getAlbumComments(aid, 1));
    if (data) applyFirstPage(data);
  }, [run, applyFirstPage]);

  /**
   * 加载下一页评论（追加）。
   *
   * 改之前详情页永远只请求 page=1：官方每页 10 条，
   * 实测 aid=283429 有 478 条评论，用户只能看到 10 条（审查发现）。
   */
  const loadMoreComments = useCallback(async () => {
    const cur = detailRef.current;
    const loaded = commentsRef.current;
    if (!cur || !loaded || commentsLoadingMore) return;
    const total = Number(loaded.total || 0);
    if (total > 0 && loaded.list.length >= total) return; // 已经到底
    const nextPage = commentsPage + 1;
    setCommentsLoadingMore(true);
    try {
      const next = await client.getAlbumComments(cur.id, nextPage);
      if (!next) return;
      const before = commentsRef.current?.list.length ?? 0;
      const merged = mergeCommentPage(commentsRef.current, next);
      setComments(merged);
      setCommentsPage(nextPage);
      // 评论很少时服务端会把第一页原样返回（实测 total=1 的专辑 page=2/3 都是同一条）：
      // 再去重也拿不到新内容，直接把 total 收到实际条数，按钮随之消失，不会无限点下去。
      if (merged.list.length === before) setComments({ ...merged, total: merged.list.length });
    } catch (err) {
      pushToast("评论加载失败：" + String(err).replace(/^Error: /, "").slice(0, 60), "err");
    } finally {
      setCommentsLoadingMore(false);
    }
  }, [commentsPage, commentsLoadingMore]);

  const commentsTotal = Number(comments?.total || 0);
  const commentsHasMore = Boolean(comments && comments.list.length > 0 && comments.list.length < commentsTotal);

  const submitComment = useCallback(async () => {
    const cur = detailRef.current;
    if (!cur || !commentText.trim()) return;
    const result = await run(() => client.sendComment(cur.id, commentText.trim()));
    if (result) {
      setCommentText("");
      pushToast("评论已发送（官方返回）", "ok");
      await loadComments(cur.id);
    } else {
      pushToast("评论发送失败，请重试", "err");
    }
  }, [commentText, run, loadComments]);

  const startRead = useCallback(() => {
    const cur = detailRef.current;
    if (!cur) return;
    const albumId = cur.id;
    // 立即保存阅读记录（从乐观数据提取，不依赖完整详情）；连载按「书」合并成一条
    const chapter = cur.series?.find((s) => String(s.id) === String(albumId));
    saveHistory({
      id: String(albumId),
      bookId: bookIdOf(cur) || String(albumId),
      name: cur.book_name || cur.name || "",
      author: authorNames(cur).join("/"),
      adddate: cur.addtime as string | number | undefined,
      description: cur.description || undefined,
      chapterName: chapter?.name || (chapter?.sort ? "第" + chapter.sort + "话" : undefined),
      sort: chapter?.sort,
      chapters: isSeriesWork(cur) ? cur.series!.length : undefined,
      lastReadAt: Date.now()
    });
    // 瞬间进入阅读器：用空 pages[] 渲染（会立即显示工具栏 + Loading）
    setRead({ id: albumId, images: [] });
    void (async () => {
      try {
        const r = await client.getRead(albumId);
        if (!r || !r.images || r.images.length === 0) {
          pushToast("该内容需先购买后才能阅读", "err");
          setRead(null);
          if (optsRef.current.isReaderActive?.()) optsRef.current.onReadFail?.();
          return;
        }
        setRead(r);
      } catch (err) {
        pushToast("阅读数据加载失败：" + String(err).slice(0, 80), "err");
        setRead(null);
        if (optsRef.current.isReaderActive?.()) optsRef.current.onReadFail?.();
      }
    })();
  }, []);

  return {
    detail, read, comments, commentsTotal, commentsHasMore, commentsLoadingMore,
    commentText, busy, error,
    setCommentText, setRead, setComments,
    begin, load, set: applyDetail, leave,
    toggleFavorite, buy, switchChapter, submitComment, startRead,
    loadComments, loadMoreComments
  };
}
