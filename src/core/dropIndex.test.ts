/**
 * 落点判定（core/dropIndex）单测 —— v3.5「快照 + 死区 + 过线 + 单向锁」版。
 *
 * ── 为什么整份重写（**判据反转，不是放宽**）────────────────────────────
 * 上一版（v3.4「接触即换位」）的断言把"**17px 就触发**"当成**期望值**（`① 三个触发点` 那条）。
 * 用户实测反馈是「**太灵敏了，稍微动一下就变化许多**」—— 那条期望值正是病根，所以：
 *   · 「越灵敏越好」→「**有死区**：半个块之内一动不动」；
 *   · 「每帧重测活几何」→「**只用起拖快照**」（本文件里有一条判别性负对照证明差别）；
 *   · 保留的旧性质：并排行的横向中线语义（用户与 e2e 都按它验收）、"移除被拖项"的下标补偿、
 *     `groupRows` 的同行判定。
 */

import { describe, expect, it } from "vitest";
import {
  DEAD_ZONE_FRACTION,
  DEAD_ZONE_MIN,
  dragStep,
  groupRows,
  initialState,
  SHADOW_CAP_FRACTION,
  SHADOW_FRACTION
} from "./dropIndex";
import type { DragSnapshot, DragState, DropBox } from "./dropIndex";

const box = (left: number, top: number, width: number, height: number): DropBox => ({ left, top, width, height });

const STACK3: DropBox[] = [box(0, 0, 300, 100), box(0, 100, 300, 100), box(0, 200, 300, 100)];
/** 一行两块，各占一半 */
const ROW2: DropBox[] = [box(0, 0, 150, 100), box(150, 0, 150, 100)];
/** 满宽 + 并排行 + 满宽 —— 三种形状混在一起 */
const MIXED: DropBox[] = [box(0, 0, 300, 100), box(0, 100, 150, 120), box(150, 100, 150, 120), box(0, 220, 300, 80)];
/** e2e 的真实形状：55 高的内嵌槽位（标题/四宫格字段那一档） */
const SMALL: DropBox[] = [box(0, 0, 300, 22), box(0, 22, 300, 22), box(0, 44, 300, 22)];

/**
 * 逐帧模拟一次拖动：**快照不变**（这正是新模型的核心约束），只移动被拖矩形。
 * 返回每一帧之后的落点、以及"真的变了"的那些落点。
 */
function simulate(
  snap: DragSnapshot,
  moves: ReadonlyArray<{ x?: number; y?: number }>
): { seen: number[]; changes: number[]; end: DragState } {
  const start = snap.boxes[snap.from >= 0 ? snap.from : 0];
  let rect = box(start.left, start.top, start.width, start.height);
  let st = initialState(snap, rect);
  const seen: number[] = [st.index];
  const changes: number[] = [];
  for (const m of moves) {
    rect = box(start.left + (m.x || 0), start.top + (m.y || 0), start.width, start.height);
    const next = dragStep(snap, rect, st);
    if (next.index !== st.index) changes.push(next.index);
    st = next;
    seen.push(st.index);
  }
  return { seen, changes, end: st };
}

const range = (a: number, b: number, step = 1) => {
  const s = Math.abs(step) || 1;
  const out: number[] = [];
  if (a <= b) for (let i = a; i <= b; i += s) out.push(i);
  else for (let i = a; i >= b; i -= s) out.push(i);
  return out;
};

/**
 * **负对照专用**：精确复刻被替换掉的 v3.4 规则 —— 门槛 = `max(6px, 两轴各 ≥ 较短边 15%)`，
 * 且**每帧用当时的活几何**（调用方每帧重测 boxes）。
 *
 * 它存在的唯一理由：证明"太灵敏"不是主观感受，而是这条规则在**20px 的微小位移**下
 * 就会换位；而新模型在同一序列里一动不动。摘掉这条负对照，就没有证据说明换模型是必要的。
 */
