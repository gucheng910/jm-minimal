// 菜单广告位：官方 ad_content_all 的 app_home_top 横幅；每次打开菜单轮换到下一条（不重复）
import { useEffect, useRef, useState } from "react";
import { client } from "../core/api";
import type { AdItem } from "../core/types";
import { pushToast } from "./toast";

interface Banner { img: string; link: string; title: string }

function parseEntry(a: AdItem): Banner | null {
  const html = String(a.adv_text || "");
  if (html) {
    try {
      const doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
      const linkEl = doc.querySelector("a[href]");
      const imgEl = doc.querySelector("img[src]");
      if (linkEl && imgEl) {
        return { img: imgEl.getAttribute("src") || "", link: linkEl.getAttribute("href") || "", title: String(a.adv_name || "") };
      }
    } catch { /* fallthrough */ }
  }
  const img = String(a.img || "");
  const link = String(a.link || "");
  if (img || link) return { img, link, title: String(a.adv_name || a.title || "") };
  return null;
}

function fullUrl(link: string): string {
  if (/^https?:/i.test(link)) return link;
  const base = String((client.setting && (client.setting as unknown as { main_web_host?: string }).main_web_host) || "");
  if (link.startsWith("/") && base) {
    return (base.startsWith("http") ? base.replace(/\/$/, "") : "https://" + base.replace(/\/$/, "")) + link;
  }
  return link;
}

export default function AdMenuBanner({ open }: { open: boolean }) {
  const [advs, setAdvs] = useState<Banner[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const lastIdx = useRef(-1);

  // 拉取一次并缓存全部未过期广告（后续打开只轮换，不再重复请求）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!client.apiBase) await client.init();
        const groups = await client.getAdContent();
        const grp = groups && groups.app_home_top;
        const raw = (grp && Array.isArray(grp.advs) ? grp.advs : []) as AdItem[];
        if (!alive) return;
        const now = Date.now();
        const list: Banner[] = [];
        for (const a of raw) {
          if (a.adv_expire_date) {
            const exp = new Date(String(a.adv_expire_date).replace(/-/g, "/")).getTime();
            if (!Number.isNaN(exp) && exp < now) continue;
          }
          const b = parseEntry(a);
          if (b) list.push(b);
        }
        setAdvs(list);
        setLoaded(true);
      } catch {
        if (alive) { setAdvs([]); setLoaded(true); }
      }
    })();
    return () => { alive = false; };
  }, []);

  // 每次菜单打开：顺序取下一条（与上次不同）；只有一条时保持不变
  useEffect(() => {
    if (!open || !loaded) return;
    if (advs.length === 0) { setBanner(null); return; }
    const idx = advs.length === 1 ? 0 : (lastIdx.current + 1) % advs.length;
    lastIdx.current = idx;
    setBanner(advs[idx]);
  }, [open, loaded, advs]);

  if (!loaded) return <p className="muted menu-note">广告位加载中…</p>;
  if (!banner) return <p className="muted menu-note">（官方广告位暂无内容）</p>;
  return (
    <button
      className="ad-banner"
      onClick={() => {
        const u = fullUrl(banner.link);
        if (!u) { pushToast("广告链接不可用", "err"); return; }
        window.open(u, "_blank");
      }}
    >
      <img src={banner.img} alt={banner.title || "广告"} loading="lazy" decoding="async"
        onError={(e) => { e.currentTarget.style.display = "none"; }} />
    </button>
  );
}