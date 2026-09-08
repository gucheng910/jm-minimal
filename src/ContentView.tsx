import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBackHandler } from "./hooks/useBackHandler";
import type { FormEvent } from "react";
import { client } from "./core/api";
import { downloadAlbum, isAlbumCached } from "./core/offline";
import ReaderPanel from "./Reader";
import Loading from "./ui/Loading";
import { pushToast } from "./ui/toast";
import { sanitizeCommentHtml } from "./core/commentRich";
import { RANK_MODES, SORT_MODES, UI_KEYS } from "./core/constants";
import { albumCoverUrl } from "./ui/AlbumCard";
import { AlbumGrid } from "./ui/AlbumGrid";
import { SkeletonGrid } from "./ui/SkeletonGrid";
import { debouncedSetJSON, getJSONNow, removeKeyNow } from "./core/debounceStorage";
import { announceStartupReady, gatePassed } from "./core/startup";
import type { AlbumDetail, AlbumSummary, CategoryItem, ForumPayload, ReadPayload, WeekPayload } from "./core/types";

type Mode = "home" | "detail" | "reader" | "week";
type FeedKind = "latest" | "search" | "favorites" | "history" | "category" | "week" | null;

const PAGE_SIZE = 80;
// 滚动恢复 key（sessionStorage 兜底，避免 ref 丢失）
const SCROLL_KEY = "jm:pendingRestoreY";
const HISTORY_KEY = UI_KEYS.history;
const SEARCH_HISTORY_KEY = UI_KEYS.searchHistory;

function progressKey(id: number | string): string {
  return "jmclient.read.y." + String(id);
}

function loadHistory(): AlbumSummary[] {
  return getJSONNow<AlbumSummary[]>(HISTORY_KEY, []);
}

function loadSearchHistory(): string[] {
  return getJSONNow<string[]>(SEARCH_HISTORY_KEY, []);
}

function rememberSearch(q: string) {
  const list = loadSearchHistory().filter((x) => x !== q);
  list.unshift(q);
  debouncedSetJSON(SEARCH_HISTORY_KEY, list.slice(0, 12), 300);
}

function saveHistoryEntry(entry: AlbumSummary) {
  const list = loadHistory().filter((x) => String(x.id) !== String(entry.id));
  list.unshift(entry);
  debouncedSetJSON(HISTORY_KEY, list.slice(0, 50), 500);
}

/** 是否付费未购：price 为有效金额且 purchased 无已购标记 */
function parsePaid(d: AlbumDetail): boolean {
  const p = Number(d.price);
  if (!(p > 0)) return false;
  const own = typeof d.purchased === "string"
    ? !["", "0", "false", "null", "undefined"].includes(String(d.purchased).toLowerCase())
    : Boolean(d.purchased);
  return !own;
}

interface ContentViewProps { initialAction?: string }

