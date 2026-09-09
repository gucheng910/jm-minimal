import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBackHandler } from "./hooks/useBackHandler";
import { navTransition } from "./core/viewTransition";
import { emit, on } from "./core/bus";
import { client } from "./core/api";
import { downloadAlbum, isAlbumCached } from "./core/offline";
import ReaderPanel from "./Reader";
import Loading from "./ui/Loading";
import { pushToast } from "./ui/toast";
import { UI_KEYS } from "./core/constants";
import { useWeekRank } from "./hooks/useWeekRank";
import { useCategoryFeed } from "./hooks/useCategoryFeed";
import { useSearchFeed } from "./hooks/useSearchFeed";
import SearchFeed from "./pages/SearchFeed";
import AlbumDetailPage from "./pages/AlbumDetail";
import HomeFeed from "./pages/HomeFeed";
import PullToRefresh from "./ui/PullToRefresh";
import { useHomeFeed } from "./hooks/useHomeFeed";
import CategoryFeed from "./pages/CategoryFeed";
import WeekRank from "./pages/WeekRank";
import { albumCoverUrl, prefetchCovers } from "./ui/AlbumCard";
import { parsePaid } from "./core/albumMeta";
import { SearchResultPage } from "./ui/SearchResultPage";
import type { SRKind } from "./ui/SearchResultPage";
import { debouncedSetJSON, getJSONNow } from "./core/debounceStorage";
import { announceStartupReady, gatePassed } from "./core/startup";
import type { AlbumDetail, AlbumSummary, ForumPayload, ReadPayload } from "./core/types";

type Mode = "home" | "detail" | "reader" | "week";

// 滚动恢复 key（sessionStorage 兜底，避免 ref 丢失）
const SCROLL_KEY = "jm:pendingRestoreY";
const HISTORY_KEY = UI_KEYS.history;

function progressKey(id: number | string): string {
  return "jmclient.read.y." + String(id);
}

function loadHistory(): AlbumSummary[] {
  return getJSONNow<AlbumSummary[]>(HISTORY_KEY, []);
}

function saveHistoryEntry(entry: AlbumSummary) {
  const list = loadHistory().filter((x) => String(x.id) !== String(entry.id));
  list.unshift(entry);
  debouncedSetJSON(HISTORY_KEY, list.slice(0, 50), 500);
}

/** 特殊搜索结果层（详情页作者/标签 → 只读搜索页）的完整状态 */
interface SRState {
  kind: SRKind;
  text: string;
  items: AlbumSummary[];
  page: number;
  hasMore: boolean;
  busy: boolean;
  error: string;
}

interface ContentViewProps { initialAction?: string }

