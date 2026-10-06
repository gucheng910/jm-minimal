import { APP_VERSION, AUTO_SELECT_TTL_MS, CONTENT_SECRET, FALLBACK_SHUNT_KEYS, HEAL_COOLDOWN_MS, LINE_FAIL_STREAK, LINE_PROBE_ROUNDS, TOKEN_SECRET, UI_KEYS } from "./constants";
import { aesEcbDecrypt, md5Hex } from "./crypto";
import { API_PATHS } from "./endpoints";
import { measureImages, pickFastestSource, type SpeedSample } from "./speed";
import { chooseLine, loadHostConfig } from "./host";
import { getMemCache, invalidatePath, makeKey, setMemCache } from "./requestCache";
import { bookIdOf, mergeBookMeta, rememberSeries } from "./series";
import { emit } from "./bus";
import { sessionStore } from "./storage";
import { registerDnsHosts } from "./dnsClean";
import { fetchWithTimeout } from "./fetchTimeout";
import type {
  AlbumDetail,
  AlbumSummary,
  ApiEnvelope,
  CategoriesPayload,
  DailyPayload,
  FavoritePayload,
  FavoriteToggleResult,
  ForumPayload,
  HostConfig,
  MemberInfo,
  PaymentPayload,
  ReadPayload,
  SearchResult,
  SettingConfig,
  TaskPayload,
  WatchHistoryPayload,
  AdSlotGroup,
  WeekFilterPayload,
  WeekPayload
} from "./types";

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: Query;
  json?: boolean;
  timeoutMs?: number;
  retries?: number;
  /** 登录等场景：不携带本地旧 Authorization/Cookie（避免服务端不签发新 token） */
  noAuth?: boolean;
  /** 登录/重登等场景：401 时不触发自动 relogin（防递归） */
  noRelogin?: boolean;
  /** 仅对参数稳定、变化慢的只读接口启用（毫秒）；如 getCategories/getWeek/getHotTags */
  cacheTtlMs?: number;
  /** 强制使用指定线路域名（解密失败自动换线 fallback 用） */
  host?: string;
  /**
   * 该请求是否可以安全重发（幂等）。
   * 默认：GET = true，其它方法 = false。
   *
   * 为什么必须显式区分：POST 打到的是写接口（收藏 / 购买 / 签到 / 发评论 / 兑换）。
   * 一次「失败」可能只是**响应**没回来，服务端其实已经受理并执行了；
   * 此时自动重发就是重复扣币、重复提交。用户手动再点一次是可见的重试，
   * 静默重发不是 —— 所以非幂等请求一律只发一次，除非调用方明确声明它幂等（如登录）。
   */
  idempotent?: boolean;
}

/** 请求失败原因分类。用属性标记而不是 Error 子类：`String(err)` 的文案必须保持不变（UI 直接展示它）。 */
type JmErrorKind = "business" | "network" | "timeout" | "decrypt";
type JmError = Error & { jmKind?: JmErrorKind };

function markError(err: Error, kind: JmErrorKind): JmError {
  (err as JmError).jmKind = kind;
  return err as JmError;
}

function kindOf(err: unknown): JmErrorKind | undefined {
  return err instanceof Error ? (err as JmError).jmKind : undefined;
}

/** 服务端已经答复（`code !== 200`）——请求确实到达并被执行过，任何情况下都不得自动重发。 */
function businessError(env: ApiEnvelope): JmError {
  return markError(new Error("api error code=" + env.code + (env.msg ? "：" + env.msg : "")), "business");
}

const AD_PATHS = ["ad_content_all", "advertise_all"];

/** 单调时钟（毫秒）：测速只用它，系统时间被改也不会算出负耗时 */
function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/** 与阅读器同样的 [jmd] 前缀：Android release 包的 WebView console 会进 logcat，便于真机排障 */
function jlogApi(...args: unknown[]): void {
  try { console.log("[jmd]", ...args); } catch { /* ignore */ }
}

/** 图源预检的 HEAD 超时：只判"这个图床给不给这张图"，不需要等正文下完。放 4s 是因为
 *  它挡在首屏前面——超时就认为这个图床不可用，由镜像池兜底，不让用户干等。 */
const SOURCE_HEAD_TIMEOUT_MS = 4000;
/** 镜像池实测取图的超时（只在当前图床不可用时才走到这里） */
const SOURCE_PROBE_TIMEOUT_MS = 6000;
/** 图床镜像池缓存时长：hosts 不会每秒变，进几次阅读器不该反复问 /setting */
const HOST_POOL_TTL_MS = 10 * 60 * 1000;

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

/** 取 URL 的路径 + query：换图床时只换 host，保留原路径与签权参数 */
function pathOf(url: string): string {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return ""; }
}

/** 只换主机、保留路径与 query（同一套 /media/photos 路径在镜像池各图床上是同一份内容） */
function swapHostKeepPath(url: string, host: string): string {
  try { const u = new URL(url); u.hostname = host; return u.toString(); } catch { return url; }
}

/**
 * 图床探针路径：**必须用真实正文图**，不是 /media/logo/new_logo.png。
 *
 * 为什么（2026-09-30 实测，见 jm-probe/JM加载慢-问题总结.md §3）：
 *  · logo 是静态文件，CDN 边缘直吐；正文图要走回源 + 解密，两者排名会整体错位
 *    —— key=2 的 logo 探针 2340ms 而正文只要 226ms（差 10 倍），
 *    express 的 logo 716ms 而正文 3843ms（差 17 倍，"官方源全挂时兜底到 express"那条路会让整本阅读卡死）。
 *  · 用 logo 挑源 = **主动避开正文最快的源**，并且会把"只能出 logo 不能出正文"的源判成可用。
 */