function legacyContactSwap(boxes: DropBox[], from: number, rect: DropBox): number {
  const hits = (a: DropBox, b: DropBox) => {
    const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
    const needW = Math.max(6, 0.15 * Math.min(a.width, b.width));
    const needH = Math.max(6, 0.15 * Math.min(a.height, b.height));
    return w >= needW && h >= needH;
  };
  let best = -1;
  let bestArea = 0;
  for (let i = 0; i < boxes.length; i++) {
    if (i === from) continue;
    if (!hits(rect, boxes[i])) continue;
    const w = Math.min(rect.left + rect.width, boxes[i].left + boxes[i].width) - Math.max(rect.left, boxes[i].left);
    const h = Math.min(rect.top + rect.height, boxes[i].top + boxes[i].height) - Math.max(rect.top, boxes[i].top);
    const a = w * h;
    if (a > bestArea) {
      bestArea = a;
      best = i;
    }
  }
  if (best < 0) return from;
  const shifted = best > from ? best - 1 : best;
  // 纵向流看运动方向：这里固定"往下拖" → 插到目标之后
  return Math.max(0, Math.min(boxes.length - 1, shifted + 1));
}

describe("边界：块数极少时不该乱动", () => {
  it("空列表 → 0（不抛异常）", () => {
    const snap: DragSnapshot = { boxes: [], from: -1 };
    const st = initialState(snap, box(0, 0, 100, 100));
    expect(dragStep(snap, box(0, 0, 100, 100), st).index).toBe(0);
  });

  it("只有一块 → 0（放哪都是它）", () => {
    const snap: DragSnapshot = { boxes: [box(0, 0, 300, 100)], from: 0 };
    expect(simulate(snap, [{ y: 50 }, { y: 500 }]).changes).toEqual([]);
  });
});

describe("① 死区：半个块之内**一动不动**（直接治'太灵敏'）", () => {
  it("常数与依据：死区 = 自身尺寸的一半（下限 24px）；影子带比例 0.5 但被 10% 上限夹住", () => {
    expect(DEAD_ZONE_FRACTION).toBe(0.5);
    expect(DEAD_ZONE_MIN).toBe(24);
    expect(SHADOW_FRACTION).toBe(0.5);
    // v3.5.2：影子带实际取 `max(24, min(0.5×主轴, 0.1×主轴))` → 22~240px 的块都是 24px。
    // 出处：GridStack 把方向滞回夹到 ≤10% 格（gridstack-core.ts:3100-3119）。
    expect(SHADOW_CAP_FRACTION).toBe(0.1);
  });

  it("【★1 判别】块高 100、间隙 10：位移 20 / 40 / 49px 全都不换位（死区 50）", () => {
    const snap: DragSnapshot = { boxes: [box(0, 0, 300, 100), box(0, 110, 300, 100), box(0, 220, 300, 100)], from: 0 };
    expect(simulate(snap, [{ y: 20 }, { y: 40 }, { y: 49 }]).changes).toEqual([]);
  });

  it("越过死区之后**才**开始动，且只动一格（不是'一动就到底'）", () => {
    const snap: DragSnapshot = { boxes: [box(0, 0, 300, 100), box(0, 110, 300, 100), box(0, 220, 300, 100)], from: 0 };
    const r = simulate(snap, [{ y: 49 }, { y: 60 }]);
    expect(r.changes).toEqual([1]);
    expect(r.end.index).toBe(1);
  });

  it("【★1 负对照】同一串位移喂给被替换掉的 v3.4 规则（活几何 + 15% 门槛）→ **立刻换位**", () => {
    // 同一串"手指只动了 20px"的位移：新模型原地不动，旧模型已经换了一格
    const snap: DragSnapshot = { boxes: [box(0, 0, 300, 100), box(0, 110, 300, 100), box(0, 220, 300, 100)], from: 0 };
    const rect20 = box(0, 20, 300, 100);
    expect(simulate(snap, [{ y: 20 }]).changes).toEqual([]); // 新：死区里 → 不动
    expect(legacyContactSwap(STACK3, 0, box(0, 20, 300, 100))).toBe(1); // 旧：接触门槛（≥15px 重叠）→ 换位
    expect(legacyContactSwap(STACK3, 0, rect20)).not.toBe(0);
  });

  it("内嵌小槽位（22px 高）走 24px 下限：拖 12px 不换位，拖 30px 才换", () => {
    const snap: DragSnapshot = { boxes: SMALL, from: 0 };
    expect(simulate(snap, [{ y: 12 }, { y: 23 }]).changes).toEqual([]);
    expect(simulate(snap, [{ y: 23 }, { y: 30 }]).changes).toEqual([1]);
  });

  it("【v3.5.3 判据反转】门槛按**目标**的尺寸算，不再按被拖块（拖大块的邻居矮 → 走得少就能换；拖小块的邻居高 → 要走更远）", () => {
    const big: DragSnapshot = { boxes: [box(0, 0, 300, 200), box(0, 200, 300, 40)], from: 0 };
    const small: DragSnapshot = { boxes: [box(0, 0, 300, 40), box(0, 40, 300, 200)], from: 0 };
    // 被拖 200 高、邻居只有 40 高 → 门槛 = max(24, 0.5×40) = 24：走 60px 就换得动
    expect(simulate(big, [{ y: 60 }]).changes).toEqual([1]);
    // 被拖只有 40 高、邻居 200 高 → 门槛 = max(24, 0.5×200) = 100：走 60px 还不够
    expect(simulate(small, [{ y: 60 }]).changes).toEqual([]);
    // ⚠️ 这两条与旧口径**恰好相反**（旧：拖 200 高要 100px、拖 40 高只要 24px）。
    // 反转的依据是实测相关性：旧口径的门槛与"被拖块尺寸" r=0.98、与目标 r=−0.14
    // → "拖大块永远木"（用户症状）；新口径与目标 r≈1.00（见调研报告 §3.2）。
  });
});

