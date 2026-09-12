// 缓存管理：按「书」分组（同书多话合并成一本），点封面先进离线详情页
// - 离线详情页的数据全部来自 IndexedDB（books/chapters）+ Cache API，飞行模式可用
// - 目录里标出哪些话已缓存；点未缓存的话走正常网络加载，没网自然报错
// - 返回键：阅读器 → 离线详情页 → 缓存列表 → 关闭（overlay 不卸载，返回后目录与滚动位置都在）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBackHandler } from "../hooks/useBackHandler";
import { client } from "../core/api";
import { emit, on } from "../core/bus";
import {
  cacheList, chapterPages, clearAllCacheTasks, pauseCache, reDownloadCache, rekeyBook, removeCache, resumeCache,
  type CacheTaskMeta
} from "../core/cacheTasks";
import { cachedCoverUrl, pagesFromCache, scanCachedChapters, toOfflinePageUrls, type CachedChapterInfo } from "../core/offline";
import { ensureBookMeta } from "../core/bookSync";
import { knownBookId } from "../core/series";
import { hasOpenSheet } from "../core/uiLocks";
import { chapterLabel, getBook, getChapter, listChapters, type BookMeta, type ChapterMeta } from "../core/offlineMeta";
import { saveHistory } from "../core/history";
import type { ReadPage } from "../core/types";
import ReaderPanel from "../Reader";
import { pushToast } from "./toast";
import { CloseIcon } from "./icons";
import UnderlineTabs from "./UnderlineTabs";

type View = { kind: "list" } | { kind: "book"; bookId: string };

interface Reading {
  id: number | string;
  title: string;
  scrambleId?: number | string;
  pages: ReadPage[];
  offline: boolean;
}

interface BookGroup {
  bookId: string;
  title: string;
  author?: string;
  cover?: string;
  chapters: CacheTaskMeta[];
  doneCount: number;
  donePages: number;
  updatedAt: number;
}

const STATUS_TEXT: Record<CacheTaskMeta["status"], string> = {
  queued: "排队中…",
  running: "缓存中…",
  paused: "已暂停",
  failed: "缓存失败",
  done: "已完成"
};

function groupByBook(list: CacheTaskMeta[]): BookGroup[] {
  const map = new Map<string, BookGroup>();
  for (const t of list) {
    let g = map.get(t.bookId);
    if (!g) {
      g = { bookId: t.bookId, title: t.title, author: t.author, cover: t.cover, chapters: [], doneCount: 0, donePages: 0, updatedAt: 0 };
      map.set(t.bookId, g);
    }
    g.chapters.push(t);
    if (t.status === "done") { g.doneCount += 1; g.donePages += t.total; }
    if (!g.cover && t.cover) g.cover = t.cover;
    if (!g.author && t.author) g.author = t.author;
    if (!g.title && t.title) g.title = t.title;
    if (t.updatedAt > g.updatedAt) g.updatedAt = t.updatedAt;
  }
  const arr = [...map.values()];
  for (const g of arr) g.chapters.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  return arr.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 封面：优先本书任意一话缓存下来的封面，否则回落到远程 URL（尺寸交给 CSS，避免覆盖 .list-item 的卡片布局） */
function GroupCover({ group }: { group: BookGroup }) {
  const [src, setSrc] = useState("");
  const blobRef = useRef("");
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const t of group.chapters) {
        if (!t.cover) continue;
        const u = await cachedCoverUrl(t.id, t.cover);
        if (u) { if (alive) { blobRef.current = u; setSrc(u); } return; }
      }
      if (alive && group.cover && group.cover.startsWith("http")) setSrc(group.cover);
    })();
    return () => {
      alive = false;
      if (blobRef.current) { try { URL.revokeObjectURL(blobRef.current); } catch { /* ignore */ } blobRef.current = ""; }
    };
  }, [group.bookId, group.cover, group.chapters]);
  if (!src) return <div className="thumb empty">{group.title.slice(0, 1)}</div>;
  return (
    <span className="thumb-box">
      <img className="thumb" src={src} alt={group.title} onError={(e) => { e.currentTarget.style.opacity = "0"; }} />
      <span className="thumb-fallback">{group.title.slice(0, 1)}</span>
    </span>
  );
}

