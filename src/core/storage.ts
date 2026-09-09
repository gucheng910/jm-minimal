import { SESSION_TTL_MS, STORAGE_KEYS } from "./constants";
import { emit } from "./bus";
import type { MemberInfo } from "./types";

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export interface StoredAccount {
  username: string;
  password: string;
}

export const sessionStore = {
  get apiUrl(): string { return localStorage.getItem(STORAGE_KEYS.apiUrl) || ""; },
  set apiUrl(v: string) { localStorage.setItem(STORAGE_KEYS.apiUrl, v); },

  get token(): string {
    const v = safeParse<string>(localStorage.getItem(STORAGE_KEYS.token), "");
    return typeof v === "string" ? v : "";
  },
  set token(v: string) { localStorage.setItem(STORAGE_KEYS.token, JSON.stringify(v)); },

  get memberInfo(): MemberInfo | null {
    return safeParse<MemberInfo | null>(localStorage.getItem(STORAGE_KEYS.memberInfo), null);
  },
  set memberInfo(v: MemberInfo | null) {
    localStorage.setItem(STORAGE_KEYS.memberInfo, JSON.stringify(v));
  },

  get authExpiry(): number {
    return Number(localStorage.getItem(STORAGE_KEYS.authExpiry) || 0);
  },
  set authExpiry(v: number) { localStorage.setItem(STORAGE_KEYS.authExpiry, String(v)); },

  get account(): StoredAccount | null {
    return safeParse<StoredAccount | null>(localStorage.getItem(STORAGE_KEYS.account), null);
  },
  set account(v: StoredAccount | null) {
    if (v) localStorage.setItem(STORAGE_KEYS.account, JSON.stringify(v));
    else localStorage.removeItem(STORAGE_KEYS.account);
  },

  get lang(): string { return localStorage.getItem(STORAGE_KEYS.lang) || "CN"; },
  set lang(v: string) { localStorage.setItem(STORAGE_KEYS.lang, v); },

  /**
   * 登录态的唯一判据：本地有 token 即视为已登录。
   * 不要用 memberInfo/authExpiry 参与判断——它们只是「本地缓存的会员资料及其新鲜度」，
   * 服务端会话通常比本地 1 小时 TTL 活得久。此前会员页按资料判、详情页按 token 判，
   * 于是出现「会员页显示未登录、详情页却能点收藏」的分裂。
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
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.memberInfo);
    localStorage.removeItem(STORAGE_KEYS.authExpiry);
    localStorage.removeItem(STORAGE_KEYS.account);
    emit("jm:authChanged");
  }
} as const;
