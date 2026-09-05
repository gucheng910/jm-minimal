import { useEffect, useState } from "react";
import { useBackHandler } from "../hooks/useBackHandler";
import { cacheList, clearAllCacheTasks, pauseCache, removeCache, reDownloadCache, resumeCache, type CacheTaskMeta } from "../core/cacheTasks";
import { cachedCoverUrl, toOfflinePageUrls } from "../core/offline";
import type { ReadPage } from "../core/types";
import ReaderPanel from "../Reader";
import { pushToast } from "./toast";
import { CloseIcon } from "./icons";

interface Reading {
  id: number | string;
  title: string;
  scrambleId?: number | string;
  pages: ReadPage[];
}

function TaskCover({ task }: { task: CacheTaskMeta }) {
  const [blob, setBlob] = useState("");
  useEffect(() => {
    let alive = true;
    if (!task.cover) return;
    cachedCoverUrl(task.id, task.cover).then((u) => { if (alive) setBlob(u); });
    return () => { alive = false; };
  }, [task.id, task.cover]);
  const src = blob || (task.cover && task.cover.startsWith("http") ? task.cover : "");
  if (!src) return <div className="thumb empty">{task.title.slice(0, 1)}</div>;
  return (
    <span className="thumb-box">
      <img className="thumb" src={src} alt={task.title} onError={(e) => { e.currentTarget.style.opacity = "0"; }} />
      <span className="thumb-fallback">{task.title.slice(0, 1)}</span>
    </span>
  );
}

const STATUS_TEXT: Record<CacheTaskMeta["status"], string> = {
  queued: "排队中…",
  running: "缓存中…",
  paused: "已暂停",
  failed: "缓存失败",
  done: "已完成"
};

export default function CacheCenter({ onClose }: { onClose: () => void }) {
  const [tasks, setTasks] = useState<CacheTaskMeta[]>(cacheList);
  const [tab, setTab] = useState<"active" | "done">("active");
  const [reading, setReading] = useState<Reading | null>(null);

  useEffect(() => {
    const sync = () => setTasks(cacheList());
    window.addEventListener("jm:caches", sync);
    return () => window.removeEventListener("jm:caches", sync);
  }, []);

  // 离线阅读时进入沉浸全屏（隐藏顶栏/底栏）
  useEffect(() => {
    window.dispatchEvent(new CustomEvent<boolean>("jm:immersive", { detail: Boolean(reading) }));
    return () => { window.dispatchEvent(new CustomEvent<boolean>("jm:immersive", { detail: false })); };
  }, [reading]);

  // 系统返回键：阅读中 → 任务列表；任务列表 → 关闭缓存中心
  useBackHandler(() => {
    if (reading) setReading(null);
    else onClose();
  }, [reading, onClose]);

  if (reading) {
    return (
      <div className="cache-overlay cache-overlay-reader">
        <ReaderPanel
          albumId={reading.id}
          pages={reading.pages}
          title={reading.title}
          scrambleId={reading.scrambleId}
          offline
          onBack={() => setReading(null)}
        />
      </div>
    );
  }

  const active = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  async function openOffline(t: CacheTaskMeta) {
    const pages = await toOfflinePageUrls(t.id, t.pages);
    setReading({ id: t.id, title: t.title, scrambleId: t.scrambleId, pages });
  }

  return (
    <div className="cache-overlay">
      <div className="cache-header">
        <div>
          <h2>缓存管理</h2>
          <p className="muted">退出软件后自动停止下载；下载完成的作品可离线阅读</p>
        </div>
        <button className="ghost" aria-label="关闭" onClick={onClose}><CloseIcon size={18} /></button>
      </div>
      <div className="cache-tabs row">
        <button className={tab === "active" ? "chip active" : "chip"} onClick={() => setTab("active")}>进行中{active.length > 0 ? "（" + active.length + "）" : ""}</button>
        <button className={tab === "done" ? "chip active" : "chip"} onClick={() => setTab("done")}>已缓存{done.length > 0 ? "（" + done.length + "）" : ""}</button>
        <button className="ghost danger" onClick={async () => {
          const n = await clearAllCacheTasks();
          setTasks([]);
          pushToast(n > 0 ? "已清理全部缓存（" + n + " 个专辑）" : "没有可清理的缓存", "ok");
        }}>清理全部缓存</button>
      </div>

      {tab === "active" && (
        <div className="cache-list">
          {active.length === 0 && <p className="muted cache-empty">暂无进行中的缓存任务，可在阅读器中点「缓存」加入</p>}
          {active.map((t) => {
            const pct = t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
            return (
              <div key={t.id} className="card cache-item">
                <TaskCover task={t} />
                <div className="cache-item-main">
                  <div className="title one-line">{t.title}</div>
                  <div className="muted">{STATUS_TEXT[t.status]}{t.status === "running" || t.status === "queued" ? " · " + t.done + "/" + t.total + " 页" : ""}</div>
                  {(t.status === "queued" || t.status === "running") && (
                    <div className="progress"><div className="progress-fill" style={{ width: pct + "%" }} /></div>
                  )}
                  {t.status === "failed" && t.error && <div className="err small-err">{t.error}</div>}
                </div>
                <div className="cache-item-actions">
                  {(t.status === "running" || t.status === "queued") && <button className="ghost" onClick={() => pauseCache(t.id)}>暂停</button>}
                  {t.status === "paused" && <button className="ghost" onClick={() => resumeCache(t.id)}>继续</button>}
                  {t.status === "failed" && <button className="ghost" onClick={() => resumeCache(t.id)}>重试</button>}
                  <button className="ghost danger" onClick={async () => { await removeCache(t.id); pushToast("已删除缓存任务", "ok"); }}>删除</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === "done" && (
        <div>
          {done.length === 0 && <p className="muted cache-empty">还没有已缓存的漫画，阅读器中点「缓存」即可离线观看</p>}
          <div className="list">
            {done.map((t) => (
              <button key={t.id} className="list-item" onClick={() => openOffline(t)}>
                <TaskCover task={t} />
                <div className="title">{t.title}</div>
                <div className="muted">{String(t.author || "")}{t.category ? " · " + t.category : ""} · {t.pages.length} 页</div>
                <span className="list-ops" onClick={(e) => e.stopPropagation()}>
                  <span className="op-link" onClick={() => openOffline(t)}>离线阅读</span>
                  <span className="op-link" onClick={async () => { await reDownloadCache(t.id); pushToast("已重新加入缓存队列", "ok"); }}>重下</span>
                  <span className="op-link danger" onClick={async () => { await removeCache(t.id); pushToast("已删除缓存", "ok"); }}>删除</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