export default function CacheCenter({ onClose, entering, closing }: { onClose: () => void; entering?: boolean; closing?: boolean }) {
  const [tasks, setTasks] = useState<CacheTaskMeta[]>(cacheList);
  const [tab, setTab] = useState<"active" | "done">("active");
  const [view, setView] = useState<View>({ kind: "list" });
  const [reading, setReading] = useState<Reading | null>(null);
  const [cachedIds, setCachedIds] = useState<Map<string, CachedChapterInfo>>(new Map());
  const [book, setBook] = useState<BookMeta | null>(null);
  const [bookChapters, setBookChapters] = useState<ChapterMeta[]>([]);
  const [loadingBook, setLoadingBook] = useState(false);
  /** 正在执行的清理动作（"del:话id" / "re:话id" / "book:书id" / "__all__"）：该项显示进行中、其余不可点 */
  const [actingKey, setActingKey] = useState<string | null>(null);

  /**
   * 只扫「指定的这几话」。进某本书的缓存详情只需要自己那几十话 ——
   * 原来这里是 scanCachedChapters()（遍历整机所有 cache），老机型上就是"进详情页要等半天"的主因。
   */
  const refreshCached = useCallback(async (ids: string[]) => {
    if (ids.length === 0) { setCachedIds(new Map()); return; }
    setCachedIds(await scanCachedChapters(ids));
  }, []);

  /** 当前打开的书有哪些话（缓存变动后只需要重扫这几话） */
  const bookIdsRef = useRef<string[]>([]);

  useEffect(() => {
    return on("jm:caches", () => {
      setTasks(cacheList());
      const ids = bookIdsRef.current;
      if (ids.length) void refreshCached(ids);
    });
  }, [refreshCached]);

  // 离线阅读时进入沉浸全屏（隐藏顶栏/底栏）
  useEffect(() => {
    emit("jm:immersive", Boolean(reading));
    return () => { emit("jm:immersive", false); };
  }, [reading]);

  /** 读本地书数据；旧版本缓存缺书级元数据时联网补一次（失败保持降级显示） */
  const loadBook = useCallback(async (bookId: string): Promise<string> => {
    setLoadingBook(true);
    let [meta, chapters] = await Promise.all([getBook(bookId), listChapters(bookId)]);
    let effective = bookId;
    if ((!meta || meta.chapters.length === 0) && chapters.length > 0) {
      // 旧版本把「话 id」当书 id 存过：先按 knownBookId 本地纠正（纯 IDB 查询，不联网）
      const hint = knownBookId(chapters[0].chapterId);
      if (hint && hint !== effective) {
        const alt = await getBook(hint);
        if (alt) {
          effective = hint;
          meta = alt;
          chapters = await listChapters(effective);
          rekeyBook(bookId, effective, alt.name);
          setTasks(cacheList());
        }
      }
    }
    setBook(meta);
    setBookChapters(chapters);
    setLoadingBook(false);
    const ids = meta && meta.chapters.length > 0
      ? meta.chapters.map((c) => String(c.id))
      : chapters.map((c) => String(c.chapterId));
    bookIdsRef.current = ids;
    void refreshCached(ids);
    // 元数据补全挪到后台：联网慢/断网都不再卡住目录显示（本地够用时 ensureBookMeta 会直接返回）
    if (chapters.length > 0) {
      void ensureBookMeta(chapters[0].chapterId)
        .then((filled) => { if (filled) setBook(filled); })
        .catch(() => { /* 保持本地降级显示 */ });
    }
    return effective;
  }, [refreshCached]);

  async function openBook(bookId: string) {
    setView({ kind: "book", bookId });
    setBook(null);
    setBookChapters([]);
    const effective = await loadBook(bookId);
    if (effective !== bookId) setView({ kind: "book", bookId: effective });
    window.scrollTo(0, 0);
  }

  const groups = useMemo(() => groupByBook(tasks), [tasks]);
  const activeGroups = groups.filter((g) => g.chapters.some((t) => t.status !== "done"));
  const doneGroups = groups.filter((g) => g.chapters.some((t) => t.status === "done"));

  const currentGroup = view.kind === "book" ? groups.find((g) => g.bookId === view.bookId) : undefined;

  useBackHandler(() => {
    // 阅读器内弹窗开着时不要消费返回键（缓存中心的监听注册得更早，这里必须让路）
    if (hasOpenSheet()) return false;
    if (reading) { setReading(null); return; }
    if (view.kind === "book") { setView({ kind: "list" }); return; }
    onClose();
  }, [reading, view, onClose]);

  /** 从离线详情页读任意一话也要记足迹（按书合并，与在线阅读一致） */
  function recordHistory(chapterId: string, label: string) {
    const chapter = book?.chapters.find((c) => String(c.id) === chapterId);
    saveHistory({
      id: chapterId,
      bookId: book?.bookId || currentGroup?.bookId || chapterId,
      name: book?.name || currentGroup?.title || "",
      author: book?.author.join("/") || currentGroup?.author,
      description: book?.description,
      chapterName: label,
      sort: chapter ? Number(chapter.sort) || undefined : undefined,
      chapters: book && book.chapters.length > 1 ? book.chapters.length : undefined,
      lastReadAt: Date.now()
    });
  }

  /** 离线阅读：页列表来自 IDB，图片来自 Cache API */
  async function readOffline(chapterId: string, label: string) {
    const rec = await getChapter(chapterId);
    let pages = rec && rec.pages && rec.pages.length ? rec.pages : await chapterPages(chapterId);
    // IndexedDB 记录丢失（老版本配额溢出/迁移中断）时，只要图片还在就能继续离线读
    if (!pages.length) pages = await pagesFromCache(chapterId);
    if (!pages.length) {
      // 本地确实没有：回落网络，没网就走正常报错
      await readOnline(chapterId, label);
      return;
    }
    const urls = await toOfflinePageUrls(chapterId, pages);
    recordHistory(chapterId, label);
    const title = [book?.name, label].filter(Boolean).join(" ");
    setReading({ id: chapterId, title, scrambleId: rec?.scrambleId, pages: urls, offline: true });
    // 只有图片、没有 IDB 记录（老版本配额溢出/迁移中断）时才需要联网补 scrambleId ——
    // 这一步**放到后台**：本地缓存就该立刻打开，不能因为一个可选的切片参数去等网络（弱网/断网时尤其明显）
    if (!rec) {
      void client.getRead(chapterId).then((r) => {
        if (!r || r.scramble_id === undefined || r.scramble_id === null) return;
        setReading((cur) => (cur && String(cur.id) === String(chapterId) ? { ...cur, scrambleId: r.scramble_id } : cur));
      }).catch(() => { /* 离线/失败就按未重排显示 */ });
    }
  }

  /** 未缓存的话：正常走网络（没网就报错，不做特殊处理） */
  async function readOnline(chapterId: string, label: string) {
    try {
      if (!client.apiBase) await client.init();
      const r = await client.getRead(chapterId);
      if (!r || !Array.isArray(r.images) || r.images.length === 0) {
        pushToast("该话暂无可用图片（可能需要购买或登录）", "err");
        return;
      }
      recordHistory(chapterId, label);
      setReading({ id: chapterId, title: [book?.name, label].filter(Boolean).join(" "), scrambleId: r.scramble_id, pages: r.images, offline: false });
    } catch (err) {
      pushToast("加载失败：" + String(err).replace(/^Error: /, "").slice(0, 90), "err");
    }
  }

  async function deleteBookGroup(g: BookGroup) {
    if (actingKey) return;
    setActingKey("book:" + g.bookId);
    try {
      for (const t of g.chapters) await removeCache(t.id);
      setTasks(cacheList());
      await refreshCached(bookIdsRef.current);
      if (view.kind === "book" && view.bookId === g.bookId) setView({ kind: "list" });
      pushToast("已删除《" + g.title + "》的缓存", "ok");
    } finally {
      setActingKey(null);
    }
  }

  async function reDownloadChapter(chapterId: string) {
    if (actingKey) return;
    setActingKey("re:" + chapterId);
    try {
      await reDownloadCache(chapterId);
      setTasks(cacheList());
      pushToast("已重新加入缓存队列", "ok");
    } finally {
      setActingKey(null);
    }
  }

  async function deleteOneChapter(chapterId: string) {
    if (actingKey) return;
    setActingKey("del:" + chapterId);
    try {
      await removeCache(chapterId);
      setTasks(cacheList());
      if (view.kind === "book") {
        const rest = await listChapters(view.bookId);
        if (rest.length === 0) { setView({ kind: "list" }); }
        else await loadBook(view.bookId);
      }
      pushToast("已删除该话缓存", "ok");
    } finally {
      setActingKey(null);
    }
  }

  if (reading) {
    return (
      <div className="cache-overlay cache-overlay-reader" data-entering={entering ? "" : undefined} data-closed={closing ? "" : undefined}>
        <ReaderPanel
          albumId={reading.id}
          pages={reading.pages}
          title={reading.title}
          scrambleId={reading.scrambleId}
          offline={reading.offline}
          onBack={() => setReading(null)}
          meta={{ author: book?.author.join("/") || currentGroup?.author || "", cover: book?.cover || "" }}
          bookMeta={book || undefined}
          chapterName={book?.chapters.find((c) => String(c.id) === String(reading.id))?.name}
          chapterSort={Number(book?.chapters.find((c) => String(c.id) === String(reading.id))?.sort) || undefined}
        />
      </div>
    );
  }

  // ---- 离线详情页（数据全部本地，飞行模式可用）----
  if (view.kind === "book") {
    const chapters: { id: string; name: string; sort: number }[] = book && book.chapters.length > 0
      ? book.chapters
      : bookChapters.map((c) => ({ id: c.chapterId, name: c.name || "", sort: Number(c.sort) || 0 }));
    return (
      <div className="cache-overlay" data-entering={entering ? "" : undefined} data-closed={closing ? "" : undefined}>
        <div className="cache-header">
          <div>
            <h2>{book?.name || currentGroup?.title || "离线详情"}</h2>
            <p className="muted">{book ? book.author.join(" / ") : (currentGroup?.author || "")}{chapters.length > 1 ? " · 共 " + chapters.length + " 话" : ""}</p>
          </div>
          <button className="btn soft sm" aria-label="返回缓存列表" onClick={() => setView({ kind: "list" })}>返回</button>
        </div>
        {loadingBook && <p className="muted cache-empty">正在读取本地数据…</p>}
        {!loadingBook && book && book.tags.length > 0 && (
          <p className="muted book-tags">{book.tags.map((t) => "#" + t).join("  ")}</p>
        )}
        {!loadingBook && book && book.description && <p className="book-desc">{book.description}</p>}
        {!loadingBook && !book && <p className="muted">该缓存来自旧版本，缺少简介/标签/目录；重新缓存即可补齐。</p>}
        {!loadingBook && chapters.length === 0 && <p className="muted cache-empty">没有可显示的目录</p>}
        {!loadingBook && chapters.length > 0 && (
          <div className="list book-chapters">
            {chapters.map((c) => {
              const id = String(c.id);
              const label = chapterLabel(c) || ("#" + id);
              const info = cachedIds.get(id);
              const cached = Boolean(info);
              const task = tasks.find((t) => t.id === id);
              const meta = bookChapters.find((m) => m.chapterId === id);
              const cachedText = info
                ? "已缓存 · " + info.pages + " 页" + (meta && meta.total > info.pages ? "/" + meta.total : "")
                : null;
              return (
                <div key={id} className="chapter-row">
                  <button className="chapter-main" onClick={() => { void (cached ? readOffline(id, label) : readOnline(id, label)); }}>
                    <div>
                      <div className="title one-line">{label}</div>
                      <div className="muted">
                        {cachedText
                          ? cachedText
                          : task ? STATUS_TEXT[task.status] + (task.status === "running" || task.status === "queued" ? " · " + task.done + "/" + task.total + " 页" : "")
                            : "未缓存"}
                      </div>
                    </div>
                    <span className={"badge" + (cached ? " ok" : task && task.status !== "done" ? " pending" : "")}>
                      {cached ? "✓" : task && task.status !== "done" ? "…" : "☁"}
                    </span>
                  </button>
                  {cached && (
                    <div className="chapter-ops">
                      <span
                        className={"op-link" + (actingKey === "re:" + id ? " busy" : "")}
                        onClick={() => { void reDownloadChapter(id); }}
                      >{actingKey === "re:" + id ? "重下中…" : "重下"}</span>
                      <span
                        className={"op-link danger" + (actingKey === "del:" + id ? " busy" : "")}
                        onClick={() => { void deleteOneChapter(id); }}
                      >{actingKey === "del:" + id ? "删除中…" : "删除"}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ---- 缓存列表（按书分组）----
  return (
    <div className="cache-overlay" data-entering={entering ? "" : undefined} data-closed={closing ? "" : undefined}>
      <div className="cache-header">
        <div>
          <h2>缓存管理</h2>
          <p className="muted">退出软件后自动停止下载；下载完成的作品可离线阅读</p>
        </div>
        <button className="ghost" aria-label="关闭" onClick={onClose}><CloseIcon size={18} /></button>
      </div>
      <div className="cache-tabs">
        {/* 选中态与全站一致：文字 + 下划线（内容与操作不变） */}
        <UnderlineTabs
          items={[
            { key: "active", label: "进行中" + (activeGroups.length > 0 ? "（" + activeGroups.length + "）" : "") },
            { key: "done", label: "已缓存" + (doneGroups.length > 0 ? "（" + doneGroups.length + "）" : "") }
          ]}
          value={tab}
          onChange={(k) => setTab(k === "done" ? "done" : "active")}
        />
        <button
          className={"op-link danger cache-clear" + (actingKey === "__all__" ? " busy" : "")}
          onClick={async () => {
            if (actingKey) return;
            setActingKey("__all__");
            try {
              const n = await clearAllCacheTasks();
              setTasks([]);
              setCachedIds(new Map());
              bookIdsRef.current = [];
              pushToast(n > 0 ? "已清理全部缓存（" + n + " 个话）" : "没有可清理的缓存", "ok");
            } finally {
              setActingKey(null);
            }
          }}
        >{actingKey === "__all__" ? "清理中…" : "清理全部缓存"}</button>
      </div>

      {tab === "active" && (
        <div className="cache-list">
          {activeGroups.length === 0 && <p className="muted cache-empty">暂无进行中的缓存任务，可在阅读器中点「缓存」加入</p>}
          {activeGroups.map((g) => (
            <div key={g.bookId} className="card cache-item book-group">
              <GroupCover group={g} />
              <div className="cache-item-main">
                <div className="title one-line">{g.title}</div>
                <div className="muted">{g.author || ""}</div>
                {g.chapters.filter((t) => t.status !== "done").map((t) => {
                  const pct = t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
                  return (
                    <div key={t.id} className="chapter-progress">
                      <div className="muted mono-num">{t.chapterName || ("#" + t.id)} · {STATUS_TEXT[t.status]}{t.status === "running" || t.status === "queued" ? " " + t.done + "/" + t.total + " 页" : ""}</div>
                      {(t.status === "queued" || t.status === "running") && <div className="progress"><div className="progress-fill" style={{ transform: "scaleX(" + (pct / 100) + ")" }} /></div>}
                      {t.status === "failed" && t.error && <div className="err small-err">{t.error}</div>}
                      <div className="row chapter-actions">
                        {(t.status === "running" || t.status === "queued") && <button className="btn soft sm" onClick={() => pauseCache(t.id)}>暂停</button>}
                        {t.status === "paused" && <button className="btn soft sm" onClick={() => resumeCache(t.id)}>继续</button>}
                        {t.status === "failed" && <button className="btn soft sm" onClick={() => resumeCache(t.id)}>重试</button>}
                        <button className="btn soft sm danger" onClick={async () => { await removeCache(t.id); setTasks(cacheList()); pushToast("已删除该话缓存", "ok"); }}>删除</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "done" && (
        <div>
          {doneGroups.length === 0 && <p className="muted cache-empty">还没有已缓存的漫画，阅读器中点「缓存」即可离线观看</p>}
          <div className="list">
            {doneGroups.map((g) => (
              <button key={g.bookId} className="list-item" onClick={() => { void openBook(g.bookId); }}>
                <GroupCover group={g} />
                <div>
                  <div className="title">{g.title}</div>
                  <div className="muted">{[g.author, "已缓存 " + g.doneCount + " 话", g.donePages + " 页"].filter(Boolean).join(" · ")}</div>
                </div>
                <span className="list-ops" onClick={(e) => e.stopPropagation()}>
                  <span className="op-link" onClick={() => { void openBook(g.bookId); }}>详情/目录</span>
                  <span
                    className={"op-link danger" + (actingKey === "book:" + g.bookId ? " busy" : "")}
                    onClick={() => { void deleteBookGroup(g); }}
                  >{actingKey === "book:" + g.bookId ? "删除中…" : "删除本书"}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
