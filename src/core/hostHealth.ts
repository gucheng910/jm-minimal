/**
 * 图床（host）的**健康评分与冷却**。
 *
 * 为什么要有它：现在选图床只有两条路 —— 要么主动 HEAD 探一次（进阅读器就是几百毫秒的固定成本），
 * 要么按"上次成功的那个"直接信。两条路都没有**记住这个 host 最近坏成什么样**：
 * 一个刚超时 3 次的图床，下一话还会被当成首选，然后又超时一次。
 *
 * 这里的做法（照抄 JMComicX 的 ImageHostHealth，见 docs/26 §9）：
 *   · 每次真实请求成败都记账（连续失败、延迟 EWMA）；
 *   · 连续失败第 2 次起进入**指数退避冷却**（1s → 2s → 4s …封顶 300s），冷却期内不选它；
 *   · 成功即清冷却、更新平均延迟（α = 1/8）；
 *   · 选择时按加权分数取最高，失败惩罚随时间衰减（网络恢复后能自己爬回来）。
 *
 * 状态**只存在内存里**（和原生那边一致）：每次启动重新累计。持久化反而有害 ——
 * 上次在网络 A 上测出的成绩，换到网络 B 之后就是错误的前提。
 */

/** 单条 host 的健康档案 */
export interface HostHealth {
  host: string;
  /** 累计成功次数（分数里封顶计 10 次） */
  successCount: number;
  /** 累计失败次数（封顶计 20 次） */
  failureCount: number;
  /** 连续失败次数（封顶计 10 次，权重最大） */
  consecutiveFailures: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  /** 最近一次成功的耗时（ms） */
  lastLatencyMs: number | null;
  /** 平均耗时（EWMA，α = 1/8） */
  avgLatencyMs: number | null;
  /** 冷却截止时间戳（0 = 不在冷却） */
  unavailableUntil: number;
  lastError: string;
}

/** 分数基准：没任何记录的新 host 也从 100 起步（等于"不偏向"） */
const BASE_SCORE = 100;
/** 每次成功 +3，最多计 10 次（+30） */
const SUCCESS_WEIGHT = 3;
const SUCCESS_CAP = 10;
/** 每次失败 -4，最多计 20 次（-80） */
const FAIL_WEIGHT = 4;
const FAIL_CAP = 20;
/** 连续失败每次 -30，最多计 10 次（-300：一次连败直接把 host 压到底） */
const CONSEC_WEIGHT = 30;
const CONSEC_CAP = 10;
/** 平均延迟每 200ms 扣 1 分，最多扣 30 */
const LATENCY_STEP_MS = 200;
const LATENCY_PENALTY_CAP = 30;
/** 冷却期内的分数（远低于任何可用 host） */
const COOLING_SCORE = -1000;

/** 冷却档位：连续失败第 2 次起 1s，之后每多一次翻倍 */
const COOLDOWN_BASE_MS = 1000;
/** 冷却上限（5 分钟）：再坏的 host 也要给它一次机会，否则网络切换后永远回不来 */
const COOLDOWN_MAX_MS = 300_000;
/** 失败惩罚从"上次失败 60s 后"开始衰减 */
const PENALTY_DECAY_START_MS = 60_000;
/** 之后每 2 分钟衰减一档（右移一位），最多 5 档 */
const PENALTY_DECAY_STEP_MS = 120_000;
const PENALTY_DECAY_MAX_SHIFT = 5;

/**
 * 「可以信任 last-success」的时效：10 分钟内成功过的 host，进阅读器时**不再 HEAD 预检**，
 * 直接按它开读（失败自有页级重试 + 自愈兜底）。这是省掉"每次进阅读器一次 HEAD"的关键。
 */
export const HOST_TRUST_TTL_MS = 10 * 60 * 1000;

/** 正在生效的健康档案（内存态，进程内唯一） */
const table = new Map<string, HostHealth>();

/** 从 URL 里取 host（http(s)/blob/data 都容忍；取不到返回空串） */
export function hostOfUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host || u.hostname || "";
  } catch {
    return "";
  }
}

/** 北京时间无关：所有判断都用调用方给的 now（便于测试注入） */
function get(host: string): HostHealth {
  const key = String(host || "").toLowerCase();
  let h = table.get(key);
  if (!h) {
    h = {
      host: key,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      lastLatencyMs: null,
      avgLatencyMs: null,
      unavailableUntil: 0,
      lastError: ""
    };
    table.set(key, h);
  }
  return h;
}