describe("①.5 每格门槛（v3.5.3 / 批次 C2）：治「换位风暴」的机器级判据", () => {
  /**
   * 这是"拖动中抖 / 抽搐 / 跳格"那条症状的**判别性**断言。
   *
   * 机制：让位动画 150ms，而旧实现第二次换位起只要 ~32px 就换一格 → 换位间隔 33~68ms
   * ⇒ 每次动画都在跑完前被打断、每次牵动 7 个元素同时动（实测 10 个间隔里 7 个 <150ms）。
   * 新实现：每一格都要"被拖块前沿越过这一格目标的中线" ⇒ 相邻两次换位之间要走**一个块距**。
   */
  it("【判别】相邻两次换位之间的位移 ≈ 一个块距（旧实现 ≈30px，这里 ≥90px）", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    // 每帧 10px 往下拖 260px，看"第一次换到 1"与"第一次换到 2"各需要多少位移
    const moves = Array.from({ length: 26 }, (_, i) => ({ y: (i + 1) * 10 }));
    const { seen } = simulate(snap, moves);
    const at = (idx: number) => seen.indexOf(idx) * 10; // seen[i] 对应 y = i×10
    expect(at(1)).toBe(50);   // 第一格 = 越过目标中线（目标 100 高 → 50）
    expect(at(2)).toBe(150);  // 第二格 = 再过一整格（+100px）—— 旧实现这里是 ~80
    expect(at(2) - at(1)).toBeGreaterThanOrEqual(90); // 换位间隔被拉开，动画才跑得完
  });

  it("位置判据（不是位移判据）：**手指停住后坑仍会追到指针位置就停**", () => {
    // 一口气拖到很远，然后连续 5 帧不动 —— 坑应当逐帧追上来并**停住**，
    // 而不是"只换一格就永远追不上"（位移判据会那样，实测踩过）。
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    const moves = [{ y: 250 }, { y: 250 }, { y: 250 }, { y: 250 }, { y: 250 }, { y: 250 }];
    const { seen, end } = simulate(snap, moves);
    expect(seen[seen.length - 1]).toBe(2);       // 追到最远的那一格
    expect(seen[seen.length - 1]).toBe(seen[seen.length - 2]); // 停住（不再推进）
    expect(end.index).toBe(2);
  });
});

