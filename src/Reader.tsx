import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { client } from "./core/api";
import { cacheList, enqueueCache, type CacheTaskMeta } from "./core/cacheTasks";
import { blobCheckpoint, pagesFromCache, releaseOfflinePageUrls, releaseOfflinePageUrlsBefore, scanCachedChapters, toOfflinePageUrls, type CachedChapterInfo } from "./core/offline";
import { chapterLabel, getChapter, listChapters, type BookChapter, type ChapterMeta } from "./core/offlineMeta";
import { saveHistory } from "./core/history";
import { useBackHandler } from "./hooks/useBackHandler";
import { popSheetLock, pushSheetLock } from "./core/uiLocks";
import { useSheetTransition } from "./hooks/useSheetTransition";
import { measureImages, pickFastestSource, type SpeedItem } from "./core/speed";
import { pushToast } from "./ui/toast";
import { SkeletonRows } from "./ui/SkeletonRows";
import { DownloadIcon, LightningIcon, MenuIcon, SettingsIcon } from "./ui/icons";
import { deseaOn, drawUnscrambled, measureSeamDetail, pageNameOf, scrambleSliceCount, setDeseam, smoothSeams } from "./core/scramble";
import { resolveReaderScrollHost, scrollByHost, scrollToTopOf, scrollTopOf } from "./core/scrollHost";
import { TAP_ZONES_CONTINUOUS, TAP_ZONES_SINGLE, loadTapInvert, resolveTapAction, saveTapInvert } from "./core/tapZones";
import { NO_SEAM, UI_KEYS } from "./core/constants";
import { isLowFx } from "./core/lowfx";
import type { ReadPage } from "./core/types";
import type { BookMeta } from "./core/offlineMeta";
import { on } from "./core/bus";

type ReaderMode = "continuous" | "single";

// 阅读模式的存储键统一走 UI_KEYS（原来这里和 core/constants.ts 各写了一份字面量）
const MODE_KEY = UI_KEYS.readerMode;

/** 翻页预取页数（非低配机）；低配机由 isLowFx() 降到 1 页 */
const PRELOAD_AHEAD_PAGES = 3;
/** 预取防抖：停下翻页 60ms 后再发请求（原来是 180ms，快速连翻时等于没预取） */
const PRELOAD_DEBOUNCE_MS = 60;

interface Props {
  albumId: number | string;
  pages: ReadPage[];
  title: string;
  scrambleId?: number | string;
  onBack: () => void;
  meta?: { author?: string; category?: string; cover?: string };
  /** 书级元数据（简介/标签/作者/目录）：缓存时一并写入 IDB，离线详情页依赖它 */
  bookMeta?: BookMeta;
  /** 当前话名称（"第12话"）与序号 */
  chapterName?: string;
  chapterSort?: number;
  /**
   * 在阅读器内换了话：把新话回写给外层（详情页同步"当前话"）。
   * 不接这个回调就会出现"阅读器里翻了好几话，退回详情页还停在进入时那一话"。
   */
  onChapterChange?: (id: string, label: string, sort?: number) => void;
  /** 离线阅读模式：隐藏图源测速/切换等在线功能 */
  offline?: boolean;
}

function imageName(p: ReadPage): string {
  if (p.name) return p.name;
  const clean = (p.image || "").split("?")[0].split("/").pop() || "";
  return clean.replace(/\.(webp|jpg|jpeg|png|gif)$/i, "");
}

// 去条纹 = 纯本地图像修复（不消耗额外流量）：
//   按条带边界量测"超额跳变"，未达标的做逐列加权垂直高斯（平坦列全量、有垂直细节的列不动），
//   修完复测该边界，未达标则换更宽的核再来一遍。
// 评分 > 1 即判为可见条纹（阈值见 src/core/scramble.ts）
const SEAM_BAD_SCORE = 1.0;

function jlog(...args: unknown[]) {
  try { console.log("[jmd]", ...args); } catch { /* ignore */ }
}
/**
 * 调试日志去重用的 Set —— **必须有上限**。
 * 原本只 add 不删：翻一部长篇会把整本书每一页的 URL 常驻内存（审查发现的无界增长）。
 * 到顶就整体清空（比 LRU 简单，且这里只是日志去重，偶尔重复打一条无所谓）。
 */
const LOGGED_SRC_MAX = 300;
const loggedSrc = new Set<string>();

// 带 CORS 加载失败（个别图床不发 CORS 头）时，回退为普通加载——此时 canvas 会被污染，
// 评分/平滑会自动跳过（见 measureSeamScore 的 try/catch），不影响阅读
let expressHintShown = false;

/**
 * 正文页失败后的重试节奏（毫秒）。
 *
 * 为什么必须有：这里以前只重试 **一次**（去 crossorigin 再拉一遍），失败就把该页永久钉死
 * —— 2026-10-06 用无头 Chromium 复现过：把 /media/photos/* 断 6 秒再放开，
 * 页面 15 秒后依然是 77 张全失败、0 张成功，永远不会自己恢复。
 * 用户看到的就是"首次进阅读器正文加载不出来"，只能靠「换源」把 <img> 重挂一遍才好
 * （这也解释了"更快的源选中的依然是当前源，却能加载出正文"——起作用的是重挂，不是换源）。
 *
 * 节奏：先用快速退避打掉瞬时抖动（首次连接被 reset / 图床抽风），再放慢继续试。
 * 与列表封面（ui/AlbumCard 的 Cover）同一套思路，封面能自愈、正文也必须能。
 */
const PAGE_RETRY_DELAYS = [700, 1500, 3000, 8000, 20000];
/**
 * 快速退避用尽后的慢速恢复间隔：这时页面已经亮出"点按重试"，
 * 但我们仍然每隔 30s 自己再试一次 —— 否则"断网/图床抽风几十秒后恢复"的场景，
 * 还得让用户一页一页手点（原来连一次重试都没有，只能整本换源）。
 */
const PAGE_RETRY_SLOW_MS = 30000;
/** 快速 5 次 + 慢速 8 次（≈4 分钟）后彻底放弃，避免死图床一直空跑 */
const PAGE_RETRY_MAX = PAGE_RETRY_DELAYS.length + 8;
/** 同一话内累计这么多页彻底失败就自动换源一次 */
const PAGE_FAIL_HEAL_MIN = 3;
/** 一话最多自动换源几次 / 两次之间至少隔多久 */
const PAGE_HEAL_MAX = 2;
const PAGE_HEAL_COOLDOWN_MS = 60 * 1000;

/** 重试用的独立 URL：换 URL 才能绕开浏览器里那条失败的缓存记录（同 Cover 的 retry=N 招数） */
function retryUrl(src: string, n: number): string {
  const clean = src.replace(/[?&]retry=\d+/g, "");
  return clean + (clean.includes("?") ? "&" : "?") + "retry=" + n;
}

function pageBoxOf(im: HTMLImageElement): HTMLElement | null {
  return im.closest<HTMLElement>(".jm-figure, .jm-single-wrap");
}

/** 定时器挂在元素上，翻页/卸载时能清掉，避免离场元素还去发请求 */
const pageRetryTimers = new Map<HTMLImageElement, number>();
function clearPageRetry(im: HTMLImageElement): void {
  const t = pageRetryTimers.get(im);
  if (t) { window.clearTimeout(t); pageRetryTimers.delete(im); }
}

/**
 * 页图加载失败的统一处理：CORS 回退 → 退避重试 → 彻底失败时标记 + 通知阅读器自愈。
 * 模块级是因为它只碰 DOM 与定时器；需要"上报失败"时通过 ctx 回调交给组件（组件才拿得到状态）。
 */
function handlePageImgError(e: React.SyntheticEvent<HTMLImageElement>, onGiveUp: () => void): void {
  const im = e.currentTarget;
  if (!im.dataset.origSrc) im.dataset.origSrc = im.src;
  // express（图源 0 / 快速通道）实测只给 logo 不给正文图（photos 被 CDN 重置）：
  // 用户手动选到它时给一次明确提示，而不是对着一片黑猜哪里坏了（每次会话只提示一次）
  if (!expressHintShown && String(client.imageShunt) === "0" && /jm-page|jm-single/.test(im.className)) {
    expressHintShown = true;
    pushToast("快速通道（图源 0）拉不到正文图，请到「换源」换回普通图源", "err");
  }
  const n = Number(im.dataset.retryN || "0");
  if (n === 0) {
    // 第 1 次：图床可能不发 CORS 头 → 去掉 crossorigin 立刻重来（canvas 变污染只影响去条纹）
    im.dataset.retryN = "1";
    im.removeAttribute("crossorigin");
    im.src = im.dataset.origSrc;
    return;
  }
  if (n >= PAGE_RETRY_MAX) {
    markPageFailed(im, onGiveUp);
    return;
  }
  im.dataset.retryN = String(n + 1);
  // 快速退避阶段：只重试，不打扰用户；转入慢速阶段后先把失败态亮出来（并上报一次）
  const fast = n <= PAGE_RETRY_DELAYS.length;
  const delay = fast ? PAGE_RETRY_DELAYS[n - 1] : PAGE_RETRY_SLOW_MS;
  if (!fast) markPageFailed(im, onGiveUp);
  clearPageRetry(im);
  const timer = window.setTimeout(() => {
    pageRetryTimers.delete(im);
    im.src = retryUrl(im.dataset.origSrc || im.src, n);
  }, delay);
  pageRetryTimers.set(im, timer);
  jlog("page retry " + n + "/" + PAGE_RETRY_MAX + " in " + delay + "ms page=" + (im.dataset.page || "?"));
}

