import { APP_VERSION, AUTO_SELECT_TTL_MS, CONTENT_SECRET, FALLBACK_SHUNT_KEYS, TOKEN_SECRET, UI_KEYS } from "./constants";
import { aesEcbDecrypt, md5Hex } from "./crypto";
import { API_PATHS } from "./endpoints";
import { measureAll, measureImages, pickFastestSource } from "./speed";
import { chooseLine, loadHostConfig } from "./host";
import { getMemCache, makeKey, setMemCache } from "./requestCache";
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
}

const AD_PATHS = ["ad_content_all", "advertise_all"];

/**
 * 校验一个图床域名是否真能出图。
 * 用 <img> 真实解码而不是 fetch（no-cors 的 fetch 对 403/404 也会 resolve，会把"连得上但不给图"误判为可用）。
 * 用途：setting 里给的 express 图床在部分网络下是死的，光信它就会一直"线路通、封面全白"。
 */
async function imageHostOk(host: string, timeoutMs: number): Promise<boolean> {
  const h = String(host || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!h) return false;
  const samples = await measureImages(
    [{ label: "check", url: "https://" + h + "/media/logo/new_logo.png?t=" + Date.now() }],
    timeoutMs
  );
  return samples.some((s) => s.ok);
}

export class JMClient {
  apiBase = "";
  private selecting: Promise<boolean> | null = null;
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
    const servers = this.hostConfig?.jm3_Server || [];
    if (servers.length === 0) return false;
    // 图源清单来自 setting：没就绪时只有 express 一个候选源，测不出东西就只能停在死图床
    if (!this.setting) { try { await this.getSetting(); } catch { /* 尽力而为 */ } }
    const stamp = String(Date.now());
    // 1) 线路测速
    const lineItems = servers.map(([host]) => ({ label: host, url: "https://" + host + "/static/jmapp3apk/version.json?t=" + stamp, tag: host }));
    const lineSamples = await measureAll(lineItems, servers.length);
    // 线路没有 express 概念（tag 就是主机名，不会是 "0"），这里等价于"最快的可用线路"
    const bestLine = pickFastestSource(lineSamples);
    let anyOk = false;
    if (bestLine) {
      const host = bestLine.url.replace(/^https?:\/\//, "").split("/")[0];
      this.selectLine(host);
      anyOk = true;
    }
    // 2) 图源图床测速（快速通道 + 官方图源1..N）
    const keys: string[] = ["0"];
    for (const s of this.setting?.app_shunts || []) {
      const k = String(s.key ?? "");
      if (k && !keys.includes(k)) keys.push(k);
    }
    // setting 缺失/为空时也要能换源（与官方清单取并集，去重后顺序不变）
    for (const k of FALLBACK_SHUNT_KEYS) { if (!keys.includes(k)) keys.push(k); }
    const hostByKey = await Promise.all(keys.map(async (key) => {
      let host = "";
      try { host = await this.probeImageHost(key); } catch { host = ""; }
      host = host.replace(/^https?:\/\//, "");
      if (!host && key === "0") host = "cn-ms.jmapiproxy2.cc";
      return { key, host };
    }));
    // 用真实封面图（<img> 解码）而不是 no-cors 的 logo 探测：
    // 后者对 403/404 也会 resolve，会把"连得上但不给图"的图床误判为可用（老设备封面全白就是这么来的）
    const imgItems = hostByKey
      .filter((p) => p.host)
      .map((p) => ({ label: p.key, url: "https://" + p.host + "/media/logo/new_logo.png?t=" + stamp, tag: p.key }));
    const okHosts = new Set<string>();
    if (imgItems.length > 0) {
      const samples = await measureImages(imgItems, 6000);
      for (const s of samples) { if (s.ok) okHosts.add(s.url.replace(/^https?:\/\//, "").split("/")[0]); }
      // 官方正常图源优先于 express（0）。实测（小米 4W / 2026-09-11）：express 图床（cn-ms.*）
      // 对 /media/logo/new_logo.png 返回 200，对正文 /media/photos/*.webp 直接 ERR_CONNECTION_RESET。
      // 只按"能不能出图 + 快不快"挑，express 必然胜出 → 封面正常、整本正文全黑。
      // 所以：官方源里有任何一个可用就不用 express，express 只在官方源全挂时兜底。
      // 选源规则收在 core/speed.pickFastestSource：官方源优先于 express（0），按 tag 精确取 key，
      // 不再用 host 反查（host 带尾斜杠/重复时反查会失败或串行）
      const bestImg = pickFastestSource(samples, "0");
      if (bestImg && bestImg.tag !== undefined) { this.setImageShunt(String(bestImg.tag)); anyOk = true; }
    }
    // 3) 用选定线路 + 图源刷新配置（图床随之更新），并记住本次最优选择
    await this.getSetting().catch(() => { /* ignore */ });
    // 3.5) express（快速通道）图床兜底：setting 给出的 img_host 在部分网络下是死的，
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
    throw new Error("api decrypt failed"); // 不再静默返回密文（调用方会误判为空）
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
        { method: "POST", noAuth: true, noRelogin: true }
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
    const retries = Math.max(1, options.retries ?? 3);
    const timeoutMs = options.timeoutMs ?? 15000;
    const cacheTtl = method === "GET" ? options.cacheTtlMs || 0 : 0;
    let lastErr: unknown = null;

    // 内存缓存命中（只读、参数稳定的接口）
    if (cacheTtl > 0) {
      const q = this.cleanQuery(params);
      const key = makeKey(apiPath, q as Record<string, unknown>);
      const hit = getMemCache<T>(key);
      if (hit !== null) return hit;
    }

    const baseUrl = options.host ? "https://" + options.host + "/" : this.apiBase;
    for (let attempt = 0; attempt < retries; attempt++) {
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
          // 自动续期：仅业务请求（非 noAuth/noRelogin）首个 attempt 触发一次
          if (!options.noAuth && !options.noRelogin && attempt === 0 && env.code === 401) {
            const rel = await this.autoRelogin();
            if (rel) continue; // 用新 token 重发
          }
          throw new Error("api error code=" + env.code + (env.msg ? "：" + env.msg : ""));
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
        return result;
      } catch (err) {
        // 网络错误打上 [network] 标记（区别于业务 api error），便于 UI 提示「检查网络或线路」
        if (err instanceof TypeError && !(err instanceof DOMException)) {
          err = new TypeError("[network] " + (err.message || "fetch failed"));
        } else if (err instanceof DOMException && err.name === "AbortError") {
          err = new DOMException("[timeout] 请求超时", "AbortError");
        }
        lastErr = err;
        const isDecrypt = err instanceof Error && err.message === "api decrypt failed";
        // 解密失败说明命中异常节点：跳出本线重试循环，交给线路级 fallback
        if (isDecrypt) break;
        const retryable = (err instanceof DOMException && err.name === "AbortError") || err instanceof TypeError;
        // 网络类错误指数退避 + 抖动；业务错误若仍有剩余尝试也允许重试（与旧行为一致）
        if (retryable && attempt < retries - 1) {
          const delay = Math.min(500 * Math.pow(2, attempt), 5000) + Math.random() * 200;
          await new Promise((r) => setTimeout(r, delay));
        }
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

  postForm<T>(apiPath: string, params?: Query): Promise<T> {
    return this.request<T>(apiPath, params, { method: "POST" });
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

  getRead(id: number | string): Promise<ReadPayload> {
    return this.request<ReadPayload>(API_PATHS.comicRead, {
      id,
      app_img_shunt: this.imageShunt,
      express: this.express ? "on" : "off"
    });
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
