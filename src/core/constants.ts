// 协议常量（来自对原客户端 v2.1.6 的逆向验证；2.1.5→2.1.6 协议层无变化，仅前端 UI 改动）
export const APP_VERSION = "2.1.6";
export const TOKEN_SECRET = "185Hcomic3PAPP7R";
export const CONTENT_SECRET = "18comicAPPContent";
export const HOST_KEY_SECRET = "diosfjckwpqpdfjkvnqQjsik";
export const SESSION_TTL_MS = 60 * 60 * 1000;

/** 出包标识（诊断用，每次发布更新） */
export const BUILD_TAG = "v20260912-2.1.0";
/**
 * 当前客户端版本号（由 UpdateSection / 侧边栏版本信息共用）。
 * 构建时由 vite.config.ts 的 define 从 package.json 注入 __APP_VERSION__，
 * 运行时也能通过 globalThis 覆盖（如 Android 壳注入原生 versionName）。
 */
declare const __APP_VERSION__: string;
export const LOCAL_VERSION =
  (typeof globalThis !== "undefined" && (globalThis as { __builtinVersion?: string }).__builtinVersion) ||
  (typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0");
/**
 * 构建变体：modern（现代内核）/ compat（老内核兼容包）/ legacy（Android 6 老安卓包）。
 * 由 vite.config.ts 的 define 注入 __BUILD_VARIANT__（--mode compat / --mode legacy）。
 * **应用内更新器据此挑选对应的 APK 资产**——三个包同 versionName，只能靠构建期注入区分，
 * 否则 compat / legacy 用户会被引导下载装不上或跑不起来的包。
 */
declare const __BUILD_VARIANT__: string;
declare const __NO_SEAM__: boolean;
/**
 * 本构建是否移除了「去条纹」（接缝修复）逻辑。
 * 老安卓专用包置 true：阅读器不再排队做 canvas 重排，设置里也没有开关。
 * 写成构建期常量是为了让整块代码能被摇掉（不是运行期判空）。
 */
export const NO_SEAM: boolean = typeof __NO_SEAM__ !== "undefined" && __NO_SEAM__ === true;

export const BUILD_VARIANT: string = (() => {
  const v = (typeof __BUILD_VARIANT__ !== "undefined" ? String(__BUILD_VARIANT__) : "modern").toLowerCase();
  return v === "compat" || v === "legacy" ? v : "modern";
})();

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
/**
 * 列表排序（功能）：改变**当前列表**的先后顺序，作用于分类结果与搜索结果。
 * 参数就是官方 categories/filter 与 search 的 o（实测：""/mv/mp/tf 均有效）。
 */
export const SORT_MODES: Array<[string, string]> = [
  ["", "最新"], ["mv", "最多点击"], ["mp", "最多图片"], ["tf", "最多爱心"]
];
/**
 * 排行榜（去处）：与「同人」「单本」并列的一个入口，选中后出现二级榜。
 * 实测参数：mv 总榜 / mv_m 月榜 / mv_w 周榜（total 693）/ mv_t 日榜（total 121）；
 * 注意 mp_w 无效（返回与"最新"逐条一致），所以周榜必须用 mv_w。
 */
export const RANK_MODES: Array<[string, string]> = [
  ["mv", "总榜"], ["mv_m", "月榜"], ["mv_w", "周榜"], ["mv_t", "日榜"]
];
/** 排行榜在分类行里的伪 slug（服务端没有这个分类，只是 UI 上的一个去处） */
export const RANK_PLACE = "__rank__";
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

/**
 * 官方图源 key 兜底表。
 * 图源清单来自 setting.app_shunts，可老设备冷启动时 setting 往往还没就绪（或超时），
 * 那时启动测速就只剩 express 一个候选源可测，测不出结果就一直停在死图床上（封面全白）。
 * 这份常量让"配置未就绪"也能测速换源，与 setting 返回的清单取并集使用。
 */
export const FALLBACK_SHUNT_KEYS = ["1", "2", "3", "4", "5"] as const;