/** 标记"这页彻底失败"并只上报一次（同一页重复报会让自愈阈值提前达成） */
function markPageFailed(im: HTMLImageElement, onGiveUp: () => void): void {
  const box = pageBoxOf(im);
  if (box && box.dataset.failed !== "1") {
    box.dataset.failed = "1";
    onGiveUp();
  }
}

/** "点按重试"：清掉失败态与计数，从原地址重新来一轮 */
function resetPageImage(im: HTMLImageElement): void {
  clearPageRetry(im);
  delete im.dataset.retryN;
  const box = pageBoxOf(im);
  if (box) delete box.dataset.failed;
  const src = im.dataset.origSrc || im.src;
  im.src = retryUrl(src, Date.now() % 100000); // 换 URL：绕开失败缓存
  jlog("page retry by tap page=" + (im.dataset.page || "?"));
}

// —— 去条纹（接缝修复）延后执行 ——
// 重排（drawUnscrambled）是「能不能读懂」的前提，必须随图片加载立刻完成；
// 去条纹只是画质优化，实测单页 measure+smooth 最坏 191 ms，同步做会把主线程堵死，
// 导致后续图片迟迟不加载、切片迟迟不重排。所以：立刻重排 → 进入视口 + 主线程空闲时再修。
interface SeamTask { pageName: string; parts: number }
const seamTasks = new WeakMap<HTMLCanvasElement, SeamTask>();
const seamQueue: HTMLCanvasElement[] = [];
let seamPumping = false;
let seamObserver: IntersectionObserver | null = null;

function idleRun(cb: () => void): void {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === "function") ric(cb, { timeout: 1500 });
  else window.setTimeout(cb, 40);
}

function ensureSeamObserver(): IntersectionObserver | null {
  if (seamObserver) return seamObserver;
  if (typeof IntersectionObserver === "undefined") return null;
  seamObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const cv = e.target as HTMLCanvasElement;
      seamObserver?.unobserve(cv);
      if (cv.isConnected && !cv.dataset.seamRepaired) enqueueSeam(cv);
    }
  }, { rootMargin: "400px 0px" });
  return seamObserver;
}

function enqueueSeam(cv: HTMLCanvasElement): void {
  if (seamQueue.includes(cv)) return;
  seamQueue.push(cv);
  pumpSeam();
}

function pumpSeam(): void {
  if (seamPumping) return;
  seamPumping = true;
  const step = () => {
    const cv = seamQueue.shift();
    if (!cv) { seamPumping = false; return; }
    if (cv.isConnected && !cv.dataset.seamRepaired && deseaOn()) {
      const task = seamTasks.get(cv);
      if (task) {
        try {
          const before = measureSeamDetail(cv, task.parts);
          const fixed = before.score > SEAM_BAD_SCORE ? smoothSeams(cv, task.parts) : 0;
          cv.dataset.seamRepaired = "1";
          jlog("seam page=" + task.pageName + " 超额 " + before.score.toFixed(2) +
            (fixed > 0 ? " → 修复 " + fixed + " 条边界" : " 达标跳过"));
        } catch (err) {
          // canvas 被跨域数据污染（图床未发 CORS 头）→ 无法量测，跳过
          jlog("seam skip page=" + task.pageName + " " + String(err).slice(0, 60));
        }
      }
    }
    idleRun(step);
  };
  idleRun(step);
}

function applyScramble(img: HTMLImageElement, albumId: number | string, scrambleId?: number | string) {
  // 尚未解码完成先不动（交给 onLoad）；否则会把键写死，后续再也不会还原
  if (!img.complete || img.naturalWidth === 0) return;
  // 变量名不要叫 `on`：会遮蔽从 core/bus 导入的事件订阅函数 on()（no-shadow），
  // 一旦后面在这段作用域里写 on("jm:xxx", ...) 就会变成 "boolean is not a function"
  const repairOn = deseaOn();
  // 键 = scrambleId + 开关状态 + 当前图源地址：图源切换、scrambleId 迟到/变化、开关切换都必须重绘
  const key = String(scrambleId ?? "") + "|" + (repairOn ? "fix" : "raw") + "|" + (img.currentSrc || img.src);
  if (img.dataset.scrambleKey === key) return;
  // 图源/页面变化时允许对新图重新做一次接缝修复
  delete img.dataset.seamRepaired;
  // 清掉同一容器内上一轮生成的 canvas（切源 / 单页翻页时 React 会替换 img，旧 canvas 必须移除）
  const parent = img.parentElement;
  if (parent) parent.querySelectorAll("canvas.scramble-canvas").forEach((c) => c.remove());
  const canvas = scrambleId ? drawUnscrambled(img, albumId, scrambleId) : null;
  img.dataset.scrambleKey = key;
  if (!canvas) {
    img.style.display = "";
    return;
  }
  canvas.classList.add("scramble-canvas");
  if (img.dataset.page) canvas.dataset.page = img.dataset.page;
  img.parentElement?.insertBefore(canvas, img.nextSibling);
  img.style.display = "none";
  // 重排已完成（上面 9ms 的 drawUnscrambled）→ 去条纹排队，等进入视口 + 主线程空闲再做
  // NO_SEAM 构建里 !NO_SEAM 是编译期常量 false → 整块（含 observer/队列）会被摇掉
  if (scrambleId && repairOn && !NO_SEAM) {
    const pageName = pageNameOf(img);
    seamTasks.set(canvas, { pageName, parts: scrambleSliceCount(albumId, pageName) });
    const obs = ensureSeamObserver();
    if (obs) obs.observe(canvas); else enqueueSeam(canvas);
  } else if (scrambleId) {
    jlog("unscramble page=" + pageNameOf(img) + (NO_SEAM ? "" : "（去条纹关闭）"));
  }
}

