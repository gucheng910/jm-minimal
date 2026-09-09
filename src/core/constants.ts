// 协议常量（来自对原客户端 v2.1.5 的逆向验证）
export const APP_VERSION = "2.1.5";
export const TOKEN_SECRET = "185Hcomic3PAPP7R";
export const CONTENT_SECRET = "18comicAPPContent";
export const HOST_KEY_SECRET = "diosfjckwpqpdfjkvnqQjsik";
export const SESSION_TTL_MS = 60 * 60 * 1000;

/** 出包标识（诊断用，每次发布更新） */
export const BUILD_TAG = "v20260909-1.8.0";
/**
 * 当前客户端版本号（由 UpdateSection / 侧边栏版本信息共用）。
 * 构建时由 vite.config.ts 的 define 从 package.json 注入 __APP_VERSION__，
 * 运行时也能通过 globalThis 覆盖（如 Android 壳注入原生 versionName）。
 */
declare const __APP_VERSION__: string;
export const LOCAL_VERSION =
  (typeof globalThis !== "undefined" && (globalThis as { __builtinVersion?: string }).__builtinVersion) ||
  (typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0");
export const HOST_URLS: string[] = [
  "https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt",
  "https://rup4a04-c01.tos-ap-southeast-1.bytepluses.com/newsvr-2025.txt",
  "https://rup4a04-c03.tos-cn-beijing.bytepluses.com.cn/newsvr-2025.txt"
];

export const STORAGE_KEYS = {
  apiUrl: "apiUrl",
  hostServer: "hostServer",
  memberInfo: "memberInfo",
  token: "jwttoken",
  lang: "lang",
  langCode: "langCode",
  account: "memberAccount",
  authExpiry: "authExpiry"
} as const;
// ---- UI 共享常量（架构收敛：列表排序 / 榜单 / 本地存储键） ----
/** 官方接口每页条数（latest / search / week 一致） */
export const PAGE_SIZE = 80;
export const SORT_MODES: Array<[string, string]> = [["", "最新"], ["tf", "最多爱心"]];
export const RANK_MODES: Array<[string, string]> = [
  ["mv", "人气榜"], ["mv_m", "月榜"], ["mv_w", "周榜"], ["mv_t", "日榜"]
];
export const UI_KEYS = {
  history: "jmclient.history",
  searchHistory: "jmclient.searchHistory",
  readerMode: "jmclient.reader.mode",
  hostConfigCache: "jmclient.hostcfg.v1",
  autoSelectCache: "jmclient.autoSelect.v1",
  theme: "jmclient.theme"
} as const;

/** 最优线路/图源记忆有效期：期间冷启动直连上次最优，跳过启动测速 */
export const AUTO_SELECT_TTL_MS = 6 * 60 * 60 * 1000;
