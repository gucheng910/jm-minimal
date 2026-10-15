import { SESSION_TTL_MS, STORAGE_KEYS } from "./constants";
import { emit } from "./bus";
import type { MemberInfo } from "./types";

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/**
 * localStorage 的**唯一入口**：全部读写都从这里走。
 *
 * 为什么必须包一层：这些访问器是在**渲染期**被读的（`App.tsx` 的
 * `useState(() => sessionStore.apiUrl)` / `useState(() => sessionStore.memberInfo)`），
 * 而 `localStorage.getItem` 本身**会抛** —— 隐私模式、存储被企业策略禁用、
 * 配额超限、跨源隔离被收紧，任一条都会让一次读取变成"首次渲染抛异常"→
 * 整页落到 ErrorBoundary，用户看到的是白屏兜底而不是应用。
 *
 * 注意 `safeParse` 只包了 `JSON.parse`，**包不住 getItem 自己抛**（以前的漏洞就在这里）。
 * 包起来之后语义是"存储不可用 = 读到默认值 / 写入被丢弃"，界面照常显示。
 */
function readLS(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLS(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 存储不可用：丢弃写入，不影响界面 */ }
}
function removeLS(key: string): void {
  try { localStorage.removeItem(key); } catch { /* 同上 */ }
}

export interface StoredAccount {
  username: string;
  password: string;
}

export const sessionStore = {
  get apiUrl(): string { return readLS(STORAGE_KEYS.apiUrl) || ""; },
  set apiUrl(v: string) { writeLS(STORAGE_KEYS.apiUrl, v); },

  get token(): string {
    const v = safeParse<string>(readLS(STORAGE_KEYS.token), "");
    return typeof v === "string" ? v : "";
  },
  set token(v: string) { writeLS(STORAGE_KEYS.token, JSON.stringify(v)); },

  get memberInfo(): MemberInfo | null {
    return safeParse<MemberInfo | null>(readLS(STORAGE_KEYS.memberInfo), null);
  },
  set memberInfo(v: MemberInfo | null) {
    writeLS(STORAGE_KEYS.memberInfo, JSON.stringify(v));
  },

  get authExpiry(): number {
    return Number(readLS(STORAGE_KEYS.authExpiry) || 0);
  },
  set authExpiry(v: number) { writeLS(STORAGE_KEYS.authExpiry, String(v)); },

  get account(): StoredAccount | null {
    return safeParse<StoredAccount | null>(readLS(STORAGE_KEYS.account), null);
  },
  set account(v: StoredAccount | null) {
    if (v) writeLS(STORAGE_KEYS.account, JSON.stringify(v));
    else removeLS(STORAGE_KEYS.account);
  },

  get lang(): string { return readLS(STORAGE_KEYS.lang) || "CN"; },
  set lang(v: string) { writeLS(STORAGE_KEYS.lang, v); },

  /**
   * 登录态的唯一判据：本地有 token 即视为已登录。
   * 不要用 memberInfo/authExpiry 参与判断——它们只是「本地缓存的会员资料及其新鲜度」，
   * 服务端会话通常比本地 1 小时 TTL 活得久。此前设置页按资料判、详情页按 token 判，
   * 于是出现「设置页显示未登录、详情页却能点收藏」的分裂。
   */
  isLoggedIn(): boolean {
    return Boolean(this.token);
  },

  /** 会员资料是否需要刷新（有 token 但资料缺失或本地有效期已过） */
  needsMemberRefresh(): boolean {
    return Boolean(this.token) && (!this.memberInfo || Date.now() >= this.authExpiry);
  },

  /** 「会话是否新鲜」——仅用于需要资料新鲜度的场景，不再作为 UI 登录态判据 */
  hasValidSession(): boolean {
    return Boolean(this.token && this.memberInfo && Date.now() < this.authExpiry);
  },

  saveAuth(token: string, member: MemberInfo) {
    this.token = token;
    this.memberInfo = member;
    this.authExpiry = Date.now() + SESSION_TTL_MS;
    emit("jm:authChanged");
  },

  clearAuth() {
    removeLS(STORAGE_KEYS.token);
    removeLS(STORAGE_KEYS.memberInfo);
    removeLS(STORAGE_KEYS.authExpiry);
    removeLS(STORAGE_KEYS.account);
    emit("jm:authChanged");
  }
} as const;
