import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { App as CapApp } from "@capacitor/app";
import { client } from "./core/api";
import { measureAll } from "./core/speed";
import type { SpeedSample } from "./core/speed";
import { sessionStore } from "./core/storage";
import { BookIcon, CheckInIcon, ClockIcon, DownloadIcon, GridIcon, HomeIcon, LightningIcon, MenuIcon, MoonIcon, SearchIcon, SunIcon, UserIcon } from "./ui/icons";
import { authService } from "./state/auth";
import ContentView from "./ContentView";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { emit, on } from "./core/bus";
import { useLoggedIn } from "./hooks/useLoggedIn";
import ToastHost, { pushToast } from "./ui/toast";
import { openGate, startupReady } from "./core/startup";
import CacheCenter from "./ui/CacheCenter";
import AdMenuBanner from "./ui/AdMenuBanner";
import UpdateSection from "./ui/UpdateSection";
import DesktopUpdate from "./ui/DesktopUpdate";
import { isDesktop } from "./core/dnsClean";
import TosModal from "./ui/TosModal";
import { REPO_URL, TOS_ACCEPTED_KEY } from "./core/tos";
import { APP_VERSION, BUILD_VARIANT, LOCAL_VERSION, UI_KEYS } from "./core/constants";
import { openExternal } from "./core/openExternal";
import LibPage from "./ui/LibPage";
import TagBlockSetting from "./ui/TagBlockSetting";
import DnsGuide from "./ui/DnsGuide";
import type { DailyPayload, MemberInfo, PaymentPayload, SettingConfig } from "./core/types";

interface DemoState {
  apiBase: string;
  setting?: SettingConfig;
  payment?: PaymentPayload;
  busy: boolean;
  error: string;
  msg: string;
}

/** 把原始错误字符串转成用户友好提示；网络类错误附加"去配 DNS"建议 */
function friendlyError(raw: string): string {
  if (/[network]|[timeout]|fetch failed|Failed to fetch|network/i.test(raw)) {
    return "网络连接失败 · 请先到会员页「DNS 加速」按指引配置 DoT 公共 DNS，配置后需删除后台重新进入 App 使设置生效，再重试（若仍失败可尝试切换线路）";
  }
  return raw;
}

function fmt(v: unknown): string { return v === null || v === undefined || v === "" ? "-" : String(v); }

/** 依据官方 daily.record 判断今天是否已签到（日期格式 "01"~"31"） */
function signedToday(daily: DailyPayload | null): boolean {
  if (!daily || !Array.isArray(daily.record)) return false;
  const today = String(new Date().getDate()).padStart(2, "0");
  for (const week of daily.record) {
    if (!Array.isArray(week)) continue;
    for (const cell of week) {
      const c = (cell || {}) as { date?: string; signed?: boolean | null };
      if (String(c.date) === today && c.signed === true) return true;
    }
  }
  return false;
}

