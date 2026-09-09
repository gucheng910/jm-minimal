// 服务端协议类型（依据解密后的真实响应定义，字段按需保留 unknown 兼容）

export interface HostConfig {
  Setting: string[];
  Server: string[];
  jm3_Server: Array<[string, string]>;
}

export interface AppShunt {
  title: string;
  key: string;
  [k: string]: unknown;
}

export interface SettingConfig {
  version: string;
  test_version: string;
  jm3_version: string;
  jm3_download_url: string;
  ipcountry: string;
  ad_cache_version: number | string;
  float_ad: boolean;
  is_cn: number;
  cn_base_url: string;
  base_url: string;
  main_web_host: string;
  img_host: string;
  app_shunts?: AppShunt[];
  [k: string]: unknown;
}

export interface MemberInfo {
  uid?: string | number;
  username?: string;
  level?: number | string;
  coin?: number | string;
  charge?: number | string;
  jar?: number | string;
  ad_free?: boolean;
  ad_free_before?: string;
  exp?: number | string;
  s?: string;
  [k: string]: unknown;
}

export interface SessionData {
  token: string;
  memberInfo: MemberInfo | null;
}

export interface PaymentPlan {
  key: string;
  name: string;
  months: number;
  price: number;
  total: number;
  special_price: number;
  days: number;
  exp: number;
  features: string[];
  [k: string]: unknown;
}

export interface PayMethod {
  pid: number;
  name: string;
  type: string;
  min_price: number;
  max_price: number;
  [k: string]: unknown;
}

export interface PaymentPayload {
  plans: PaymentPlan[];
  pay_methods: PayMethod[];
  uid: number | string;
  orders: unknown[];
  web_host: string;
  checkout: string;
}

export interface ApiEnvelope<T = unknown> {
  code: number;
  data: T;
  msg?: string;
}

export interface LoginResult extends MemberInfo {
  jwttoken?: string;
}

// ---- M2 内容流类型（探测自官方只读接口） ----
export interface AlbumSummary {
  id: number | string;
  author?: string;
  name: string;
  image?: string;
  description?: string | null;
  category?: { id?: number | string; title?: string };
  category_sub?: { id?: number | string; title?: string };
  liked?: boolean;
  is_favorite?: boolean;
  is_aids?: boolean;
  update_at?: string | number;
  adddate?: string | number;
  /** 本地派生展示字段（如「读到 第12话」）；接口不返回 */
  sub?: string;
}

export interface AlbumDetail {
  id: number | string;
  name: string;
  images?: unknown[];
  addtime?: string | number;
  description?: string | null;
  total_views?: number | string;
  total_photos?: number | string;
  likes?: number | string;
  series?: SeriesItem[];
  series_id?: string | number;
  /** 书级书名（mergeBookMeta 注入；话级回包只有「书名-第N话」），足迹/列表标题用 */
  book_name?: string;
  author?: string[];
  tags?: string[];
  works?: string[];
  actors?: string[];
  related_list?: AlbumSummary[];
  liked?: boolean;
  is_favorite?: boolean;
  is_aids?: boolean;
  price?: string;
  purchased?: unknown;
}

export interface SeriesItem {
  id: number | string;
  name?: string;
  sort?: number | string;
  is_buy_ok?: string | number;
  is_need_buy_nc?: string | number;
}

export interface SearchResult {
  search_query?: string;
  search_type?: string;
  total?: number | string;
  redirect_aid?: string | number;
  content: AlbumSummary[];
}

export interface ReadPage {
  page: number;
  image: string;
  /** 原始文件名（无扩展名），离线 blob URL 场景用于 scramble 重排 */
  name?: string;
}

export interface ReadPayload {
  id: number | string;
  scramble_id?: string | number;
  name?: string;
  total_page?: number;
  images: ReadPage[];
}

export interface LatestResult {
  content?: AlbumSummary[];
  [k: string]: unknown;
}

// ---- 鉴权/模块接口（登录账号只读探测后沉淀；不含任何账号数据） ----
export interface FavoritePayload {
  list: AlbumSummary[];
  folder_list: unknown[];
  total: number | string;
  count: number | string;
}

export interface WatchHistoryPayload {
  list: AlbumSummary[];
  total: number | string;
}

export interface TaskRuleData {
  type?: string;
  operator?: string;
  value?: number | string;
  unique?: number | string;
  [k: string]: unknown;
}

export interface TaskItem {
  id: number | string;
  name?: string;
  type?: string;
  content?: string;
  coin?: number | string;
  rule?: string;
  begin_time?: string | number;
  end_time?: string | number;
  percent?: number | string;
  done?: boolean | number;
  rule_data?: TaskRuleData;
  [k: string]: unknown;
}

export interface TaskPayload {
  msg?: string;
  status?: string;
  list: TaskItem[];
}

export interface DailyPayload {
  daily_id?: number | string;
  three_days_coin?: number | string;
  three_days_exp?: number | string;
  seven_days_coin?: number | string;
  seven_days_exp?: number | string;
  event_name?: string;
  currentProgress?: Record<string, unknown>;
  record?: unknown[];
  [k: string]: unknown;
}

export interface ForumComment {
  AID?: number | string;
  BID?: number | string;
  CID?: number | string;
  NID?: number | string;
  NCID?: number | string;
  UID?: number | string;
  username?: string;
  nickname?: string;
  content?: string;
  likes?: number | string;
  parent_CID?: number | string;
  spoiler?: number | string;
  [k: string]: unknown;
}

export interface ForumPayload {
  list: ForumComment[];
  total: number | string;
}

export interface CategorySubItem {
  CID?: number | string;
  id?: number | string;
  name: string;
  slug: string;
}

export interface CategoryItem {
  id?: number | string;
  name: string;
  slug?: string;
  type?: string;
  total_albums?: number | string;
  sub_categories?: CategorySubItem[];
}

export interface CategoriesPayload {
  categories: CategoryItem[];
  blocks?: unknown[];
}

export interface WeekIssue {
  id: number | string;
  title?: string;
  time?: string;
}

export interface WeekType {
  id: string | number;
  title: string;
}

export interface WeekPayload {
  categories: WeekIssue[];
  type: WeekType[];
}

export interface WeekFilterPayload {
  list: AlbumSummary[];
  total: number | string;
}

// ---- 官方广告位（ad_content_all） ----
export interface AdItem {
  id?: number | string;
  adv_name?: string;
  title?: string;
  adv_text?: string;
  img?: string;
  link?: string;
  adv_type?: string | number;
  adv_On_date?: string;
  adv_expire_date?: string;
}

export interface AdSlotGroup {
  advgrp_id?: string | number;
  adv_width?: string | number;
  adv_height?: string | number;
  adv_desc?: string;
  advs?: AdItem[];
}