const PROBE_PHOTO_PATHS = ["/media/photos/400222/00001.webp"];
const PROBE_LOGO_PATH = "/media/logo/new_logo.png";

/**
 * 校验一个图床域名是否真能出**正文图**。
 * 用 <img> 真实解码而不是 fetch（no-cors 的 fetch 对 403/404 也会 resolve，会把"连得上但不给图"误判为可用）。
 * 用途：setting 里给的图床在部分网络下是死的，光信它就会一直"线路通、封面全白"。
 *
 * 正文路径整体取不到（样例图册被删等）时才退回 logo 复检——那时是"路径没了"而不是"图床死了"，
 * 退回旧判据总好过把可用图床判死。复检超时故意给得短：它只需要分辨 404 与"连不上"。
 */
async function imageHostOk(host: string, timeoutMs: number): Promise<boolean> {
  const h = String(host || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!h) return false;
  for (const path of PROBE_PHOTO_PATHS) {
    const samples = await measureImages(
      [{ label: "check", url: "https://" + h + path + "?t=" + Date.now() }],
      timeoutMs
    );
    if (samples.some((s) => s.ok)) return true;
  }
  const fallback = await measureImages(
    [{ label: "check", url: "https://" + h + PROBE_LOGO_PATH + "?t=" + Date.now() }],
    Math.min(timeoutMs, 1500)
  );
  return fallback.some((s) => s.ok);
}

export class JMClient {
  apiBase = "";
  private selecting: Promise<boolean> | null = null;
  /** 测速是否正在跑（与 selecting 不同：selecting 兑现后仍非空，用它可以区分"在跑"与"跑完过"） */
  private selectingBusy = false;
  /** >0 表示当前处于测速/探测流程内部，期间的失败不计入线路劣化（见 noteLineFailure） */
  private probing = 0;
  /** 连续网络层失败次数（业务错误码 / 服务端已答复不计） */
  private netFailStreak = 0;
  private lastHealAt = 0;
  /** 图床镜像池缓存 + 上次预检选中的图床（下次预检优先试它） */
  private hostPool: { at: number; hosts: string[] } = { at: 0, hosts: [] };
  private preferredHost = "";
  private initPromise: Promise<string> | null = null;
  /** relogin 单飞锁：并发 401 只触发一次登录 */
  private reloginPromise: Promise<MemberInfo | null> | null = null;
  /** 同秒 Token 签名 MD5 缓存 + 解密密钥记忆 */
  private md5Cache = new Map<string, string>();
  private decryptHitSecret: string | null = null;
  hostConfig: HostConfig | null = null;
  setting: SettingConfig | null = null;
  express = false;
  imageShunt = (() => {
    try { return sessionStorage.getItem("imageSource") || "1"; }
    catch { return "1"; }
  })();

