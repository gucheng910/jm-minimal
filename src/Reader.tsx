import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { client } from "./core/api";
import { cacheList, enqueueCache, type CacheTaskMeta } from "./core/cacheTasks";
import { releaseOfflinePageUrls, scanCachedChapters, toOfflinePageUrls } from "./core/offline";
import { chapterLabel, getChapter, listChapters, type BookChapter, type ChapterMeta } from "./core/offlineMeta";
import { saveHistory } from "./core/history";
import { useBackHandler } from "./hooks/useBackHandler";
import { measureAll } from "./core/speed";
import { pushToast } from "./ui/toast";
import { deseaOn, drawUnscrambled, measureSeamDetail, pageNameOf, scrambleSliceCount, setDeseam, smoothSeams } from "./core/scramble";
import type { ReadPage } from "./core/types";
import type { BookMeta } from "./core/offlineMeta";
import { on } from "./core/bus";

type ReaderMode = "continuous" | "single";

const MODE_KEY = "jmclient.reader.mode";

function progressKey(id: number | string): string {
  // 页号方案：老版本存的是像素滚动值（jmclient.read.y.<id>），新键避免误当页号恢复
  return "jmclient.read.page." + String(id);
}

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
function onImgError(e: React.SyntheticEvent<HTMLImageElement>) {
  const im = e.currentTarget;
  if (im.dataset.corsFallback) return;
  im.dataset.corsFallback = "1";
  im.removeAttribute("crossorigin");
  const src = im.src;
  im.src = "";
  im.src = src;
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
  // 本地修复（零流量）：逐边界量测"超额跳变"，未达标的按强度自适应加宽高斯并复测
  if (scrambleId && !on) {
    jlog("unscramble page=" + pageNameOf(img) + " 原图（去条纹关闭）");
  } else if (scrambleId) {
    const pageName = pageNameOf(img);
    const parts = scrambleSliceCount(albumId, pageName);
    try {
      const t0 = performance.now();
      const before = measureSeamDetail(canvas, parts);
      const fixed = before.score > SEAM_BAD_SCORE ? smoothSeams(canvas, parts) : 0;
      const after = fixed > 0 ? measureSeamDetail(canvas, parts) : before;
      const ms = Math.round(performance.now() - t0);
      jlog("unscramble page=" + pageName + " parts=" + parts +
        " 条纹超额 " + before.score.toFixed(2) + "(亮度" + before.lum.toFixed(2) + "/色度" + before.chroma.toFixed(2) + ")" +
        (fixed > 0
          ? " → " + after.score.toFixed(2) + "(亮度" + after.lum.toFixed(2) + "/色度" + after.chroma.toFixed(2) + ") 修复" + fixed + "条边界"
          : " 达标跳过") + " " + ms + "ms" +
        " src=" + (img.currentSrc || img.src).split("//").slice(-1)[0].slice(0, 70));
    } catch (err) {
      // canvas 被跨域数据污染（图床未发 CORS 头）→ 无法量测，跳过评分与修复
      jlog("unscramble skip page=" + pageName + " 无法量测: " + String(err).slice(0, 60));
    }
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
  const [cacheOpen, setCacheOpen] = useState(false);
  const [cacheSel, setCacheSel] = useState<Set<string>>(new Set());
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [chapterMetas, setChapterMetas] = useState<ChapterMeta[]>([]);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);

  const [mode, setMode] = useState<ReaderMode>(() => {
    const saved = localStorage.getItem(MODE_KEY);
    return saved === "single" ? "single" : "continuous";
  });
  const [current, setCurrent] = useState(1);
  const [jumpInput, setJumpInput] = useState("1");
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

  /** 已缓存话集合 + 每话缓存记录（弹窗里显示「已缓存 · N 页」，与详情页一致） */
  const refreshCached = useCallback(async () => {
    setCachedIds(await scanCachedChapters());
    if (bookMeta) setChapterMetas(await listChapters(bookMeta.bookId));
  }, [bookMeta]);

  useEffect(() => { if (bookMeta) void refreshCached(); }, [bookMeta, refreshCached]);

  // 弹窗打开时，系统返回键先关弹窗（子组件在父级之前注册监听，先收到事件）
  useBackHandler(() => {
    if (sourceOpen) { setSourceOpen(false); return; }
    if (chapOpen) { setChapOpen(false); return; }
    if (cacheOpen) { setCacheOpen(false); return; }
    return false;
  }, [sourceOpen, chapOpen, cacheOpen]);

  useEffect(() => { currentRef.current = current; }, [current]);

  const [pageUrls, setPageUrls] = useState<ReadPage[]>(pages);
  // 父组件先以空 pages[] 渲染阅读器（立即进入），后台获取到实际数据后更新 props → 同步到内部状态
  useEffect(() => { if (pages.length > 0) setPageUrls(pages); }, [pages]);
  // scrambleId 迟到/变化时补一次还原（在线 payload 分批、离线缓存缺字段等），已还原且键相同的页不会重复绘制
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLImageElement>("img.jm-page").forEach((img) => applyScramble(img, albumId, scrambleId));
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
    if (total > 0) localStorage.setItem(progressKey(albumId), String(p));
  }, [mode, total, albumId]);

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

  // 连续阅读时隐藏系统滚动条（由右侧浮标代替），仅阅读器所在的文档/overlay 生效
  useEffect(() => {
    if (mode !== "continuous") return;
    const root = document.documentElement;
    root.classList.add("jm-reading");
    return () => root.classList.remove("jm-reading");
  }, [mode]);

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

  // —— 页进度：恢复上次页码 + 当前页检测（扫 .jm-figure 容器而非 img，兼容切块重组/懒加载）——
  // 兼容两种滚动宿主：在线阅读（窗口滚动）与缓存中心离线阅读（fixed overlay 内滚动）
  useEffect(() => {
    const key = progressKey(albumId);
    const clampP = (n: number) => Math.min(Math.max(1, n), total);
    const saved = clampP(Number(localStorage.getItem(key) || 0));
    if (mode !== "continuous") {
      // 单页模式：仅恢复页码（无需滚动）
      if (saved >= 1) {
        setCurrent(saved);
        setJumpInput(String(saved));
      }
      return;
    }
    const first = document.getElementById("jm-pg-" + saved);
    if (first) {
      setCurrent(saved);
      setJumpInput(String(saved));
      first.scrollIntoView({ block: "start" });
    }
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
      localStorage.setItem(key, String(cur));
      setCurrent(cur);
      setJumpInput(String(cur));
      showRail();
    };
    const target = isWin ? window : host;
    target.addEventListener("scroll", compute, { passive: true });
    compute();
    return () => target.removeEventListener("scroll", compute);
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
    client.setImageShunt(key);
    try {
      if (key !== "0") await client.getSetting();
      const r = await client.getRead(albumId);
      if (!r) return;
      setPageUrls(r.images);
      jumpTo(1);
      pushToast(key === "0" ? "已开启快速通道" : "图源已切换", "ok");
    } catch {
      pushToast("图源切换失败，请重试", "err");
    }
  }

  /** 「更快的源」：立即弹窗并自动开始测速；测速完成后弹窗不关闭 */
  function openSourcePicker() {
    setSourceRows(buildSourceRows());
    setSourceOpen(true);
    void runSpeedTest();
  }

  /** 阅读器内测速：实测各图源图床下载耗时，自动切到最快图源，并把结果写回弹窗列表 */
  async function runSpeedTest() {
    if (testing) return;
    setTesting(true);
    try {
      if (!client.setting) {
        try { await client.getSetting(); } catch { /* ignore */ }
      }
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
      const samples = await measureAll(items, 3);
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

  /** 取某话页列表：当前话用内存数据（离线 blob 除外）→ IDB → 网络 */
  async function resolvePages(id: string): Promise<{ pages: ReadPage[]; scrambleId?: number | string } | null> {
    if (id === String(albumId) && pages.length > 0 && !String(pages[0].image || "").startsWith("blob:")) {
      return { pages, scrambleId };
    }
    const rec = await getChapter(id);
    if (rec && rec.pages.length > 0) return { pages: rec.pages, scrambleId: rec.scrambleId };
    if (offline) return null;
    const r = await client.getRead(id);
    if (!r || !Array.isArray(r.images) || r.images.length === 0) return null;
    return { pages: r.images, scrambleId: r.scramble_id };
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
    try {
      let next: { pages: ReadPage[]; scrambleId?: number | string } | null = null;
      if (offline || cachedIds.has(id)) {
        const rec = await getChapter(id);
        if (rec && rec.pages.length > 0) next = { pages: await toOfflinePageUrls(id, rec.pages), scrambleId: rec.scrambleId };
      }
      if (!next && offline) { pushToast("该话未缓存，无法离线阅读", "err"); return; }
      if (!next) next = await resolvePages(id);
      if (!next) { pushToast("该话暂无可用图片（可能需要购买或登录）", "err"); return; }
      setOverride({ id, pages: next.pages, scrambleId: next.scrambleId, label, sort: Number(c.sort) || undefined });
      setCurrent(1);
      setJumpInput("1");
      window.scrollTo(0, 0);
      recordHistory(id, label, Number(c.sort) || undefined);
      setChapOpen(false);
    } catch (err) {
      pushToast("切换失败：" + String(err).replace(/^Error: /, "").slice(0, 80), "err");
    } finally {
      setSwitchBusy(false);
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
    const resolved = await resolvePages(id);
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
      <figure key={String(p.page)} id={"jm-pg-" + p.page} data-page={p.page} className="jm-figure">
        <img className="jm-page" data-page={p.page} src={pageSrc(p)} alt={imageName(p)} crossOrigin="anonymous" loading="lazy" decoding="async" draggable={false} onLoad={(e) => applyScramble(e.currentTarget, albumId, scrambleId)} onError={onImgError} />
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

  const toolbar = (
    <div className="reader-toolbar">
      <button onClick={handleBack}>返回</button>
      <button onClick={() => jumpTo(current - 1)} disabled={current <= 1}>上</button>
      <button onClick={() => jumpTo(current + 1)} disabled={current >= total}>下</button>
      <input className="page-input mono-num" value={jumpInput} onChange={(e) => setJumpInput(e.target.value)} inputMode="numeric" onKeyDown={(e) => { if (e.key === "Enter") jumpTo(Number(jumpInput)); }} />
      <span className="muted mono-num">/{total}</span>
      <button onClick={() => setMode(mode === "continuous" ? "single" : "continuous")}>{mode === "continuous" ? "切单页" : "切连续"}</button>
      {!offline && <button disabled={testing} onClick={openSourcePicker} title="测速并选择图源">{testing ? "测速中…" : "更快的源"}</button>}
      {chapters.length > 1 && (
        <button onClick={() => { void refreshCached(); setChapOpen(true); }} title="切换话数">
          {switchBusy ? "切换中…" : (curLabel || "换话")}
        </button>
      )}
      {!offline && (
        <button
          className={deseam ? "btn-deseam on" : ""}
          onClick={toggleDeseam}
          title="通过简单算法尝试去除部分漫画中的条纹（本地处理，不消耗额外流量）；亮=显示修复后，灭=显示原图"
        >
          {deseam ? "去条纹 ✓" : "去条纹"}
        </button>
      )}
      <button
        disabled={!pages.length || Boolean(task && (task.status === "queued" || task.status === "running"))}
        onClick={openCacheDialog}
        title={chapters.length > 1 ? "选择要缓存的话数" : "缓存本话"}
      >
        {task && (task.status === "queued" || task.status === "running")
          ? <span className="mono-num">{"缓存中 " + task.done + "/" + task.total}</span>
          : "缓存"}
      </button>
    </div>
  );

  /** 阅读器内弹窗（图源 / 换话 / 选话缓存）：底部抽屉，点遮罩或系统返回键关闭 */
  const overlays = (
    <>
      {sourceOpen && (
        <div className="drawer-backdrop reader-sheet-backdrop" onClick={() => setSourceOpen(false)}>
          <div className="source-drawer reader-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h3>更快的源</h3>
              <button className="ghost" onClick={() => setSourceOpen(false)}>关闭</button>
            </div>
            <p className="muted">{testing ? "正在测速，自动切换到最快图源…" : "已自动选择最快图源，也可以手动点选（弹窗不会自动关闭）"}</p>
            <div className="list sheet-list">
              {sourceRows.map((s) => {
                const active = String(client.imageShunt) === s.key;
                return (
                  <button key={s.key} className={"list-item sheet-row" + (active ? " active" : "")} onClick={() => { void changeSource(s.key); }}>
                    <div>
                      <div className="title">{s.title}{active ? "（当前）" : ""}</div>
                      <div className="muted">{[s.host, s.ms != null ? s.ms + " ms" : (testing ? "测速中…" : ""), s.ok === false && !testing ? "不可用" : ""].filter(Boolean).join(" · ")}</div>
                    </div>
                    <span className={"badge" + (active ? " ok" : "")}>{active ? "✓" : ""}</span>
                  </button>
                );
              })}
            </div>
            <div className="row sheet-actions">
              <button disabled={testing} onClick={() => { void runSpeedTest(); }}>{testing ? "测速中…" : "重新测速"}</button>
            </div>
          </div>
        </div>
      )}

      {chapOpen && (
        <div className="drawer-backdrop reader-sheet-backdrop" onClick={() => setChapOpen(false)}>
          <div className="source-drawer reader-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h3>{"切换话数" + (bookMeta?.name ? "：" + bookMeta.name : "")}</h3>
              <button className="ghost" onClick={() => setChapOpen(false)}>关闭</button>
            </div>
            <p className="muted">共 {chapters.length} 话 · 当前 {curLabel || "第1话"}</p>
            <div className="list sheet-list">
              {chapters.map((c) => {
                const id = String(c.id);
                const label = chapterLabel(c) || ("#" + id);
                const isCur = id === String(albumId);
                const cached = cachedIds.has(id);
                const rec = chapterMetas.find((m) => m.chapterId === id);
                return (
                  <button key={id} className={"list-item sheet-row" + (isCur ? " active" : "")} onClick={() => { void switchToChapter(c); }}>
                    <div>
                      <div className="title">{label}{isCur ? "（当前）" : ""}</div>
                      <div className="muted">
                        {[cached ? "已缓存" + (rec ? " · " + rec.total + " 页" : "") : "未缓存",
                          !cached && offline ? "离线不可读" : ""].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <span className={"badge" + (cached ? " ok" : "")}>{cached ? "✓" : ""}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {cacheOpen && (
        <div className="drawer-backdrop reader-sheet-backdrop" onClick={() => { if (!cacheBusy) setCacheOpen(false); }}>
          <div className="source-drawer reader-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h3>选择要缓存的话数</h3>
              <button className="ghost" disabled={cacheBusy} onClick={() => setCacheOpen(false)}>关闭</button>
            </div>
            <p className="muted">默认只选中当前话；已缓存的话不可重复选择</p>
            <div className="list sheet-list">
              {chapters.map((c) => {
                const id = String(c.id);
                const label = chapterLabel(c) || ("#" + id);
                const cached = cachedIds.has(id);
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
                      <span className="muted">{cached ? "已缓存" + (rec ? " · " + rec.total + " 页" : "") : "未缓存"}</span>
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
  );

  const bubblePage = scrubPage ?? current;
  const bubbleRatio = total > 1 ? Math.min(1, Math.max(0, (bubblePage - 1) / (total - 1))) : 0;

  // 初始空 pages（后台 getRead 尚未返回）显示加载态
  if (pageUrls.length === 0) {
    return (
      <div className="reader-wrap" ref={rootRef}>
        {toolbar}
        <h2 className="reader-title">{title}</h2>
        <div className="card"><p className="muted">正在加载阅读数据…</p></div>
        {overlays}
      </div>
    );
  }

  if (mode === "single") {
    const page = loadedPage;
    return (
      <div className="reader-wrap" ref={rootRef}>
        {toolbar}
        <h2 className="reader-title">{title}</h2>
        {page && <img key={String(page.page)} className="jm-single" src={pageSrc(page)} alt={imageName(page)} crossOrigin="anonymous" onLoad={(e) => applyScramble(e.currentTarget, albumId, scrambleId)} onError={onImgError} />}
        <div className="row"><button disabled={current <= 1} onClick={() => jumpTo(current - 1)}>上一页</button><button disabled={current >= total} onClick={() => jumpTo(current + 1)}>下一页</button></div>
        {overlays}
      </div>
    );
  }

  return (
    <div className="reader-wrap" ref={rootRef}>
      {toolbar}
      <h2 className="reader-title">{title}</h2>
      <div className="reader-cont">{pageUrls.map((p) => renderPage(p))}</div>
      <div className="row"><button onClick={() => jumpTo(1)}>回到开头</button><span className="muted">竖屏连续阅读：滚轮 / 空格翻页，拖动右侧圆点跳页</span></div>
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
