import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBackHandler } from "./hooks/useBackHandler";
import { navTransition } from "./core/viewTransition";
import { emit, on } from "./core/bus";
import { client } from "./core/api";
import ReaderPanel from "./Reader";
import { pushToast } from "./ui/toast";
import { useWeekRank } from "./hooks/useWeekRank";
import { useCategoryFeed } from "./hooks/useCategoryFeed";
import { useSearchFeed } from "./hooks/useSearchFeed";
import SearchFeed from "./pages/SearchFeed";
import AlbumDetailPage from "./pages/AlbumDetail";
import HomeFeed from "./pages/HomeFeed";
import { SkeletonGrid } from "./ui/SkeletonGrid";
import PullToRefresh from "./ui/PullToRefresh";
import { useHomeFeed } from "./hooks/useHomeFeed";
import { useAlbumDetail } from "./hooks/useAlbumDetail";
import { useLoggedIn } from "./hooks/useLoggedIn";
import CategoryFeed from "./pages/CategoryFeed";
import WeekRank from "./pages/WeekRank";
import { albumCoverUrl } from "./ui/AlbumCard";
import { SearchResultPage } from "./ui/SearchResultPage";
import type { SRKind } from "./ui/SearchResultPage";
import { KIND_META } from "./ui/SearchResultPage";
import { announceStartupReady, gatePassed } from "./core/startup";
import { bookIdOf } from "./core/series";
import { hasOpenSheet } from "./core/uiLocks";
import { useBodyScrollLock } from "./hooks/useBodyScrollLock";
import { bookMetaFromDetail, chapterLabel } from "./core/offlineMeta";
import type { AlbumDetail, AlbumSummary } from "./core/types";
import { isSearch, lastDetail, patchScreen, popScreen, pushScreen, topScreen } from "./core/navStack";
import type { Screen, SearchScreen } from "./core/navStack";

type Mode = "home" | "detail" | "reader" | "week";

/** 搜索层退场动画时长：与 --t-page 一致（弹栈后要留它挂一拍才能播完"向右滑出"） */
const SR_EXIT_MS = 340;

interface ContentViewProps { initialAction?: string }

