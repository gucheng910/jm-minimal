import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "./core/api";
import { cacheList, enqueueCache, type CacheTaskMeta } from "./core/cacheTasks";
import { releaseOfflinePageUrls } from "./core/offline";
import { measureAll } from "./core/speed";
import { pushToast } from "./ui/toast";
import { drawUnscrambled } from "./core/scramble";
import type { ReadPage } from "./core/types";

type ReaderMode = "continuous" | "single";

const MODE_KEY = "jmclient.reader.mode";

function progressKey(id: number | string): string {
  return "jmclient.read.y." + String(id);
}

interface Props {
  albumId: number | string;
  pages: ReadPage[];
  title: string;
  scrambleId?: number | string;
  onBack: () => void;
  meta?: { author?: string; category?: string; cover?: string };
  /** 离线阅读模式：隐藏图源测速/切换等在线功能 */
  offline?: boolean;
}

function imageName(p: ReadPage): string {
  if (p.name) return p.name;
  const clean = (p.image || "").split("?")[0].split("/").pop() || "";
  return clean.replace(/\.(webp|jpg|jpeg|png|gif)$/i, "");
}

function applyScramble(img: HTMLImageElement, albumId: number | string, scrambleId?: number | string) {
  if (img.dataset.scrambled) return;
  img.dataset.scrambled = "1";
  if (!scrambleId) return;
  const canvas = drawUnscrambled(img, albumId, scrambleId);
  if (canvas) {
    canvas.classList.add("scramble-canvas");
    if (img.dataset.page) canvas.dataset.page = img.dataset.page;
    img.parentElement?.insertBefore(canvas, img.nextSibling);
    img.style.display = "none";
  }
}

