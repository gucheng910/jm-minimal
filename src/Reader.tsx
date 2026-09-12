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
import { measureAll } from "./core/speed";
import { pushToast } from "./ui/toast";
import { SkeletonRows } from "./ui/SkeletonRows";
import { DownloadIcon, LightningIcon, MenuIcon, SettingsIcon } from "./ui/icons";
import { deseaOn, drawUnscrambled, measureSeamDetail, pageNameOf, scrambleSliceCount, setDeseam, smoothSeams } from "./core/scramble";
import { NO_SEAM } from "./core/constants";
import type { ReadPage } from "./core/types";
import type { BookMeta } from "./core/offlineMeta";
import { on } from "./core/bus";

type ReaderMode = "continuous" | "single";

const MODE_KEY = "jmclient.reader.mode";

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
const loggedSrc = new Set<string>();

// 带 CORS 加载失败（个别图床不发 CORS 头）时，回退为普通加载——此时 canvas 会被污染，
// 评分/平滑会自动跳过（见 measureSeamScore 的 try/catch），不影响阅读
let expressHintShown = false;
function onImgError(e: React.SyntheticEvent<HTMLImageElement>) {
  const im = e.currentTarget;
  // express（图源 0 / 快速通道）实测只给 logo 不给正文图（photos 被 CDN 重置）：
  // 用户手动选到它时给一次明确提示，而不是对着一片黑猜哪里坏了（每次会话只提示一次）
  if (!expressHintShown && String(client.imageShunt) === "0" && /jm-page|jm-single/.test(im.className)) {
    expressHintShown = true;
    pushToast("快速通道（图源 0）拉不到正文图，请到「换源」换回普通图源", "err");
  }
  if (im.dataset.corsFallback) return;
  im.dataset.corsFallback = "1";
  im.removeAttribute("crossorigin");
  const src = im.src;
  im.src = "";
  im.src = src;
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
  const on = deseaOn();
  // 键 = scrambleId + 开关状态 + 当前图源地址：图源切换、scrambleId 迟到/变化、开关切换都必须重绘
  const key = String(scrambleId ?? "") + "|" + (on ? "fix" : "raw") + "|" + (img.currentSrc || img.src);
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
  if (scrambleId && on && !NO_SEAM) {
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
  onBack, meta, bookMeta, chapterName, chapterSort, offline = false
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
  const currentRef = useRef(1);
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

  // 翻页预解码：防抖后提前加载并解码相邻下一页（单页/连续均生效，最多占用 1 张内存）
  useEffect(() => {
    const next = pageUrls.find((p) => Number(p.page) === current + 1);
    if (!next) return;
    const timer = window.setTimeout(() => {
      const im = new Image();
      im.decoding = "async";
      im.src = next.image;
      if (typeof im.decode === "function") {
        im.decode().catch(() => { /* 解码失败不影响正常流程 */ });
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [current, pageUrls]);

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

  // 浮标纵向范围：避开顶部工具栏（可换行）与底部提示行
  useEffect(() => {
    if (mode !== "continuous") return;
    const update = () => {
      const tb = document.querySelector<HTMLElement>(".reader-toolbar");
      const top = (tb ? tb.getBoundingClientRect().bottom : 0) + 6;
      setRailTop(top > 0 ? top : 64);
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
    const figs = Array.from(document.querySelectorAll<HTMLElement>(".jm-figure"));
    if (figs.length === 0) return;
    // 向上找最近的滚动容器（如 .cache-overlay）；找不到则按窗口滚动处理
    let hostEl: HTMLElement | null = null;
    let walk = figs[0].parentElement;
    while (walk && walk !== document.body) {
      const cs = window.getComputedStyle(walk);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && walk.scrollHeight > walk.clientHeight + 2) {
        hostEl = walk;
        break;
      }
      walk = walk.parentElement;
    }
    const isWin = hostEl === null;
    const host = (hostEl || document.scrollingElement || document.documentElement) as HTMLElement;
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
      const st = isWin ? window.scrollY : host.scrollTop;
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

  /** 手动选源：弹窗保持打开，测速结果与当前选中项都在弹窗里看 */
  async function changeSource(key: string) {
    if (sourceBusy) return;
    setSourceBusy(key);
    client.setImageShunt(key);
    try {
      if (key !== "0") await client.getSetting();
      const r = await client.getRead(albumId);
      if (!r) return;
      blobCursorRef.current = blobCheckpoint();
      setPageUrls(r.images);
      setCurrent(1);
      setJumpInput("1");
      setScrubPage(null);
      setStageGen((g) => g + 1); // 整块重载：新骨架 + 从头渲染
      resetReaderScroll();
      pushToast(key === "0" ? "已开启快速通道" : "图源已切换", "ok");
    } catch {
      pushToast("图源切换失败，请重试", "err");
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

  /** 阅读器内测速：实测各图源图床下载耗时，自动切到最快图源，并把结果写回弹窗列表 */
  async function runSpeedTest(gen = ++speedGenRef.current) {
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
      const items: Array<{ label: string; url: string; noCors: boolean }> = [];
      const stamp = String(Date.now());
      for (const p of probes) {
        if (!p.host) continue;
        hostMap.set(p.key, p.host);
        const label = rows.find((x) => x.key === p.key)?.title || p.key;
        items.push({
          label: label + "（" + p.host + "）",
          url: "https://" + p.host + "/media/albums/" + String(albumId) + "_3x4.jpg?v=" + stamp,
          noCors: true
        });
      }
      if (items.length === 0) {
        pushToast("暂时无法获取图源图床", "err");
        return;
      }
      if (gen !== speedGenRef.current) return; // 弹窗已关闭：不再测速
      const samples = await measureAll(items, 3);
      if (gen !== speedGenRef.current) return; // 测速期间被关闭：结果作废，不切源
      // 每行写回耗时/可用性（没有样本的图源视为不可用）
      setSourceRows((list) => list.map((row) => {
        const host = hostMap.get(row.key);
        const s = host ? samples.find((x) => x.url.includes(host)) : undefined;
        return { ...row, host, ms: s ? s.ms : undefined, ok: s ? s.ok : false };
      }));
      const best = samples.find((s) => s.ok);
      if (!best) {
        pushToast("所有图源均测速失败，请检查网络后重试", "err");
        return;
      }
      const bestHost = best.url.replace(/^https?:\/\//, "").split("/")[0];
      let bestKey = rows[0].key;
      for (const [k, h] of hostMap) {
        if (h === bestHost) { bestKey = k; break; }
      }
      const bestTitle = rows.find((x) => x.key === bestKey)?.title || "图源";
      client.setImageShunt(bestKey);
      const r = await client.getRead(albumId);
      if (r) {
        setPageUrls(r.images);
        jumpTo(1);
      }
      pushToast("已切换最快图源：" + bestTitle + "（" + best.ms + " ms）", "ok");
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
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    if (mode === "single" && (ratio < 1 / 3 || ratio > 2 / 3)) {
      jumpTo(ratio > 2 / 3 ? current + 1 : current - 1);
      showChrome();
      return;
    }
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
      const r = await client.getRead(id).catch(() => null);
      return { pages: recovered, scrambleId: r?.scramble_id };
    }
    const r = await client.getRead(id).catch(() => null);
    if (!r || !Array.isArray(r.images) || r.images.length === 0) return null;
    return { pages: r.images, scrambleId: r.scramble_id };
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
    try {
      blobCursorRef.current = blobCheckpoint();
      const next = await resolvePages(id);
      if (!next) { pushToast("该话本地数据缺失，联网后可加载", "err"); return; }
      setOverride({ id, pages: next.pages, scrambleId: next.scrambleId, label, sort: Number(c.sort) || undefined });
      setCurrent(1);
      setJumpInput("1");
      setScrubPage(null);
      setStageGen((g) => g + 1); // 整块重载：像重新进入阅读器一样
      resetReaderScroll();
      recordHistory(id, label, Number(c.sort) || undefined);
      setChapOpen(false);
    } catch (err) {
      pushToast("切换失败：" + String(err).replace(/^Error: /, "").slice(0, 80), "err");
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

  /** 阅读时的滚动宿主：缓存中心离线阅读是 overlay 容器内滚动，其余是窗口滚动（null = 窗口） */
  function readerScrollHost(): HTMLElement | null {
    const figs = rootRef.current?.querySelectorAll<HTMLElement>(".jm-figure");
    let el: HTMLElement | null = figs && figs.length > 0 ? figs[0].parentElement : null;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 2) return el;
      el = el.parentElement;
    }
    return null;
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
    const host = readerScrollHost();
    if (host) host.scrollTop += delta;
    else window.scrollBy(0, delta);
  }

  /** 换话/换源后回到顶部：窗口滚动与缓存中心 overlay 两种宿主都要处理 */
  function resetReaderScroll(): void {
    const host = readerScrollHost();
    if (host) host.scrollTop = 0;
    else window.scrollTo(0, 0);
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
          onLoad={(e) => { applyScramble(e.currentTarget, albumId, scrambleId); markPageReady(e.currentTarget); }}
          onError={onImgError} />
      </figure>
    );
  }

  function toggleDeseam() {
    const next = !deseam;
    jlog("toggle pressed →", next ? "ON（显示修复后）" : "OFF（显示原图）", "album=" + albumId, "pages=" + pageUrls.length, "scrambleId=" + String(scrambleId));
    setDeseamState(next);
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
          {page && <img key={String(page.page)} className="jm-single" src={pageSrc(page)} alt={imageName(page)} crossOrigin="anonymous"
            onLoad={(e) => { applyScramble(e.currentTarget, albumId, scrambleId); markPageReady(e.currentTarget); }}
            onError={onImgError} />}
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