describe("② 快照：换位后的重排**不可能**再产生换位（连锁的机器级否证）", () => {
  it("【★2 判别】同一 (快照, 矩形, 状态) 反复判定 → 结果完全相同（幂等，无隐藏的活几何输入）", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    const rect = box(0, 60, 300, 100);
    const st = initialState(snap, box(0, 0, 300, 100));
    const a = dragStep(snap, rect, st);
    const b = dragStep(snap, rect, st);
    expect(b.index).toBe(a.index);
    expect(b.axis).toBe(a.axis);
    expect(b.dir).toBe(a.dir);
    expect(b.origin).toEqual(a.origin);
  });

  it("【★2 判别】落点相同的一帧返回**同一个对象引用**（调用方据此跳过重渲染）", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    const st = initialState(snap, box(0, 0, 300, 100));
    expect(dragStep(snap, box(0, 10, 300, 100), st)).toBe(st);
  });

  it("【★2 结构判别】新接口**没有「活几何」这个入参**：同一快照下连判 30 帧，落点稳如泰山", () => {
    const rect = box(0, 60, 300, 100);
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    const st = initialState(snap, box(0, 0, 300, 100));
    const first = dragStep(snap, rect, st);
    let cur = first;
    // 30 帧 = 半秒；真实拖动里这半秒内 DOM 会重排好几次（换位 → FLIP 让位动画）
    for (let i = 0; i < 30; i++) cur = dragStep(snap, rect, cur);
    expect(cur.index).toBe(first.index);
    expect(cur.axis).toBe(first.axis);
    expect(cur.dir).toBe(first.dir);
    /* 对照（如实说明，不编造）：
       · 旧接口 `dropIndexAt(boxes, from, rect, hint)` 的**第一个入参就是几何** ——
         调用方每帧重测（`useCanvasDrag.dropIndexAtList`），于是"重排后的新几何"会直接进判定；
       · 本模型的快照由调用方在**起拖时**建立一次，拖动期间只在容器尺寸/滚动变化时重建并重设原点。
       两者的差别不在阈值，而在"几何从哪来"，这就是连锁被消除的地方。 */
  });

  it("【★1 附带证据】旧规则在 20px 位移上就换位（门槛 = max(6px, 15%)），新模型一动不动", () => {
    expect(legacyContactSwap(STACK3, 0, box(0, 20, 300, 100))).toBe(1);
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    expect(simulate(snap, [{ y: 20 }]).changes).toEqual([]);
  });

  it("落点是位移的**单调函数**：慢速逐像素扫下去，绝不回头、每帧最多一格、最终到末位", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    const { seen } = simulate(snap, range(0, 260).map((y) => ({ y })));
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
      expect(seen[i] - seen[i - 1]).toBeLessThanOrEqual(1);
    }
    expect(seen[seen.length - 1]).toBe(2);
  });

  it("一帧最多推进一格（快速甩动也不会一次跨两格）", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    const st0 = initialState(snap, box(0, 0, 300, 100));
    const st1 = dragStep(snap, box(0, 200, 300, 100), st0);
    expect(st1.index - st0.index).toBeLessThanOrEqual(1);
  });

  it("同向持续前进：逐帧喂更大的位移 → 依次 1、2（连续两帧各一格）", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    const r = simulate(snap, [{ y: 60 }, { y: 160 }]);
    expect(r.changes).toEqual([1, 2]);
  });
});