export default function ReaderPanel({ albumId, pages, title, scrambleId, onBack, meta, offline = false }: Props) {
  const [mode, setMode] = useState<ReaderMode>(() => {
    const saved = localStorage.getItem(MODE_KEY);
    return saved === "single" ? "single" : "continuous";
  });
  const [current, setCurrent] = useState(1);
  const [jumpInput, setJumpInput] = useState("1");
  const [task, setTask] = useState<CacheTaskMeta | undefined>(() => cacheList().find((t) => t.id === String(albumId)));
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const sync = () => setTask(cacheList().find((t) => t.id === String(albumId)));
    window.addEventListener("jm:caches", sync);
    return () => window.removeEventListener("jm:caches", sync);
  }, [albumId]);
  const [pageUrls, setPageUrls] = useState<ReadPage[]>(pages);
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
    let cancelled = false;
    if (!client.setting) {
      client.getSetting().catch(() => { /* ignore */ });
    }
    return () => { cancelled = true; };
  }, []);

  // 卸载时释放离线阅读 blob URL，防止泄漏
  useEffect(() => {
    return () => { releaseOfflinePageUrls(); };
  }, []);

  useEffect(() => {
    const key = progressKey(albumId);
    const saved = Number(localStorage.getItem(key) || 0);
    window.scrollTo(0, saved);
    const onScroll = () => {
      localStorage.setItem(key, String(window.scrollY));
      if (mode !== "continuous") return;
      const imgs = Array.from(document.querySelectorAll<HTMLElement>(".jm-page"));
      let cur = 1;
      for (const img of imgs) {
        if (img.getBoundingClientRect().top <= window.innerHeight * 0.5) cur = Number(img.dataset.page || 1);
      }
      setCurrent(cur);
      setJumpInput(String(cur));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, [albumId, mode]);

  const loadedPage = useMemo(() => pages.find((p) => Number(p.page) === current) || pages[0], [pages, current]);

  const jumpTo = useCallback((target: number) => {
    const p = Math.min(Math.max(1, target), total);
    if (mode === "continuous") {
      const el = document.getElementById("jm-pg-" + p);
      el?.scrollIntoView({ block: "start" });
    }
    setCurrent(p);
    setJumpInput(String(p));
  }, [mode, total]);

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

  async function changeSource(key: string) {
    client.setImageShunt(key);
    try {
      if (key !== "0") await client.getSetting();
      const r = await client.getRead(albumId);
      if (!r) return;
      setPageUrls(r.images);
      setJumpInput("1");
      setCurrent(1);
      pushToast(key === "0" ? "已开启快速通道" : "图源已切换", "ok");
    } catch {
      pushToast("图源切换失败，请重试", "err");
    }
  }

  /** 阅读器内测速：实测当前漫画封面对每个图源图床的下载耗时，自动切换到最快图源 */
  async function speedTestAndSwitch() {
    if (testing) return;
    setTesting(true);
    try {
      if (!client.setting) {
        try { await client.getSetting(); } catch { /* ignore */ }
      }
      const shunts = client.setting?.app_shunts || [];
      const keys: Array<{ key: string; title: string }> = [{ key: "0", title: "快速通道" }];
      for (const s of shunts) {
        const k = String(s.key ?? "");
        if (k && !keys.some((x) => x.key === k)) keys.push({ key: k, title: String(s.title || k) });
      }
      // 并发探测每个图源的图床地址（只读，不改当前图源）
      const hostMap = new Map<string, string>();
      const probes = await Promise.all(keys.map(async (k) => {
        let host = "";
        try { host = await client.probeImageHost(k.key); } catch { host = ""; }
        if (!host && k.key === "0") host = "cn-ms.jmapiproxy2.cc";
        host = host.replace(/^https?:\/\//, "");
        return { key: k.key, host };
      }));
      const items: Array<{ label: string; url: string; noCors: boolean }> = [];
      const stamp = String(Date.now());
      for (const p of probes) {
        if (!p.host) continue;
        hostMap.set(p.key, p.host);
        const label = keys.find((x) => x.key === p.key)?.title || p.key;
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
      const best = samples.find((s) => s.ok);
      if (!best) {
        pushToast("所有图源均测速失败，请检查网络后重试", "err");
        return;
      }
      const bestHost = best.url.replace(/^https?:\/\//, "").split("/")[0];
      let bestKey = keys[0].key;
      for (const [k, h] of hostMap) {
        if (h === bestHost) { bestKey = k; break; }
      }
      const bestTitle = keys.find((x) => x.key === bestKey)?.title || "图源";
      client.setImageShunt(bestKey);
      const r = await client.getRead(albumId);
      if (r) {
        setPageUrls(r.images);
        setJumpInput("1");
        setCurrent(1);
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

  async function handleCache() {
    if (!pages.length) return;
    if (task && (task.status === "queued" || task.status === "running")) {
      pushToast("该作品已在缓存队列中", "info");
      return;
    }
    if (task && task.status === "done") return;
    await enqueueCache({
      id: albumId,
      title,
      author: meta?.author,
      category: meta?.category,
      cover: meta?.cover,
      scrambleId,
      pages
    });
    pushToast("已加入缓存队列", "ok");
  }

  function renderPage(p: ReadPage) {
    return (
      <figure key={String(p.page)} id={"jm-pg-" + p.page} data-page={p.page} className="jm-figure">
        <img className="jm-page" data-page={p.page} src={p.image} alt={imageName(p)} loading="lazy" decoding="async" draggable={false} onLoad={(e) => applyScramble(e.currentTarget, albumId, scrambleId)} />
      </figure>
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
      {!offline && <button disabled={testing} onClick={speedTestAndSwitch}>{testing ? "测速中…" : "测速切换"}</button>}
      {!offline && (
        <select className="source-select" value={client.imageShunt} onChange={(e) => changeSource(e.target.value)}>
          <option value="0">快速通道</option>
          {(client.setting?.app_shunts || []).map((s) => <option key={String(s.key)} value={String(s.key)}>{String(s.title)}</option>)}
        </select>
      )}
      <button className={task && task.status === "done" ? "btn-cached" : ""} disabled={Boolean(task && (task.status === "queued" || task.status === "running" || task.status === "done"))} onClick={handleCache}>
        {task && task.status === "done" ? "已缓存" : task && (task.status === "queued" || task.status === "running") ? <span className="mono-num">{"缓存中 " + task.done + "/" + task.total}</span> : task && task.status === "failed" ? "重新缓存" : "缓存"}
      </button>
    </div>
  );

  if (mode === "single") {
    const page = loadedPage;
    return (
      <div className="reader-wrap">
        {toolbar}
        <h2 className="reader-title">{title}</h2>
        {page && <img key={String(page.page)} className="jm-single" src={page.image} alt={imageName(page)} onLoad={(e) => applyScramble(e.currentTarget, albumId, scrambleId)} />}
        <div className="row"><button disabled={current <= 1} onClick={() => jumpTo(current - 1)}>上一页</button><button disabled={current >= total} onClick={() => jumpTo(current + 1)}>下一页</button></div>
      </div>
    );
  }

  return (
    <div className="reader-wrap">
      {toolbar}
      <h2 className="reader-title">{title}</h2>
      <div className="reader-cont">{pageUrls.map((p) => renderPage(p))}</div>
      <div className="row"><button onClick={() => jumpTo(1)}>回到开头</button><span className="muted">竖屏连续阅读：滚轮/上下键/空格</span></div>
    </div>
  );
}
