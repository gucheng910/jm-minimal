// 桌面端内置 DNS 清洗的渲染层客户端
// main 进程通过 preload 暴露 window.jmDns（Electron 专属）；Web/Android 无此桥，全部逻辑自动跳过。
import { HOST_URLS } from "./constants";

export interface DnsCleanState {
  enabled: boolean;
  port: number | null;
  domains: number;
  upstream: string;
  lastClean?: { domain: string; upstream: string; ms: number } | null;
  lastError?: string;
  okCount: number;
  failCount: number;
}

export interface DesktopDnsBridge {
  set(enabled: boolean): Promise<DnsCleanState>;
  sync(roots: string[]): void;
  get(): Promise<DnsCleanState>;
  onStatus(cb: (s: DnsCleanState) => void): () => void;
}

declare global {
  interface Window {
    __jmDesktop?: boolean;
    jmDns?: DesktopDnsBridge;
  }
}

export const isDesktop: boolean =
  typeof window !== "undefined" && Boolean(window.__jmDesktop);
export const jmDns: DesktopDnsBridge | null =
  isDesktop && window.jmDns ? window.jmDns : null;

/** 桌面端偏好键：默认开启（免配置 DoT）；'0' 表示用户手动关闭 */
export const DNS_CLEAN_PREF = "jmclient.dnsClean";

export function dnsCleanPrefEnabled(): boolean {
  try { return localStorage.getItem(DNS_CLEAN_PREF) !== "0"; } catch { return true; }
}

export function setDnsCleanPref(enabled: boolean): void {
  try { localStorage.setItem(DNS_CLEAN_PREF, enabled ? "1" : "0"); } catch { /* ignore */ }
  if (jmDns) { void jmDns.set(enabled).catch(() => { /* 主进程未就绪等场景静默 */ }); }
}

// 双段 ccTLD 列表：注册根域名时避免把 bytepluses.com.cn 截成 com.cn 这类错误根
const TWO_LABEL_TLDS = new Set([
  "com.cn", "net.cn", "org.cn", "gov.cn", "com.hk", "com.mo", "com.tw",
  "com.sg", "com.jp", "co.jp", "co.kr", "com.au", "co.uk", "org.uk", "co.nz"
]);

export function domainRoot(input: string): string {
  let h = String(input || "").toLowerCase().trim();
  h = h.replace(/^https?:\/\//, "").split(/[/?#]/)[0].split(":")[0];
  const labels = h.split(".");
  if (labels.length < 2) return h;
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && TWO_LABEL_TLDS.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

const registeredRoots = new Set<string>();

/** 注册需要清洗的域名（去重后整体同步给主进程；可反复调用） */
export function registerDnsHosts(hosts: Array<string | null | undefined>): void {
  if (!jmDns) return;
  let changed = false;
  for (const h of hosts) {
    if (!h) continue;
    const root = domainRoot(h);
    if (!root || /^d+.d+.d+.d+$/.test(root) || root.includes("*")) continue;
    if (!registeredRoots.has(root)) {
      registeredRoots.add(root);
      changed = true;
    }
  }
  if (changed) jmDns.sync([...registeredRoots]);
}

/** App 启动时调用一次：按偏好启用清洗 + 注册固定域名（线路表源、快速通道兜底） */
export function initDnsClean(): void {
  if (!jmDns) return;
  const cfgHosts: string[] = [];
  for (const u of HOST_URLS) {
    try { cfgHosts.push(new URL(u).host); } catch { /* ignore */ }
  }
  registerDnsHosts([...cfgHosts, "cn-ms.jmapiproxy2.cc"]);
  void jmDns.set(dnsCleanPrefEnabled()).catch(() => { /* ignore */ });
}