/** 失败惩罚的时间衰减：距上次失败越久，扣分越轻（每 2 分钟右移一位，最多 5 档） */
function decayed(penalty: number, now: number, health: HostHealth): number {
  if (penalty <= 0) return 0;
  const since = now - (health.lastFailureAt || 0);
  if (since <= PENALTY_DECAY_START_MS) return penalty;
  const shift = Math.min(PENALTY_DECAY_MAX_SHIFT, Math.floor((since - PENALTY_DECAY_START_MS) / PENALTY_DECAY_STEP_MS));
  return penalty >> shift;
}

/** 是否处于冷却期 */
export function isCoolingDown(host: string, now = Date.now()): boolean {
  const h = table.get(String(host || "").toLowerCase());
  if (!h || !h.unavailableUntil) return false;
  return h.unavailableUntil > now;
}

/** 分数（越高越好；冷却期内恒为 -1000） */
export function scoreOf(host: string, now = Date.now()): number {
  const h = table.get(String(host || "").toLowerCase());
  if (!h) return BASE_SCORE; // 没记录 = 中位分，不偏向也不排斥
  if (h.unavailableUntil > now) return COOLING_SCORE;
  const ok = Math.min(SUCCESS_CAP, h.successCount) * SUCCESS_WEIGHT;
  const fail = decayed(Math.min(FAIL_CAP, h.failureCount) * FAIL_WEIGHT, now, h);
  const consec = decayed(Math.min(CONSEC_CAP, h.consecutiveFailures) * CONSEC_WEIGHT, now, h);
  const lat = h.avgLatencyMs == null ? 0 : Math.min(LATENCY_PENALTY_CAP, Math.floor(h.avgLatencyMs / LATENCY_STEP_MS));
  return BASE_SCORE + ok - fail - consec - lat;
}

/** 记一次成功：清冷却与失败计数，更新延迟 EWMA（α = 1/8） */
export function recordSuccess(host: string, latencyMs?: number | null, now = Date.now()): void {
  const h = get(host);
  if (!h.host) return;
  h.successCount += 1;
  h.failureCount = 0;
  h.consecutiveFailures = 0;
  h.lastSuccessAt = now;
  h.unavailableUntil = 0;
  h.lastError = "";
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
    const l = Math.min(60_000, Math.round(latencyMs));
    h.lastLatencyMs = l;
    h.avgLatencyMs = h.avgLatencyMs == null ? l : Math.round((l + h.avgLatencyMs * 7) / 8);
  }
}

/**
 * 记一次失败：累计失败、连续失败 +1，第 2 次连败起进入指数退避冷却。
 * 第 1 次失败**不冷却**（可能只是瞬时抖动），只降分。
 */
export function recordFailure(host: string, error = "", now = Date.now()): void {
  const h = get(host);
  if (!h.host) return;
  h.failureCount += 1;
  h.consecutiveFailures += 1;
  h.lastFailureAt = now;
  h.lastError = String(error || "").slice(0, 120);
  if (h.consecutiveFailures >= 2) {
    const step = h.consecutiveFailures - 2;
    const backoff = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS << Math.min(20, step));
    h.unavailableUntil = now + backoff;
  }
}

/**
 * 能不能直接信任这个 host（省掉一次 HEAD 预检）：
 * 冷却中 → 不能；10 分钟内成功过 → 能；其它 → 不能（老老实实探一次）。
 */
export function canTrust(host: string, now = Date.now()): boolean {
  const h = table.get(String(host || "").toLowerCase());
  if (!h || !h.lastSuccessAt) return false;
  if (h.unavailableUntil > now) return false;
  return now - h.lastSuccessAt <= HOST_TRUST_TTL_MS;
}

/**
 * 从候选里挑最好的一个：先排除冷却中的，再按分数降序。
 * 全都在冷却里时返回 null（调用方自己决定是回退第一个还是交给页级重试）。
 */
export function pickHost(hosts: string[], now = Date.now()): string | null {
  const list = [...new Set(hosts.filter(Boolean))];
  const alive = list.filter((h) => !isCoolingDown(h, now));
  if (alive.length === 0) return null;
  // 同分时保留原顺序（稳定），便于"内置顺序"仍然有意义
  let best = alive[0];
  let bestScore = scoreOf(best, now);
  for (let i = 1; i < alive.length; i++) {
    const s = scoreOf(alive[i], now);
    if (s > bestScore) { best = alive[i]; bestScore = s; }
  }
  return best;
}

/** 按"从好到坏"排序（探针按这个顺序发，好的先测出结果） */
export function orderHosts(hosts: string[], now = Date.now()): string[] {
  return [...new Set(hosts.filter(Boolean))]
    .map((h) => ({ h, s: scoreOf(h, now) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.h);
}

/** 诊断/测试用：当前所有档案的快照 */
export function snapshot(): HostHealth[] {
  return [...table.values()].map((h) => ({ ...h }));
}

/** 清空（切换图源/重置网络状态时用；测试也用它） */
export function resetHostHealth(): void {
  table.clear();
}