describe("③ 单向锁 + 影子带：换完之后不许被手抖翻回去", () => {
  it("锁定后反向 30px（< 影子带 50）→ 落点不动", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    const r = simulate(snap, [{ y: 60 }, { y: 30 }]);
    expect(r.seen[r.seen.length - 1]).toBe(1);
  });

  it("反向走过影子带 → 解锁（重设原点、落点保持），再走够死区才会回到 0", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    // 60 下行换位 → -60 是反向 120px（> 影子带 50）→ 解锁（原点重设到当前位置）
    // → 再往下走 80px（> 死区 50）→ 回到 0
    const r = simulate(snap, [{ y: 60 }, { y: -60 }, { y: -140 }]);
    expect(r.seen[r.seen.length - 1]).toBe(0);
  });

  it("轴一旦锁定，另一轴的抖动不会改落点（斜着拖不跳）", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    const r = simulate(snap, [{ y: 60 }, { x: 200, y: 60 }, { x: 400, y: 60 }]);
    expect(r.seen[r.seen.length - 1]).toBe(1);
  });

  /* ── v3.5.1：影子带量的是"最近一次换位以来"的位移，不是"起拖以来"的位移 ──
     用户实测（v3.4 包）：「往一个方向拖后不松手往另一个方向继续拖动就会变得迟钝和卡手」。
     机器级病根：换位被接受时 `origin` 不重置 → 影子带一直从**起拖点**量 →
     往下连拖 3 格（位移 200px）后想反向，要先把手拖回起拖点（-200px）再走半个块
     才解锁。修法：换位时把原点搬到当前中心，反向永远只走"最近一次换位"的半个块。 */
  it("【v3.5.1 判别】往下连拖两格后立刻反向：半影带（60px）内就要**开始**响应，而不是等拖回起拖点", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    // 60 换位① → 160 换位②（同向连拖）→ 反向 60px（= 影子带 50 < 60，且死区 50 < 60）
    // 修复后：解锁（原点在第二格中心）→ 但落点单调不回退，仍是 2；
    // 旧行为：影子带从起拖点量，反向 60 远远不够（要 -160），状态原样返回（axis 仍 2）。
    // 判据：修复后这一帧**状态对象会变**（axis 解锁为 0），旧实现原样返回旧状态。
    const r = simulate(snap, [{ y: 60 }, { y: 160 }, { y: 100 }]);
    expect(r.seen[r.seen.length - 1]).toBe(2);          // 落点不回退（单调）
    expect(r.end.axis).toBe(0);                          // 但方向锁已经随原点重置而解锁
  });

  it("【v3.5.1 判别】往下连拖两格后往回拖：60px 内解锁（旧行为要拖回起拖点，约 200px）", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    // 60 换位① → 160 换位② → 反向 60px（> 影子带 50）：**原地解锁**（原点=最近换位点），
    // 再反向 50px（> 死区 50）：回到 1。全程只往回走了 110px；
    // 旧行为（影子带从起拖点量）：center 不回到起拖点上方（-160px）+ 半个块，锁永不解开
    // —— 同一串动作落点钉死在 2（负对照见下一条）。
    const r = simulate(snap, [{ y: 60 }, { y: 160 }, { y: 100 }, { y: 40 }]);
    expect(r.seen).toEqual([0, 1, 2, 2, 1]);
  });

  it("【v3.5.1 负对照】把原点重置拆掉（影子带从起拖点量）→ 同一串回拖动弹不动", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    // 复刻旧实现：origin 永远停在起拖点（这里手工模拟——每帧都从"初始原点"判定）。
    // 60 换位① → 160 换位② → 反向 60 → 反向 50：center(y=90) 仍在起拖原点(y=50)下方
    // → along 一直为正 → 影子带永不触发解锁 → 落点钉死 2。这正是用户说的"迟钝、卡手"。
    const st0 = initialState(snap, box(0, 0, 300, 100));
    const oldOrigin = st0.origin; // 旧实现换位时不重置 origin
    let rect = box(0, 0, 300, 100);
    let st = st0;
    const seen: number[] = [st.index];
    for (const y of [60, 160, 100, 40]) {
      rect = box(0, y, 300, 100);
      const c = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const dy = c.y - oldOrigin.y;
      // 旧逻辑只有"反向超过半个块"才解锁；along 相对旧原点仍为正 → 永不解锁
      if (st.dir !== 0 && dy * st.dir < 0 && Math.abs(dy) > 50) {
        st = { axis: 0, dir: 0, index: st.index, origin: c };
      }
      const next = dragStep(snap, rect, st);
      st = { ...next, origin: st.dir === next.dir && next.axis === 2 ? oldOrigin : next.origin };
      seen.push(st.index);
    }
    expect(seen).toEqual([0, 1, 2, 2, 2]);
  });

  it("【v3.5.2 修正】反向**只付一笔**滞回：解锁那一帧之后，再走一点就回一格（不再叠加一遍死区）", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    // 换位到 2 → 反向 40（> 滞回 band = max(24, 10%×100) = 24 → 原地解锁，落点仍是 2）
    // → 再反向 30（累计 70）→ 回 1 → 再反向 50（累计 120）→ 回 0。
    // 旧实现（解锁只把原点重设到当前中心）同一条轨迹是 [0,1,2,2,2,1]：
    // 反向要累计 **120px** 才动第一格（真机反馈的"回拖迟钝、卡手"）。
    const r = simulate(snap, [{ y: 60 }, { y: 160 }, { y: 120 }, { y: 90 }, { y: 40 }]);
    expect(r.seen).toEqual([0, 1, 2, 2, 1, 0]);
  });

  it("【v3.5.2 负对照】把「解锁时推过死区」拆掉（原点只重设到当前中心）→ 同一串回拖晚一格才动", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    // 只改一件事：解锁后 origin = 当前中心（旧写法），于是下一帧还要再走一遍死区（50px）。
    // 结果：反向累计 70px 时落点仍然钉在 2，要等到 120px 才回 1 ——
    // 这条负对照钉住的正是"一次反向 = 影子带 + 死区 两笔串联"那个 bug。
    let st = initialState(snap, box(0, 0, 300, 100));
    let rect = box(0, 0, 300, 100);
    const seen: number[] = [st.index];
    for (const y of [60, 160, 120, 90, 40]) {
      rect = box(0, y, 300, 100);
      const c = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const along = c.y - st.origin.y;
      if (st.dir !== 0 && along * st.dir < 0 && Math.abs(along) > 24) {
        st = { axis: 0, dir: 0, index: st.index, origin: c }; // ← 旧写法
      }
      st = dragStep(snap, rect, st);
      seen.push(st.index);
    }
    expect(seen).toEqual([0, 1, 2, 2, 2, 1]);
  });
});