export default function ContentView({ initialAction = "" }: ContentViewProps = {}) {
  const pageMode = initialAction === "categories" ? "categories" : initialAction === "search" ? "search" : "home";
  const [mode, setMode] = useState<Mode>("home");
  const [detail, setDetail] = useState<AlbumDetail | null>(null);
  // ---- 特殊搜索结果层（页面栈语义）----
  // 栈最多同时存在「详情页 + 搜索页」两层：
  //   列表 → 详情A → 搜索X → 详情B，此时 B 直接返回回到 X，再返回回到 A；
  //   但若在 B 上又点了作者/标签，则丢弃 A 与 X（相当于杀后台），栈变成「详情B + 搜索Y」。
  const [sr, setSr] = useState<SRState | null>(null);
  const [srOpen, setSrOpen] = useState(false);
  const [srParent, setSrParent] = useState<AlbumDetail | null>(null);
  const [detailFrom, setDetailFrom] = useState<"list" | "search">("list");
  const srReqIdRef = useRef(0);
  const srParentScrollRef = useRef(0);
  const [read, setRead] = useState<ReadPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<AlbumSummary[]>(loadHistory);
  const cat = useCategoryFeed();
  // 首页内容流：列表/分页/错误都在 hook 内；onListShown 负责「是否切回 home」的编排
  const home = useHomeFeed({
    onListShown: () => {
      // 用户已主动进入详情/阅读器时，不把首页预取结果打回 home
      // （修复：从会员页收藏/足迹点进详情，被冷启动测速后的 showList 抢回首页）
      if (modeRef.current === "detail" || modeRef.current === "reader") return;
      setMode("home");
    },
    onRandomFail: () => pushToast("内容加载失败，建议先配 DNS，配置后删除后台重进生效", "err", "goto-dns")
  });
  const week = useWeekRank();
  // 搜索纯数字 JM 号时服务端返回 redirect_aid → 直接打开详情页
  const search = useSearchFeed((aid) => { void openDetail({ id: aid } as AlbumSummary); });
  const [comments, setComments] = useState<ForumPayload | null>(null);
  const [commentText, setCommentText] = useState("");
  const [cached, setCached] = useState(false);
  const [dlProgress, setDlProgress] = useState(0);
  const [dlState, setDlState] = useState<"idle" | "run" | "done">("idle");
  const [curPage, setCurPage] = useState(1);
  const [jumpInput, setJumpInput] = useState("1");
  // 同步 mode 的 ref：异步回调里判断用户是否已主动进入详情/阅读器（防止首页预取把页面打回 home）
  const modeRef = useRef<Mode>("home");
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => {
    emit("jm:immersive", mode === "reader");
  }, [mode]);

  // 搜索页在前台时锁住底层详情页的滚动（搜索页自带滚动容器）
  useEffect(() => {
    if (!srOpen) return;
    document.body.classList.add("jm-scroll-lock");
    return () => document.body.classList.remove("jm-scroll-lock");
  }, [srOpen]);

  // setting/图床配置迟到时刷新封面（例如测速兜底后才拿到 img_host）
  const [settingTick, setSettingTick] = useState(0);
  useEffect(() => {
    const h = () => setSettingTick((t) => t + 1);
    return on("jm:setting", h);
  }, []);

  // 记录离开列表（进入详情/周榜）前的滚动位置，返回时恢复，避免找漫翻页丢失
  const listScrollRef = useRef(0);
  // 离开详情页的序号：每次 exitDetail/exitWeek 递增，进入详情页时同步递增
  // 用于在离开后拦截仍在运行的 getAlbum/getAlbumComments 回调
  const detailReqIdRef = useRef(0);

  /** 保存待恢复的滚动位置（ref + sessionStorage 双写） */
  function saveScrollTarget(y: number) {
    listScrollRef.current = y;
    try { sessionStorage.setItem(SCROLL_KEY, String(y)); } catch { /* ignore */ }
  }

  /** useLayoutEffect: mode 从非 home 切回 home 时，在浏览器绘制前同步恢复滚动 */
  useLayoutEffect(() => {
    if (mode !== "home") return;
    const y = listScrollRef.current || Number(sessionStorage.getItem(SCROLL_KEY) || "0");
    if (y > 0) window.scrollTo(0, y);
  }, [mode]);

  /** 清空搜索结果层与栈记忆（离开详情页 / 回首页时调用） */
  function clearSearchLayer() {
    srReqIdRef.current++;
    setSr(null);
    setSrOpen(false);
    setSrParent(null);
    setDetailFrom("list");
  }

  /** 详情写入统一入口：若搜索页背后的父详情是同一部，一并刷新（避免返回时拿到旧快照） */
  function applyDetail(next: AlbumDetail | null) {
    setDetail(next);
    setSrParent((p) => (p && next && String(p.id) === String(next.id) ? next : p));
  }

  function exitDetailToHome() {
    // 详情 → 列表：反向推拉（详情页右移滑出，列表页回到原位并恢复滚动）
    navTransition("pop", () => {
      setDetail(null);
      clearSearchLayer();
      // 作废仍在执行的 openDetail/switchChapter 异步回调（防止 setState 干扰滚动）
      detailReqIdRef.current++;
      setMode("home");
    });
  }

  function exitReaderToDetail() {
    setRead(null);
    setMode("detail");
    // 阅读器滚动很长：回到详情需先回到页面顶部（进度已由阅读器自行保存，不影响）
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }

  /** 复制 JM 号（详情页按钮） */
  function copyJmId() {
    if (!detail) return;
    navigator.clipboard.writeText(String(detail.id));
    pushToast("JM号已复制", "ok");
  }

  /** 详情页返回：父级是搜索页就先回搜索页，否则回列表 */
  function detailBack() {
    if (detailFrom === "search" && sr) {
      setSrOpen(true);
      return;
    }
    exitDetailToHome();
  }

  /** 详情页作者/标签 → 打开只读搜索结果页：只保留当前详情一层，其余栈丢弃（防无限套娃） */
  function openSpecialSearch(kind: SRKind, text: string) {
    const q = text.trim();
    if (!q) return;
    srParentScrollRef.current = window.scrollY;
    setSrParent(detail);
    setDetailFrom("list"); // 杀后台：背后详情页的父级改为主页（再返回即回首页）
    const reqId = ++srReqIdRef.current;
    setSr({ kind, text: q, items: [], page: 1, hasMore: false, busy: true, error: "" });
    setSrOpen(true);
    void loadSRPage(q, kind, 1, reqId);
  }

  async function loadSRPage(q: string, kind: SRKind, p: number, reqId = srReqIdRef.current) {
    if (!client.apiBase) {
      try { await client.init(); } catch { /* 静默：详情页摘要仍可看 */ }
    }
    try {
      const r = await client.search(q, p, 0, kind === "tag" ? "tag" : "author");
      if (srReqIdRef.current !== reqId) return; // 已换词/已关闭，丢弃过期回包
      const content = r.content || [];
      const total = Number(r.total || 0);
      setSr((s) => {
        if (!s) return s;
        const items = p > 1 ? [...s.items, ...content] : content;
        // content 为空即到底：避免服务端重复返回同一页时无限滚动打转
        const hasMore = content.length > 0 && items.length < total;
        return { ...s, items, page: p, hasMore, busy: false, error: "" };
      });
    } catch (err) {
      if (srReqIdRef.current !== reqId) return;
      const msg = String(err).slice(0, 140);
      setSr((s) => (s ? { ...s, busy: false, error: msg } : s));
    }
  }

  function loadMoreSR() {
    if (!sr || sr.busy || !sr.hasMore) return;
    setSr((s) => (s ? { ...s, busy: true } : s));
    void loadSRPage(sr.text, sr.kind, sr.page + 1);
  }

  /** 关闭搜索页 → 回到它背后的详情页；若中途从结果点进过别的详情，恢复原来那部并刷新评论 */
  function closeSearch() {
    setSrOpen(false);
    const back = srParent;
    if (back && (!detail || String(back.id) !== String(detail.id))) {
      const reqId = ++detailReqIdRef.current;
      applyDetail(back);
      setComments(null);
      setError("");
      client.getAlbumComments(back.id, 1)
        .then((c) => { if (detailReqIdRef.current === reqId) setComments(c); })
        .catch(() => { /* 评论拉取失败不影响详情页 */ });
      const y = srParentScrollRef.current;
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
    setDetailFrom("list");
  }

  useBackHandler(() => {
    if (srOpen) {
      closeSearch();
    } else if (mode === "reader") {
      client.finishFastTrack();
      exitReaderToDetail();
    } else if (mode === "detail") {
      detailBack();
    } else if (mode === "week") {
      week.reset();
      detailReqIdRef.current++;
      setMode("home");
    } else {
      // home 等其他模式不消费返回键，让 App.tsx 处理两次返回退出
      return false;
    }
  }, [mode, srOpen, detailFrom, sr, srParent, detail]);

  // 搜索 tab 挂载时：读搜索记录 + 拉热词（逻辑在 useSearchFeed 内）
  useEffect(() => {
    if (pageMode !== "search") return;
    void search.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageMode]);

  useEffect(() => {
    const handler = (action: string) => {
      if (action === "categories") {
        // 分类页默认停留在“最新A漫”并自动加载一次列表（先确保 apiBase 就绪）
        (async () => {
          try {
            if (!client.apiBase) await client.init();
            await cat.openCategories();
            await cat.load("", "", 1, true, "");
          } catch (err) {
            setError(String(err));
          }
        })();
      }
      if (action === "latest") { void home.loadLatest(); }
      if (action === "ranking") { openWeek(); }
      if (action === "search") {
        setMode("home");
        window.scrollTo({ top: 0 });
        setTimeout(() => document.querySelector<HTMLInputElement>(".searchbar input")?.focus(), 120);
      }
    };
    return on("jm:nav", handler);
  }, []);

  useEffect(() => {
    if (pageMode !== "home") return;
    const handler = () => {
      // 底部“首页”再次点击：从详情/阅读退回列表并刷新首页推荐
      setRead(null);
      setDetail(null);
      clearSearchLayer();
      setComments(null);
      setMode("home");
      window.scrollTo({ top: 0 });
      void home.loadRandom();
    };
    return on("jm:refreshHome", handler);
  }, [pageMode]);

  useEffect(() => {
    return on("jm:openAid", (raw) => {
      const aid = String(raw || "");
      if (!aid || pageMode !== "home") return;
      openDetail({ id: aid } as AlbumSummary);
    });
  }, [pageMode]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true);
      try {
        // 18+ 门放行后才开始网络启动（点击确认后由 App 放行），避免后台提前跑完造成“秒进”
        await gatePassed;
        if (!client.apiBase) await client.init();
        if (initialAction === "categories") {
          try { await client.getSetting(); } catch { /* 不阻塞分类加载 */ }
          await cat.openCategories();
          return;
        }
        if (initialAction === "search") {
          setMode("home");
          if (!client.setting) client.getSetting().catch(() => { /* ignore */ });
          setTimeout(() => document.querySelector<HTMLInputElement>(".searchbar input")?.focus(), 120);
        }
        const aid = new URLSearchParams(window.location.search).get("aid");
        if (pageMode === "home" && !aid) {
          // 每次冷启动都自动测速并应用最快线路/图源（18+ 确认页期间后台完成）
          let speedOk = false;
          try { speedOk = await client.autoSelectBest(); } catch { speedOk = false; }
          if (!speedOk) {
            // 测速全部失败：回退上次记忆值兜底（保证能进主界面 / 看离线缓存）
            await client.restoreBestSelection().catch(() => false);
          }
          // 兜底：setting 未就绪时补一次（封面图床域名）
          if (!client.setting) {
            try { await client.getSetting(); } catch { /* 尽力而为 */ }
          }
          // 通知 18+ 门：测速阶段结束（成功或全部失败），可以放行
          announceStartupReady({ speedOk });
          let list: AlbumSummary[] | null = null;
          const r1 = await client.getRandomRecommend().catch(() => null);
          if (alive && Array.isArray(r1)) {
            list = r1 as AlbumSummary[];
          } else {
            await new Promise((res) => setTimeout(res, 900));
            const r2 = await client.getRandomRecommend().catch(() => null);
            if (alive && Array.isArray(r2)) list = r2 as AlbumSummary[];
          }
          if (alive && list) {
            setError("");
            home.show(list, "latest", false, 1);
          } else if (alive) {
            setError("网络连接失败，推荐内容加载不出来。请先到会员页「DNS 加速」按指引配置 DoT 公共 DNS（大多可解决）；配置后需删除后台重新进入 App 使设置生效，再点“重试”；若仍失败再考虑使用魔法。");
            pushToast("内容加载失败，建议先配 DNS，配置后删除后台重进生效", "err", "goto-dns");
          }
        }
        if (aid) {
          const d = await client.getAlbum(aid);
          if (alive && d) {
            setDetail(d);
            setMode("detail");
            setComments(null);
            loadComments(d.id);
          }
        }
      } catch (err) {
        if (alive) setError(String(err));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (mode !== "reader" || !read) return;
    let cancelled = false;
    // 阅读进度/页码由 ReaderPanel 自管（按页号记忆 + .jm-figure 锚线检测），
    // 这里移除旧版残留的“像素滚动恢复 + .page-img 扫描”（旧 key jmclient.read.y 已废弃）
    isAlbumCached(read.id).then((ok) => { if (!cancelled) setCached(ok); });
    return () => { cancelled = true; };
  }, [mode, read]);

  async function loadComments(aid: number | string) {
    const data = await run(() => client.getAlbumComments(aid, 1));
    if (data) setComments(data);
  }

  async function submitComment() {
    if (!detail || !commentText.trim()) return;
    const result = await run(() => client.sendComment(detail.id, commentText.trim()));
    if (result) {
      setCommentText("");
      pushToast("评论已发送（官方返回）", "ok");
      await loadComments(detail.id);
    } else {
      pushToast("评论发送失败，请重试", "err");
    }
  }

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError("");
    try { return await fn(); }
    catch (err) { setError(String(err)); return null; }
    finally { setBusy(false); }
  }

  /** 打开周榜：数据与分页都在 useWeekRank 内，这里只负责记滚动位置与切页 */
  async function openWeek() {
    if (mode === "home") saveScrollTarget(window.scrollY); // 记住打开周榜前列位置
    if (await week.open()) setMode("week");
  }

  function retryHomeFeed() {
    // 与底部导航点击「首页」时的刷新逻辑完全一致（复用 jm:refreshHome 事件）
    setRead(null);
    setDetail(null);
    clearSearchLayer();
    setComments(null);
    setMode("home");
    window.scrollTo({ top: 0 });
    void home.loadRandom();
  }

  // from="list"：从任意列表进入（重置页面栈）；from="search"：从搜索结果页点进（背后保留搜索页）
  const openDetail = useCallback(async (item: AlbumSummary, from: "list" | "search" = "list") => {
    if (from === "list") saveScrollTarget(window.scrollY); // 记住进入详情前列表位置
    // 乐观渲染：用列表页已有摘要立刻展示详情页，不等 API
    const snapshot = { ...item, name: item.name || "" } as unknown as AlbumDetail;
    const enterDetail = () => {
      setDetail(snapshot);
      setDetailFrom(from);
      if (from === "list") {
        // 从列表进入 = 页面栈重置，搜索结果层作废
        srReqIdRef.current++;
        setSr(null);
        setSrOpen(false);
        setSrParent(null);
      } else {
        // 从搜索结果页点进：关闭搜索层（滑出动画）
        setSrOpen(false);
      }
      setMode("detail");
      setComments(null);
      setError("");
      // 新页从顶部开始（列表位置已存进 listScrollRef，返回时恢复）
      window.scrollTo(0, 0);
    };
    if (from === "list") {
      // 列表 → 详情：推拉转场（旧页后退，详情页从右滑入）。
      // 必须 await：转场回调是异步执行的，若不等它落地就发起请求，
      // 响应可能先回来并被随后的乐观快照覆盖（详情页会缺标签/简介）
      await navTransition("push", enterDetail);
    } else {
      // 搜索结果页 → 详情：搜索层自带滑出动画，不再叠加整页转场
      enterDetail();
      requestAnimationFrame(() => window.scrollTo(0, 0));
    }
    // 记录本次请求 ID：若后续 exitDetailToHome 已递增此值，说明用户已离开
    const reqId = detailReqIdRef.current;
    // 并行拉取完整详情 + 评论，不再串行等待
    try {
      if (!client.apiBase) await client.init();
    } catch { /* 静默，详情页仍可用摘要数据 */ }
    const [d, c] = await Promise.allSettled([
      client.getAlbum(item.id).catch(() => null),
      client.getAlbumComments(item.id, 1).catch(() => null)
    ]);
    // 离开详情页后（reqId 已递增）拦截过期回包，避免 setState 破坏滚动恢复
    if (detailReqIdRef.current !== reqId) return;
    if (d.status === "fulfilled" && d.value) applyDetail(d.value);
    if (c.status === "fulfilled" && c.value) setComments(c.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 搜索结果页里的卡片点击 → 详情页（背后保留搜索页） */
  const openAlbumFromSearch = useCallback((a: AlbumSummary) => { void openDetail(a, "search"); }, [openDetail]);

  /** 立即阅读：不等 getRead 返回，先切阅读器再后台加载图片列表 */
  async function startRead() {
    if (!detail) return;
    const albumId = detail.id;
    const title = detail.name || "";
    // author 兼容两种数据源：列表乐观快照（string）与完整详情（string[]）
    const authorRaw = detail.author;
    const authorStr = Array.isArray(authorRaw) ? authorRaw.join("/") : (typeof authorRaw === "string" ? authorRaw : "");
    // 立即保存阅读记录（从列表页乐观数据中提取，不依赖完整详情）
    saveHistoryEntry({
      id: albumId,
      name: title,
      author: authorStr,
      adddate: detail.addtime as string | number | undefined,
      description: detail.description || undefined
    });
    setHistory(loadHistory());
    // 瞬间进入阅读器：用空 pages[] 渲染 ReaderPanel（会立即显示工具栏 + Loading）
    setRead({ id: albumId, images: [] });
    setMode("reader");
    setDlState("idle");
    setDlProgress(0);
    // 后台获取实际图片列表：到达后直接更新阅读器内容
    try {
      const r = await client.getRead(albumId);
      if (!r || !r.images || r.images.length === 0) {
        pushToast("该内容需先购买后才能阅读", "err");
        if (modeRef.current === "reader") setMode("detail");
        setRead(null);
        return;
      }
      setRead(r);
    } catch (err) {
      pushToast("阅读数据加载失败：" + String(err).slice(0, 80), "err");
      if (modeRef.current === "reader") setMode("detail");
      setRead(null);
    }
  }

  function jumpPage(p: number) {
    if (!read) return;
    const target = Math.min(Math.max(1, p), read.images.length);
    document.getElementById("pg-" + target)?.scrollIntoView({ block: "start" });
    setCurPage(target);
    setJumpInput(String(target));
  }

  async function doDownload() {
    if (!read) return;
    setDlState("run");
    setDlProgress(0);
    const done = await downloadAlbum(read.id, read.images, (doneCount) => setDlProgress(doneCount));
    setDlState("done");
    setCached(done > 0);
  }

  async function toggleFavorite() {
    if (!detail) return;
    if (detail.is_favorite) { pushToast("已在收藏中", "info"); return; }
    const ok = await run(() => client.addFavorite(detail.id));
    if (ok) {
      applyDetail({ ...detail, is_favorite: true });
      pushToast("已加入官方收藏", "ok");
    } else {
      pushToast("收藏失败，请重试", "err");
    }
  }

  async function switchChapter(id: number | string) {
    // 从当前 series 列表找到目标章节名做乐观快照，立刻展示
    const target = detail?.series?.find((s) => String(s.id) === String(id));
    if (target && detail) {
      const snapshot = { ...detail, id, name: target.name || detail.name } as unknown as AlbumDetail;
      applyDetail(snapshot);
    }
    setError("");
    const reqId = detailReqIdRef.current;
    // 后台拉取真实详情 + 评论
    const [d, c] = await Promise.allSettled([
      client.getAlbum(id).catch(() => null),
      client.getAlbumComments(id, 1).catch(() => null)
    ]);
    if (detailReqIdRef.current !== reqId) return; // 离开详情后忽略过期回包
    if (d.status === "fulfilled" && d.value) applyDetail(d.value);
    if (c.status === "fulfilled" && c.value) setComments(c.value);
  }

  const logged = Boolean(localStorage.getItem("jwttoken"));

  if (mode === "week" && week.payload) {
    return (
      <WeekRank
        payload={week.payload}
        items={week.items}
        issue={week.issue}
        type={week.type}
        busy={week.busy}
        error={week.error}
        gridKey={"week" + settingTick}
        onIssueChange={week.setIssue}
        onTypeChange={week.setType}
        onLoad={() => { void week.load(week.issue, week.type, 1, true); }}
        onOpenAlbum={openDetail}
        onBack={() => { week.reset(); detailReqIdRef.current++; setMode("home"); }}
      />
    );
  }

  if (mode === "detail" && detail) {
    return (
      <>
      {/* key 必须固定：否则 React 会把首页列表的 DOM 节点（含下拉刷新指示器）复用成本卡片，
          下拉刷新遗留的 180ms 定时器随后把 display:none 打到详情页上 → 白屏 */}
      <div key="detail-page" className={"page-push" + (srOpen ? " pushed" : "")} aria-hidden={srOpen}>
      <AlbumDetailPage
        detail={detail}
        logged={logged}
        busy={busy}
        comments={comments}
        commentText={commentText}
        backLabel={detailFrom === "search" && sr ? "返回搜索结果" : "返回列表"}
        onBack={detailBack}
        onCopyId={copyJmId}
        onOpenAuthor={(a) => openSpecialSearch("author", a)}
        onOpenTag={(t) => openSpecialSearch("tag", t)}
        onSwitchChapter={switchChapter}
        onBuy={buyAlbum}
        onToggleFavorite={toggleFavorite}
        onRead={startRead}
        onCommentChange={setCommentText}
        onSubmitComment={submitComment}
      />
      </div>
      <div className={"page-scrim" + (srOpen ? " on" : "")} aria-hidden="true" />
      {sr && (
        <SearchResultPage
          open={srOpen}
          kind={sr.kind}
          text={sr.text}
          items={sr.items}
          busy={sr.busy}
          error={sr.error}
          hasMore={sr.hasMore}
          resetKey={sr.kind + ":" + sr.text}
          coverTick={settingTick}
          onBack={closeSearch}
          onOpenAlbum={openAlbumFromSearch}
          onLoadMore={loadMoreSR}
        />
      )}
      </>
    );
  }

  async function buyAlbum() {
    if (!detail) return;
    let result: unknown = null;
    try {
      result = await client.purchaseAlbum(detail.id);
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
    // 成功：立即重新拉取详情确认真实解锁状态，避免误报
    const fresh = await client.getAlbum(detail.id).catch(() => null);
    if (fresh && !parsePaid(fresh)) {
      applyDetail(fresh);
      pushToast("购买成功，已解锁，可立即阅读", "ok");
      emit("jm:coinChanged");
    } else {
      if (fresh) applyDetail(fresh);
      pushToast(rawMsg || "已提交购买，请稍后刷新确认", "info");
    }
  }

  if (mode === "reader" && read) {
    return (
      <ReaderPanel
        albumId={read.id}
        pages={read.images}
        title={read.name || detail?.name || ""}
        scrambleId={read.scramble_id}
        onBack={exitReaderToDetail}
        meta={{
          author: Array.isArray(detail?.author) ? detail!.author.join("/") : (typeof detail?.author === "string" ? detail.author : ""),
          cover: detail ? albumCoverUrl({ id: detail.id, name: detail.name || "", update_at: detail.addtime }) : ""
        }}
      />
    );
  }

  function gotoPage(action: string) {
    emit("jm:goto", action);
  }

  if (pageMode === "search") {
    return (
      <SearchFeed
        query={search.query}
        type={search.type}
        items={search.items}
        page={search.page}
        hasMore={search.hasMore}
        busy={search.busy}
        error={search.error}
        searched={search.searched}
        hotTags={search.hotTags}
        hotErr={search.hotErr}
        history={search.history}
        gridKey={"g" + settingTick}
        onQueryChange={search.setQuery}
        onSubmit={search.submit}
        onRunTerm={search.runTerm}
        onTypeChange={search.changeType}
        onRetryHot={search.retryHot}
        onClearHistory={search.clearHistory}
        onLoadMore={search.loadMore}
        onOpenAlbum={openDetail}
      />
    );
  }

  if (pageMode === "categories") {
    return (
      <CategoryFeed
        categories={cat.categories}
        items={cat.items}
        slug={cat.slug}
        sub={cat.sub}
        order={cat.order}
        page={cat.page}
        hasMore={cat.hasMore}
        busy={cat.busy}
        error={cat.error}
        gridKey={"g" + settingTick}
        onPickCategory={(s) => { void cat.load(s, "", 1, true, ""); }}
        onPickSub={(s, subSlug, order) => { void cat.load(s, subSlug, 1, true, order); }}
        onSort={cat.changeSort}
        onLoadMore={cat.loadMore}
        onOpenAlbum={openDetail}
      />
    );
  }

  return (
    <PullToRefresh onRefresh={retryHomeFeed}>
      <HomeFeed
        items={home.items}
        page={home.page}
        hasMore={home.hasMore}
        busy={home.busy}
        error={home.error}
        gridKey={"g" + settingTick}
        onLatest={() => gotoPage("latest")}
        onRanking={() => gotoPage("ranking")}
        onRetry={retryHomeFeed}
        onGotoDns={() => emit("jm:gotoDns")}
        onLoadMore={home.loadMore}
        onOpenAlbum={openDetail}
      />
    </PullToRefresh>
  );
}