  async init(excludeLine = "線路5"): Promise<string> {
    if (this.apiBase) return this.apiBase;
    if (!this.initPromise) {
      this.initPromise = this.doInit(excludeLine).catch((err) => {
        this.initPromise = null; // 允许失败后重试
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInit(excludeLine: string): Promise<string> {
    const host = await loadHostConfig();
    this.hostConfig = host;
    // 桌面端：把官方线路域名注册进内置 DNS 清洗池（早于任何业务请求）
    registerDnsHosts(host.jm3_Server.map(([h]) => h));
    const hostName = chooseLine(host, excludeLine);
    this.apiBase = "https://" + hostName + "/";
    sessionStore.apiUrl = this.apiBase;
    return this.apiBase;
  }

  selectLine(hostOrBase: string) {
    // 统一强制 https：拒绝 http 混合内容（页面 https → 请求 http 会被浏览器拦截）
    let base = hostOrBase.trim();
    if (!/^https?:\/\//i.test(base)) base = "https://" + base;
    if (!base.startsWith("https://")) base = "https://" + base.replace(/^https?:\/\//i, "");
    base = base.replace(/\/+$/, "") + "/";
    this.apiBase = base;
    sessionStore.apiUrl = this.apiBase;
    // 通知外壳同步“当前线路”显示（自动测速/手动切换都走这里）
    if (typeof window !== "undefined") {
      emit("jm:lineChanged");
    }
  }

  setImageShunt(key: string | number) {
    this.imageShunt = String(key);
    this.express = String(key) === "0";
    try { sessionStorage.setItem("imageSource", this.imageShunt); } catch { /* ignore */ }
  }


  /** 恢复上次最优选择（6h 内直连，跳过启动测速）；成功返回 true */
  async restoreBestSelection(): Promise<boolean> {
    try {
      const raw = localStorage.getItem(UI_KEYS.autoSelectCache);
      if (!raw) return false;
      const saved = JSON.parse(raw) as { host?: string; shunt?: string; imgHost?: string; ts?: number };
      if (!saved.host || !saved.shunt || !saved.ts) return false;
      if (Date.now() - saved.ts > AUTO_SELECT_TTL_MS) return false;
      // 记忆里的图床可能已经失效（官方换源 / 代理挂掉）：先验一张图，坏了就走完整测速。
      // 不验的话恢复出来的正是"线路能通、封面全白"那种状态（老设备冷启动白封面十几秒的根因）
      if (saved.imgHost && !(await imageHostOk(saved.imgHost, 4000))) return false;
      // express(0) 不再作为自动选优结果（正文图被 CDN 重置，见 runAutoSelect 注释）：
      // 旧缓存里还是 0 就判无效，重新测速挑一个官方源，避免"封面能出、正文全黑"。
      if (String(saved.shunt) === "0") return false;
      this.selectLine(saved.host);
      this.setImageShunt(saved.shunt);
      await this.getSetting();
      return true;
    } catch {
      return false;
    }
  }

  private saveBestSelection() {
    try {
      localStorage.setItem(UI_KEYS.autoSelectCache, JSON.stringify({
        host: this.apiBase.replace(/^https?:\/\//, "").replace(/\/$/, ""),
        shunt: this.imageShunt,
        imgHost: String(this.setting?.img_host || ""),
        ts: Date.now()
      }));
    } catch { /* ignore */ }
  }

  /** 启动自动选优：并发测速官方线路 + 各图源图床，应用最快线路与图源（每次会话只执行一次）。返回是否有可用线路/图源 */
  autoSelectBest(): Promise<boolean> {
    if (!this.selecting) {
      this.selecting = this.runAutoSelect()
        .catch(() => false)
        .then((ok) => {
          // 全失败时不缓存，允许稍后重试（老设备/弱网冷启动第一次很容易全超时：
          // 修之前失败结果会被永久缓存，整个会话只能一直用默认图源 1 —— 封面全部加载不出来的根因之一）
          if (!ok) this.selecting = null;
          return ok;
        });
    }
    return this.selecting;
  }

  private async runAutoSelect(): Promise<boolean> {
    // 测速期间不计入"线路劣化"（这里的失败是"正在比较各条线路"，不代表当前线路坏了），
    // 否则弱网下一轮测速就能把自己的自愈触发起来
    this.probing += 1;
    this.selectingBusy = true;
    try {
      return await this.runAutoSelectInner();
    } finally {
      this.probing -= 1;
      this.selectingBusy = false;
    }
  }

  private async runAutoSelectInner(): Promise<boolean> {
    const servers = this.hostConfig?.jm3_Server || [];
    if (servers.length === 0) return false;
    // 图源清单来自 setting：没就绪时只有 express 一个候选源，测不出东西就只能停在死图床
    if (!this.setting) { try { await this.getSetting(); } catch { /* 尽力而为 */ } }
    // 1) 线路测速：真实业务接口 /setting + 每线多轮取中位数（见 measureLines 的实测依据）
    const lineSamples = await this.measureLines(servers.map(([host]) => host));
    // 线路没有 express 概念（tag 就是主机名，不会是 "0"），这里等价于"最快的可用线路"
    const bestLine = pickFastestSource(lineSamples);
    let anyOk = false;
    if (bestLine) {
      this.selectLine(String(bestLine.tag || ""));
      anyOk = true;
    }
    // 2) 图源图床测速（快速通道 + 官方图源1..N）
    const keys: string[] = ["0"];
    for (const s of this.setting?.app_shunts || []) {
      const k = String(s.key ?? "");
      if (k && !keys.includes(k)) keys.push(k);
    }
    // 兜底表只在 setting 没给出任何图源时补位：那时没有别的候选源可测。
    // setting 正常时不再并上它——那会为不存在的 key 多发 N 次 /setting，全压在冷启动上。
    if (keys.length <= 1) {
      for (const k of FALLBACK_SHUNT_KEYS) { if (!keys.includes(k)) keys.push(k); }
    }
    const hostByKey = await Promise.all(keys.map(async (key) => {
      let host = "";
      try { host = await this.probeImageHost(key); } catch { host = ""; }
      host = host.replace(/^https?:\/\//, "");
      if (!host && key === "0") host = "cn-ms.jmapiproxy2.cc";
      return { key, host };
    }));
    // 用真实正文图（<img> 解码）测速，理由见 PROBE_PHOTO_PATHS：
    // logo 探针会主动避开正文最快的源，还会把"只能出 logo 不能出正文"的源判成可用。
    const okHosts = new Set<string>();
    const samples = await this.measureShuntHosts(hostByKey);
    for (const s of samples) { if (s.ok) okHosts.add(s.url.replace(/^https?:\/\//, "").split("/")[0]); }
    // 官方正常图源优先于 express（0）。实测（小米 4W / 2026-09-11）：express 图床（cn-ms.*）
    // 对 /media/logo/new_logo.png 返回 200，对正文 /media/photos/*.webp 直接 ERR_CONNECTION_RESET。
    // 只按"能不能出图 + 快不快"挑，express 必然胜出 → 封面正常、整本正文全黑。
    // 所以：官方源里有任何一个可用就不用 express，express 只在官方源全挂时兜底。
    // 选源规则收在 core/speed.pickFastestSource：官方源优先于 express（0），按 tag 精确取 key，
    // 不再用 host 反查（host 带尾斜杠/重复时反查会失败或串行）
    const bestImg = pickFastestSource(samples, "0");
    if (bestImg && bestImg.tag !== undefined) { this.setImageShunt(String(bestImg.tag)); anyOk = true; }
    // 3) 用选定线路 + 图源刷新配置（图床随之更新），并记住本次最优选择
    await this.getSetting().catch(() => { /* ignore */ });
    // 3.5) 图床兜底：setting 给出的 img_host 在部分网络下是死的，
    //      光信它就会一直"线路通、封面全白"。测速已经验过的源里换一个真能出图的。
    const applied = String(this.setting?.img_host || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (applied && !okHosts.has(applied) && !(await imageHostOk(applied, 4000))) {
      const alt = hostByKey.find((p) => p.host && p.host !== applied && p.key !== "0" && okHosts.has(p.host))
        || hostByKey.find((p) => p.host && p.host !== applied && okHosts.has(p.host));
      if (alt) {
        this.setImageShunt(alt.key);
        await this.getSetting().catch(() => { /* ignore */ });
        anyOk = true;
      }
    }
    // 只有真正选到可用线路/图源才写缓存：否则会把"全失败时的默认值"当成最优存下来，
    // 之后 restoreBestSelection 会把死图源直接恢复回来（2026-09-11 老设备封面全白的另一半原因）
    if (anyOk) this.saveBestSelection();
    return anyOk;
  }

  /**
   * 线路测速：每线 LINE_PROBE_ROUNDS 轮**真实 /setting**，取中位数。返回可直接喂 pickFastestSource 的样本。
   *
   * 两处都是实测结论（见 jm-probe/JM加载慢-问题总结.md §2）：
   *  · 单次采样在 ±200ms 抖动面前就是抽签：p50 只差 37ms 的两条线路，单轮差值能在 4~132ms 之间翻，
   *    20 轮模拟里选中最优的正确率只有 30%；而选错的代价被 TTL 放大成好几十分钟。
   *  · 测速对象不能用 /static/jmapp3apk/version.json：静态文件是 CDN 边缘直吐、不需要回源，
   *    与业务接口的排名会整体错位（实测某线路 version.json 排名第 1、/setting 实测最慢）。
   *    所以这里直接打业务路径、并带上 Token 签名（与业务请求同一条链路，含服务端解密）。
   */
  private async measureLines(hosts: string[]): Promise<SpeedSample[]> {
    const times = new Map<string, number[]>();
    for (let round = 0; round < LINE_PROBE_ROUNDS; round++) {
      // 同一轮内所有线路并发（串行会把"并发"的差别算进单线耗时）
      const one = await Promise.all(hosts.map(async (host) => ({ host, ms: await this.probeLineOnce(host) })));
      for (const r of one) {
        if (r.ms === null) continue;
        const arr = times.get(r.host);
        if (arr) arr.push(r.ms); else times.set(r.host, [r.ms]);
      }
    }
    const out: SpeedSample[] = hosts.map((host) => {
      // 只按成功的轮次算中位数：超时/失败不参与，否则一次超时会把一条好线路判死
      const arr = (times.get(host) || []).slice().sort((a, b) => a - b);
      const ok = arr.length > 0;
      return {
        label: host,
        tag: host,
        url: "https://" + host + "/" + API_PATHS.setting,
        ms: ok ? arr[Math.floor(arr.length / 2)] : 0,
        ok
      };
    });
    return out.sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : a.ok ? -1 : 1));
  }

  /** 单次线路探测：强制指定线路打业务接口，失败返回 null（不重试、不缓存） */
  private async probeLineOnce(host: string): Promise<number | null> {
    const t0 = nowMs();
    try {
      await this.request<SettingConfig>(
        API_PATHS.setting,
        { app_img_shunt: this.imageShunt, t: Math.floor(Date.now() / 1000) },
        // host 指定线路 → request() 的"解密失败换线"兜底不会介入，测到的就是这条线的时间
        { host, retries: 1, timeoutMs: 8000, cacheTtlMs: 0 }
      );
    } catch {
      return null;
    }
    return Math.round(nowMs() - t0);
  }

  /**
   * 图床测速：对每个候选图床用**真实正文图**探测（见 PROBE_PHOTO_PATHS）。
   * 正文路径整体取不到时退回 logo 复测一遍——那时是"样例图册没了"而不是"所有图床都挂了"，
   * 退回旧判据只是回到改动前，总好过测不出源、把会话钉在默认图床上。
   */
  private async measureShuntHosts(hostByKey: Array<{ key: string; host: string }>): Promise<SpeedSample[]> {
    const usable = hostByKey.filter((p) => p.host);
    if (usable.length === 0) return [];
    const stamp = String(Date.now());
    const probe = (path: string) => measureImages(
      usable.map((p) => ({ label: p.key, url: "https://" + p.host + path + "?t=" + stamp, tag: p.key })),
      6000
    );
    for (const path of PROBE_PHOTO_PATHS) {
      const samples = await probe(path);
      if (samples.some((s) => s.ok)) return samples;
    }
    return probe(PROBE_LOGO_PATH);
  }

  /**
   * 线路劣化自愈：连续 LINE_FAIL_STREAK 次**网络层**失败（业务错误码、服务端已答复的不算）就重测一次。
   * 触发在请求的 catch 里，所以必须是非阻塞的：调用方那次请求照常失败返回，
   * 换到的新线路/图源由 selectLine 的 jm:lineChanged 与 getSetting 的 jm:setting 驱动 UI 刷新。
   */
  private noteLineFailure(): void {
    this.netFailStreak += 1;
    if (this.netFailStreak < LINE_FAIL_STREAK) return;
    this.netFailStreak = 0;
    const now = Date.now();
    if (this.selectingBusy || now - this.lastHealAt < HEAL_COOLDOWN_MS) return;
    this.lastHealAt = now;
    // 正常路径下 autoSelectBest 每次会话只跑一次（selecting 兑现后仍非空），自愈必须显式放行它
    this.selecting = null;
    void this.autoSelectBest().catch(() => false);
  }

  /** 探测指定图源 key 的图床地址（只读，不改变当前图源） */
  async probeImageHost(key: string | number): Promise<string> {
    const cfg = await this.request<SettingConfig>(API_PATHS.setting, {
      app_img_shunt: String(key),
      t: Math.floor(Date.now() / 1000)
    });
    const host = String(cfg?.img_host || "");
    registerDnsHosts([host]); // 桌面端：该图床域名注册进清洗池（探测即注册）
    return host;
  }

  finishFastTrack() {
    if (!this.express) return;
    this.express = false;
    this.imageShunt = "1";
    try { sessionStorage.setItem("imageSource", "1"); } catch { /* ignore */ }
  }

  private md5Cached(input: string): string {
    let h = this.md5Cache.get(input);
    if (!h) {
      h = md5Hex(input);
      if (this.md5Cache.size > 64) this.md5Cache.clear();
      this.md5Cache.set(input, h);
    }
    return h;
  }

  buildHeaders(ts: string, noAuth = false): Record<string, string> {
    const headers: Record<string, string> = {
      Tokenparam: ts + "," + APP_VERSION,
      Token: this.md5Cached(ts + TOKEN_SECRET)
    };
    if (!noAuth) {
      const token = sessionStore.token;
      if (token) headers.Authorization = "Bearer " + token;
      const info = sessionStore.memberInfo;
      if (info && info.s) headers.Cookie = "AVS=" + info.s;
    }
    return headers;
  }

  private decryptPayload<T>(ts: string, urlPath: string, env: ApiEnvelope): T {
    if (env == null || typeof env.data !== "string") return env?.data as T;
    const isAd = AD_PATHS.some((p) => urlPath.includes(p));
    const base = [TOKEN_SECRET, CONTENT_SECRET];
    // 上次成功的密钥优先，减少平均解密尝试次数
    const secrets = this.decryptHitSecret ? [this.decryptHitSecret, ...base.filter((s) => s !== this.decryptHitSecret)] : base;
    for (const secret of secrets) {
      const key = this.md5Cached(isAd ? secret : ts + secret);
      try {
        const plain = aesEcbDecrypt(env.data, key);
        const parsed = JSON.parse(plain) as T;
        this.decryptHitSecret = secret;
        return parsed;
      } catch {
        // try next key
      }
    }
    throw markError(new Error("api decrypt failed"), "decrypt"); // 不再静默返回密文（调用方会误判为空）
  }

  private cleanQuery(params?: Query): Query {
    const out: Query = {};
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== null && v !== undefined && v !== "") out[k] = v;
    }
    if (!("lang" in out)) out.lang = sessionStore.lang || "TW";
    return out;
  }

  /**
   * 自动续期：仅当本地记住账号且业务请求返回 401/403 时，单飞登录一次后重发。
   * login 自身带 noRelogin（防递归）；每个请求最多触发一次（attempt===0）。
   */
  private autoRelogin(): Promise<MemberInfo | null> {
    if (this.reloginPromise) return this.reloginPromise;
    this.reloginPromise = this.doAutoRelogin().finally(() => { this.reloginPromise = null; });
    return this.reloginPromise;
  }

  private async doAutoRelogin(): Promise<MemberInfo | null> {
    const account = sessionStore.account;
    if (!account) return null;
    try {
      const data = await this.request<MemberInfo & { jwttoken?: string }>(
        API_PATHS.login,
        { username: account.username, password: account.password },
        // 登录是幂等的（重复登录只是再签发一次会话），允许重试：续期失败会让整个会话掉线
        { method: "POST", noAuth: true, noRelogin: true, idempotent: true }
      );
      if (!data.jwttoken) return null;
      sessionStore.saveAuth(data.jwttoken, data as MemberInfo);
      sessionStore.account = { username: account.username, password: account.password };
      return data as MemberInfo;
    } catch {
      // 重登失败不清理本地会话：保留旧 token，等待用户手动刷新，避免无故登出
      return null;
    }
  }

  async request<T>(apiPath: string, params?: Query, options: RequestOptions = {}): Promise<T> {
    if (!this.apiBase) throw new Error("API base 未初始化，请先调用 init()");
    const method = options.method || "GET";
    /** 幂等请求才允许自动重发；非幂等（默认所有非 GET）只发一次 */
    const idempotent = options.idempotent ?? method === "GET";
    const maxAttempts = Math.max(1, options.retries ?? (idempotent ? 3 : 1));
    const timeoutMs = options.timeoutMs ?? 15000;
    const cacheTtl = method === "GET" ? options.cacheTtlMs || 0 : 0;
    let lastErr: unknown = null;
    /** 401 续期后的重发次数：它是「换张证再试一次」，不消耗网络重试预算（否则预算=1 时会空手退出） */
    let authReplayLeft = 1;

    // 内存缓存命中（只读、参数稳定的接口）
    if (cacheTtl > 0) {
      const q = this.cleanQuery(params);
      const key = makeKey(apiPath, q as Record<string, unknown>);
      const hit = getMemCache<T>(key);
      if (hit !== null) return hit;
    }

    const baseUrl = options.host ? "https://" + options.host + "/" : this.apiBase;
    // attempt 只在「真正再赌一次网络」时自增（见下方 catch）；401 续期后的重发不占预算
    for (let attempt = 0; attempt < maxAttempts;) {
      const ts = String(Math.floor(Date.now() / 1000));
      const url = new URL(apiPath, baseUrl);
      const headers = this.buildHeaders(ts, Boolean(options.noAuth));
      let body: BodyInit | null = null;

      if (method === "GET") {
        const q = this.cleanQuery(params);
        for (const [k, v] of Object.entries(q)) url.searchParams.set(k, String(v));
      } else if (options.json) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(params || {});
      } else {
        const form = new FormData();
        for (const [k, v] of Object.entries(params || {})) {
          if (v !== null && v !== undefined) form.append(k, String(v));
        }
        body = form;
      }

      try {
        // credentials 始终 include：登录响应也可能 Set-Cookie（如 PHPSESSID），
        // 登录/重登的 noAuth 不再 omit，避免丢失服务端会话 Cookie。
        // 超时走 fetchWithTimeout：老内核没有 AbortController 时自动退化为 Promise.race。
        const resp = await fetchWithTimeout(url.toString(), {
          method,
          headers,
          body,
          credentials: "include",
          referrerPolicy: "no-referrer"
        }, timeoutMs);
        const text = await resp.text();
        let env: ApiEnvelope;
        try {
          env = JSON.parse(text) as ApiEnvelope;
        } catch {
          // 响应非 JSON（HTML 错误页 / 502 网关 / CORS 拒绝等）
          const status = resp.status;
          throw new Error("api parse failed: status=" + status + " body=" + (text.slice(0, 80) || "(empty)"));
        }
        if (env.code !== 200) {
          // 自动续期：仅业务请求（非 noAuth/noRelogin）触发一次，且**不消耗网络重试预算**
          if (authReplayLeft > 0 && !options.noAuth && !options.noRelogin && env.code === 401) {
            const rel = await this.autoRelogin();
            if (rel) { authReplayLeft -= 1; continue; } // 用新 token 重发，attempt 不变
          }
          throw businessError(env);
        }
        const result = this.decryptPayload<T>(ts, apiPath, env);
        // 任意一话的 /album 都带回整本书的 series[]：顺手种入「话 → 书」映射（足迹/缓存合并用）
        if (apiPath === API_PATHS.album && result && typeof result === "object" && !Array.isArray(result) && "id" in (result as object)) {
          rememberSeries(result as unknown as AlbumDetail);
        }
        if (cacheTtl > 0) {
          const q = this.cleanQuery(params);
          setMemCache(makeKey(apiPath, q as Record<string, unknown>), result, cacheTtl);
        }
        // 这一次请求走通了当前线路：清掉劣化计数（连续失败要求是"连着的"）
        this.netFailStreak = 0;
        return result;
      } catch (caught) {
        // 网络错误打上 [network] 标记（区别于业务 api error），便于 UI 提示「检查网络或线路」。
        // 注意不要给 catch 参数重新赋值（no-ex-assign）：另起一个局部量，语义更清楚。
        let err: unknown = caught;
        if (kindOf(err) === undefined && err instanceof TypeError && !(err instanceof DOMException)) {
          err = markError(new TypeError("[network] " + (err.message || "fetch failed")), "network");
        } else if (kindOf(err) === undefined && err instanceof DOMException && err.name === "AbortError") {
          err = markError(new DOMException("[timeout] 请求超时", "AbortError"), "timeout");
        }
        lastErr = err;
        const kind = kindOf(err);
        // 线路劣化自愈：连续多次**网络层**失败（不是业务错误码）说明当前线路节点在抽风，
        // 后台重测一次换线。测速/探测自身的失败不算（options.host 或 probing>0），否则会自激。
        if (this.probing === 0 && !options.host && (kind === "network" || kind === "timeout")) this.noteLineFailure();
        // 解密失败说明命中异常节点：跳出本线重试循环，交给线路级 fallback
        if (kind === "decrypt") break;
        // 服务端已经答复过（业务错误码）：请求确实被执行了，绝不重发
        if (kind === "business") break;
        // 非幂等请求：网络层失败也不自动重发（见 RequestOptions.idempotent 的说明）
        if (!idempotent) break;
        const retryable = kind === "timeout" || kind === "network";
        attempt += 1;
        if (!retryable || attempt >= maxAttempts) break;
        // 网络类错误指数退避 + 抖动
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 5000) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    // 线路级 fallback：当前线路节点异常时依次尝试其它官方线路
    if (!options.host && this.hostConfig && lastErr instanceof Error && lastErr.message === "api decrypt failed") {
      for (const [altHost] of this.hostConfig.jm3_Server) {
        if (altHost === options.host || !altHost) continue;
        try {
          return await this.request<T>(apiPath, params, { ...options, host: altHost, retries: 1, cacheTtlMs: 0 });
        } catch { /* 下一线路 */ }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async getSetting(): Promise<SettingConfig> {
    const cfg = await this.request<SettingConfig>(API_PATHS.setting, {
      app_img_shunt: this.imageShunt,
      t: Math.floor(Date.now() / 1000)
    });
    this.setting = cfg;
    // 桌面端：当前图床域名注册进清洗池（封面/正文镜像请求随之受益）
    registerDnsHosts([cfg.img_host as string | undefined]);
    // 图床配置就绪通知：封面等依赖 img_host 的渲染可据此刷新
    if (typeof window !== "undefined") {
      emit("jm:setting");
    }
    return cfg;
  }

  getPayment(): Promise<PaymentPayload> {
    return this.request<PaymentPayload>(API_PATHS.payment, {});
  }

  /**
   * POST 表单。**默认不重发**（写接口：收藏/购买/签到/评论/兑换）。
   * 只有确认服务端重复执行无害时，调用方才传 `{ idempotent: true }`。
   */
  postForm<T>(apiPath: string, params?: Query, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(apiPath, params, { method: "POST", ...options });
  }

  getLatest(): Promise<AlbumSummary[]> {
    return this.request<AlbumSummary[]>(API_PATHS.latest, {});
  }

  /** order：列表排序（o 参数），实测 "" 最新 / mv 最多点击 / mp 最多图片 / tf 最多爱心 均有效 */
  search(query: string, page = 1, mainTag = 0, searchType = "site", order = ""): Promise<SearchResult> {
    return this.request<SearchResult>(API_PATHS.search, {
      search_query: query,
      page,
      main_tag: mainTag,
      search_type: searchType,
      o: order
    });
  }

  getHotTags(): Promise<string[]> {
    // 热词随请求轮换，不做内存缓存；短超时快失败，避免 UI 长时间空等
    return this.request<string[]>(API_PATHS.hotTags, {}, { timeoutMs: 8000, retries: 2 });
  }

  getAlbum(id: number | string): Promise<AlbumDetail> {
    // 短期内存缓存（30s）：同漫画反复进出详情页无需重复请求
    return this.request<AlbumDetail>(API_PATHS.album, { id }, { cacheTtlMs: 30_000 });
  }

  /**
   * 购买后强制重取详情（绕过 30s 内存缓存）。
   *
   * 为什么必须强制：`/album` 有 30s 内存缓存，购买成功那一刻缓存里还是**购买前**的快照
   * （purchased = 未购形态）。直接重拉会命中它，UI 于是永远切不到"已解锁"，
   * 重进详情只要还在 30s 内也一样 —— 真机反馈的"付款后按钮不变、从列表重进依旧"就是这个。
   * 先失效再取，语义上等于"这次我要服务端的当前真相"。
   */
  async refreshAlbum(id: number | string): Promise<AlbumDetail | null> {
    invalidatePath(API_PATHS.album);
    return this.getAlbumFull(id).catch(() => null);
  }

  /**
   * 详情（连载自动补书级元数据）。
   * 实测：话级 /album 的 author 为空数组、description 为空串、tags 少「韩漫/完结」，
   * 书级（id = series_id）才有。单本直接返回；连载最多多一次请求（同样 30s 内存缓存）。
   */
  async getAlbumFull(id: number | string): Promise<AlbumDetail> {
    const chapter = await this.getAlbum(id);
    const bookId = bookIdOf(chapter);
    if (bookId === String(chapter.id)) return chapter;
    const book = await this.getAlbum(bookId).catch(() => null);
    return mergeBookMeta(chapter, book);
  }

  /**
   * 取一话的阅读数据（页 URL）。默认在建请求前做一次**正文图源预检**（见 ensureReadableSource）：
   * 进阅读器时"先静默测速、通过后才开始拉正文"，避免进去一片黑还得手动换源。
   * 内部已经刚测过源的地方（阅读器换源/测速）传 { preflight: false } 跳过。
   */
  getRead(id: number | string, opts: { preflight?: boolean } = {}): Promise<ReadPayload> {
    return this.fetchRead(id).then(async (r) => {
      if (opts.preflight === false) return r;
      return (await this.ensureReadableSource(r)) || r;
    });
  }

  private fetchRead(id: number | string): Promise<ReadPayload> {
    return this.request<ReadPayload>(API_PATHS.comicRead, {
      id,
      app_img_shunt: this.imageShunt,
      express: this.express ? "on" : "off"
    });
  }

  /** 单次 HEAD：拿状态码与耗时，不下载正文（这些图床吞 Range，HEAD 是唯一近乎零流量的判据） */
  private async headOk(url: string, timeoutMs: number): Promise<boolean> {
    try {
      const resp = await fetchWithTimeout(url, { method: "HEAD", cache: "no-store", credentials: "omit" }, timeoutMs);
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * 正文图源预检（阅读器进入时用）：拿到真实页 URL 后、真正开始下图之前，确认这批 URL 真能取到图。
   *
   * 三条都是实测结论（2026-10-06，见 jm-probe）：
   *  1) 判据必须打在**真实页 URL** 上。用封面/logo 判是假的：封面走 CDN 边缘直吐、正文要回源，
   *     一个图床完全可能"封面 200、正文被重置"（express 就是活例子）。
   *  2) 这些图床吞 Range（带 Range 仍返回整图 ~170KB），所以"当前源能不能用"用 **HEAD** 判最省：
   *     实测各图床 HEAD 均 200 且 size_download=0。
   *  3) 换源不能按 key 映射到图床 —— `/setting?app_img_shunt=k` 给的 img_host 与
   *     `/comic_read?app_img_shunt=k` 返回的页 URL 主机**可以不一致**（实测已踩：按 /setting 挑的
   *     key，切过去拿到的页 URL 落在一个拉不动的 .xyz 主机上）。而同一套 `/media/photos/...` 路径
   *     在镜像池的各图床上是同一份内容（实测 7 个图床同一路径同为 200/167708B），
   *     所以正解是：**验证真实 URL → 不行就把主机换成可用的镜像图床**（路径与 t 参数不变）。
   *
   * 成本：最常见 **只发 1 次 HEAD**（~0 字节）；只有当前图床不可用时，才多发 N 次 /setting（并发，
   * 有 10 分钟缓存）+ N 次真实取图（并发）。且被选中的那张正是第 1 页，URL 完全相同 → 命中缓存不白下。
   * 找不到可用图床就原样返回 null，交给页级重试与阅读器自愈兜底。
   */
  private async ensureReadableSource(r: ReadPayload): Promise<ReadPayload | null> {
    const first = (r?.images || []).find((p) => /^https?:\/\//i.test(String(p?.image || "")));
    const pageUrl = String(first?.image || "");
    if (!pageUrl) return null;
    const curHost = hostOf(pageUrl);
    if (await this.headOk(pageUrl, SOURCE_HEAD_TIMEOUT_MS)) {
      this.preferredHost = curHost;
      return null; // 最常见的出口
    }
    const path = pathOf(pageUrl);
    jlogApi("preflight: 图床 " + curHost + " 取不到正文图，改从镜像池里挑一个");
    // 先试"上次成功过的图床"：命中就只花 1 张图的探测（重复进阅读器时最省）
    const tried = this.preferredHost && this.preferredHost !== curHost
      ? await this.probeMirrorHosts(path, [this.preferredHost])
      : [];
    const samples = tried.some((s) => s.ok) ? tried : await this.probeMirrorHosts(path, await this.candidateHosts());
    const ok = samples.filter((s) => s.ok && String(s.tag) !== curHost);
    if (ok.length === 0) {
      jlogApi("preflight: 镜像池里也没有可用图床，交给页级重试");
      return null;
    }
    const best = ok.reduce((a, b) => (b.ms < a.ms ? b : a));
    const host = String(best.tag || "");
    if (!host) return null;
    this.preferredHost = host;
    jlogApi("preflight: 正文改走 " + host + "（" + best.ms + "ms，同路径镜像）");
    return { ...r, images: r.images.map((p) => ({ ...p, image: swapHostKeepPath(String(p.image || ""), host) })) };
  }

  /** 用真实页路径（只换主机）实测一批图床：<img> 真解码，403/404 不会被当成可用 */
  private probeMirrorHosts(path: string, hosts: string[]): Promise<SpeedSample[]> {
    const list = [...new Set(hosts)].filter(Boolean);
    if (list.length === 0) return Promise.resolve([]);
    return measureImages(
      list.map((h) => ({ label: h, url: "https://" + h + path, tag: h })),
      SOURCE_PROBE_TIMEOUT_MS
    );
  }

  /** 图床镜像池：/setting?app_img_shunt=k 的 img_host 去重（10 分钟缓存，别每次进阅读器都问一遍） */
  private async candidateHosts(): Promise<string[]> {
    if (Date.now() - this.hostPool.at < HOST_POOL_TTL_MS && this.hostPool.hosts.length > 0) {
      return this.hostPool.hosts;
    }
    const keys: string[] = ["0"];
    for (const s of this.setting?.app_shunts || []) {
      const k = String(s.key ?? "");
      if (k && !keys.includes(k)) keys.push(k);
    }
    const hosts = (await Promise.all(keys.map(async (k) => {
      try { return await this.probeImageHost(k); } catch { return ""; }
    }))).map((h) => h.replace(/^https?:\/\//, "").replace(/\/+$/, "")).filter(Boolean);
    const uniq = [...new Set(hosts)];
    if (uniq.length > 0) this.hostPool = { at: Date.now(), hosts: uniq };
    return uniq;
  }

  // ---- M3 官方账务动作（全部由服务端结算） ----
  purchaseAlbum(id: number | string): Promise<unknown> {
    return this.postForm(API_PATHS.coinBuyComics, { id });
  }

  redeemAdFree(type: "day" | "month"): Promise<unknown> {
    return this.postForm(API_PATHS.adFree, { type });
  }

  buyCharge(): Promise<unknown> {
    return this.postForm(API_PATHS.coinBuyCharge, {});
  }

  /**
   * 收藏开关：官方前端就这一个 POST（入参只有 aid），**服务端自己判断是加还是删**，
   * 响应里用 type 说明结果（add / remove / edit / move）、status="ok" 表示成功。
   * 所以「取消收藏」不需要另一个接口，也不要在本地早退（原实现收藏后再也取消不掉）。
   */
  toggleFavorite(id: number | string): Promise<FavoriteToggleResult> {
    return this.postForm<FavoriteToggleResult>(API_PATHS.favorite, { aid: id });
  }

  getFavorites(): Promise<FavoritePayload> {
    return this.request<FavoritePayload>(API_PATHS.favorite, {});
  }

  getWatchHistory(): Promise<WatchHistoryPayload> {
    return this.request<WatchHistoryPayload>(API_PATHS.watchList, {});
  }

  getTasks(type = "coin", filter = "all"): Promise<TaskPayload> {
    return this.request<TaskPayload>(API_PATHS.tasks, { type, filter });
  }

  getDaily(userId: number | string): Promise<DailyPayload> {
    return this.request<DailyPayload>(API_PATHS.daily, { user_id: userId });
  }

  checkIn(userId: number | string, dailyId: number | string): Promise<unknown> {
    return this.postForm(API_PATHS.dailyCheck, { user_id: userId, daily_id: dailyId });
  }

  /** 官方广告位内容（匿名可读；解密走广告专用无时间戳密钥） */
  getAdContent(): Promise<Record<string, AdSlotGroup>> {
    return this.request<Record<string, AdSlotGroup>>("ad_content_all", {});
  }

  getForum(params?: Query): Promise<ForumPayload> {
    return this.request<ForumPayload>(API_PATHS.forum, params || {});
  }

  getAlbumComments(aid: number | string, page = 1): Promise<ForumPayload> {
    return this.getForum({ aid, page });
  }

  // ---- 发现模块：首页推荐 / 分类 / 周榜 ----
  getRandomRecommend(): Promise<AlbumSummary[]> {
    // 首页首屏请求：短超时快失败，断网时能及时给出可交互的错误提示
    return this.request<AlbumSummary[]>(API_PATHS.randomRecommend, {}, { timeoutMs: 8000, retries: 2 });
  }

  getCategories(): Promise<CategoriesPayload> {
    return this.request<CategoriesPayload>(API_PATHS.categories, {}, { cacheTtlMs: 30 * 60 * 1000 });
  }

  getCategoryAlbums(category: number | string, page = 1, order = ""): Promise<SearchResult> {
    return this.request<SearchResult>(API_PATHS.categoriesFilter, { c: category, page, o: order });
  }

  getWeek(): Promise<WeekPayload> {
    return this.request<WeekPayload>(API_PATHS.week, {}, { cacheTtlMs: 15 * 60 * 1000 });
  }

  getWeekAlbums(issueId: number | string, type: string | number, page = 1): Promise<WeekFilterPayload> {
    return this.request<WeekFilterPayload>(API_PATHS.weekFilter, { id: issueId, type, page });
  }

  sendComment(aid: number | string, content: string): Promise<unknown> {
    return this.postForm(API_PATHS.comment, { aid, content, spoiler: "0" });
  }
}

export const client = new JMClient();