export default function App() {
  const [state, setState] = useState<DemoState>({ apiBase: sessionStore.apiUrl, busy: false, error: "", msg: "" });
  // member = 会员资料（展示用）。登录态不看它；它缺失/过期时下面的 effect 会静默续期
  const [member, setMember] = useState<MemberInfo | null>(() => sessionStore.memberInfo);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [daily, setDaily] = useState<DailyPayload | null>(null);
  const [speedResult, setSpeedResult] = useState<SpeedSample[]>([]);
  const [tab, setTab] = useState("home");
  // 每次冷启动显示 18+ 确认（与自动测源同频）；确认期间后台完成测速与首屏预取
  const [ageGate, setAgeGate] = useState(true);
  const [gateBusy, setGateBusy] = useState(false);
  // 暗色模式：跟随左侧菜单开关，持久化到 localStorage；阅读器区域本身就是深色不受影响
  const [dark, setDark] = useState<boolean>(() => {
    try { return localStorage.getItem(UI_KEYS.theme) === "dark"; } catch { return false; }
  });
  // 顶栏滚动态：内容滚动出一定距离后加阴影/底边，分离层级
  const [scrolled, setScrolled] = useState(false);

  // 点击确认：放行首页启动（测速此时才开始）→ 按钮转圈等待测速结束 → 成功/失败后进门
  async function confirmGate() {
    if (gateBusy) return;
    setGateBusy(true);
    openGate(); // ContentView 收到信号后开始 init + 自动测速
    let speedOk = true;
    try {
      const info = await Promise.race([
        startupReady,
        new Promise<{ speedOk: boolean }>((resolve) => setTimeout(() => resolve({ speedOk: true }), 35000))
      ]);
      speedOk = info.speedOk;
    } catch { /* keep */ }
    setGateBusy(false);
    setAgeGate(false);
    if (!speedOk) {
      pushToast("线路/DNS 连接失败，建议到会员页「DNS 加速」配置 DoT，配置后删除后台重进生效", "err", "goto-dns");
    }
  }
  const [showSource, setShowSource] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [backHint, setBackHint] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tosOpen, setTosOpen] = useState(false);
  const [tosAccepted, setTosAccepted] = useState<boolean>(() => {
    try { return localStorage.getItem(TOS_ACCEPTED_KEY) === "1"; } catch { return false; }
  });
  const touchStartX = useRef<number | null>(null);
  const [showCache, setShowCache] = useState(false);
  const [libPanel, setLibPanel] = useState<null | "favorite" | "history">(null);
  const lastBackRef = useRef(0);

  useEffect(() => {
    return on("jm:immersive", (v) => setImmersive(Boolean(v)));
  }, []);

  useEffect(() => {
    return on("jm:goto", (detail) => {
      if (detail === "latest" || detail === "ranking") {
        setTab("categories");
        setTimeout(() => emit("jm:nav", detail), 150);
      }
    });
  }, []);

  useEffect(() => { sessionStore.lang = "CN"; }, []);

  useEffect(() => {
    try {
      if (dark) document.documentElement.setAttribute("data-theme", "dark");
      else document.documentElement.removeAttribute("data-theme");
      localStorage.setItem(UI_KEYS.theme, dark ? "dark" : "light");
    } catch { /* ignore */ }
  }, [dark]);

  // 顶栏滚动态：> 8px 切换 .scrolled，rAF 节流
  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        setScrolled(window.scrollY > 8);
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // 菜单展开时按需拉取官方赞助方案（匿名可读；登录后带订单）
  useEffect(() => {
    if (!menuOpen || state.payment || !client.apiBase) return;
    let alive = true;
    client.getPayment().then((payment) => {
      if (alive) setState((s) => ({ ...s, payment: payment || s.payment }));
    }).catch(() => { /* 保持现状 */ });
    return () => { alive = false; };
  }, [menuOpen, state.payment]);

  // 初次进入主页：18+ 门关闭后弹出使用须知
  useEffect(() => {
    if (!ageGate && !tosAccepted) setTosOpen(true);
  }, [ageGate, tosAccepted]);

  // 左缘右滑唤出菜单（推拉覆盖效果）
  useEffect(() => {
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      touchStartX.current = t.clientX <= 44 ? t.clientX : null;
    };
    const onMove = (e: TouchEvent) => {
      if (touchStartX.current == null) return;
      const t = e.touches[0];
      if (t && t.clientX - touchStartX.current > 64) {
        setMenuOpen(true);
        touchStartX.current = null;
      }
    };
    const onEnd = () => { touchStartX.current = null; };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
  }, []);

  // 线路变化（自动测速/手动切换）后同步外壳显示的当前线路
  useEffect(() => {
    const handler = () => {
      setState((s) => ({ ...s, apiBase: client.apiBase || sessionStore.apiUrl || s.apiBase }));
    };
    return on("jm:lineChanged", handler);
  }, []);

  // 购买成功后刷新会员余额（已记住账号时）
  useEffect(() => {
    const handler = () => {
      if (!sessionStore.account) return;
      authService.reloginFromStoredAccount().then((info) => { if (info) setMember(info); }).catch(() => { /* ignore */ });
    };
    return on("jm:coinChanged", handler);
  }, []);

  useEffect(() => {
    const sub = CapApp.addListener("backButton", async () => {
      console.log("jm back native pressed");
      const back = { consumed: false };
      emit("jm:back", back);
      if (back.consumed) return;
      if (tab !== "home") {
        setTab("home");
        window.scrollTo({ top: 0 });
        return;
      }
      const now = Date.now();
      if (now - lastBackRef.current < 2500) {
        await CapApp.exitApp();
      } else {
        lastBackRef.current = now;
        setBackHint(true);
        setTimeout(() => setBackHint(false), 2200);
      }
    });
    return () => { sub.then((l) => l.remove()); };
  }, [tab]);

  function patch(p: Partial<DemoState>) { setState((s) => ({ ...s, ...p })); }

  async function ensureInit() {
    if (client.apiBase) return;
    const apiBase = await client.init();
    patch({ apiBase });
  }

  async function bootstrap() {
    patch({ busy: true, error: "", msg: "" });
    try {
      await ensureInit();
      const setting = await client.getSetting();
      let payment: PaymentPayload | undefined;
      try { payment = await client.getPayment(); } catch { /* 未登录时可忽略 */ }
      patch({ setting, payment, busy: false });
    } catch (err) {
      patch({ busy: false, error: String(err) });
    }
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    patch({ busy: true, error: "", msg: "" });
    try {
      await ensureInit();
      const info = await authService.login(username.trim(), password, remember);
      setMember(info);
      setPassword("");
      patch({ busy: false, msg: "登录成功" });
    } catch (err) {
      patch({ busy: false, error: String(err) });
    }
  }

  async function handleLogout() {
    patch({ busy: true, error: "" });
    await authService.logout();
    setMember(null);
    patch({ busy: false, msg: "已登出" });
  }

  async function handleRefresh() {
    patch({ busy: true, error: "", msg: "" });
    try {
      const info = await authService.reloginFromStoredAccount();
      if (info) {
        setMember(info);
        patch({ busy: false, msg: "会话已刷新" });
      } else {
        patch({ busy: false, error: "没有保存的账号，请重新登录" });
      }
    } catch (err) {
      patch({ busy: false, error: String(err) });
    }
  }

  async function officialAction(label: string, fn: () => Promise<unknown>) {
    patch({ busy: true, error: "", msg: "" });
    try {
      const result = await fn();
      const status = (result as { status?: string; msg?: string } | null)?.status;
      const base = label + (status ? "：" + status : "成功");
      const account = sessionStore.account;
      if (account) {
        const info = await authService.reloginFromStoredAccount();
        if (info) setMember(info);
        patch({ busy: false, msg: base });
      } else {
        patch({ busy: false, msg: base + "（未记住账号，余额需重新登录后刷新）" });
      }
    } catch (err) {
      patch({ busy: false, error: String(err) });
    }
  }

  function acceptTos() {
    try { localStorage.setItem(TOS_ACCEPTED_KEY, "1"); } catch { /* ignore */ }
    setTosAccepted(true);
    setTosOpen(false);
  }

  async function reloadConfig() {
    const setting = await client.getSetting();
    patch({ setting });
    try {
      const payment = await client.getPayment();
      patch({ payment });
    } catch { /* 未登录/未完成支付时忽略 */ }
  }

  async function handleLineChange(host: string) {
    if (!host) return;
    patch({ busy: true, error: "", msg: "" });
    try {
      client.selectLine(host);
      patch({ apiBase: client.apiBase });
      await reloadConfig();
      patch({ busy: false, msg: "已切换线路：" + host });
    } catch (err) {
      patch({ busy: false, error: String(err) });
    }
  }

  async function loadDaily() {
    if (!member) return;
    const d = await client.getDaily(member.uid || "");
    setDaily(d);
    patch({ msg: "签到活动已加载（点击签到才会真正签到）" });
  }

  async function doCheckIn() {
    if (!member || !daily) return;
    patch({ busy: true, error: "", msg: "" });
    try {
      // 权威判定一：今天在官方签到记录里已 signed → 直接判失败（不依赖接口返回格式）
      if (signedToday(daily)) {
        pushToast("签到失败：今天已经签到过了", "err");
        const d = await client.getDaily(member.uid || "").catch(() => null);
        if (d) setDaily(d);
        patch({ busy: false });
        return;
      }
      // 执行签到（noAuth 无关，正常带凭证）
      const raw = await client.checkIn(member.uid || "", daily.daily_id || "");
      const res = (typeof raw === "string" ? { msg: raw } : (raw as { msg?: string; status?: string; coin?: number | string; exp?: number | string } | null)) || {};
      const text = String(res.msg || res.status || "");
      if (/已签|重复|失败|错误|未签|不存在/.test(text)) {
        pushToast("签到失败：" + text, "err");
      } else {
        // 成功：刷新会员数据并对比 JCoin 变化，给出具体奖励
        const coinBefore = Number(member.coin) || 0;
        let info = member;
        try {
          const rel = await authService.reloginFromStoredAccount();
          if (rel) { setMember(rel); info = rel; }
        } catch { /* 未记住账号则跳过自动刷新 */ }
        const gained = (Number(info.coin) || 0) - coinBefore;
        const extra = res.coin !== undefined && res.coin !== "" ? String(res.coin) : gained > 0 ? "+" + gained + " JCoin" : "";
        pushToast("签到成功" + (extra ? "，获得 " + extra : "") + "，会员数据已更新", "ok");
      }
      const d = await client.getDaily(member.uid || "").catch(() => null);
      if (d) setDaily(d);
      patch({ busy: false });
    } catch (err) {
      patch({ busy: false, error: String(err) });
    }
  }

  async function handleShuntChange(key: string) {
    if (!key) return;
    patch({ busy: true, error: "", msg: "" });
    try {
      client.setImageShunt(key);
      await reloadConfig();
      patch({ busy: false, msg: "已切换图源：" + key });
    } catch (err) {
      patch({ busy: false, error: String(err) });
    }
  }

  /** 线路测速：仅测 5 条官方 API 线路的连通与延迟（图源已改为在阅读器内按漫画实测） */
  async function runLineSpeed() {
    if (!client.hostConfig) { patch({ error: "请先初始化官方配置" }); return; }
    patch({ busy: true, error: "", msg: "" });
    setSpeedResult([]);
    try {
      const lineItems = (client.hostConfig.jm3_Server || []).map(([host, name]) => ({
        label: "线路" + name + "（" + host + "）",
        url: "https://" + host + "/static/jmapp3apk/version.json?t=" + Date.now()
      }));
      const samples = await measureAll(lineItems);
      setSpeedResult(samples);
      const okCount = samples.filter((s) => s.ok).length;
      patch({ busy: false, msg: okCount > 0 ? "线路测速完成，可手动选择最快线路" : "线路测速失败，请检查网络" });
    } catch (err) {
      patch({ busy: false, error: String(err) });
    }
  }

  // 登录态唯一判据（有 token 即已登录）；member 只是「会员资料」，缺失/过期时后台自愈
  const logged = useLoggedIn();
  const availableLines = client.hostConfig?.jm3_Server || [];
  let currentHost = "";
  if (state.apiBase) { try { currentHost = new URL(state.apiBase).host; } catch { currentHost = ""; } }

  // 登录态变化（登录/登出/自动续期）→ 同步会员资料
  useEffect(() => on("jm:authChanged", () => setMember(sessionStore.memberInfo)), []);

  // 有 token 但会员资料缺失或本地有效期已过 → 用记住的账号静默续期（没记住账号就等用户手动登录）
  useEffect(() => {
    if (!logged || !sessionStore.needsMemberRefresh()) return;
    if (!sessionStore.account) return;
    let alive = true;
    (async () => {
      // 必须先确保线路就绪，否则续期请求会以「API base 未初始化」直接失败
      try { if (!client.apiBase) await client.init(); } catch { return; }
      const info = await authService.reloginFromStoredAccount().catch(() => null);
      if (alive && info) setMember(info);
    })();
    return () => { alive = false; };
  }, [logged, member]);

  // 协议漂移检测：官方 /setting 的 jm3_version 与客户端常量不一致时提示
  // （APP_VERSION 参与 Tokenparam/Token 计算，官方改协议时客户端可能整体失效且此前毫无提示）
  // 数据源用 client.setting + jm:setting 事件：state.setting 只有手动点「初始化官方配置」才会有
  const [onlineProto, setOnlineProto] = useState(() => String(client.setting?.jm3_version || ""));
  useEffect(() => on("jm:setting", () => setOnlineProto(String(client.setting?.jm3_version || ""))), []);
  const protoDrift = Boolean(onlineProto) && !onlineProto.startsWith(APP_VERSION);
  useEffect(() => {
    if (protoDrift) console.warn("[jmd] proto drift: client=" + APP_VERSION + " server=" + onlineProto);
  }, [protoDrift, onlineProto]);

  function navTo(action: string) {
    setTab(action);
    window.scrollTo({ top: 0 });
    setTimeout(() => emit("jm:nav", action), 80);
  }

  function goHome() {
    if (tab !== "home") {
      navTo("home");
      return;
    }
    // 已在首页：回到顶部并通知首页实例刷新推荐内容
    window.scrollTo({ top: 0 });
    emit("jm:refreshHome");
  }

  function openSourcePanel() {
    // 立即响应：先弹出抽屉，配置未就绪时后台补齐（页面加载不阻塞顶栏操作）
    setMenuOpen(false);
    setShowSource(true);
    if (!state.apiBase || !state.setting) {
      bootstrap().catch(() => { /* 抽屉内显示配置占位 */ });
    }
  }

  function openCheckinFromTop() {
    setMenuOpen(false);
    openMember();
    if (logged) setTimeout(() => { loadDaily(); }, 150);
  }

  async function openMember() {
    setTab("member");
    window.scrollTo({ top: 0 });
    // 同步 client 侧已就绪的配置快照（不重复 getSetting，避免覆盖已选好的图床域名）
    setState((s) => ({
      ...s,
      apiBase: client.apiBase || sessionStore.apiUrl || s.apiBase,
      setting: client.setting || s.setting
    }));
    // 官方赞助方案匿名也可读（uid=0）；已登录则带订单
    try {
      if (!client.apiBase) await client.init();
      const payment = await client.getPayment();
      setState((s) => ({ ...s, payment: payment || s.payment }));
    } catch { /* 未初始化成功时忽略，页面显示占位 */ }
  }

  /** 跳转到会员页（DnsGuide 组件监听 jm:gotoDns 自行滚动） */
  function openMemberAndDns() {
    openMember();
  }

  // 全局响应「去 DNS 配置」点击
  useEffect(() => {
    const h = () => openMemberAndDns();
    return on("jm:gotoDns", h);
  }, []);

  return (
    <div className={immersive ? "app immersive" : "app"}>
      <header className={"top-bar" + (scrolled ? " scrolled" : "")}>
        <div className="top-left">
          <button className="menu-btn" aria-label="菜单" onClick={() => setMenuOpen((o) => !o)}><MenuIcon size={20} /></button>
          <div className="top-title">JM极简版</div>
        </div>
        <div className="top-actions">
          <button aria-label="缓存" onClick={() => { setMenuOpen(false); setShowCache(true); }}><DownloadIcon size={20} /></button>
          <button aria-label="签到" onClick={openCheckinFromTop}><CheckInIcon size={20} /></button>
          <button aria-label="搜索" onClick={() => { setMenuOpen(false); navTo("search"); }}><SearchIcon size={20} /></button>
          <button aria-label="线路测速" title="线路测速" onClick={openSourcePanel}><LightningIcon size={20} /></button>
        </div>
      </header>
      <main className="view-stack">
      <section className={tab === "member" ? "member-page" : "member-page view-hidden"}>
      <div className="row">
        <button disabled={state.busy} onClick={bootstrap}>初始化官方配置</button>
        {logged && <button disabled={state.busy} onClick={handleLogout}>登出</button>}
        {logged && <button disabled={state.busy} onClick={handleRefresh}>刷新会话</button>}
      </div>
      {state.error && (
        <div className="card err">
          {friendlyError(state.error)}
          {/\[network\]|\[timeout\]|fetch failed|Failed to fetch|network/i.test(state.error) && (
            <div style={{ marginTop: 8 }}>
              <button className="ghost" onClick={openMemberAndDns}>去会员页配 DNS</button>
            </div>
          )}
        </div>
      )}
      {state.msg && <div className="card msg">{state.msg}</div>}

      {!logged && (
        <div className="card row">
          <button className="ghost" onClick={() => pushToast("登录后可查看收藏", "info")}><BookIcon size={16} /> 我的收藏</button>
          <button className="ghost" onClick={() => setLibPanel("history")}><ClockIcon size={16} /> 我的足迹</button>
        </div>
      )}
      {!logged ? (
        <form className="card" onSubmit={handleLogin}>
          <h2>官方账号登录</h2>
          <label className="field">账号
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <label className="field">密码
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <label className="row"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> 记住登录（本地保存账号，用于刷新会话）</label>
          <button disabled={state.busy}>登录</button>
          <p className="muted">登录/会话/兑换均走官方后端；本地不做任何账务修改。</p>
        </form>
      ) : (
        <div className="card">
          <h2>会员中心（官方数据）</h2>
          <div className="grid2">
            <span>账号：{fmt(member?.username)}</span>
            <span>等级：{fmt(member?.level)}</span>
            <span>UID：{fmt(member?.uid)}</span>
            <span>JCoin：{fmt(member?.coin)}</span>
            <span>充能：{fmt(member?.charge)}</span>
            <span>J罐：{fmt(member?.jar)}</span>
            <span>经验：{fmt(member?.exp)}</span>
            <span>无广告：{member?.ad_free ? "是（超级JM人）" : "否"}</span>
            <span>到期：{fmt(member?.ad_free_before)}</span>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="ghost" disabled={state.busy} onClick={() => setLibPanel("favorite")}><BookIcon size={16} /> 我的收藏</button>
            <button className="ghost" disabled={state.busy} onClick={() => setLibPanel("history")}><ClockIcon size={16} /> 我的足迹</button>
          </div>
          <div className="row">
            <button disabled={state.busy} onClick={() => officialAction("3充能兑换1天无广告", () => client.redeemAdFree("day"))}>3充能→1天无广告</button>
            <button disabled={state.busy} onClick={() => officialAction("1J罐兑换30天无广告", () => client.redeemAdFree("month"))}>1J罐→30天无广告</button>
            <button disabled={state.busy} onClick={() => officialAction("10000JCoin换1充能", () => client.buyCharge())}>JCoin→充能</button>
            <button disabled={state.busy} onClick={loadDaily}>签到活动</button>
          </div>
          {daily && (
            <div style={{ marginTop: 8 }}>
              <p className="muted">活动：{String(daily.event_name || "")} · 3天奖励 {String(daily.three_days_coin ?? "")}币/{String(daily.three_days_exp ?? "")}经验 · 7天奖励 {String(daily.seven_days_coin ?? "")}币/{String(daily.seven_days_exp ?? "")}经验</p>
              <button disabled={state.busy} onClick={doCheckIn}>立即签到</button>
            </div>
          )}
        </div>
      )}

      {/* 标签屏蔽：官方服务端过滤，需登录 + 等级 >= 8 + 冷却机制（仅登录态可见） */}
      {logged && <TagBlockSetting />}

      {/* DNS 加速引导（非登录态也可见，用于解决运营商 DNS 污染） */}
      <DnsGuide />

      {state.apiBase && <div className="card"><h2>当前线路</h2><p className="mono">{state.apiBase}</p></div>}
      {state.setting && (
        <div className="card">
          <h2>官方 setting / 线路与图源</h2>
          <div className="row">
            <label>线路
              <select value={currentHost} onChange={(e) => handleLineChange(e.target.value)}>
                {availableLines.map(([host, name]) => <option key={host} value={host}>{name}（{host}）</option>)}
              </select>
            </label>
            <label>图源
              <select value={client.imageShunt} onChange={(e) => handleShuntChange(e.target.value)}>
                {Array.isArray(state.setting.app_shunts) && state.setting.app_shunts.length > 0
                  ? state.setting.app_shunts.map((s) => <option key={String(s.key)} value={String(s.key)}>{String(s.title)}</option>)
                  : <option value="1">图源1</option>}
              </select>
            </label>
          </div>
          <div className="row">
            <button disabled={state.busy} onClick={runLineSpeed}>线路测速</button>
            {speedResult.length > 0 && (
              <ul className="speed-list">
                {speedResult.map((r) => <li key={r.label} className={r.ok ? "ok" : "fail"}>{r.ok ? "✔" : "✘"} {r.label} · {r.ok ? r.ms + " ms" : "超时/失败"}</li>)}
              </ul>
            )}
          </div>
          <p className="muted">jm3_version={state.setting.jm3_version} · ipcountry={state.setting.ipcountry} · img_host={String(state.setting.img_host || "")} · ad_cache_version={String(state.setting.ad_cache_version)}</p>
        </div>
      )}
      {state.payment && (
        <div className="card">
          <h2>官方赞助</h2>
          <p className="muted">赞助支持项目持续更新；选择方案并支付后权益自动生效。</p>
          <div className="row">
            {(state.payment.plans || []).map((p) => (
              <span key={p.key} className="muted" style={{ display: "block", marginBottom: 4 }}>{p.name} · USD {p.price} / {p.days} 天</span>
            ))}
          </div>
          <button onClick={() => { openExternal("https://comic18j-bibi.me/payment?link=homepage_icon"); }}>前往官方赞助页面</button>
        </div>
      )}
      </section>
      {tab !== "member" && (
      <section className="browse-page">
      <ErrorBoundary label="内容页">
      {tab === "home" && <ContentView key="home" />}
      {tab === "categories" && <ContentView key="categories" initialAction="categories" />}
      {tab === "search" && <ContentView key="search" initialAction="search" />}
      </ErrorBoundary>
      </section>
      )}
      </main>

      <nav className="bottom-nav">
        <button className={tab === "home" ? "nav-item active" : "nav-item"} onClick={goHome}><HomeIcon /><span>首页</span></button>
        <button className={tab === "categories" ? "nav-item active" : "nav-item"} onClick={() => navTo("categories")}><GridIcon /><span>分类</span></button>
        <button className={tab === "search" ? "nav-item active" : "nav-item"} onClick={() => navTo("search")}><SearchIcon /><span>搜索</span></button>
        <button className={tab === "member" ? "nav-item active" : "nav-item"} onClick={() => { openMember(); }}><UserIcon /><span>会员</span></button>
      </nav>

      <div className={"menu-backdrop" + (menuOpen ? " open" : "")} onClick={() => setMenuOpen(false)} />
      <div className={"side-drawer" + (menuOpen ? " open" : "")}>
        <div className="menu-head">
          <img className="menu-logo" src="./icons/icon-192.png" alt="JM极简版" />
          <span className="app-name">JM极简版</span>
        </div>
        <div className="menu-body">
          <div className="menu-section">
            <h4>官方广告位</h4>
            <AdMenuBanner open={menuOpen} />
          </div>
          <div className="menu-section">
            <h4>官方赞助</h4>
            <button className="menu-plan" onClick={() => openExternal("https://comic18j-bibi.me/payment?link=homepage_icon")}>
              <span className="plan-name">前往官方赞助页面</span>
              <span className="plan-price">→</span>
            </button>
            <p className="muted menu-note">赞助支持项目持续更新；支付后权益自动生效</p>
          </div>
          <div className="menu-section">
            <h4>GitHub 仓库</h4>
            <button className="menu-link" onClick={() => openExternal(REPO_URL)}>
              github.com/gucheng910/jm-minimal ↗
            </button>
          </div>
          <div className="menu-section">
            <button className="menu-link" onClick={() => setTosOpen(true)}>使用须知</button>
          </div>
          <div className="menu-section">
            <button className="theme-toggle" onClick={() => setDark((d) => !d)}>
              <span className="theme-toggle-left">
                {dark ? <MoonIcon size={18} /> : <SunIcon size={18} />}
                {dark ? "深色模式" : "浅色模式"}
              </span>
              <span className={"theme-toggle-switch" + (dark ? " on" : "")} />
            </button>
          </div>
          <div className="menu-section">
            <h4>版本</h4>
            <p className="muted menu-note">v{LOCAL_VERSION}（官方协议 {APP_VERSION}{BUILD_VARIANT === "compat" ? " · 兼容包" : ""}）</p>
            {protoDrift && (
              <p className="err small-err">官方协议已更新到 {onlineProto}，当前客户端按 {APP_VERSION} 通信；若出现异常请留意后续版本</p>
            )}
            {isDesktop ? <DesktopUpdate /> : <UpdateSection />}
          </div>
        </div>
      </div>
      {showSource && (
        <div className="drawer-backdrop" onClick={() => setShowSource(false)}>
          <div className="source-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h2>线路 / 图源切换</h2>
            </div>
            <div className="row">
              <label>线路
                <select value={currentHost} onChange={(e) => { handleLineChange(e.target.value); }}>
                  {availableLines.map(([host, name]) => <option key={host} value={host}>{name}（{host}）</option>)}
                </select>
              </label>
              <label>图源
                <select value={client.imageShunt} onChange={(e) => { handleShuntChange(e.target.value); }}>
                  {Array.isArray(state.setting?.app_shunts) && state.setting!.app_shunts!.length > 0
                    ? state.setting!.app_shunts!.map((s) => <option key={String(s.key)} value={String(s.key)}>{String(s.title)}</option>)
                    : <option value="1">图源1</option>}
                </select>
              </label>
            </div>
            <div className="row">
              <button disabled={state.busy} onClick={runLineSpeed}>线路测速</button>
              {speedResult.length > 0 && <ul className="speed-list">{speedResult.map((r) => <li key={r.label} className={r.ok ? "ok" : "fail"}>{r.label} · {r.ok ? r.ms + "ms" : "失败"}</li>)}</ul>}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="ghost" onClick={() => setShowSource(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {showCache && <CacheCenter onClose={() => setShowCache(false)} />}
      {libPanel && (
        <LibPage
          kind={libPanel}
          onClose={() => setLibPanel(null)}
          onOpenAlbum={(aid) => {
            setLibPanel(null);
            setTab("home");
            window.scrollTo({ top: 0 });
            setTimeout(() => emit("jm:openAid", String(aid)), 120);
          }}
        />
      )}
      {backHint && <div className="back-hint">再按一次返回退出</div>}
      <ToastHost />
      <TosModal open={tosOpen} requireWait={!tosAccepted} onAccept={acceptTos} />
      {ageGate && (
        <div className="age-gate">
          <div className="age-card">
            <img className="age-logo-img" src="./icons/icon-192.png" alt="JM极简版" />
            <h1>JMClient</h1>
            <p className="age-warn">本站内容包含成人题材，仅供年满 18 周岁的成年人浏览。</p>
            <button className="age-confirm" disabled={gateBusy} onClick={confirmGate}>
              {gateBusy ? <><span className="mini-spin" />正在自动选择最快线路…</> : "我保证我已满18周岁，确认进入"}
            </button>
            <p className="age-tip">未满 18 岁请立即退出本应用</p>
          </div>
        </div>
      )}
    </div>
  );
}