describe("④ 前后：并排行仍用横向中线（用户已验收，别动）", () => {
  it("并排行：拖块中心越过目标的横向中线 → 落到它之后", () => {
    const snap: DragSnapshot = { boxes: ROW2, from: 0 };
    // 死区（150 宽 → 75px）刚过、中心还没到 225 → 不动
    expect(simulate(snap, [{ x: 80 }]).changes).toEqual([]);
    // 中心 155+? 继续右移到 150+ → 越过中点 225
    expect(simulate(snap, [{ x: 80 }, { x: 226 }]).changes).toEqual([1]);
  });

  it("并排行：还没越过横向中线 → 即使重叠很深也不换（左半 = 之前）", () => {
    const snap: DragSnapshot = { boxes: ROW2, from: 0 };
    expect(simulate(snap, [{ x: 80 }, { x: 149 }]).changes).toEqual([]);
  });

  it("`MIXED`：并排行里的两块各自可被跨过（行分组仍然生效）", () => {
    const snap: DragSnapshot = { boxes: MIXED, from: 1 };
    const rows = groupRows(MIXED);
    expect(rows.length).toBe(3);
    expect(rows[1]).toEqual([1, 2]);
    // 从第 2 块往右拖过中线 → 与第 3 块换位（x=80 只过死区，x=200 才越过中线 225）
    const r = simulate(snap, [{ x: 80 }, { x: 200 }]);
    expect(r.seen[r.seen.length - 1]).toBe(2);
  });

  it("`groupRows`：top 差 10px 但垂直区间重叠 → 仍判为同一行", () => {
    const rows = groupRows([box(0, 0, 300, 100), box(0, 90, 300, 100)]);
    expect(rows.length).toBe(1);
  });
});