export default function ContentView({ initialAction = "" }: ContentViewProps = {}) {
  const pageMode = initialAction === "categories" ? "categories" : initialAction === "search" ? "search" : "home";
  const [mode, setMode] = useState<Mode>("home");
  const [items, setItems] = useState<AlbumSummary[]>([]);
  const [query, setQuery] = useState("");
  const [feedKind, setFeedKind] = useState<FeedKind>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [detail, setDetail] = useState<AlbumDetail | null>(null);
  const [read, setRead] = useState<ReadPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<AlbumSummary[]>(loadHistory);
  const [categoryList, setCategoryList] = useState<CategoryItem[]>([]);
  const [weekPayload, setWeekPayload] = useState<WeekPayload | null>(null);
  const [feedC, setFeedC] = useState("");
  const [feedOrder, setFeedOrder] = useState("");
  const [catSlug, setCatSlug] = useState("");
  const [catSub, setCatSub] = useState("");
  const [weekType, setWeekType] = useState("");
  const [weekIssue, setWeekIssue] = useState("");
  const [weekMode, setWeekMode] = useState(false);
  const [comments, setComments] = useState<ForumPayload | null>(null);
  const [commentText, setCommentText] = useState("");
  const [cached, setCached] = useState(false);
  const [dlProgress, setDlProgress] = useState(0);
  const [dlState, setDlState] = useState<"idle" | "run" | "done">("idle");
  const [curPage, setCurPage] = useState(1);
  const [jumpInput, setJumpInput] = useState("1");
  const [searchType, setSearchType] = useState("site");
  const [hotTags, setHotTags] = useState<string[]>([]);
  const [searched, setSearched] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  // 下拉刷新：DOM 直接更新（无 setState 触发重渲染） + 固定阈值
  const [refreshing, setRefreshing] = useState(false);
  const ptrStartY = useRef(0);
  const ptrPosRef = useRef(0);
  const isRefreshingRef = useRef(false);
  const ptrIndicatorRef = useRef<HTMLDivElement | null>(null);
  const ptrArrowRef = useRef<HTMLSpanElement | null>(null);
  const ptrLabelRef = useRef<HTMLSpanElement | null>(null);
  const MAX_PULL = 110;          // 阻力公式校正：拉到 110px 时即可达到阈值
  const REFRESH_THRESHOLD = 70;   // 阈值 70px，正常手指下滑一次即可触发
  // 同步 mode 的 ref：异步回调里判断用户是否已主动进入详情/阅读器（防止首页预取把页面打回 home）
  const modeRef = useRef<Mode>("home");
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent<boolean>("jm:immersive", { detail: mode === "reader" }));
  }, [mode]);

  // setting/图床配置迟到时刷新封面（例如测速兜底后才拿到 img_host）
  const [settingTick, setSettingTick] = useState(0);
  useEffect(() => {
    const h = () => setSettingTick((t) => t + 1);
    window.addEventListener("jm:setting", h);
    return () => window.removeEventListener("jm:setting", h);
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

  function exitDetailToHome() {
    setDetail(null);
    // 作废仍在执行的 openDetail/switchChapter 异步回调（防止 setState 干扰滚动）
    detailReqIdRef.current++;
    setMode("home");
  }

  function exitWeekToHome() {
    setWeekMode(false);
    detailReqIdRef.current++;
    setMode("home");
  }

  function exitReaderToDetail() {
    setRead(null);
    setMode("detail");
    // 阅读器滚动很长：回到详情需先回到页面顶部（进度已由阅读器自行保存，不影响）
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }

  useBackHandler(() => {
    if (mode === "reader") {
      client.finishFastTrack();
      exitReaderToDetail();
    } else if (mode === "detail") {
      exitDetailToHome();
    } else if (mode === "week") {
      exitWeekToHome();
    } else {
      // home 等其他模式不消费返回键，让 App.tsx 处理两次返回退出
      return false;
    }
  }, [mode]);

  const [hotErr, setHotErr] = useState("");

  useEffect(() => {
    if (pageMode !== "search") return;
    let alive = true;
    setSearchHistory(loadSearchHistory());
    setHotErr("");
    (async () => {
      try {
        if (!client.apiBase) { try { await client.init(); } catch { return; } }
        if (!client.setting) { client.getSetting().catch(() => { /* 后台尽力，不阻塞热词 */ }); }
        const loadTags = async (): Promise<string[]> => {
          const t = await client.getHotTags();
          return Array.isArray(t) ? t : [];
        };
        let tags: string[] = [];
        try { tags = await loadTags(); } catch (err) { if (alive) setHotErr(String(err).slice(0, 100)); }
        if (alive && tags.length === 0) {
          await new Promise((r) => setTimeout(r, 900));
          try { tags = await loadTags(); } catch (err) { if (alive) setHotErr(String(err).slice(0, 100)); }
        }
        if (alive && tags.length > 0) { setHotErr(""); setHotTags(tags); }
      } catch { /* 静默 */ }
    })();
    return () => { alive = false; };
  }, [pageMode]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const action = (ev as CustomEvent<string>).detail;
      if (action === "categories") {
        // 分类页默认停留在“最新A漫”并自动加载一次列表（先确保 apiBase 就绪）
        (async () => {
          try {
            if (!client.apiBase) await client.init();
            setFeedOrder("");
            await openCategories();
            loadCategory("", "", 1, true, "");
          } catch (err) {
            setError(String(err));
          }
        })();
      }
      if (action === "latest") { loadLatest(); }
      if (action === "ranking") { openWeek(); }
      if (action === "search") {
        setMode("home");
        window.scrollTo({ top: 0 });
        setTimeout(() => document.querySelector<HTMLInputElement>(".searchbar input")?.focus(), 120);
      }
    };
    window.addEventListener("jm:nav", handler);
    return () => window.removeEventListener("jm:nav", handler);
  }, []);

  useEffect(() => {
    if (pageMode !== "home") return;
    const handler = () => {
      // 底部“首页”再次点击：从详情/阅读退回列表并刷新首页推荐
      setRead(null);
      setDetail(null);
      setComments(null);
      setMode("home");
      window.scrollTo({ top: 0 });
      loadRandom();
    };
    window.addEventListener("jm:refreshHome", handler);
    return () => window.removeEventListener("jm:refreshHome", handler);
  }, [pageMode]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const aid = String((ev as CustomEvent).detail || "");
      if (!aid || pageMode !== "home") return;
      openDetail({ id: aid } as AlbumSummary);
    };
    window.addEventListener("jm:openAid", handler);
    return () => window.removeEventListener("jm:openAid", handler);
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
          await openCategories();
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
            showList(list, "latest", false);
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

  function showList(list: AlbumSummary[], kind: FeedKind, hasMoreFlag = false, p = 1) {
    setItems(list);
    setFeedKind(kind);
    setPage(p);
    setHasMore(hasMoreFlag);
    // 用户已主动进入详情/阅读器时，不把首页预取结果打回 home
    // （修复：从会员页收藏/足迹点进详情，被冷启动测速后的 showList 抢回首页）
    if (modeRef.current === "detail" || modeRef.current === "reader") return;
    setMode("home");
    // 首屏前 6 张封面预取（不阻塞渲染，命中浏览器缓存后立即显示）
    try {
      for (const a of list.slice(0, 6)) {
        const url = albumCoverUrl(a);
        if (url.startsWith("http")) {
          const im = new Image();
          im.decoding = "async";
          im.src = url;
        }
      }
    } catch { /* ignore */ }
  }

  async function loadLatest() {
    const list = await run(() => client.getLatest());
    if (list) showList(list, "latest", list.length >= PAGE_SIZE);
  }

  async function loadRandom() {
    const list = await run(() => client.getRandomRecommend());
    if (list) {
      showList(list, "latest", false);
    } else if (list === null) {
      // run() 失败已置 error；这里统一为可操作的提示
      setError("网络连接失败，推荐内容加载不出来。先去会员页「DNS 加速」配置 DoT 公共 DNS（可解决大多数运营商 DNS 污染）；配置后需删除后台重新进入 App 使设置生效，再重试；仍失败再尝试魔法或切换线路。");
      pushToast("内容加载失败，建议先配 DNS，配置后删除后台重进生效", "err", "goto-dns");
    }
  }

  async function openCategories() {
    const cats = await run(() => client.getCategories());
    if (cats) {
      setCategoryList(cats.categories || []);
      // 注意：不能 setMode("home")——若它晚于“排行榜”打开完成，会把周榜页打回分类初始页
    }
  }

  async function loadCategory(slug: string, sub = "", p = 1, replace = true, order?: string) {
    const c = sub ? slug + "_" + sub : slug;
    const o = order !== undefined ? order : feedOrder;
    const result = await run(() => client.getCategoryAlbums(c, p, o));
    if (!result) return;
    const content = result.content || [];
    const next = replace ? content : [...items, ...content];
    const total = Number(result.total || 0);
    setCatSlug(slug);
    setCatSub(sub);
    setFeedC(c);
    showList(next, "category", replace ? next.length < total : next.length < total, p);
  }

  function changeSort(o: string) {
    setFeedOrder(o);
    loadCategory(catSlug, catSub, 1, true, o);
  }

  async function openWeek() {
    if (mode === "home") saveScrollTarget(window.scrollY); // 记住打开周榜前列位置
    const wk = await run(() => client.getWeek());
    if (!wk) return;
    setWeekPayload(wk);
    setWeekMode(true);
    setMode("week");
    // 自动选中最新一期 + 全部类型并立即加载（type 为空=全部）
    const latest = wk.categories && wk.categories[0];
    if (latest) {
      setWeekIssue(String(latest.id));
      setWeekType("");
      await loadWeekList(String(latest.id), "", 1, true);
    }
  }

  async function loadWeekList(issueId?: string, type?: string, p = 1, replace = true) {
    const iid = issueId || weekIssue;
    const tid = type || weekType;
    if (!iid) return; // tid 为空串=全部类型
    const result = await run(() => client.getWeekAlbums(iid, tid, p));
    if (!result) return;
    const list = result.list || [];
    const next = replace ? list : [...items, ...list];
    setWeekIssue(iid);
    setWeekType(tid);
    // 注意：不能走 showList（它会 setMode("home") 把排行榜页打回分类页）
    setItems(next);
    setFeedKind("week");
    setPage(p);
    setHasMore(list.length >= PAGE_SIZE);
  }

  async function doSearch(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    rememberSearch(query.trim());
    setSearchHistory(loadSearchHistory());
    setSearched(true);
    await searchPage(query.trim(), 1, true, searchType);
  }

  async function searchPage(q: string, p: number, replace: boolean, type = searchType) {
    const result = await run(() => client.search(q, p, 0, type));
    if (!result) return;
    // 官方协议：搜索纯数字 JM 号时服务器返回 redirect_aid（无 content）
    // 客户端收到后直接跳转详情页，与官方 v2.1.5 行为一致
    if (replace && result.redirect_aid) {
      openDetail({ id: result.redirect_aid } as AlbumSummary);
      return;
    }
    const total = Number(result.total || 0);
    const next = replace ? result.content || [] : [...items, ...(result.content || [])];
    showList(next, "search", next.length < total, p);
  }

  function changeSearchType(t: string) {
    setSearchType(t);
    if (searched && query.trim()) searchPage(query.trim(), 1, true, t);
  }

  function runSearchTerm(term: string) {
    setQuery(term);
    rememberSearch(term);
    setSearchHistory(loadSearchHistory());
    setSearched(true);
    searchPage(term, 1, true, searchType);
  }

  function clearSearchHistory() {
    removeKeyNow(SEARCH_HISTORY_KEY);
    setSearchHistory([]);
  }

  function retryHomeFeed() {
    // 与底部导航点击「首页」时的刷新逻辑完全一致（复用 jm:refreshHome 事件）
    setRead(null);
    setDetail(null);
    setComments(null);
    setMode("home");
    window.scrollTo({ top: 0 });
    loadRandom();
  }

  function handlePTRStart(e: React.TouchEvent) {
    if (window.scrollY > 0 || isRefreshingRef.current) return;
    ptrStartY.current = e.touches[0].clientY;
  }
  function handlePTRMove(e: React.TouchEvent) {
    if (ptrStartY.current === 0 || isRefreshingRef.current) return;
    const raw = e.touches[0].clientY - ptrStartY.current;
    if (raw <= 0) {
      ptrPosRef.current = 0;
      updatePTRUI(0);
      return;
    }
    // 阻力公式（更平缓）：pos = raw / (1 + raw/k)
    // raw=70 → pos≈53；raw=150 → pos≈91；raw=300 → pos≈120（封顶）
    const pos = Math.min(raw / (1 + raw / 220), MAX_PULL);
    ptrPosRef.current = pos;
    updatePTRUI(pos);
  }
  function handlePTREnd() {
    if (ptrStartY.current === 0) return;
    ptrStartY.current = 0;
    const finalPos = ptrPosRef.current;
    ptrPosRef.current = 0;
    hidePTRUI();
    if (finalPos < REFRESH_THRESHOLD) return; // 未达阈值，自动回弹
    isRefreshingRef.current = true;
    setRefreshing(true);
    showRefreshingUI();
    Promise.resolve().then(() => retryHomeFeed()).finally(() => {
      isRefreshingRef.current = false;
      setRefreshing(false);
    });
  }
  // 直接操作 DOM，避免 React 重渲染造成的卡顿
  function updatePTRUI(pos: number) {
    const ind = ptrIndicatorRef.current;
    const arr = ptrArrowRef.current;
    const lab = ptrLabelRef.current;
    if (!ind || !arr || !lab) return;
    const h = Math.min(pos * 0.7, 60);
    ind.style.height = h + "px";
    ind.style.opacity = String(Math.min(pos / REFRESH_THRESHOLD, 1));
    ind.style.display = "flex";
    const reachThreshold = pos >= REFRESH_THRESHOLD;
    arr.style.transform = reachThreshold
      ? "rotate(180deg)"
      : "rotate(" + Math.min(pos / REFRESH_THRESHOLD * 180, 180) + "deg)";
    arr.style.color = reachThreshold ? "var(--brand)" : "var(--ink-2)";
    lab.textContent = reachThreshold ? "松手刷新" : "继续下拉";
  }
  function hidePTRUI() {
    const ind = ptrIndicatorRef.current;
    if (ind) {
      ind.style.transition = "height 0.18s ease, opacity 0.18s ease";
      ind.style.height = "0px";
      ind.style.opacity = "0";
      setTimeout(() => {
        if (ind) ind.style.display = "none";
        ind.style.transition = "";
      }, 180);
    }
  }
  function showRefreshingUI() {
    const ind = ptrIndicatorRef.current;
    const arr = ptrArrowRef.current;
    const lab = ptrLabelRef.current;
    if (!ind || !arr || !lab) return;
    ind.style.transition = "none";
    ind.style.height = "60px";
    ind.style.opacity = "1";
    ind.style.display = "flex";
    arr.style.transform = "none";
    arr.className = "ptr-spinner";
    lab.textContent = "正在刷新…";
  }

  async function loadMore() {
    if (feedKind === "latest") {
      const p = page + 1;
      const list = await run(() => client.request<AlbumSummary[]>("/latest", { page: p }));
      if (list) { const next = [...items, ...list]; showList(next, "latest", list.length >= PAGE_SIZE, p); }
    } else if (feedKind === "search" && query.trim()) {
      await searchPage(query.trim(), page + 1, false);
    } else if (feedKind === "category") {
      const p = page + 1;
      const result = await run(() => client.getCategoryAlbums(feedC, p, feedOrder));
      if (result && result.content) showList([...items, ...result.content], "category", items.length + result.content.length < Number(result.total || 0), p);
    } else if (feedKind === "week" && weekIssue && weekType) {
      const p = page + 1;
      await loadWeekList(weekIssue, weekType, p, false);
    }
  }

  async function loadFavorites() {
    const result = await run(() => client.getFavorites());
    if (!result) return;
    const obj = result as { list?: AlbumSummary[]; content?: AlbumSummary[]; data?: { list?: AlbumSummary[] } };
    const list = obj.list || obj.content || obj.data?.list || [];
    showList(list, "favorites");
  }

  const openDetail = useCallback(async (item: AlbumSummary) => {
    saveScrollTarget(window.scrollY); // 记住进入详情前列表位置
    // 乐观渲染：用列表页已有摘要立刻展示详情页，不等 API
    const snapshot = { ...item, name: item.name || "" } as unknown as AlbumDetail;
    setDetail(snapshot);
    setMode("detail");
    setComments(null);
    setError("");
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
    if (d.status === "fulfilled" && d.value) setDetail(d.value);
    if (c.status === "fulfilled" && c.value) setComments(c.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setDetail({ ...detail, is_favorite: true });
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
      setDetail(snapshot);
    }
    setError("");
    const reqId = detailReqIdRef.current;
    // 后台拉取真实详情 + 评论
    const [d, c] = await Promise.allSettled([
      client.getAlbum(id).catch(() => null),
      client.getAlbumComments(id, 1).catch(() => null)
    ]);
    if (detailReqIdRef.current !== reqId) return; // 离开详情后忽略过期回包
    if (d.status === "fulfilled" && d.value) setDetail(d.value);
    if (c.status === "fulfilled" && c.value) setComments(c.value);
  }

  const logged = Boolean(localStorage.getItem("jwttoken"));

  if (mode === "week" && weekPayload) {
    return (
      <div className="card">
        <button className="ghost" onClick={exitWeekToHome}>返回列表</button>
        <h2>周榜（选择期号 + 类型）</h2>
        <div className="row">
          <select value={weekIssue} onChange={(e) => setWeekIssue(e.target.value)}>
            <option value="">选择期号</option>
            {weekPayload.categories.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.time || c.id)}</option>)}
          </select>
          <select value={weekType} onChange={(e) => setWeekType(e.target.value)}>
            <option value="">全部类型</option>
            {weekPayload.type.map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.title)}</option>)}
          </select>
          <button disabled={busy || !weekIssue || !weekType} onClick={() => loadWeekList(weekIssue, weekType, 1, true)}>加载该期</button>
        </div>
        <AlbumGrid key={"g" + settingTick} items={items} onOpen={openDetail} />
      </div>
    );
  }

  if (mode === "detail" && detail) {
    const locked = parsePaid(detail);
    return (
      <div className="card">
        <button className="ghost" onClick={exitDetailToHome}>返回列表</button>
        <h2>{detail.name}</h2>
        <p className="muted">JM号：{String(detail.id)}
          <button className="ghost" style={{ marginLeft: 8 }} onClick={() => { navigator.clipboard.writeText(String(detail.id)); pushToast("JM号已复制", "ok"); }}>复制</button>
        </p>
        <p className="muted">作者：{(Array.isArray(detail.author) ? detail.author : [detail.author].filter(Boolean)).join(" / ") || "-"} · 页数：{String(detail.total_photos ?? "-")}</p>
        <p className="muted">标签：{(detail.tags || []).join("、") || "-"}</p>
        {Array.isArray(detail.series) && detail.series.length > 1 && (
          <div className="row">
            <label>选择话数</label>
            <select value={String(detail.id)} onChange={(e) => switchChapter(e.target.value)}>
              {detail.series.map((s) => <option key={String(s.id)} value={String(s.id)}>{"#" + String(s.sort ?? "") + " " + (s.name || "")}</option>)}
            </select>
          </div>
        )}
        <p>{detail.description}</p>
        {locked && !logged && <p className="err">官方付费内容：请先登录，再通过官方会员中心购买（本客户端不做绕过）</p>}
        {locked && logged && <div className="row"><button disabled={busy} onClick={buyAlbum}>使用官方 JCoin 购买</button></div>}
        {!locked && (
          <div className="row action-row">
            {logged && <button className="ghost" disabled={busy || Boolean(detail.is_favorite)} onClick={toggleFavorite}>{detail.is_favorite ? "已收藏" : "☆ 收藏"}</button>}
            <button disabled={busy} onClick={startRead}>立即阅读</button>
          </div>
        )}
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
              <textarea value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="发表评论（真实动作，请谨慎）" rows={3} />
              <div className="row"><button disabled={busy || !commentText.trim()} onClick={submitComment}>发送评论（官方 /comment）</button></div>
            </div>
          )}
          {!logged && <p className="muted">登录后可评论</p>}
        </div>
      </div>
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
      setDetail(fresh);
      pushToast("购买成功，已解锁，可立即阅读", "ok");
      try { window.dispatchEvent(new CustomEvent("jm:coinChanged")); } catch { /* ignore */ }
    } else {
      if (fresh) setDetail(fresh);
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
    window.dispatchEvent(new CustomEvent<string>("jm:goto", { detail: action }));
  }

  if (pageMode === "search") {
    const typeLabels: Array<{ key: string; label: string }> = [
      { key: "site", label: "站内搜索" },
      { key: "work", label: "作品" },
      { key: "author", label: "作者" },
      { key: "tag", label: "标签" },
      { key: "character", label: "登场人物" }
    ];
    return (
      <div>
        <form className="searchbar card" onSubmit={doSearch}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索（官方接口）" />
          <button disabled={busy || !query.trim()}>搜索</button>
        </form>
        <div className="card row">
          {typeLabels.map((t) => (
            <button key={t.key} className={searchType === t.key ? "chip active" : "chip"} onClick={() => changeSearchType(t.key)}>{t.label}</button>
          ))}
        </div>
        {!searched ? (
          <div>
            <div className="card">
              <h3>热门搜索</h3>
              {hotTags.length > 0 ? (
                <div className="row">{hotTags.map((t) => <button key={t} className="chip" onClick={() => runSearchTerm(t)}>{t}</button>)}</div>
              ) : hotErr ? (
                <div className="row">
                  <span className="err small-err">加载失败：{hotErr}</span>
                  <button className="ghost" onClick={() => { setHotErr(""); client.getHotTags().then((t) => { if (Array.isArray(t) && t.length) { setHotTags(t); setHotErr(""); } }).catch((e) => setHotErr(String(e).slice(0, 120))); }}>重试</button>
                </div>
              ) : (
                <p className="muted">正在加载…</p>
              )}
            </div>
            {searchHistory.length > 0 && (
              <div className="card">
                <div className="row"><h3>搜索记录</h3><button onClick={clearSearchHistory}>清除</button></div>
                <div className="row">{searchHistory.map((t) => <button key={t} className="chip" onClick={() => runSearchTerm(t)}>{t}</button>)}</div>
              </div>
            )}
          </div>
        ) : (
          <div>
            {error && <div className="card err">{error}</div>}
            {busy && items.length === 0 ? <SkeletonGrid /> : null}
            <AlbumGrid key={"g" + settingTick} items={items} onOpen={openDetail} />
            {hasMore && <div className="card row"><button disabled={busy} onClick={loadMore}>加载更多（第 {page + 1} 页）</button></div>}
          </div>
        )}
      </div>
    );
  }

  if (pageMode === "categories") {
    const activeCat = categoryList.find((c) => String(c.slug ?? "") === String(catSlug ?? ""));
    const subCats = activeCat?.sub_categories || [];
    return (
      <div>
        <div className="card row">
          {categoryList.map((c) => {
            const slug = String(c.slug ?? "");
            const active = slug === String(catSlug ?? "") && !catSub;
            return (
              <button key={slug || String(c.id)} className={active ? "chip active" : "chip"} disabled={busy} onClick={() => { setFeedOrder(""); loadCategory(slug, "", 1, true, ""); }}>{c.name}</button>
            );
          })}
        </div>
        <div className="card row">
          <span className="chip-label">排序</span>
          {SORT_MODES.map(([k, label]) => (
            <button key={k} className={(feedOrder === k ? "chip active" : "chip") + " sort-chip"} disabled={busy} onClick={() => changeSort(k)}>{label}</button>
          ))}
        </div>
        <div className="card row">
          <span className="chip-label">排行榜</span>
          {RANK_MODES.map(([k, label]) => (
            <button key={k} className={(feedOrder === k ? "chip active" : "chip") + " sort-chip"} disabled={busy} onClick={() => changeSort(k)}>{label}</button>
          ))}
        </div>
        {subCats.length > 0 && (
          <div className="card row">
            {subCats.map((s) => {
              const subSlug = String(s.slug ?? "");
              const active = catSub === subSlug;
              return (
                <button key={subSlug} className={active ? "chip active" : "chip"} disabled={busy} onClick={() => loadCategory(String(activeCat?.slug ?? ""), subSlug, 1, true, feedOrder)}>{s.name}</button>
              );
            })}
          </div>
        )}
        {error && <div className="card err">{error}</div>}
        {busy && items.length === 0 ? <SkeletonGrid /> : null}
        <AlbumGrid key={"g" + settingTick} items={items} onOpen={openDetail} />
        {hasMore && <div className="card row"><button disabled={busy} onClick={loadMore}>加载更多（第 {page + 1} 页）</button></div>}
      </div>
    );
  }

  return (
    <div onTouchStart={handlePTRStart} onTouchMove={handlePTRMove} onTouchEnd={handlePTREnd}>
      <div ref={ptrIndicatorRef} className="ptr-indicator" style={{ height: 0, opacity: 0, display: "none" }}>
        <span ref={ptrArrowRef} className="ptr-arrow">↓</span>
        <span ref={ptrLabelRef}></span>
      </div>
      <div className="card row">
        <button className="ghost" disabled={busy} onClick={() => gotoPage("latest")}>最新</button>
        <button className="ghost" disabled={busy} onClick={() => gotoPage("ranking")}>排行榜</button>
      </div>
      {error && (
        <div className="card err">
          {error}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="ghost" disabled={busy} onClick={retryHomeFeed}>重新加载推荐</button>
            <button className="ghost" onClick={() => window.dispatchEvent(new CustomEvent("jm:gotoDns"))}>去配 DNS</button>
          </div>
        </div>
      )}
      {busy && items.length === 0 ? <SkeletonGrid /> : null}
      <AlbumGrid key={"g" + settingTick} items={items} onOpen={openDetail} />
      {hasMore && <div className="card row"><button disabled={busy} onClick={loadMore}>加载更多（第 {page + 1} 页）</button></div>}
    </div>
  );
}