export default function ReaderPanel({
  albumId: albumIdProp, pages: pagesProp, title: titleProp, scrambleId: scrambleIdProp,
  onBack, meta, bookMeta, chapterName, chapterSort, onChapterChange, offline = false
}: Props) {
  // —— 阅读器内换话：本组件自己维护「当前话」覆盖值，不打断父级的页面栈 ——
  const [override, setOverride] = useState<{ id: string; pages: ReadPage[]; scrambleId?: number | string; label: string; sort?: number } | null>(null);
  const albumId = override ? override.id : albumIdProp;
  const pages = override ? override.pages : pagesProp;
  const scrambleId = override ? override.scrambleId : scrambleIdProp;
  const title = override ? [bookMeta?.name, override.label].filter(Boolean).join(" ") : titleProp;
  /** 连载目录（多话才有；单本为空数组 → 不显示换话/多选缓存） */
  const chapters = useMemo(() => (bookMeta && bookMeta.chapters.length > 1 ? bookMeta.chapters : []), [bookMeta]);
  const curChapter = chapters.find((c) => String(c.id) === String(albumId));
  /**
   * 下一话 = 当前话在**列表里的下一项**（连载列表本身就是阅读顺序）。
   *
   * 为什么不直接按 sort 挑"比当前话号大的最小者"：实测有连载的 series.sort 全是一个值
   * （id=1159383 的 48 话 sort 全是 1），按 sort 挑会一个都挑不出来 → 按钮永远显示"已是最后一话"。
   * 所以只用 sort 判**列表方向**：单调递增 = 正序（取 idx+1），否则按倒序取 idx-1；
   * sort 缺失/全相等时判为"不递减"，退化成列表顺序 —— 也就是用户在弹窗里看到的顺序。
   */
  const nextChapter = useMemo(() => {
    if (chapters.length < 2) return null;
    const idx = chapters.findIndex((c) => String(c.id) === String(albumId));
    if (idx < 0) return null;
    const ascending = chapters.every((c, i) => i === 0 || !(Number(c.sort) < Number(chapters[i - 1].sort)));
    const chapter = (ascending ? chapters[idx + 1] : chapters[idx - 1]) || null;
    // index = 它在列表里是第几话（1 起始），用于话号重复时消歧
    return chapter ? { chapter, index: ascending ? idx + 2 : idx } : null;
  }, [chapters, albumId]);

  /**
   * 「下一话」按钮文案。
   * 部分连载的 series.sort 全是一个值（实测 id=1159383 的 48 话 sort 全是 1、name 为空），
   * 那时每一话都叫"第1话"，直接拼出来就是"下一话 · 第1话"（和当前话一模一样，等于没说）——
   * 这种情况用它在列表里的位置消歧。
   */
  const nextChapterText = (() => {
    if (!nextChapter) return "";
    const label = chapterLabel(nextChapter.chapter) || ("#" + nextChapter.chapter.id);
    const cur = chapterLabel(curChapter) || (curChapter ? "#" + curChapter.id : "");
    return label && label !== cur ? "下一话 · " + label : "下一话（列表第 " + nextChapter.index + " 话）";
  })();
  const curLabel = override ? override.label : (chapterLabel(curChapter) || chapterName || "");
  const curSort = override ? override.sort : (Number(chapterSort) || Number(curChapter?.sort) || undefined);
  // —— 弹窗状态 ——
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceRows, setSourceRows] = useState<Array<{ key: string; title: string; host?: string; ms?: number; ok?: boolean }>>([]);
  const [chapOpen, setChapOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);
  // 四个浮层的出入场（逻辑状态仍然是上面的 boolean：返回键/锁屏判定不受动画影响）
  const sourceAnim = useSheetTransition(sourceOpen);
  const settingsAnim = useSheetTransition(settingsOpen);
  const chapAnim = useSheetTransition(chapOpen);
  const cacheAnim = useSheetTransition(cacheOpen);
  const [cacheSel, setCacheSel] = useState<Set<string>>(new Set());
  const [cachedIds, setCachedIds] = useState<Map<string, CachedChapterInfo>>(new Map());
  const [chapterMetas, setChapterMetas] = useState<ChapterMeta[]>([]);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  /** 正在生效的那一话（该行显示转圈、整层不可点） */
  const [switchKey, setSwitchKey] = useState<string | null>(null);
  /** 正在生效的那一个图源 */
  const [sourceBusy, setSourceBusy] = useState<string | null>(null);
  /** 测速代际：关闭弹窗就 +1，让在途的测速结果作废（不再切源、不再刷新列表） */
  const speedGenRef = useRef(0);

  const [mode, setMode] = useState<ReaderMode>(() => {
    const saved = localStorage.getItem(MODE_KEY);
    return saved === "single" ? "single" : "continuous";
  });
  const [current, setCurrent] = useState(1);
  /**
   * 渲染代数：换话 / 换源后 +1，用作页面容器的 key → 整块重建（新骨架、新 canvas、从头渲染），
   * 而不是在旧 DOM 上逐张替换（旧做法会留下上一话的 canvas/尺寸状态，观感像"打补丁"）。
   */
  const [stageGen, setStageGen] = useState(0);
  /** 换话/换源那一刻的 blob 游标：等新一话提交渲染后再释放它之前的 blob（否则屏上旧图会裂） */
  const blobCursorRef = useRef(0);
  /**
   * 每页骨架的估算比例（高 ÷ 宽 × 100）。页数在进入阅读器时就已知，先用它把每页"撑起来"：
   * 图片/拼图就绪后 figure 再切回自然高度（同一话内页面尺寸基本一致，学到的比例误差通常只有 1px 级）。
   */
  const ratioRef = useRef(139.5);
  /** 当前页检测函数：骨架→内容切换会改变高度，切完要重算一次，避免计数停在旧值 */
  const recomputeRef = useRef<(() => void) | null>(null);
  const recomputeRafRef = useRef(0);
  const [jumpInput, setJumpInput] = useState("1");
  // 沉浸阅读：控件默认不显示，点画面中间唤出，3 秒无操作自动淡出
  const [chromeOn, setChromeOn] = useState(false);
  const chromeTimer = useRef<number | null>(null);
  const [task, setTask] = useState<CacheTaskMeta | undefined>(() => cacheList().find((t) => t.id === String(albumId)));
  const [testing, setTesting] = useState(false);
  // —— B 方案：右侧页数浮标（阅读进度指示 + 拖动/点按跳页）——
  const [railVisible, setRailVisible] = useState(false);
  const [railTop, setRailTop] = useState(64);
  const [scrubPage, setScrubPage] = useState<number | null>(null);
  // —— 去条纹：本地修复开关（持久化、全局生效、默认开启）——
  // 按钮亮 = 显示修复后效果；按钮灭 = 显示原图（点击即切换，无需长按）
  const [deseam, setDeseamState] = useState<boolean>(() => deseaOn());
  /** 左右点击分区是否反转（左手 / 右起翻页），持久化 */
  const [tapInvert, setTapInvert] = useState<boolean>(() => loadTapInvert());
  // 「去条纹」的真值在 core/scramble 的模块状态里，订阅它的变化事件同步按钮态。
  // 之前 jm:deseam 只发不收（半截契约），按钮态与真值一旦分头修改就会不一致。
  useEffect(() => on("jm:deseam", (v) => setDeseamState(Boolean(v))), []);
  const currentRef = useRef(1);
  /** 已预取（并正在解码）的前方页：键是页码，翻过去即释放 */
  const preloadRef = useRef<Map<number, HTMLImageElement>>(new Map());
  /** 本话累计"彻底失败"的页数；自愈次数与上次自愈时间（允许隔一段时间再自愈一次，不再一话只给一次机会） */
  const pageFailRef = useRef(0);
  const healCountRef = useRef(0);
  const healAtRef = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const railTimer = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const scrubRaf = useRef(0);

  useEffect(() => {
    return on("jm:caches", () => setTask(cacheList().find((t) => t.id === String(albumId))));
  }, [albumId]);

  /**
   * 已缓存话实况 + 每话缓存记录（弹窗显示「已缓存 · N 页」）。
   * 依赖 bookId 而不是 bookMeta 对象：bookMeta 每次渲染都是新对象，
   * 之前用它会每渲染一次就重扫一遍 Cache API（实测静置 5s 触发 5 次）。
   */
  const bookId = bookMeta?.bookId || "";
  const refreshCached = useCallback(async () => {
    // 只扫「本书的话 + 当前话」：阅读器切话、开缓存弹窗都只关心自己这本书，
    // 全库扫描在老机型上要遍历整机所有 cache（几十秒级的等待就是这么来的）
    const metas = bookId ? await listChapters(bookId) : [];
    const ids = metas.map((c) => String(c.chapterId));
    if (albumId) ids.push(String(albumId));
    setCachedIds(await scanCachedChapters(ids));
    if (bookId) setChapterMetas(metas);
  }, [bookId, albumId]);

  useEffect(() => { if (bookId) void refreshCached(); }, [bookId, refreshCached]);

  /**
   * 弹窗打开时系统返回键只关弹窗。
   * 必须「只注册一次」：jm:back 按注册顺序派发，若依赖弹窗状态重新注册，
   * 监听器会被排到父级之后 → 父级先消费 → 直接退出阅读器（真机反馈的 bug）。
   */
  const dialogRef = useRef({ sourceOpen: false, chapOpen: false, cacheOpen: false, settingsOpen: false });
  dialogRef.current = { sourceOpen, chapOpen, cacheOpen, settingsOpen };
  useBackHandler(() => {
    const d = dialogRef.current;
    if (d.sourceOpen) { closeSourcePicker(); return; }
    if (d.settingsOpen) { setSettingsOpen(false); return; }
    if (d.chapOpen) { setChapOpen(false); return; }
    if (d.cacheOpen) { setCacheOpen(false); return; }
    return false;
  }, []);

  // 有弹窗时给父级一个信号：不要消费返回键（缓存中心的返回监听注册得更早）
  // 注意：新增阅读器弹窗必须同时加进 dialogRef 和这里，否则系统返回键会直接退出阅读器
  const anySheetOpen = sourceOpen || chapOpen || cacheOpen || settingsOpen;
  useEffect(() => {
    if (!anySheetOpen) return;
    pushSheetLock();
    return () => popSheetLock();
  }, [anySheetOpen]);

  useEffect(() => { currentRef.current = current; }, [current]);

  // 换话/换源：新一话已提交渲染（stageGen 变化），此时才释放上一话的 blob（避免屏上旧图裂开）
  useEffect(() => {
    if (stageGen === 0) return;
    releaseOfflinePageUrlsBefore(blobCursorRef.current);
  }, [stageGen]);

  const [pageUrls, setPageUrls] = useState<ReadPage[]>(pages);
  // 父组件先以空 pages[] 渲染阅读器（立即进入），后台获取到实际数据后更新 props → 同步到内部状态
  useEffect(() => { if (pages.length > 0) setPageUrls(pages); }, [pages]);
  // scrambleId 迟到/变化时补一次还原（在线 payload 分批、离线缓存缺字段等），已还原且键相同的页不会重复绘制
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    keepAnchor(() => {
      root.querySelectorAll<HTMLImageElement>("img.jm-page").forEach((img) => {
        if (!img.complete || img.naturalWidth === 0) return; // 还没解码：等 onLoad
        applyScramble(img, albumId, scrambleId);
        markPageReady(img);
      });
    });
  }, [albumId, scrambleId, pageUrls]);


  const total = pages.length;

  useEffect(() => { localStorage.setItem(MODE_KEY, mode); }, [mode]);

  // 翻页预解码：防抖后提前加载并解码相邻 N 页（单页/连续均生效）。
  // 原来只预取 1 页、防抖 180ms：正文图实测 110~120KB，移动网络下单张几百毫秒，
  // 也就是**翻页几乎必然要等**（读者感知的"卡"主要在翻页瞬间，不在首页）。
  // 预取张数按机型分档：低配机（isLowFx）只取 1 页，别和主线程抢解码。
  // 持有的 Image 只保留"仍在前方"的那几页，翻过去的当帧释放（一张解码后 1~2MB）。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const ahead = isLowFx() ? 1 : PRELOAD_AHEAD_PAGES;
      const keep = new Map<number, HTMLImageElement>();
      for (let k = 1; k <= ahead; k++) {
        const pageNo = current + k;
        const next = pageUrls.find((p) => Number(p.page) === pageNo);
        if (!next) break;
        const held = preloadRef.current.get(pageNo);
        if (held) { keep.set(pageNo, held); continue; } // 已预取过，别重复发请求
        const im = new Image();
        im.decoding = "async";
        im.src = next.image;
        if (typeof im.decode === "function") {
          im.decode().catch(() => { /* 解码失败不影响正常流程 */ });
        }
        keep.set(pageNo, im);
      }
      preloadRef.current = keep;
    }, PRELOAD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [current, pageUrls]);

  // 卸载时放掉预取引用（图片缓存本身由浏览器管，不在这里动）
  useEffect(() => () => { preloadRef.current.clear(); }, []);

  useEffect(() => {
    if (!client.setting) {
      client.getSetting().catch(() => { /* ignore */ });
    }
  }, []);

  // 卸载时释放离线阅读 blob URL，防止泄漏
  useEffect(() => {
    return () => { releaseOfflinePageUrls(); };
  }, []);


  const loadedPage = useMemo(() => pages.find((p) => Number(p.page) === current) || pages[0], [pages, current]);

  const jumpTo = useCallback((target: number) => {
    const p = Math.min(Math.max(1, target), total);
    if (mode === "continuous") {
      const el = document.getElementById("jm-pg-" + p);
      el?.scrollIntoView({ block: "start" });
    }
    setCurrent(p);
    setJumpInput(String(p));
    // 只更新"当前是第几页"的临时状态：不写存储（章节内位置不做记录）
  }, [mode, total]);

  // —— 浮标自动显隐（滚动/拖动/悬停唤起，静止 1.7s 后淡出）——
  const showRail = useCallback(() => {
    setRailVisible(true);
    if (railTimer.current !== null) window.clearTimeout(railTimer.current);
    railTimer.current = window.setTimeout(() => {
      railTimer.current = null;
      setRailVisible(false);
    }, 1700);
  }, []);

  const scrubPageFromY = useCallback((clientY: number): number => {
    const el = railRef.current;
    if (!el) return 1;
    const rect = el.getBoundingClientRect();
    const ratio = rect.height > 0 ? Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) : 0;
    return Math.round(ratio * (total - 1)) + 1;
  }, [total]);

  /** 拖动过程合并跳页：每帧最多一次 scrollIntoView，避免 pointermove 洪峰 */
  const railJump = useCallback((page: number) => {
    if (scrubRaf.current) cancelAnimationFrame(scrubRaf.current);
    scrubRaf.current = requestAnimationFrame(() => {
      scrubRaf.current = 0;
      jumpTo(page);
    });
  }, [jumpTo]);

  const onRailPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (total <= 1) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    draggingRef.current = true;
    if (railTimer.current !== null) window.clearTimeout(railTimer.current);
    setRailVisible(true);
    const p = scrubPageFromY(e.clientY);
    setScrubPage(p);
    railJump(p);
    e.preventDefault();
  }, [railJump, scrubPageFromY, total]);

  const onRailPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const p = scrubPageFromY(e.clientY);
    setScrubPage(p);
    railJump(p);
  }, [railJump, scrubPageFromY]);

  const onRailPointerEnd = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setScrubPage(null);
    showRail();
  }, [showRail]);

  // 卸载/切图源时清理浮标定时器与跳页 rAF
  useEffect(() => () => {
    if (railTimer.current !== null) window.clearTimeout(railTimer.current);
    if (scrubRaf.current) cancelAnimationFrame(scrubRaf.current);
  }, []);

  // 连续阅读时隐藏系统滚动条（由右侧浮标承担进度），只在本阅读器挂载期间生效
  useEffect(() => {
    if (mode !== "continuous") return;
    const root = document.documentElement;
    root.classList.add("jm-reading");
    return () => root.classList.remove("jm-reading");
  }, [mode]);

  // 浮标纵向范围：避开顶部工具栏（可换行）与底部提示行
  // 注意：工具栏是整屏遮罩（position:fixed; inset:0），它的底边=屏幕底，拿它算浮标起点会把浮标推到屏幕外、高度算成 0
  // （1.8.3 的 .reader-toolbar 没有这条样式，内流小盒子底边≈顶栏底边，所以那时的写法是对的）。这里改取顶栏 .rt-top 的底边。
  useEffect(() => {
    if (mode !== "continuous") return;
    const update = () => {
      const bar = document.querySelector<HTMLElement>(".reader-toolbar .rt-top");
      const y = (bar ? bar.getBoundingClientRect().bottom : 0) + 6;
      const max = Math.max(64, window.innerHeight - 96 - 80); // 底部 96px 提示行 + 至少 80px 轨道
      setRailTop(Math.min(y > 0 ? y : 64, max));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [mode]);

  // —— 当前页检测（扫 .jm-figure 容器而非 img，兼容切块重组/懒加载）——
  // 兼容两种滚动宿主：在线阅读（窗口滚动）与缓存中心离线阅读（fixed overlay 内滚动）。
  // 注意：**不恢复也不记录章节内的页码** —— 按产品要求，阅读只保留"上次读到哪一话"（历史记录），
  // 章节内位置属于临时状态，退出重进从第一页开始。
  useEffect(() => {
    if (mode !== "continuous") return; // 单页模式页码由翻页/跳页控制，无需监听滚动
    // 查询限定在本阅读器内：缓存中心那份离线阅读器可能同时挂载，
    // 不限定范围会扫到它的 .jm-figure（页码、锚点、浮标都会算错）
    const scope: ParentNode = rootRef.current || document;
    const figs = Array.from(scope.querySelectorAll<HTMLElement>(".jm-figure"));
    if (figs.length === 0) return;
    // 滚动宿主判定统一在 core/scrollHost.ts（判定条件只有一份，双宿主与老内核兜底都在那里）
    const hostInfo = resolveReaderScrollHost(rootRef.current);
    const host = hostInfo.measured;
    const isWin = hostInfo.isWindow;
    const compute = () => {
      // 布局还没立起来时不要判定：图片未解码时每页 0 高 → scrollHeight≈0 会让下面的
      // "滚到底 ⇒ total" 条件第一帧就成立，计数器一进阅读器就跳到最后一页。
      // 骨架比例盒已经把高度撑起来了，这里再兜一道（短章节也不会误判）。
      if (host.scrollHeight < host.clientHeight * 1.2) return;
      // 阅读参考线：滚动视口（窗口或 overlay 容器）45% 高度处
      const lineY = (isWin ? 0 : host.getBoundingClientRect().top) + host.clientHeight * 0.45;
      let cur = 1;
      for (const f of figs) {
        const top = f.getBoundingClientRect().top;
        if (top > lineY) break; // 参考线以下无需再扫
        cur = Number(f.dataset.page || String(f.id).replace(/^jm-pg-/, "") || 1);
      }
      // 已滚到底：最后一页可能不足以越过参考线
      const st = scrollTopOf(hostInfo);
      if (st + host.clientHeight >= host.scrollHeight - 6) cur = total;
      setCurrent(cur);
      setJumpInput(String(cur));
      showRail();
    };
    const target = isWin ? window : host;
    target.addEventListener("scroll", compute, { passive: true });
    recomputeRef.current = compute; // 骨架切内容后高度变了，需要主动重算一次
    compute();
    return () => {
      target.removeEventListener("scroll", compute);
      if (recomputeRef.current === compute) recomputeRef.current = null;
      if (recomputeRafRef.current) { cancelAnimationFrame(recomputeRafRef.current); recomputeRafRef.current = 0; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumId, mode, total, pageUrls, showRail]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") { e.preventDefault(); jumpTo(current + 1); }
      if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); jumpTo(current - 1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); jumpTo(current - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); jumpTo(current + 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, jumpTo]);

  /** 图源候选：快速通道 + 官方图源列表 */
  function buildSourceRows(): Array<{ key: string; title: string }> {
    const rows: Array<{ key: string; title: string }> = [{ key: "0", title: "快速通道" }];
    for (const s of client.setting?.app_shunts || []) {
      const k = String(s.key ?? "");
      if (k && !rows.some((x) => x.key === k)) rows.push({ key: k, title: String(s.title || k) });
    }
    return rows;
  }

  /**
   * 当前话正文图的路径（含 query）：换源测速的探针。blob:（离线缓存）与相对地址都不能用，跳过。
   */
  function pageProbePath(): string {
    for (const p of pageUrls) {
      const src = String(p.image || "");
      if (!/^https?:\/\//i.test(src)) continue;
      try { const u = new URL(src); return u.pathname + u.search; } catch { /* 跳过这个 */ }
    }
    return "";
  }

  /**
   * 页图彻底失败（重试链走完快速阶段）时上报。
   * 一话里累计到阈值就自动换源一次 —— 等于替用户点一下「更快的源」，不再让用户自己摸索。
   * 每话最多自动跑 HEAL_MAX 次、两次之间至少隔 HEAL_COOLDOWN：弱网下不会反复重载，
   * 但也不会像"一话只许一次"那样，第一轮自愈正好撞上全网不通就用完了机会。
   */
  function onPageGiveUp() {
    pageFailRef.current += 1;
    if (offline || pageFailRef.current < PAGE_FAIL_HEAL_MIN) return;
    if (healCountRef.current >= PAGE_HEAL_MAX) return;
    if (Date.now() - healAtRef.current < PAGE_HEAL_COOLDOWN_MS) return;
    healCountRef.current += 1;
    healAtRef.current = Date.now();
    pageFailRef.current = 0;
    pushToast("正文图连续加载失败，正在自动换源…", "err");
    window.setTimeout(() => { void runSpeedTest(undefined, { avoidCurrent: true }); }, 700);
  }

  /** <img onError>：CORS 回退 → 退避重试 → 彻底失败时上报（见 handlePageImgError） */
  function onImgError(e: React.SyntheticEvent<HTMLImageElement>) {
    handlePageImgError(e, onPageGiveUp);
  }

  /** <img onLoad>：先把重试计数与失败态清掉（慢速恢复里成功了也要把界面复原），再重排 */
  function onPageLoaded(im: HTMLImageElement) {
    clearPageRetry(im);
    delete im.dataset.retryN;
    const box = pageBoxOf(im);
    if (box) delete box.dataset.failed;
    applyScramble(im, albumId, scrambleId);
    markPageReady(im);
  }

  /** 手动选源：立刻关浮层，阅读器先进加载骨架，再按新源从头填充（失败把原页放回） */
  async function changeSource(key: string) {
    if (sourceBusy) return;
    setSourceBusy(key);
    client.setImageShunt(key);
    closeSourcePicker();
    const prevPages = beginRestage();
    try {
      if (key !== "0") await client.getSetting();
      // 预检开着：万一这个源返回的页 URL 落在拉不动的图床上，会自动换成同路径的可用镜像
      const [r] = await Promise.all([client.getRead(albumId), holdStage()]);
      if (!r) { setPageUrls(prevPages); return; }
      setPageUrls(r.images);
      commitRestage();
      pushToast(key === "0" ? "已开启快速通道" : "图源已切换", "ok");
    } catch {
      pushToast("图源切换失败，请重试", "err");
      setPageUrls(prevPages);
    } finally {
      setSourceBusy(null);
    }
  }

  /** 「更快的源」：立即弹窗并自动开始测速；测速完成后弹窗不关闭 */
  function openSourcePicker() {
    setSourceRows(buildSourceRows());
    setSourceOpen(true);
    void runSpeedTest(++speedGenRef.current);
  }

  /** 关闭弹窗 = 用户不想换源：作废在途测速（不再切源/刷新列表） */
  function closeSourcePicker() {
    speedGenRef.current += 1;
    setSourceOpen(false);
    setTesting(false);
  }

  /**
   * 阅读器内测速：实测各图源图床下载耗时，自动切到最快图源，并把结果写回弹窗列表。
   *
   * ⚠️ 探针对象必须是**这本书的正文图**，不是封面缩略图：
   * 封面是静态文件、CDN 边缘直吐，正文图要走回源+解密，两者会给出相反的排名
   * （启动选源那边同样踩过这个坑，见 core/api.ts 的 PROBE_PHOTO_PATHS）。
   * 以前这里测的是 /media/albums/<id>_3x4.jpg，于是"更快的源"可能选出一个封面快、
   * 正文慢甚至拉不到图的图床。现在拿当前话第 1 页的路径去换 host 测，测的就是真正要看的东西。
   */
  async function runSpeedTest(gen = ++speedGenRef.current, opts: { avoidCurrent?: boolean } = {}) {
    if (testing) return;
    setTesting(true);
    try {
      if (!client.setting) {
        try { await client.getSetting(); } catch { /* ignore */ }
      }
      if (gen !== speedGenRef.current) return;
      const rows = buildSourceRows();
      setSourceRows(rows.map((r) => ({ ...r })));
      // 并发探测每个图源的图床地址（只读，不改当前图源）
      const probes = await Promise.all(rows.map(async (k) => {
        let host = "";
        try { host = await client.probeImageHost(k.key); } catch { host = ""; }
        if (!host && k.key === "0") host = "cn-ms.jmapiproxy2.cc";
        return { key: k.key, host: host.replace(/^https?:\/\//, "") };
      }));
      const hostMap = new Map<string, string>();
      const items: SpeedItem[] = [];
      const stamp = String(Date.now());
      // 探针路径：优先当前话正文图（首页），拿不到（还没加载出页列表 / 离线 blob）才退回封面
      const samplePath = pageProbePath();
      const probePath = samplePath
        ? samplePath + (samplePath.includes("?") ? "&" : "?") + "bust="
        : "/media/albums/" + String(albumId) + "_3x4.jpg?v=";
      for (const p of probes) {
        if (!p.host) continue;
        hostMap.set(p.key, p.host);
        const label = rows.find((x) => x.key === p.key)?.title || p.key;
        items.push({
          label: label + "（" + p.host + "）",
          url: "https://" + p.host + probePath + stamp,
          tag: p.key
        });
      }
      if (items.length === 0) {
        pushToast("暂时无法获取图源图床", "err");
        return;
      }
      if (gen !== speedGenRef.current) return; // 弹窗已关闭：不再测速
      // 用 <img> 真实解码测：no-cors 的 fetch 对 403/404 也返回 ok，会把"连得上但不给图"的源当成可用
      const samples = await measureImages(items);
      if (gen !== speedGenRef.current) return; // 测速期间被关闭：结果作废，不切源
      jlog("speedtest", samples.map((s) => String(s.tag) + "=" + s.ms + (s.ok ? "" : "×")).join(" "));
      // 每行写回耗时/可用性：按 tag 精确对应（原来拿 url.includes(host) 反查，host 互为子串时会串行）
      setSourceRows((list) => list.map((row) => {
        const host = hostMap.get(row.key);
        const s = samples.find((x) => x.tag === row.key);
        return { ...row, host, ms: s ? s.ms : undefined, ok: s ? s.ok : false };
      }));
      // 选源交给 core/speed.pickFastestSource：官方源优先于 express，且不再按 host 反查、失败不再静默落到 rows[0]
      let best = pickFastestSource(samples, "0");
      // 自愈场景（正文图已经连续失败）：当前源本身要避开，否则"换到当前源"等于什么也没换
      if (opts.avoidCurrent && best && String(best.tag) === String(client.imageShunt)) {
        const alt = pickFastestSource(samples.filter((s) => String(s.tag) !== String(client.imageShunt)), "0");
        if (alt) best = alt;
      }
      if (!best || best.tag === undefined) {
        pushToast("所有图源均测速失败，请检查网络后重试", "err");
        return;
      }
      const bestKey = String(best.tag);
      const bestTitle = rows.find((x) => x.key === bestKey)?.title || "图源";
      client.setImageShunt(bestKey);
      // 换源同样是整块重载：与手动选源一致，先骨架再从第 1 页填充（失败把原页放回）
      const prevPages = beginRestage();
      try {
        // 预检开着：测速挑的是"图床"，而 /comic_read 可能把这个 key 落到另一个图床 ——
        // 预检正好补上这一环（真实页 URL 不可用就换同路径镜像），不会再出现"选了却全黑"
        const r = await client.getRead(albumId);
        if (!r) setPageUrls(prevPages);
        else { setPageUrls(r.images); commitRestage(); }
        // 快速通道（key 0）常常封面上排第一但正文拉不到图：跳过它时要说明，别让用户以为选错了
        const skippedExpress = bestKey !== "0"
          && samples.some((s) => s.ok && String(s.tag) === "0" && s.ms < best.ms);
        pushToast("已切换最快可用图源：" + bestTitle + "（" + best.ms + " ms）" + (skippedExpress ? "，已跳过快速通道（正文图不稳）" : ""), "ok");
      } catch {
        setPageUrls(prevPages);
        pushToast("测速切换失败，请重试", "err");
      }
    } catch {
      pushToast("测速切换失败，请重试", "err");
    } finally {
      setTesting(false);
    }
  }

  function handleBack() {
    client.finishFastTrack();
    onBack();
  }

  /** 唤出控制条并在 3 秒后自动淡出（翻页/滚动/点按钮都会重新计时） */
  const showChrome = useCallback(() => {
    setChromeOn(true);
    if (chromeTimer.current) window.clearTimeout(chromeTimer.current);
    chromeTimer.current = window.setTimeout(() => setChromeOn(false), 3000);
  }, []);

  const hideChrome = useCallback(() => {
    if (chromeTimer.current) window.clearTimeout(chromeTimer.current);
    setChromeOn(false);
  }, []);

  useEffect(() => () => { if (chromeTimer.current) window.clearTimeout(chromeTimer.current); }, []);

  /**
   * 点画面的行为（沉浸阅读）：
   *   控件已显示 → 收起；控件隐藏时，单页模式点左右 1/3 翻页，点中间唤出控件；
   *   连续滚动模式点任意位置都唤出控件（滚动手势不受影响）。
   */
  /**
   * 翻页或滚动时如果控制条正显示着，重新计时（否则会在用户操作中途消失）。
   * 注意两种滚动宿主：在线阅读滚的是 window，缓存中心离线阅读滚的是 .cache-overlay，
   * 所以除 window 的 scroll 外，还要在阅读器根元素上听 wheel / touchmove。
   */
  useEffect(() => {
    if (!chromeOn) return;
    const bump = () => showChrome();
    const el = rootRef.current;
    window.addEventListener("scroll", bump, { passive: true });
    el?.addEventListener("wheel", bump, { passive: true });
    el?.addEventListener("touchmove", bump, { passive: true });
    return () => {
      window.removeEventListener("scroll", bump);
      el?.removeEventListener("wheel", bump);
      el?.removeEventListener("touchmove", bump);
    };
  }, [chromeOn, showChrome]);

  function onReaderTap(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    // 只放过浮层里的真实控件（按钮/输入框）；控制条覆盖全屏，如果整块都吃掉点击，
    // 用户就没办法"再点一下收起"了，所以空白处要能穿透到收起逻辑
    if (target.closest(".reader-sheet") || target.closest(".reader-rail")) return;
    if (target.closest("button, input, a, label")) return;
    if (chromeOn) { hideChrome(); return; }
    // 分区判定收在 core/tapZones（归一化坐标 + 可反转，参考 Mihon 的 ViewerNavigation）
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    const y = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0.5;
    const zones = mode === "single" ? TAP_ZONES_SINGLE : TAP_ZONES_CONTINUOUS;
    const action = resolveTapAction(zones, x, y, tapInvert);
    if (action === "prev") { jumpTo(current - 1); showChrome(); return; }
    if (action === "next") { jumpTo(current + 1); showChrome(); return; }
    showChrome();
  }

  /**
   * 取某话的原始页列表（不含 blob 转换，用于缓存）：
   * 当前话内存 → IndexedDB 记录 → 从 Cache API 反推（IDB 记录丢失时的补救）→ 网络。
   */
  async function rawPages(id: string): Promise<{ pages: ReadPage[]; scrambleId?: number | string } | null> {
    if (id === String(albumId) && pages.length > 0 && !String(pages[0].image || "").startsWith("blob:")) {
      return { pages, scrambleId };
    }
    const rec = await getChapter(id);
    if (rec && rec.pages.length > 0) return { pages: rec.pages, scrambleId: rec.scrambleId };
    const recovered = await pagesFromCache(id);
    if (recovered.length > 0) {
      // 只有图片、没有 IDB 记录：联网补一次 scrambleId（离线时拿不到，图片会保持未重排）
      const r = await client.getRead(id, { preflight: false }).catch(() => null);
      return { pages: recovered, scrambleId: r?.scramble_id };
    }
    // 批量缓存路径：不在这里做预检（每话都 HEAD 一次纯属浪费），源在进阅读器时已经验过
    const r = await client.getRead(id, { preflight: false }).catch(() => null);
    if (!r || !Array.isArray(r.images) || r.images.length === 0) return null;
    return { pages: r.images, scrambleId: r.scramble_id };
  }

  /** 换话/换源的最短加载态：数据秒回时也能看见骨架，不会一闪而过 */
  const STAGE_MIN_MS = 180;
  const holdStage = () => new Promise<void>((res) => window.setTimeout(res, STAGE_MIN_MS));

  /** 整块重载第一步：清空当前页 → 阅读器立刻显示骨架；返回原页以便失败时放回 */
  function beginRestage(): ReadPage[] {
    const prev = pageUrls;
    blobCursorRef.current = blobCheckpoint();
    // 新一话/新图源：失败计数归零（自愈次数与冷却保留，避免换源失败后立刻再自愈一次）
    pageFailRef.current = 0;
    setPageUrls([]);
    return prev;
  }

  /** 整块重载第二步：新页已就绪，整块重挂并回到第 1 页（与重新进入阅读器一致） */
  function commitRestage(): void {
    setCurrent(1);
    setJumpInput("1");
    setScrubPage(null);
    setStageGen((g) => g + 1);
    resetReaderScroll();
  }

  /** 阅读用页列表：本地命中就把已缓存页换成 blob URL，未缓存页回落原 URL */
  async function resolvePages(id: string): Promise<{ pages: ReadPage[]; scrambleId?: number | string } | null> {
    const raw = await rawPages(id);
    if (!raw) return null;
    return { pages: await toOfflinePageUrls(id, raw.pages), scrambleId: raw.scrambleId };
  }

  function recordHistory(id: string, label: string, sort?: number) {
    saveHistory({
      id,
      bookId: bookMeta?.bookId || id,
      name: bookMeta?.name || title,
      author: bookMeta?.author.join("/") || meta?.author,
      description: bookMeta?.description,
      chapterName: label,
      sort,
      chapters: chapters.length > 1 ? chapters.length : undefined,
      lastReadAt: Date.now()
    });
  }

  /** 阅读器内换话：离线/已缓存话走本地，其余走网络 */
  async function switchToChapter(c: BookChapter) {
    if (switchBusy) return;
    const id = String(c.id);
    const label = chapterLabel(c) || ("#" + id);
    if (id === String(albumId)) { setChapOpen(false); return; }
    setSwitchBusy(true);
    setSwitchKey(id);
    // 立刻关浮层并把当前页清空：阅读器先显示骨架（正在加载阅读数据…），新一话拿到后逐页填充
    setChapOpen(false);
    const prevPages = beginRestage();
    try {
      const [next] = await Promise.all([resolvePages(id), holdStage()]);
      if (!next) { pushToast("该话本地数据缺失，联网后可加载", "err"); setPageUrls(prevPages); return; }
      setOverride({ id, pages: next.pages, scrambleId: next.scrambleId, label, sort: Number(c.sort) || undefined });
      commitRestage();
      recordHistory(id, label, Number(c.sort) || undefined);
      // 回写外层详情页的"当前话"：否则退回详情还停在进入阅读器时那一话
      onChapterChange?.(id, label, Number(c.sort) || undefined);
    } catch (err) {
      pushToast("切换失败：" + String(err).replace(/^Error: /, "").slice(0, 80), "err");
      setPageUrls(prevPages);
    } finally {
      setSwitchBusy(false);
      setSwitchKey(null);
    }
  }

  /** 缓存入口：单本直接缓存；多话弹窗选章节（默认只选中当前话） */
  function openCacheDialog() {
    if (!pages.length) return;
    if (chapters.length <= 1) { void enqueueOne(String(albumId)); return; }
    setCacheSel(new Set([String(albumId)]));
    void refreshCached();
    setCacheOpen(true);
  }

  /** 把一话加入缓存队列；返回是否真的入队 */
  async function enqueueOne(id: string, label?: string, sort?: number): Promise<boolean> {
    const t = cacheList().find((x) => x.id === id);
    if (t && (t.status === "queued" || t.status === "running")) { pushToast("该话已在缓存队列中", "info"); return false; }
    if (t && t.status === "done") { pushToast("该话已缓存", "info"); return false; }
    const resolved = await rawPages(id);
    if (!resolved || resolved.pages.length === 0) { pushToast("该话暂无可用图片，无法缓存", "err"); return false; }
    await enqueueCache({
      id,
      bookId: bookMeta?.bookId,
      title: bookMeta?.name || title,
      chapterName: label ?? curLabel,
      sort: sort ?? curSort,
      author: meta?.author,
      category: meta?.category,
      cover: meta?.cover,
      scrambleId: resolved.scrambleId,
      pages: resolved.pages,
      bookMeta
    });
    return true;
  }

  /** 弹窗确认：逐话入队（已缓存的话在弹窗里不可选） */
  async function confirmCache() {
    if (cacheBusy) return;
    const picked = chapters.filter((c) => cacheSel.has(String(c.id)));
    if (picked.length === 0) { pushToast("请至少选择一话", "info"); return; }
    setCacheBusy(true);
    let ok = 0;
    let fail = 0;
    try {
      for (const c of picked) {
        const done = await enqueueOne(String(c.id), chapterLabel(c), Number(c.sort) || undefined).catch(() => false);
        if (done) ok += 1; else fail += 1;
      }
      pushToast(fail === 0 ? "已加入缓存队列（" + ok + " 话）" : "已加入 " + ok + " 话，" + fail + " 话未能加入", fail === 0 ? "ok" : "err");
      setCacheOpen(false);
    } finally {
      setCacheBusy(false);
    }
  }

  function toggleCacheSel(id: string) {
    setCacheSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** 全选：只选可选中的（已缓存的话跳过） */
  function selectAllChapters() {
    setCacheSel(new Set(chapters.filter((c) => !cachedIds.has(String(c.id))).map((c) => String(c.id))));
  }

  /** 反选：在可选中的范围内取反 */
  function invertChapters() {
    setCacheSel((prev) => {
      const next = new Set<string>();
      for (const c of chapters) {
        const id = String(c.id);
        if (cachedIds.has(id)) continue;
        if (!prev.has(id)) next.add(id);
      }
      return next;
    });
  }

  /**
   * 尺寸自校正的配套：改高度前后把滚动位置补回来。
   * 锚点取"视口里最上面那一页"——变化发生在它上方时它会被顶走同样的距离，补回去即可；
   * 变化在它下方时锚点不动（delta≈0），自然不补。
   * 不依赖 CSS scroll anchoring（老内核不一定支持；支持的内核已被 CSS 的 overflow-anchor:none 关掉，
   * 否则两层补偿会叠加成"跳两次"），两种滚动宿主都覆盖。
   */
  function keepAnchor(mutate: () => void): void {
    const root = rootRef.current;
    if (!root) { mutate(); return; }
    const figs = Array.from(root.querySelectorAll<HTMLElement>(".jm-figure"));
    const anchor = figs.find((f) => f.getBoundingClientRect().bottom > 0) || null;
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    mutate();
    if (!anchor) return;
    const delta = anchor.getBoundingClientRect().top - before;
    if (Math.abs(delta) < 0.5) return;
    scrollByHost(resolveReaderScrollHost(root), delta);
  }

  /** 换话/换源后回到顶部：窗口滚动与缓存中心 overlay 两种宿主都要处理 */
  function resetReaderScroll(): void {
    scrollToTopOf(resolveReaderScrollHost(rootRef.current), 0);
  }

  /** 记住这一页的真实比例：同话后续页的骨架直接用它（比例没变就什么都不做） */
  function learnRatio(img: HTMLImageElement): void {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return;
    const pct = Math.round((h / w) * 1000) / 10;
    if (!(pct > 60 && pct < 400) || pct === ratioRef.current) return;
    ratioRef.current = pct;
    // 还没就绪的骨架同步换成新比例（跑在 keepAnchor 里，所以不会把读者顶走）
    rootRef.current?.querySelectorAll<HTMLElement>(".jm-figure:not([data-ready])").forEach((f) => {
      f.style.setProperty("--jm-ar", pct + "%");
    });
  }

  /** 内容就绪：比例盒骨架 → 自然高度（先补偿滚动，再在下一帧重算当前页） */
  function markPageReady(img: HTMLImageElement): void {
    keepAnchor(() => {
      learnRatio(img);
      const fig = img.closest(".jm-figure");
      if (fig instanceof HTMLElement && fig.dataset.ready !== "1") fig.dataset.ready = "1";
      const single = img.closest(".jm-single-wrap");
      if (single instanceof HTMLElement) single.dataset.ready = "1";
    });
    if (recomputeRafRef.current) return;
    recomputeRafRef.current = requestAnimationFrame(() => {
      recomputeRafRef.current = 0;
      recomputeRef.current?.();
    });
  }

  function pageSrc(p: ReadPage): string {
    const src = p.image;
    const key = imageName(p) + "|" + src;
    if (!loggedSrc.has(key)) {
      if (loggedSrc.size >= LOGGED_SRC_MAX) loggedSrc.clear(); // 容量上限：不随着阅读时长无界增长
      loggedSrc.add(key);
      jlog("pageSrc page=" + imageName(p) + " → " + src.split("//").slice(-1)[0].slice(0, 70));
    }
    return src;
  }

  function renderPage(p: ReadPage) {
    return (
      <figure
        key={String(p.page)}
        id={"jm-pg-" + p.page}
        data-page={p.page}
        className="jm-figure"
        style={{ "--jm-ar": ratioRef.current + "%" } as CSSProperties}
      >
        <img className="jm-page" data-page={p.page} src={pageSrc(p)} alt={imageName(p)} crossOrigin="anonymous" loading="lazy" decoding="async" draggable={false}
          onLoad={(e) => { onPageLoaded(e.currentTarget); }}
          onError={onImgError} />
        {/* 重试全用尽才显示（CSS 按 figure[data-failed] 控制）：以前失败页和"还在加载"长得一模一样，
            用户只能靠「换源」把整块重挂一遍来蒙 —— 现在失败是可见的，并且能单页重来 */}
        <button type="button" className="jm-retry" onClick={(e) => {
          e.stopPropagation();
          const im = e.currentTarget.parentElement?.querySelector<HTMLImageElement>("img.jm-page");
          if (im) resetPageImage(im);
        }}>加载失败 · 点按重试</button>
      </figure>
    );
  }

  function toggleDeseam() {
    const next = !deseam;
    jlog("toggle pressed →", next ? "ON（显示修复后）" : "OFF（显示原图）", "album=" + albumId, "pages=" + pageUrls.length, "scrambleId=" + String(scrambleId));
    // 只写模块真值：它会派发 jm:deseam，上面的订阅再把按钮态同步过来（单一数据源）
    setDeseam(next);
    // 立即重绘已渲染页面：关闭 → 原图，开启 → 修复后效果
    document.querySelectorAll<HTMLImageElement>("img.jm-page, img.jm-single").forEach((im) => {
      delete im.dataset.scrambleKey;
      applyScramble(im, albumId, scrambleId);
    });
    pushToast(
      next
        ? "去条纹已开启：显示修复后效果（本地处理，不消耗额外流量）"
        : "去条纹已关闭：显示原图",
      next ? "ok" : "info"
    );
  }

  const cacheTaskBusy = Boolean(task && (task.status === "queued" || task.status === "running"));
  /** 整本（或单本当前话）已全部缓存 → 按钮显示「已缓存」且不可点 */
  const allCached = chapters.length > 0
    ? chapters.every((c) => cachedIds.has(String(c.id)))
    : cachedIds.has(String(albumId));

  /**
   * 控制条（沉浸阅读）：默认不显示，点画面中间唤出、3 秒无操作自动淡出。
   * 分两行——上面是"我在哪"（返回 / 章节名 / 页码），下面是"我能做什么"（工具 / 翻页）。
   * 所有原有按钮一个不少，只是不再常驻屏幕。
   */
  const pagePct = total > 1 ? Math.min(100, Math.max(0, ((current - 1) / (total - 1)) * 100)) : 0;
  const toolbar = (
    <div className={"reader-toolbar" + (chromeOn ? " show" : "")} aria-hidden={!chromeOn} inert={!chromeOn}>
      <div className="rt-top">
        <button onClick={handleBack}>返回</button>
        <span className="rt-title one-line">{title}</span>
        <span className="rt-page mono-num">{current} / {total}</span>
      </div>
      <div className="rt-bottom">
        <div className="rt-progress" aria-hidden="true"><i style={{ transform: "scaleX(" + (pagePct / 100) + ")" }} /></div>
        <div className="rt-tools">
          {!offline && (
            <button className="rt-tool" disabled={testing} onClick={openSourcePicker} title="测速并选择图源">
              <LightningIcon size={20} />
              <span>{testing ? "测速中…" : "更快的源"}</span>
            </button>
          )}
          {chapters.length > 1 && (
            <button className="rt-tool" onClick={() => { void refreshCached(); setChapOpen(true); }} title="切换话数">
              <MenuIcon size={20} />
              <span>{switchBusy ? "切换中…" : (curLabel || "换话")}</span>
            </button>
          )}
          {allCached && !cacheTaskBusy ? (
            <button className="rt-tool btn-cached" disabled title="本作品已全部缓存">
              <DownloadIcon size={20} />
              <span>已缓存</span>
            </button>
          ) : (
            <button
              className="rt-tool"
              disabled={!pages.length || cacheTaskBusy}
              onClick={openCacheDialog}
              title={chapters.length > 1 ? "选择要缓存的话数" : "缓存本话"}
            >
              <DownloadIcon size={20} />
              <span>{cacheTaskBusy ? <span className="mono-num">{"缓存中 " + (task?.done ?? 0) + "/" + (task?.total ?? 0)}</span> : "缓存"}</span>
            </button>
          )}
          <button className="rt-tool" onClick={() => setSettingsOpen(true)} title={NO_SEAM ? "阅读设置：模式 / 跳页" : "阅读设置：模式 / 去条纹 / 跳页"}>
            <SettingsIcon size={20} />
            <span>设置</span>
          </button>
        </div>
      </div>
    </div>
  );

  /**
   * 阅读器内弹窗（图源 / 换话 / 选话缓存）：底部抽屉，点遮罩或系统返回键关闭。
   * 必须 portal 到 body：否则会命中 .reader-wrap 的深色作用域规则
   * （.reader-wrap .row button 半透明白底 + 白字、.reader-wrap .muted 深灰），
   * 在浅色抽屉上表现为「文字过淡、像禁用」。
   */
  const overlays = createPortal((
    <>
      {sourceAnim.mounted && (
        <div className="drawer-backdrop reader-sheet-backdrop" data-entering={sourceAnim.entering ? "" : undefined} data-closed={sourceAnim.closing ? "" : undefined} onClick={closeSourcePicker}>
          <div className="source-drawer reader-sheet" data-entering={sourceAnim.entering ? "" : undefined} data-closed={sourceAnim.closing ? "" : undefined} onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h3>更快的源</h3>
              <button className="sheet-close" aria-label="关闭" onClick={closeSourcePicker}>×</button>
            </div>
            <p className="muted">{testing ? "正在测速…" : "已自动选择最快图源"}</p>
            <div className="list sheet-list">
              {sourceRows.map((s) => {
                const active = String(client.imageShunt) === s.key;
                return (
                  <button
                    key={s.key}
                    className={"sheet-row" + (active ? " active" : "")}
                    disabled={Boolean(sourceBusy)}
                    aria-busy={sourceBusy === s.key ? "true" : undefined}
                    onClick={() => { void changeSource(s.key); }}
                  >
                    <div>
                      <div className="title">{s.title}{active ? "（当前）" : ""}</div>
                      <div className="muted">{sourceBusy === s.key ? "正在切换…" : [s.host, s.ms != null ? s.ms + " ms" : (testing ? "测速中…" : ""), s.ok === false && !testing ? "不可用" : ""].filter(Boolean).join(" · ")}</div>
                    </div>
                    {sourceBusy === s.key
                      ? <span className="row-spin" aria-hidden="true" />
                      : <span className={"badge" + (active ? " ok" : "")}>{active ? "✓" : ""}</span>}
                  </button>
                );
              })}
            </div>
            <div className="row sheet-actions">
              <button disabled={testing || Boolean(sourceBusy)} onClick={() => { void runSpeedTest(); }}>{testing ? "测速中…" : "重新测速"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 阅读设置：模式 / 去条纹 / 跳页（原来这些都摊在工具栏上，阅读时太吵） */}
      {settingsAnim.mounted && (
        <div className="drawer-backdrop reader-sheet-backdrop" data-entering={settingsAnim.entering ? "" : undefined} data-closed={settingsAnim.closing ? "" : undefined} onClick={() => setSettingsOpen(false)}>
          <div className="source-drawer reader-sheet" data-entering={settingsAnim.entering ? "" : undefined} data-closed={settingsAnim.closing ? "" : undefined} onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h3>阅读设置</h3>
              <button className="sheet-close" aria-label="关闭" onClick={() => setSettingsOpen(false)}>×</button>
            </div>
            <p className="muted">阅读模式</p>
            <div className="sheet-list">
              <button
                className={"sheet-row" + (mode === "continuous" ? " active" : "")}
                onClick={() => setMode("continuous")}
              >
                <div><div className="title">连续滚动</div><div className="muted">上下滚动，图片铺满整宽</div></div>
                <span className={"badge" + (mode === "continuous" ? " ok" : "")}>{mode === "continuous" ? "✓" : ""}</span>
              </button>
              <button
                className={"sheet-row" + (mode === "single" ? " active" : "")}
                onClick={() => setMode("single")}
              >
                <div><div className="title">单页</div><div className="muted">点左右两侧翻页</div></div>
                <span className={"badge" + (mode === "single" ? " ok" : "")}>{mode === "single" ? "✓" : ""}</span>
              </button>
            </div>
            {!NO_SEAM && <p className="muted">显示</p>}
            <div className="row sheet-actions settings-actions">
              {!offline && !NO_SEAM && (
                <button
                  className={deseam ? "btn-deseam on" : ""}
                  onClick={toggleDeseam}
                  title="通过简单算法尝试去除部分漫画中的条纹（本地处理，不消耗额外流量）；亮=显示修复后，灭=显示原图"
                >
                  {deseam ? "去条纹 ✓" : "去条纹"}
                </button>
              )}
            </div>
            {/* 翻页方向只对单页模式有意义：连续滚动是上下滚，没有左右分区。
                所以只在 mode==="single" 时出现（原来无条件渲染，连续滚动下也显示，
                而那儿它什么也不影响）。样式走 .seg-choice，不复用 .sheet-actions —— 见 index.css。 */}
            {mode === "single" && (
              <>
                <p className="muted">翻页方向（点左右两侧时哪边是上一页）</p>
                <div className="seg-choice" role="group" aria-label="翻页方向">
                  <button
                    className={tapInvert ? "" : "on"}
                    aria-pressed={!tapInvert}
                    onClick={() => { setTapInvert(false); saveTapInvert(false); }}
                    title="左侧点一下上一页，右侧点一下下一页（默认）"
                  >
                    左←上一页
                  </button>
                  <button
                    className={tapInvert ? "on" : ""}
                    aria-pressed={tapInvert}
                    onClick={() => { setTapInvert(true); saveTapInvert(true); }}
                    title="左右反转：适合左手持机 / 从右往左翻的阅读习惯"
                  >
                    右←上一页
                  </button>
                </div>
              </>
            )}
            <p className="muted">跳到第几页</p>
            <div className="row sheet-actions settings-actions">
              <button disabled={current <= 1} onClick={() => jumpTo(current - 1)}>上一页</button>
              <input
                className="page-input mono-num"
                value={jumpInput}
                onChange={(e) => setJumpInput(e.target.value)}
                inputMode="numeric"
                onKeyDown={(e) => { if (e.key === "Enter") jumpTo(Number(jumpInput)); }}
              />
              <span className="muted mono-num">/{total}</span>
              <button disabled={current >= total} onClick={() => jumpTo(current + 1)}>下一页</button>
              {current > 1 && <button onClick={() => jumpTo(1)}>回到开头</button>}
            </div>
          </div>
        </div>
      )}

      {chapAnim.mounted && (
        <div className="drawer-backdrop reader-sheet-backdrop" data-entering={chapAnim.entering ? "" : undefined} data-closed={chapAnim.closing ? "" : undefined} onClick={() => setChapOpen(false)}>
          <div className="source-drawer reader-sheet" data-entering={chapAnim.entering ? "" : undefined} data-closed={chapAnim.closing ? "" : undefined} onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h3>{"切换话数" + (bookMeta?.name ? "：" + bookMeta.name : "")}</h3>
              <button className="sheet-close" aria-label="关闭" onClick={() => setChapOpen(false)}>×</button>
            </div>
            <p className="muted">共 {chapters.length} 话 · 当前 {curLabel || "第1话"}</p>
            {/* 「下一话」：× 之下、话列表之上。连续看的时候不用回列表里翻找，一话读完直接点它 */}
            <button
              type="button"
              className="chap-next"
              disabled={switchBusy || !nextChapter}
              aria-busy={nextChapter && switchKey === String(nextChapter.chapter.id) ? "true" : undefined}
              onClick={() => { const n = nextChapter; if (n) void switchToChapter(n.chapter); }}
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
                const pagesText = info
                  ? "已缓存 · " + info.pages + " 页" + (rec && rec.total > info.pages ? "/" + rec.total : "")
                  : "未缓存";
                return (
                  <button
                    key={id}
                    className={"sheet-row" + (isCur ? " active" : "")}
                    disabled={switchBusy}
                    aria-busy={switchKey === id ? "true" : undefined}
                    onClick={() => { void switchToChapter(c); }}
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
          </div>
        </div>
      )}

      {cacheAnim.mounted && (
        <div className="drawer-backdrop reader-sheet-backdrop" data-entering={cacheAnim.entering ? "" : undefined} data-closed={cacheAnim.closing ? "" : undefined} onClick={() => { if (!cacheBusy) setCacheOpen(false); }}>
          <div className="source-drawer reader-sheet" data-entering={cacheAnim.entering ? "" : undefined} data-closed={cacheAnim.closing ? "" : undefined} onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h3>选择要缓存的话数</h3>
              <button className="sheet-close" aria-label="关闭" disabled={cacheBusy} onClick={() => setCacheOpen(false)}>×</button>
            </div>
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
                      checked={cached || cacheSel.has(id)}
                      disabled={cached || cacheBusy}
                      onChange={() => toggleCacheSel(id)}
                    />
                    <span className="check-main">
                      <span className="title">{label}{id === String(albumId) ? "（当前）" : ""}</span>
                      <span className="muted">{info
                        ? "已缓存 · " + info.pages + " 页" + (rec && rec.total > info.pages ? "/" + rec.total : "")
                        : "未缓存"}</span>
                    </span>
                    {cached && <span className="badge ok">✓</span>}
                  </label>
                );
              })}
            </div>
            <div className="row sheet-actions">
              <button disabled={cacheBusy} onClick={selectAllChapters}>全选</button>
              <button disabled={cacheBusy} onClick={invertChapters}>反选</button>
              <button disabled={cacheBusy || cacheSel.size === 0} onClick={() => { void confirmCache(); }}>
                {cacheBusy ? "加入中…" : "确认开始缓存（" + cacheSel.size + "）"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  ), document.body);

  const bubblePage = scrubPage ?? current;
  const bubbleRatio = total > 1 ? Math.min(1, Math.max(0, (bubblePage - 1) / (total - 1))) : 0;

  // 页数还没拿到（父组件先以空 pages 挂载）：先给几张等高骨架 + 转圈，而不是一张文字卡
  if (pageUrls.length === 0) {
    return (
      <div className={"reader-wrap" + (chromeOn ? " chrome-on" : "")} ref={rootRef} onClick={onReaderTap}>
        {toolbar}
        <h2 className="reader-title">{title}</h2>
        <div className="reader-cont" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <figure key={i} className="jm-figure" style={{ "--jm-ar": ratioRef.current + "%" } as CSSProperties} />
          ))}
        </div>
        <div className="loading-box small">
          <span className="loading-spinner" aria-hidden="true" />
          <span className="muted">正在加载阅读数据…</span>
        </div>
        {overlays}
      </div>
    );
  }

  if (mode === "single") {
    const page = loadedPage;
    return (
      <div className={"reader-wrap" + (chromeOn ? " chrome-on" : "")} ref={rootRef} onClick={onReaderTap}>
        {toolbar}
        <h2 className="reader-title">{title}</h2>
        {/* key 跟着页走：换页时转圈重新出现，不会沿用上一页的"已就绪"标记 */}
        <div className="jm-single-wrap" key={stageGen + ":" + (page ? String(page.page) : "none")}>
          <span className="loading-spinner" aria-hidden="true" />
          {page && <img key={String(page.page)} className="jm-single" src={pageSrc(page)} alt={imageName(page)} crossOrigin="anonymous" loading="lazy" decoding="async"
            onLoad={(e) => { onPageLoaded(e.currentTarget); }}
            onError={onImgError} />}
          <button type="button" className="jm-retry" onClick={(e) => {
            e.stopPropagation();
            const im = e.currentTarget.parentElement?.querySelector<HTMLImageElement>("img.jm-single");
            if (im) resetPageImage(im);
          }}>加载失败 · 点按重试</button>
        </div>

        {overlays}
      </div>
    );
  }

  return (
    <div className={"reader-wrap" + (chromeOn ? " chrome-on" : "")} ref={rootRef} onClick={onReaderTap}>
      {toolbar}
      <h2 className="reader-title">{title}</h2>
      <div className="reader-cont" key={"stage" + stageGen}>{pageUrls.map((p) => renderPage(p))}</div>
      {total > 1 && (
        <div ref={railRef} role="slider" aria-label="阅读进度" aria-valuemin={1} aria-valuemax={total} aria-valuenow={bubblePage}
          className={"reader-rail" + (railVisible ? " show" : "")}
          style={{ top: railTop }}
          onPointerDown={onRailPointerDown} onPointerMove={onRailPointerMove}
          onPointerUp={onRailPointerEnd} onPointerCancel={onRailPointerEnd}
          onPointerEnter={showRail}>
          <div className="reader-rail-line" aria-hidden="true" />
          <div className="reader-thumb" style={{ top: bubbleRatio * 100 + "%" }}>
            <span className="reader-thumb-num mono-num">{bubblePage}</span>
            <i className="reader-thumb-dot" aria-hidden="true" />
          </div>
        </div>
      )}
      {overlays}
    </div>
  );
}