export default function ContentView({ initialAction = "" }: ContentViewProps = {}) {
  const pageMode = initialAction === "categories" ? "categories" : initialAction === "search" ? "search" : "home";
  const [mode, setMode] = useState<Mode>("home");
  // ---- 页面栈（导航的唯一真相）----
  // 详情层与搜索层放进同一个栈，栈顶 = 当前屏幕，返回 = 弹一层：
  //   列表 → 详情A → 搜索X → 详情B → 搜索Y
  //   返回：       A  ←  X  ←  B  ←  Y        （每弹一层正好是链路上的前一屏）
  // 因为"返回该回哪里"由栈本身回答，这里不再需要 detailFrom / srParent / srOpen 这些互相牵制的状态
  // （上一版就是因为它们会不一致，导致真机"回错页面、搜索页内容串了"）。
  // 纯函数与不变量见 core/navStack.ts（有单元测试守着那条返回链）。
  const [screens, setScreens] = useState<Screen[]>([]);
  /** 正在退场的搜索层：弹栈后还要挂一拍，才能播完"向右滑出"的退出动画 */
  const [leaving, setLeaving] = useState<SearchScreen | null>(null);
  /** 这次露出的方向：push=新层从右拉入 / pop=被露出的层从左归位（进入动效的反方向） */
  const [srNavDir, setSrNavDir] = useState<"push" | "pop">("push");
  const navIdRef = useRef(0);
  const leavingTimerRef = useRef(0);
  /**
   * 连点保护：一次进入动画只有 ~320ms，没播完就再点一下会「连着压两层」——
   * 在搜索层的结果里连点两张卡片会压两层详情层，返回时先退回上一部漫画（真机"点多了还错乱"）。
   * 从列表进入是整栈替换（幂等），不需要锁；只有「压栈」类导航用这个短锁。
   */
  const navLockRef = useRef(0);
  /**
   * 活着的层 id 集合，**在派发时就同步维护**（不是渲染期镜像）。
   * 异步回包只认它：搜索层刚压入、React 还没重渲时，它的 id 已经在里面了，
   * 因此"命中缓存的秒回包"不会被误判成过期丢掉（上一版正是这里出问题 → 空骨架/内容串了）。
   */
  const liveIdsRef = useRef<Set<number>>(new Set());
  /** 最新栈的只读镜像：只用于事件处理器里"读当前栈" */
  const screensRef = useRef<Screen[]>([]);
  screensRef.current = screens;
  const top = topScreen(screens);
  /** 顶层是搜索层 → 覆盖层开着（详情页被压在背后） */
  const srOpen = isSearch(top);
  const openSearchId = srOpen ? top.id : 0;
  /** 当前该渲染的那一屏详情（栈里最靠上的详情层） */
  const shownDetail = lastDetail(screens);
  // 详情页数据与动作：详情/评论/收藏/购买/切章/阅读器数据
  const album = useAlbumDetail({
    // 栈里那层详情的快照一并刷新（避免返回时拿到旧数据）
    onDetailChanged: (next) => {
      if (!next) return;
      setScreens((s) => {
        const hit = s.find((x) => x.k === "detail" && String(x.snap.id) === String(next.id));
        return hit ? patchScreen(s, hit.id, { snap: next }) : s;
      });
    },
    isReaderActive: () => modeRef.current === "reader",
    onReadFail: () => setMode("detail")
  });
  // 列表已有内容、只是刷新/分页失败时的提示：只 toast，不把整屏顶成错误态
  const staleFail = useCallback((msg: string) => pushToast(msg, "err"), []);
  const cat = useCategoryFeed(staleFail);
  // 首页内容流：列表/分页/错误都在 hook 内；onListShown 负责「是否切回 home」的编排
  const home = useHomeFeed({
    onListShown: () => {
      // 用户已主动进入详情/阅读器时，不把首页预取结果打回 home
      // （修复：从会员页收藏/足迹点进详情，被冷启动测速后的 showList 抢回首页）
      if (modeRef.current === "detail" || modeRef.current === "reader") return;
      setMode("home");
    },
    onRandomFail: () => pushToast("内容加载失败，建议先配 DNS，配置后删除后台重进生效", "err", "goto-dns"),
    onStaleFail: staleFail
  });
  const week = useWeekRank(staleFail);
  // 搜索纯数字 JM 号时服务端返回 redirect_aid → 直接打开详情页
  const search = useSearchFeed((aid) => { void openDetail({ id: aid } as AlbumSummary); }, staleFail);
  // 同步 mode 的 ref：异步回调里判断用户是否已主动进入详情/阅读器（防止首页预取把页面打回 home）
  const modeRef = useRef<Mode>("home");
  useEffect(() => { modeRef.current = mode; }, [mode]);

  useEffect(() => {
    emit("jm:immersive", mode === "reader");
  }, [mode]);

  // 搜索页在前台时锁住底层详情页的滚动（搜索页自带滚动容器）
  useBodyScrollLock(srOpen);
  // 兜底：把"活层 id 集合"对齐到已提交的栈（真正的时效性靠派发时的 markLive，
  // 这里只负责兜住冷启动 / 直接 setScreens 这类没走 markLive 的路径）
  useEffect(() => {
    liveIdsRef.current = new Set(screens.map((s) => s.id));
  }, [screens]);

  // setting/图床配置迟到时刷新封面（例如测速兜底后才拿到 img_host）
  const [settingTick, setSettingTick] = useState(0);
  useEffect(() => {
    const h = () => setSettingTick((t) => t + 1);
    return on("jm:setting", h);
  }, []);

  // 首页分段：推荐（随机推荐接口）/ 最新 / 每周必看
  const [homeFeed, setHomeFeed] = useState<"random" | "latest" | "weekly">("random");
  function pickHomeFeed(key: string) {
    if (key === "weekly") {
      // 就地渲染周榜：只切分段，不切 tab。
      // 以前这里走 gotoPage("ranking") → App 收到 jm:goto 会 setTab("categories")，
      // 于是"点每周必看"实际是把用户甩到分类页，周榜只是顺带渲染在那儿。
      setHomeFeed("weekly");
      if (!week.payload) void week.open(); // 已有数据就直接复用，不重复拉
      return;
    }
    const next = key === "latest" ? "latest" : "random";
    setHomeFeed(next);
    if (next === "latest") void home.loadLatest();
    else void home.loadRandom();
  }

  // 记录离开列表（进入详情/周榜）前的滚动位置，返回时恢复，避免找漫翻页丢失
  const listScrollRef = useRef(0);
  // 离开详情页的序号：每次 exitDetail/exitWeek 递增，进入详情页时同步递增
  // 用于在离开后拦截仍在运行的 getAlbum/getAlbumComments 回调
  const commentReqIdRef = useRef(0);

  /**
   * 保存待恢复的滚动位置。**只存在内存里（临时）**：列表位置是"这一趟浏览的上下文"，
   * 不是长期数据 —— 退出应用重进首页就该回到顶部，所以不落 localStorage/sessionStorage。
   */
  function saveScrollTarget(y: number) {
    listScrollRef.current = y;
  }

  /**
   * useLayoutEffect: mode 从非 home 切回 home 时，在浏览器绘制前同步恢复滚动。
   * 列表是异步渲染 + 图片懒加载的，刚切回来时文档可能还不够高，scrollTo 会被浏览器截断到当前最大滚动量；
   * 因此补两次「如果没到位就再滚一次」（下一帧 + 120ms + 400ms），用户一旦自己滑动就立即放弃，不抢用户的手。
   */
  useLayoutEffect(() => {
    if (mode !== "home") return;
    const y = listScrollRef.current; // 只认内存里的临时位置；重启/重进应用就是 0 → 停在顶部
    if (y <= 0) return;
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    window.addEventListener("touchstart", cancel, { once: true, passive: true });
    window.addEventListener("wheel", cancel, { once: true, passive: true });
    const apply = () => { if (!cancelled && Math.abs(window.scrollY - y) > 4) window.scrollTo(0, y); };
    window.scrollTo(0, y);
    const raf = requestAnimationFrame(apply);
    const t1 = window.setTimeout(apply, 120);
    const t2 = window.setTimeout(apply, 400);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.removeEventListener("touchstart", cancel);
      window.removeEventListener("wheel", cancel);
    };
  }, [mode]);

  /** 清空整条页面栈（离开详情页 / 回首页 / 切到别的 tab 时调用） */
  function clearNav() {
    markLive([]);
    if (leavingTimerRef.current) { window.clearTimeout(leavingTimerRef.current); leavingTimerRef.current = 0; }
    setLeaving(null);
    setScreens([]);
  }

  function exitReaderToDetail() {
    album.setRead(null);
    setMode("detail");
    // 阅读器滚动很长：回到详情需先回到页面顶部（进度已由阅读器自行保存，不影响）
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }

  /** 复制 JM 号（详情页按钮） */
  function copyJmId() {
    if (!album.detail) return;
    navigator.clipboard.writeText(String(album.detail.id));
    pushToast("JM号已复制", "ok");
  }

  /** 用「接下来还在栈里的层」重建活层 id 集合（派发时同步调用；异步回包守卫只认它） */
  function markLive(st: Screen[]) {
    liveIdsRef.current = new Set(st.map((s) => s.id));
  }

  /** 连点保护：距上次「压栈类导航」不足 350ms 就忽略这一下（见 navLockRef 的说明） */
  function tapLocked(): boolean {
    const now = Date.now();
    if (now - navLockRef.current < 350) return true;
    navLockRef.current = now;
    return false;
  }

  /**
   * 把详情页同步到栈里「最靠上的详情层」：内容 + 评论 + 滚动位置。
   * 只有真的换了一部才动（同一部不重复拉评论），避免返回时出现"内容串了"。
   */
  function syncDetailTo(st: Screen[]) {
    const d = lastDetail(st);
    if (!d) return;
    const cur = album.detail;
    if (cur && String(cur.id) === String(d.snap.id)) return;
    const reqId = ++commentReqIdRef.current;
    album.set(d.snap);
    album.setComments(null);
    client.getAlbumComments(d.snap.id, 1)
      .then((c) => { if (commentReqIdRef.current === reqId) album.setComments(c); })
      .catch(() => { /* 评论拉取失败不影响详情页 */ });
    const y = d.scroll;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }

  /**
   * 返回「已记回当前详情层滚动位置」的栈。
   * 必须和随后的压栈合成**一次** setScreens：分两次派发时后一次是整数组覆盖，前一次的记录会被丢掉。
   */
  function withDetailScrollSaved(st: Screen[]): Screen[] {
    if (modeRef.current !== "detail") return st;
    const cur = lastDetail(st);
    if (!cur) return st;
    const y = window.scrollY;
    return y === cur.scroll ? st : patchScreen(st, cur.id, { scroll: y });
  }

  /**
   * 返回：弹掉栈顶一层 —— 全应用唯一的"后退"入口（返回键、详情页返回、搜索页返回都走它）。
   *   · 弹掉详情层 → 露出下层（搜索层或列表）；
   *   · 弹掉搜索层 → 它向右滑出（留一拍播完动画），露出它背后的详情层。
   * 露出搜索层时方向置 pop：让它从左归位，是"进入"的反方向，而不是再"从右拉入"一次。
   */
  function goBack() {
    const st = screensRef.current;
    if (!st.length) return;
    const { rest, popped } = popScreen(st);
    if (!popped) return;

    if (popped.k === "search") {
      if (leavingTimerRef.current) window.clearTimeout(leavingTimerRef.current);
      setLeaving(popped); // 挂一拍，播完"向右滑出"
      leavingTimerRef.current = window.setTimeout(() => { setLeaving(null); leavingTimerRef.current = 0; }, SR_EXIT_MS);
      setSrNavDir("push");
    } else {
      setSrNavDir("pop");
    }

    markLive(rest);
    setScreens(rest);

    if (rest.length === 0) {
      // 栈空 = 回到底层列表
      if (lastDetail(st) || modeRef.current === "detail") {
        // 之前展示的是详情 → 整屏反向推拉（详情页右移滑出，列表页回到原位并恢复滚动）
        navTransition("pop", () => {
          album.set(null);
          album.leave(); // 作废仍在执行的详情请求（防止回包干扰滚动恢复）
          setMode("home");
        });
        setSrNavDir("push");
      } else {
        // 底层本来就是列表（分类页/搜索 tab 点标签打开搜索层的场景）：只让搜索层自己滑出，不叠加整屏转场
        setMode("home");
      }
      return;
    }
    syncDetailTo(rest);
  }

  /** 详情页作者/标签 → 压入一层只读搜索结果页（压在当前详情之上） */
  function openSpecialSearch(kind: SRKind, text: string) {
    const q = text.trim();
    if (!q) return;
    if (tapLocked()) return; // 连点同一处标签不重复压层
    const id = ++navIdRef.current;
    const scr: SearchScreen = {
      k: "search", id, srKind: kind, text: q,
      items: [], page: 1, hasMore: false, busy: true, error: ""
    };
    const next = pushScreen(withDetailScrollSaved(screensRef.current), scr);
    markLive(next); // 先登记 id 再发请求：命中缓存的秒回包不会被误判成过期
    setScreens(next);
    setSrNavDir("push");
    void loadSrPage(id, q, kind, 1);
  }

  /**
   * 回填某一层搜索结果。守卫用 liveIdsRef（**派发时**登记，不依赖渲染时机）：
   * 该层已被弹掉/被深度裁掉 → 回包丢弃，绝不串到别的层。
   */
  async function loadSrPage(id: number, q: string, kind: SRKind, p: number) {
    if (!client.apiBase) {
      try { await client.init(); } catch { /* 静默：详情页摘要仍可看 */ }
    }
    if (!liveIdsRef.current.has(id)) return;
    try {
      const r = await client.search(q, p, 0, KIND_META[kind].searchType);
      if (!liveIdsRef.current.has(id)) return;
      const content = r.content || [];
      const total = Number(r.total || 0);
      setScreens((s) => {
        const cur = s.find((x) => x.id === id);
        if (!cur || cur.k !== "search") return s;
        const items = p > 1 ? [...cur.items, ...content] : content;
        // content 为空即到底：避免服务端重复返回同一页时无限滚动打转
        const hasMore = content.length > 0 && items.length < total;
        return patchScreen(s, id, { items, page: p, hasMore, busy: false, error: "" });
      });
    } catch (err) {
      if (!liveIdsRef.current.has(id)) return;
      const msg = String(err).slice(0, 140);
      setScreens((s) => patchScreen(s, id, { busy: false, error: msg }));
    }
  }

  /** 某一层滚到底：续它自己的下一页 */
  function loadMoreSr(id: number) {
    const cur = screensRef.current.find((s) => s.id === id);
    if (!cur || cur.k !== "search" || cur.busy || !cur.hasMore) return;
    setScreens((s) => patchScreen(s, id, { busy: true }));
    void loadSrPage(id, cur.text, cur.srKind, cur.page + 1);
  }

  // 返回键处理器要"只注册一次"，因此它的三个动作走 ref 镜像（见下方注释）
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;
  const exitReaderRef = useRef(exitReaderToDetail);
  exitReaderRef.current = exitReaderToDetail;
  const weekRef = useRef(week);
  weekRef.current = week;

  /**
   * 返回键：**只注册一次**（依赖为空）。
   * 本文件开头那段注释写明 `jm:back` 是按监听器注册顺序派发的，一旦因依赖变化重注册，顺序就会乱
   * （真机踩过：父级先消费 → 直接退出阅读器）。上一版把栈塞进了依赖，等于每次压/弹层都重注册，
   * 正是"返回时回错页面"的来源之一。所以这里全部通过 ref 读最新状态。
   */
  useBackHandler(() => {
    // 阅读器内弹窗开着时不要消费返回键（由阅读器自己关弹窗）
    if (hasOpenSheet()) return false;
    const m = modeRef.current;
    if (m === "reader") {
      client.finishFastTrack();
      exitReaderRef.current();
    } else if (m === "week") {
      weekRef.current.reset();
      setMode("home");
    } else if (screensRef.current.length > 0) {
      goBackRef.current(); // 返回 = 弹一层，全应用唯一入口
    } else {
      // home 等其他模式不消费返回键，让 App.tsx 处理两次返回退出
      return false;
    }
  }, []);

  // 搜索 tab 挂载时：读搜索记录 + 拉热词（逻辑在 useSearchFeed 内）
  useEffect(() => {
    if (pageMode !== "search") return;
    void search.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageMode]);

  /**
   * 事件订阅类 effect 必须「只注册一次」：`jm:back` 是按**监听器注册顺序**派发的，
   * 一旦因为依赖变化重新注册，顺序就会被打乱（真机踩过：父级先消费 → 直接退出阅读器）。
   * 但它们要用到 home / cat / album 这些「每次渲染都是新对象」的 hook 返回值，
   * 塞进依赖就等于每渲染重注册一次。用 ref 镜像最新的一份：
   * 既不重注册，也不会读到过期闭包（这也是本项目在 App.tsx 里已经用过的写法）。
   */
  const homeRef = useRef(home);
  homeRef.current = home;
  const catRef = useRef(cat);
  catRef.current = cat;
  const albumRef = useRef(album);
  albumRef.current = album;
  /** openDetail 定义在下方（const + useCallback），依赖数组里直接引用会撞上 TDZ，所以也走 ref */
  const openDetailRef = useRef<(a: AlbumSummary, from?: "list" | "search") => void>(() => { /* 挂载后立即被覆盖 */ });
  /** openWeek 是函数声明（会提升），可以直接镜像 */
  const openWeekRef = useRef(openWeek);
  openWeekRef.current = openWeek;

  useEffect(() => {
    const handler = (action: string) => {
      if (action === "categories") {
        // 分类页默认停留在“最新A漫”并自动加载一次列表（先确保 apiBase 就绪）
        (async () => {
          try {
            if (!client.apiBase) await client.init();
            await catRef.current.openCategories();
            await catRef.current.load("", "", 1, true, "");
          } catch { /* useCategoryFeed 内部已记录错误 */ }
        })();
      }
      if (action === "latest") { void homeRef.current.loadLatest(); }
      if (action === "ranking") { openWeekRef.current(); }
      if (action === "search") {
        setMode("home");
        window.scrollTo(0, 0); // 两参数形式：WebView < 61 不支持字典签名
        setTimeout(() => document.querySelector<HTMLInputElement>(".searchbar input")?.focus(), 120);
      }
    };
    return on("jm:nav", handler);
  }, []);

  useEffect(() => {
    if (pageMode !== "home") return;
    const handler = () => {
      // 底部“首页”再次点击：从详情/阅读退回列表并刷新首页推荐
      albumRef.current.setRead(null);
      albumRef.current.set(null);
      clearNav();
      albumRef.current.setComments(null);
      setMode("home");
      window.scrollTo(0, 0); // 两参数形式：WebView < 61 不支持字典签名
      void homeRef.current.loadRandom();
    };
    return on("jm:refreshHome", handler);
  }, [pageMode]);

  useEffect(() => {
    return on("jm:openAid", (raw) => {
      const aid = String(raw || "");
      if (!aid || pageMode !== "home") return;
      openDetailRef.current({ id: aid } as AlbumSummary);
    });
  }, [pageMode]);

  /**
   * 退出详情页时通知外壳（把先前被详情盖住的收藏/足迹浮层揭开，回到原列表）。
   * 用 mode 的迁移判定，比在每个退出口各插一句可靠：
   *   · 详情 → 读者：不算（用户还在看，浮层继续藏着）
   *   · 读者 → 详情：不算（回到详情页，浮层继续藏着）
   *   · 详情 → home 等：才算真正退出
   * 本 effect 只 emit、不订阅，不受「jm:back 按注册顺序派发」那条约束影响。
   */
  const prevModeRef = useRef<Mode>(mode);
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if (prev === "detail" && mode !== "detail" && mode !== "reader") emit("jm:detailClosed");
  }, [mode]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // 18+ 门放行后才开始网络启动（点击确认后由 App 放行），避免后台提前跑完造成“秒进”
        await gatePassed;
        if (!client.apiBase) await client.init();
        if (initialAction === "categories") {
          try { await client.getSetting(); } catch { /* 不阻塞分类加载 */ }
          await catRef.current.openCategories();
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
          // 启动顺序（老设备实测结论）：先恢复 6h 内的最优记忆——它是一次本地读 + 一次探测，
          // 远快于完整测速，能避免"冷启动十几秒白封面"；随后完整测速在后台跑一遍做纠正/自愈。
          // 记忆不可用（过期 / 图床已死 / 无记忆）才阻塞等测速结果。
          let speedOk = false;
          try { speedOk = await client.restoreBestSelection(); } catch { speedOk = false; }
          if (!speedOk) {
            try { speedOk = await client.autoSelectBest(); } catch { speedOk = false; }
            // 老设备/弱网冷启动第一次常常全超时：10 秒后再试一次（成功后 getSetting 会发 jm:setting，
            // 列表按新图床重新出封面）。
            if (!speedOk) window.setTimeout(() => { void client.autoSelectBest().catch(() => false); }, 10000);
          } else {
            // 记忆可用：后台刷新一次，换到更快的线路/图源（同样由 jm:setting 驱动封面刷新）
            window.setTimeout(() => { void client.autoSelectBest().catch(() => false); }, 1500);
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
            homeRef.current.setError("");
            homeRef.current.show(list, "latest", false, 1);
          } else if (alive && !homeRef.current.hasItems()) {
            // 已经有内容在屏上（最优记忆/后台刷新先到了）就不再占用整屏错误态，否则会出现"内容明明在却报网络错误"
            homeRef.current.setError("网络连接失败，推荐内容加载不出来。请先到会员页「DNS 加速」按指引配置 DoT 公共 DNS（大多可解决）；配置后需删除后台重新进入 App 使设置生效，再点“重试”；若仍失败再考虑使用魔法。");
            pushToast("内容加载失败，建议先配 DNS，配置后删除后台重进生效", "err", "goto-dns");
          }
        }
        if (aid) {
          const d = await client.getAlbumFull(aid);
          if (alive && d) {
            const id = ++navIdRef.current;
            liveIdsRef.current = new Set([id]);
            setScreens([{ k: "detail", id, snap: d, scroll: 0 }]);
            albumRef.current.set(d);
            setMode("detail");
            albumRef.current.setComments(null);
            void albumRef.current.loadComments(d.id);
          }
        }
      } catch (err) {
        if (alive && !homeRef.current.hasItems()) homeRef.current.setError(String(err));
      }
    })();
    return () => { alive = false; };
    // initialAction / pageMode 在本组件的生命周期内是常量（App 按 tab 传不同的 key，切 tab 即重新挂载），
    // 放进依赖只是为了让"依赖完整"，不会造成重复执行。
  }, [initialAction, pageMode]);

  /** 打开周榜：数据与分页都在 useWeekRank 内，这里只负责记滚动位置与切页 */
  async function openWeek() {
    if (mode === "home") saveScrollTarget(window.scrollY); // 记住打开周榜前列位置
    if (await week.open()) setMode("week");
  }

  function retryHomeFeed() {
    // 与底部导航点击「首页」时的刷新逻辑完全一致（复用 jm:refreshHome 事件）
    album.setRead(null);
    album.set(null);
    clearNav();
    album.setComments(null);
    setMode("home");
    window.scrollTo(0, 0); // 两参数形式：WebView < 61 不支持字典签名
    // 按当前分段重载：在「最新」上重试就不该把列表换成随机推荐
    if (homeFeed === "weekly") void week.open();
    else if (homeFeed === "latest") void home.loadLatest();
    else void home.loadRandom();
  }

  // from="list"：从任意列表进入（整栈重置）；from="search"：从搜索层的结果点进（详情层压在搜索层之上）
  const openDetail = useCallback(async (item: AlbumSummary, from: "list" | "search" = "list") => {
    // 从搜索层点进是「压栈」：连点两张卡片会压两层，返回时先退回上一部（错乱）。这里挡掉连点。
    // from="list" 是整栈替换（幂等），不加锁，避免影响正常快速操作。
    if (from === "search" && tapLocked()) return;
    // 记住"进入详情前列表停在哪"，返回时恢复。
    // 🚨 必须判 mode === "home"：from="list" 只说明"这次不做压栈叠加"，
    // 并不代表此刻屏幕上就是列表 —— 详情页的「相关漫画」(ContentView 的 onOpenRelated) 也走 from="list"，
    // 那一刻的 window.scrollY 是**详情页**的滚动量；若存进去，返回列表时就会把列表滚到那个值
    // （真机表现："进入详情后返回，外面的列表自己滚动/跳位"，2026-09-24 用 driver-scrollleak 复现）。
    // mode === "home" 恰好等价于"底部那个基础列表分支正在显示"（首页 / 分类 / 搜索 tab 都是 home），
    // 同时也排除了周榜页（mode === "week"）这个同类污染源。
    if (from === "list" && modeRef.current === "home") saveScrollTarget(window.scrollY);
    // 乐观渲染：用列表页已有摘要立刻展示详情页，不等 API
    const snapshot = { ...item, name: item.name || "" } as unknown as AlbumDetail;
    let reqId = 0;
    const enterDetail = () => {
      reqId = album.begin(snapshot); // 乐观快照 + 作废旧请求
      const scr: Screen = { k: "detail", id: ++navIdRef.current, snap: snapshot, scroll: 0 };
      if (from === "list") {
        // 从列表进入 = 整栈重置为这一屏详情
        markLive([scr]);
        setLeaving(null);
        setScreens([scr]);
      } else {
        // 从搜索层的结果点进：详情层压上去，返回先回到那个搜索层（它仍在栈里）
        const next = pushScreen(withDetailScrollSaved(screensRef.current), scr);
        markLive(next);
        setScreens(next);
      }
      setSrNavDir("push");
      setMode("detail");
      // 详情页真正渲染出来的这一刻通知外壳：可以把收藏/足迹浮层藏到后面了。
      // 不能在点击瞬间就藏 —— 那 120ms 里详情还没出来，中间会先露一下主页。
      emit("jm:detailOpened");
      // 新页从顶部开始（列表位置已存进 listScrollRef，返回时恢复）
      window.scrollTo(0, 0);
    };
    // 列表 → 详情、搜索结果 → 详情，都走同一套推拉转场（旧页后退、新页从右滑入）。
    // 必须 await：转场回调是异步执行的，若不等它落地就发起请求，
    // 响应可能先回来并被随后的乐观快照覆盖（详情页会缺标签/简介）
    await navTransition("push", enterDetail);
    if (from !== "list") requestAnimationFrame(() => window.scrollTo(0, 0));
    // 并行拉取完整详情 + 评论（reqId 守卫在 hook 内，离开/切章后自动丢弃回包）
    await album.load(item.id, reqId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 让上面那几个「只注册一次」的事件订阅拿到最新的 openDetail（openDetail 本身是 useCallback([])，
  // 这里同步镜像只是为了绕开 TDZ，不改变它的稳定性）
  openDetailRef.current = openDetail;

  /** 搜索结果页里的卡片点击 → 详情页（背后保留搜索页） */
  const openAlbumFromSearch = useCallback((a: AlbumSummary) => { void openDetail(a, "search"); }, [openDetail]);

  const logged = useLoggedIn();

  /**
   * 阅读器用书级元数据：必须 memo（否则每次渲染都是新对象，
   * 阅读器里依赖它的 effect 会每渲染一次重扫一遍 Cache API —— 1.7.2 卡顿根因之一）。
   */
  const readerBookMeta = useMemo(() => {
    const d = album.detail;
    if (!d) return undefined;
    const bookId = bookIdOf(d);
    return bookMetaFromDetail(d, albumCoverUrl({ id: bookId, name: d.book_name || d.name || "", update_at: d.addtime }));
  }, [album.detail]);

  /**
   * 只读搜索层：详情页的作者/标签/登场人物、分类页「更多分类」里点的词，都走它。
   * 栈里**每一层都挂载**（各自保有滚动位置与已加载分页，返回时不丢位置），只有栈顶那层是 open；
   * 正在退场的那层（leaving）也挂一拍，用来播完"向右滑出"。层级按栈序用 z-index 递增。
   */
  const overlays: SearchScreen[] = [];
  for (const s of screens) if (s.k === "search") overlays.push(s);
  if (leaving) overlays.push(leaving);
  const searchLayer = (
    <>
      <div className={"page-scrim" + (srOpen ? " on" : "")} aria-hidden="true" />
      {overlays.map((s, i) => (
        <SearchResultPage
          key={"sr" + s.id}
          open={s.id === openSearchId}
          navDir={srNavDir}
          zIndex={200 + i}
          kind={s.srKind}
          text={s.text}
          items={s.items}
          busy={s.busy}
          error={s.error}
          hasMore={s.hasMore}
          resetKey={s.srKind + ":" + s.text + ":" + s.id}
          coverTick={settingTick}
          onBack={goBack}
          onOpenAlbum={openAlbumFromSearch}
          onLoadMore={() => loadMoreSr(s.id)}
        />
      ))}
    </>
  );

  if (mode === "week" && week.payload) {
    return (
      <>
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
        onBack={() => { week.reset(); setMode("home"); }}
      />
      {searchLayer}
      </>
    );
  }

  if (mode === "detail" && shownDetail && album.detail) {
    return (
      <>
      {/* key 必须固定：否则 React 会把首页列表的 DOM 节点（含下拉刷新指示器）复用成本卡片，
          下拉刷新遗留的 180ms 定时器随后把 display:none 打到详情页上 → 白屏 */}
      <div key="detail-page" className={"page-push" + (srOpen ? " pushed" : "")} aria-hidden={srOpen}>
      <AlbumDetailPage
        detail={album.detail}
        logged={logged}
        busy={album.busy}
        comments={album.comments}
        commentTotal={album.commentsTotal}
        commentHasMore={album.commentsHasMore}
        commentLoadingMore={album.commentsLoadingMore}
        commentText={album.commentText}
        backLabel={isSearch(screens[screens.length - 2] ?? null) ? "返回搜索结果" : "返回列表"}
        onBack={goBack}
        onCopyId={copyJmId}
        onOpenAuthor={(a) => openSpecialSearch("author", a)}
        onOpenTag={(t) => openSpecialSearch("tag", t)}
        onOpenActor={(a) => openSpecialSearch("character", a)}
        onOpenRelated={(a) => { void openDetail(a, "list"); }}
        onSwitchChapter={(id) => { void album.switchChapter(id); }}
        onBuy={() => { void album.buy(); }}
        onToggleFavorite={() => { void album.toggleFavorite(); }}
        onRead={() => { album.startRead(); setMode("reader"); }}
        onCommentChange={album.setCommentText}
        onSubmitComment={() => { void album.submitComment(); }}
        onLoadMoreComments={() => { void album.loadMoreComments(); }}
      />
      </div>
      {searchLayer}
      </>
    );
  }

  if (mode === "reader" && album.read) {
    const d = album.detail;
    const chapter = d?.series?.find((s) => String(s.id) === String(album.read!.id));
    return (
      <ReaderPanel
        albumId={album.read.id}
        pages={album.read.images}
        title={album.read.name || d?.name || ""}
        scrambleId={album.read.scramble_id}
        onBack={exitReaderToDetail}
        meta={{
          author: Array.isArray(d?.author) ? d!.author.join("/") : (typeof d?.author === "string" ? d.author : ""),
          cover: d ? albumCoverUrl({ id: d.id, name: d.name || "", update_at: d.addtime }) : ""
        }}
        bookMeta={readerBookMeta}
        chapterName={chapterLabel(chapter)}
        chapterSort={chapter ? Number(chapter.sort) || undefined : undefined}
      />
    );
  }

  // 原来这里有个 gotoPage(action) → emit("jm:goto")，唯一用途是把「每周必看」交给 App 处理，
  // 而 App 那一步是 setTab("categories") —— 也就是"点每周必看却被甩到分类页"的来源。
  // 现在每周必看在首页内联渲染，这条跳转链没有调用方了，删掉。
  // （App 侧对 jm:goto 的订阅与 core/bus 里的事件类型保持不动；独立周榜页 mode === "week" 也照旧保留，
  //   仍可由 jm:nav "ranking" 触发。）

  if (pageMode === "search") {
    return (
      <>
      <SearchFeed
        query={search.query}
        type={search.type}
        order={search.order}
        items={search.items}
        page={search.page}
        total={search.total}
        hasMore={search.hasMore}
        busy={search.busy}
        error={search.error}
        searched={search.searched}
        hotTags={search.hotTags}
        hotErr={search.hotErr}
        history={search.history}
        // key 带上「查询词 + 类型 + 排序 + 图床 tick」：换筛选时列表重挂载，
        // 复用 .list 的 rise-in 作为内容替换的桥接（否则内容是原地瞬间换掉）
        gridKey={"g" + settingTick + "-" + search.query + "-" + search.type + "-" + search.order}
        onQueryChange={search.setQuery}
        onSubmit={search.submit}
        onRunTerm={search.runTerm}
        onTypeChange={search.changeType}
        onSort={search.changeSort}
        onRetryHot={search.retryHot}
        onClearHistory={search.clearHistory}
        onLoadMore={search.loadMore}
        onOpenAlbum={openDetail}
      />
      {searchLayer}
      </>
    );
  }

  if (pageMode === "categories") {
    return (
      <>
      <CategoryFeed
        categories={cat.categories}
        blocks={cat.blocks}
        items={cat.items}
        slug={cat.slug}
        sub={cat.sub}
        order={cat.order}
        rank={cat.rank}
        page={cat.page}
        hasMore={cat.hasMore}
        total={cat.total}
        busy={cat.busy}
        error={cat.error}
        // 同上：分类 / 榜位 / 子分类 / 排序任一变化都算一次内容替换
        gridKey={"g" + settingTick + "-" + cat.slug + "-" + cat.rank + "-" + cat.sub + "-" + cat.order}
        onPickPlace={cat.pickPlace}
        onPickRank={cat.pickRank}
        onPickSub={cat.pickSub}
        onSort={cat.changeSort}
        onLoadMore={cat.loadMore}
        onOpenAlbum={openDetail}
        onPickTerm={(term) => openSpecialSearch("tag", term)}
      />
      {searchLayer}
      </>
    );
  }

  return (
    <>
    <PullToRefresh onRefresh={retryHomeFeed}>
      <HomeFeed
        items={home.items}
        page={home.page}
        hasMore={home.hasMore}
        busy={home.busy}
        error={home.error}
        // 推荐 / 最新 是两套内容，切换时也走同一条进场
        gridKey={"g" + settingTick + "-" + homeFeed}
        feed={homeFeed}
        weekly={homeFeed === "weekly"
          ? (week.payload ? (
            <WeekRank
              inline
              payload={week.payload}
              items={week.items}
              issue={week.issue}
              type={week.type}
              busy={week.busy}
              error={week.error}
              gridKey={"weekhome" + settingTick}
              onIssueChange={week.setIssue}
              onTypeChange={week.setType}
              onLoad={() => { void week.load(week.issue, week.type, 1, true); }}
              onOpenAlbum={openDetail}
            />
          ) : <SkeletonGrid />)
          : undefined}
        onPickFeed={pickHomeFeed}
        onRetry={retryHomeFeed}
        onGotoDns={() => emit("jm:gotoDns")}
        onLoadMore={home.loadMore}
        onOpenAlbum={openDetail}
      />
    </PullToRefresh>
    {searchLayer}
    </>
  );
}
