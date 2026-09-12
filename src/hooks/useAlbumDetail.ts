// 详情页数据与动作：详情/评论/收藏/购买/章节切换/进入阅读器
// 页面编排（模式切换、页面栈、滚动位置、转场）留在 ContentView
import { useCallback, useRef, useState } from "react";
import { client } from "../core/api";
import { emit } from "../core/bus";
import { authorNames, parsePaid } from "../core/albumMeta";
import { bookIdOf, isSeriesWork, mergeBookMeta } from "../core/series";
import { saveHistory } from "../core/history";
import { pushToast } from "../ui/toast";
import type { AlbumDetail, ForumPayload, ReadPayload } from "../core/types";

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
  commentText: string;
  busy: boolean;
  error: string;
  setCommentText: (v: string) => void;
  setRead: (r: ReadPayload | null) => void;
  setComments: (v: ForumPayload | null) => void;
  loadComments: (aid: number | string) => Promise<void>;
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
  const reqIdRef = useRef(0);
  const detailRef = useRef<AlbumDetail | null>(null);
  detailRef.current = detail;
  const optsRef = useRef(opts);
  optsRef.current = opts;

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
    setComments(null);
    setError("");
    return reqId;
  }, [applyDetail]);

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
    if (c.status === "fulfilled" && c.value) setComments(c.value);
  }, [fetchDetail]);

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
    // 官方业务结果兼容解析（可能 200 但 status/msg 表示失败，如 JCoin 不足）
    const r = result as { status?: unknown; msg?: string } | null;
    const rawMsg = String((r && r.msg) || "");
    const bad = r && (r.status === 0 || r.status === "0" || r.status === false || r.status === "false" || /失败|不足|错误|已购买|重复|余额/i.test(rawMsg));
    if (bad) {
      pushToast(rawMsg || "购买未成功，请确认 JCoin 余额", "err");
      return;
    }
    // 成功：立即重新拉取详情确认真实解锁状态，避免误报（getAlbumFull 保留书级作者/简介）
    const fresh = await client.getAlbumFull(cur.id).catch(() => null);
    if (fresh && !parsePaid(fresh)) {
      applyDetail(fresh);
      pushToast("购买成功，已解锁，可立即阅读", "ok");
      emit("jm:coinChanged");
    } else {
      if (fresh) applyDetail(fresh);
      pushToast(rawMsg || "已提交购买，请稍后刷新确认", "info");
    }
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
      if (c.status === "fulfilled" && c.value) setComments(c.value);
    });
  }, [applyDetail, fetchDetail, run]);

  const loadComments = useCallback(async (aid: number | string) => {
    const data = await run(() => client.getAlbumComments(aid, 1));
    if (data) setComments(data);
  }, [run]);

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
    detail, read, comments, commentText, busy, error,
    setCommentText, setRead, setComments,
    begin, load, set: applyDetail, leave,
    toggleFavorite, buy, switchChapter, submitComment, startRead, loadComments
  };
}
