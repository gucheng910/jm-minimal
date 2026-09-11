import { APP_VERSION, AUTO_SELECT_TTL_MS, CONTENT_SECRET, TOKEN_SECRET, UI_KEYS } from "./constants";
import { aesEcbDecrypt, md5Hex } from "./crypto";
import { API_PATHS } from "./endpoints";
import { measureAll } from "./speed";
import { chooseLine, loadHostConfig } from "./host";
import { getMemCache, makeKey, setMemCache } from "./requestCache";
import { bookIdOf, mergeBookMeta, rememberSeries } from "./series";
import { emit } from "./bus";
import { sessionStore } from "./storage";
import { registerDnsHosts } from "./dnsClean";
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
      const saved = JSON.parse(raw) as { host?: string; shunt?: string; ts?: number };
      if (!saved.host || !saved.shunt || !saved.ts) return false;
      if (Date.now() - saved.ts > AUTO_SELECT_TTL_MS) return false;
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
        ts: Date.now()
      }));
    } catch { /* ignore */ }
  }

  /** 启动自动选优：并发测速官方线路 + 各图源图床，应用最快线路与图源（每次会话只执行一次）。返回是否有可用线路/图源 */
  autoSelectBest(): Promise<boolean> {
    if (!this.selecting) {
      this.selecting = this.runAutoSelect().catch(() => false);
    }
    return this.selecting;
  }

  private async runAutoSelect(): Promise<boolean> {
    const servers = this.hostConfig?.jm3_Server || [];
    if (servers.length === 0) return false;
    const stamp = String(Date.now());
    // 1) 线路测速
    const lineItems = servers.map(([host]) => ({ label: host, url: "https://" + host + "/static/jmapp3apk/version.json?t=" + stamp }));
    const lineSamples = await measureAll(lineItems, servers.length);
    const bestLine = lineSamples.find((s) => s.ok);
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
    const hostByKey = await Promise.all(keys.map(async (key) => {
      let host = "";
      try { host = await this.probeImageHost(key); } catch { host = ""; }
      host = host.replace(/^https?:\/\//, "");
      if (!host && key === "0") host = "cn-ms.jmapiproxy2.cc";
      return { key, host };
    }));
    const imgItems = hostByKey
      .filter((p) => p.host)
      .map((p) => ({ label: p.key, url: "https://" + p.host + "/media/logo/new_logo.png?t=" + stamp, noCors: true }));
    if (imgItems.length > 0) {
      const samples = await measureAll(imgItems, imgItems.length);
      const bestImg = samples.find((s) => s.ok);
      if (bestImg) {
        const bestHost = bestImg.url.replace(/^https?:\/\//, "").split("/")[0];
        const pick = hostByKey.find((p) => p.host === bestHost);
        if (pick) { this.setImageShunt(pick.key); anyOk = true; }
      }
    }
    // 3) 用选定线路 + 图源刷新配置（图床随之更新），并记住本次最优选择
    await this.getSetting().catch(() => { /* ignore */ });
    this.saveBestSelection();
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

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // credentials 始终 include：登录响应也可能 Set-Cookie（如 PHPSESSID），
        // 登录/重登的 noAuth 不再 omit，避免丢失服务端会话 Cookie。
        const resp = await fetch(url.toString(), {
          method,
          headers,
          body,
          credentials: "include",
          referrerPolicy: "no-referrer",
          signal: controller.signal
        });
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
      } finally {
        clearTimeout(timer);
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