describe("⑥ 目标选择：**指针在谁格子里就是谁**（尺寸差大时'重叠最深'会被骗）", () => {
  // e2e `slot-layout` 用例⑦ 的真实几何（列表局部坐标）：半宽行 + 被拖块是满宽
  const boxes: DropBox[] = [
    box(0, 0, 378, 139),     // hero  （满宽、高）
    box(134, 145, 183, 54),  // actors（半宽、矮）
    box(329, 145, 183, 106), // tags  （半宽、高）
    box(0, 199, 378, 65)     // action（被拖、满宽）
  ];
  const snap: DragSnapshot = { boxes, from: 3 };
  const start = box(0, 199, 378, 65);
  /** 镜像中心 = 指针（抓中部时的真实关系） */
  const ghostAt = (x: number, y: number) => box(x - 189, y - 32, 378, 65);

  it("指针在 actors 左半 → 逐帧落到「actors 之前」，**不会棘到 hero**（实测的棘轮 bug）", () => {
    const st = initialState(snap, start);
    const g = ghostAt(140, 172);
    const s1 = dragStep(snap, g, st, { x: 140, y: 172 });
    expect(s1.index).toBe(2); // 一帧最多一格
    const s2 = dragStep(snap, g, s1, { x: 140, y: 172 });
    expect(s2.index).toBe(1);
    const s3 = dragStep(snap, g, s2, { x: 140, y: 172 });
    expect(s3.index).toBe(1); // 停住（指针还在 actors 里 → 不再推进）
  });

  it("指针在 actors 右半 → 「actors 之后」（同一帧两个位置给出不同落点）", () => {
    const st = initialState(snap, start);
    const g = ghostAt(300, 172);
    const s1 = dragStep(snap, g, st, { x: 300, y: 172 });
    const s2 = dragStep(snap, g, s1, { x: 300, y: 172 });
    expect(s2.index).toBe(2);
  });

  it("负对照：被拖块**很高**时'重叠最深'会一路棘到 hero（指针优先则停在 actors 之前）", () => {
    // 高被拖块（300px，desc 那种）：镜像同时压住 hero / actors / tags，
    // "重叠最深"永远选最高的 hero → 每帧一格 → 一路棘到列表顶端。
    const tallBoxes: DropBox[] = [
      box(0, 0, 378, 200),    // hero
      box(0, 205, 183, 54),   // actors
      box(189, 205, 183, 54), // tags
      box(0, 265, 378, 300)   // 被拖（很高）
    ];
    const tallSnap: DragSnapshot = { boxes: tallBoxes, from: 3 };
    const g = box(90 - 189, 232 - 150, 378, 300); // 镜像中心 = 指针 (90, 232)：actors 的左半
    const st = initialState(tallSnap, box(0, 265, 378, 300));

    let withPointer = dragStep(tallSnap, g, st, { x: 90, y: 232 });
    for (let i = 0; i < 5; i++) withPointer = dragStep(tallSnap, g, withPointer, { x: 90, y: 232 });
    expect(withPointer.index).toBe(1); // 「actors 之前」，且不再推进

    let noPointer = dragStep(tallSnap, g, st);
    for (let i = 0; i < 5; i++) noPointer = dragStep(tallSnap, g, noPointer);
    expect(noPointer.index).toBe(0); // 棘到最上面（hero 之前）—— 这就是被尺寸骗到的样子
  });
});

describe("⑤ 移除补偿与边界：'往下拖一格落到再下面一格'这类错位不该出现", () => {
  it("拖第 1 块（from=0）往下碰到第 2 块 → 落点 1", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    expect(simulate(snap, [{ y: 60 }]).changes).toEqual([1]);
  });

  it("拖第 2 块（from=1）往下碰到第 3 块 → 落点 2", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 1 };
    expect(simulate(snap, [{ y: 60 }]).changes).toEqual([2]);
  });

  it("拖第 3 块（from=2）往上一路碰到第 1 块 → 落点 0", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 2 };
    const r = simulate(snap, range(-60, -300, -20).map((y) => ({ y })));
    expect(r.seen[r.seen.length - 1]).toBe(0);
  });

  it("拖出列表底部：逐帧推到末位（不再'一口气跳过去'）", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 0 };
    const r = simulate(snap, range(0, 500, 25).map((y) => ({ y })));
    expect(r.seen[r.seen.length - 1]).toBe(2);
  });

  it("返回值永远落在 [0, n-1]", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: 2 };
    for (const y of range(-500, 500, 50)) {
      const st = dragStep(snap, box(0, y, 300, 100), initialState(snap, box(0, 200, 300, 100)));
      expect(st.index).toBeGreaterThanOrEqual(0);
      expect(st.index).toBeLessThanOrEqual(2);
    }
  });

  it("`from = -1`（调用方不知道下标）时不做移除补偿，也不越界", () => {
    const snap: DragSnapshot = { boxes: STACK3, from: -1 };
    const r = simulate(snap, [{ y: 60 }, { y: 160 }]);
    expect(r.seen[r.seen.length - 1]).toBeGreaterThanOrEqual(0);
    expect(r.seen[r.seen.length - 1]).toBeLessThanOrEqual(2);
  });
});
