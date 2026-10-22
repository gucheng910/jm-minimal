/**
 * 18+ 门上的**静默预取**（"偷跑"）。
 *
 * 为什么值得做：冷启动时 app 是**故意什么都不请求**的 —— 点「我已满18周岁」之后才
 * `init()` → 选线路 → `getSetting()` → 首屏列表 → 封面请求。这一串在移动网络下就是一两秒，
 * 而这段时间用户正盯着确认页读文字，完全是浪费。
 *
 * 这里做三件事（全部尽力而为，任何一步失败都只是回到改造前的时序，不影响功能）：
 *   1) `client.init()`：把 API 线路定下来（纯本地配置，不发业务请求）；
 *   2) `getSetting()`：拿到 `img_host` —— 封面 URL 靠它拼，没有它拼不出地址；
 *   3) 首屏列表（`getRandomRecommend`）拿下来**暂存**，同时把前若干张封面的字节
 *      通过 `warmCover` 落进持久缓存（Worker 里取字节，不解码、不回传位图）。
 *
 * 关键约定：
 *   · **数据只交一次**：`takePrewarmedRecommend()` 拿走后就置空，ContentView 用它替代自己的
 *     `getRandomRecommend()`，所以**不会双请求**；
 *   · **不渲染**：预取只碰数据与缓存，一个字都不往屏幕上放（18+ 门仍然挡着）；
 *   · **幂等**：重复调用无副作用（只跑一次）。
 */
import { client } from "./api";
import { albumCoverUrl } from "./coverUrl";
import { warmCover } from "./imageOffload";
import type { AlbumSummary } from "./types";

/** 首屏预取几张封面（列表首屏一般 8~12 张；预热是低优先级队列，不抢正在显示的） */
const PREWARM_COVERS = 12;

let started = false;
/** 预取到的首屏列表（只能被取走一次） */
let recommend: Promise<AlbumSummary[] | null> | null = null;

/**
 * 预取进度（诊断/测试用）：`window.__jmPrewarm`。
 * 每个阶段写一次，e2e 靠它判断"偷跑走到哪一步失败了" —— 没有它，失败看起来就只是"没变快"。
 */
function mark(patch: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __jmPrewarm?: Record<string, unknown> };
  w.__jmPrewarm = { ...(w.__jmPrewarm || {}), ...patch, at: Date.now() };
}

/**
 * 在 18+ 门显示时调用（App 的 gate effect 里）。
 * 不返回 promise：调用方不需要等它，它自己跑完就好。
 */
export function prewarmOnGate(): void {
  if (started) return;
  started = true;
  // 测试开关：`?jmprewarm=0` 关掉偷跑。
  // 有些回归用例**必须**看到"冷启动那串顺序请求"（比如"过门时要有骨架屏"、下拉刷新的请求计数），
  // 预取把这段等待抹平之后，那些断言的前提就不存在了 —— 它们在旧时序下仍然必须成立。
  if (typeof location !== "undefined" && /[?&]jmprewarm=0/.test(location.search)) {
    mark({ stage: "disabled" });
    return;
  }
  void (async () => {
    try {
      if (!client.apiBase) await client.init();
      mark({ stage: "init" });
    } catch {
      // 线路都没定下来：后面的都做不了，安静退出（点确认时还会走原来的启动流程）
      mark({ stage: "init-failed" });
      return;
    }
    if (!client.setting) {
      try { await client.getSetting(); } catch { /* 没有 img_host 就拼不出封面地址，但列表仍然可以先取 */ }
    }
    mark({ stage: "setting", imgHost: String(client.setting?.img_host || "") });

    // 首屏列表：**存下来给 ContentView 用**（两边字符串一样才叫"偷跑"，重复请求就是白花流量）
    recommend = client.getRandomRecommend().then((list) => (Array.isArray(list) ? list : null)).catch(() => null);
    const list = await recommend;
    mark({ stage: "feed", items: list ? list.length : -1 });
    if (!list || list.length === 0) return;

    // 封面预热：只落字节（不解码、不回传），命中后卡片那边就是 0 网络 + 一次解码
    let warmed = 0;
    for (const a of list.slice(0, PREWARM_COVERS)) {
      const url = albumCoverUrl(a);
      // 只统计"真的会发出请求"的：拼不出绝对地址的（裸域名/空 img_host）不算，免得诊断说谎
      if (!/^https?:/i.test(url)) continue;
      warmed += 1;
      void warmCover(url);
    }
    mark({ stage: "covers", warmed });
  })();
}

/**
 * 取走预取到的首屏列表（只能取一次）。
 * 返回 null = 没有预取（还没开始 / 已经开始但没成 / 已被取走）→ 调用方照常自己请求。
 */
export function takePrewarmedRecommend(): Promise<AlbumSummary[] | null> | null {
  const p = recommend;
  recommend = null;
  return p;
}
