/**
 * 落点判定（v3.5：「快照 + 死区 + 过线 + 单向锁」）。
 *
 * ── 为什么要再改一次（用户原话）──────────────────────────────────────
 * 「拖动时手感还很差，**太灵敏了**，稍微动一下就变化许多，可以去看看 github 上模块避让
 *   是怎么实现体验好的。」
 *
 * 上一版（v3.4「接触即换位」）把触发点压到 17~31px，方向反了。真正的病根是**判定输入是活几何**：
 * `useCanvasDrag.dropIndexAtList()` 每帧重测 `offset*`，换位 → DOM 重排 → 下一帧测到新几何
 * → 又有邻居"碰到" → **连锁换位**。于是"稍微动一下就变化许多"。
 *
 * ── 业界没有一家用"接触"（研究带着出处，见 jm-drag-research.md）────────
 *   · AndroidX `ItemTouchHelper.getMoveThreshold()` 默认 `.5f`（注释写明 "fraction of the View
 *     size"）：拖动偏移不到**自身尺寸的一半**，**连判定都不做**（死区）；
 *   · jQuery-UI sortable 默认 `tolerance: "intersect"` = 拖块**中心落入**目标；
 *   · Muuri 相交 **50%**；SortableJS swap 模式要求覆盖 **100% 目标面积**；
 *   · react-beautiful-dnd **严格越过**中心，且源码注释点名"碰到中心"会 flicker
 *     （`get-reorder-impact.js`：Update1 后退 → Update2 又前进 → Update3 boom）；
 *   · dnd-kit `shapeIntersection` 源码注释：用相交面积会 **cyclic collisions**。
 *
 * ── 本模块的模型 ────────────────────────────────────────────────────
 * **几何快照 + 死区 + 单向锁 + 单调推进 + 一帧最多一格**：
 *
 *   ① **快照**：拖动开始时测一次 `boxes`（`DragSnapshot`），**拖动期间不再重测**。
 *      判定只吃"快照 + 被拖矩形当前位置"，所以**换位后的重排不可能影响落点** ——
 *      连锁在 API 层面就是不可能的（这个函数根本没有"活几何"这个入参）。
 *      容器尺寸/滚动导致的几何变化由调用方**重新快照并重设原点**（`origin`）来处理。
 *   ② **死区**：沿主轴位移不到 `max(24px, 0.5 × 被拖块主轴尺寸)` → 落点**不变**（`axis` 保持 0）。
 *      这一条直接治"太灵敏"。两轴各自比自己的死区，谁先越过谁拿下本次拖动的轴。
 *   ③ **单向锁**：越过死区后锁定轴与方向。想反转必须先沿反方向走够
 *      `max(24px, 0.5 × 主轴尺寸)`（影子带）→ 解锁并**重设原点**（从当前处重新量死区），
 *      于是"刚换完就往回换"不可能发生。
 *      ⚠️ v3.5.1：**换位被接受时也把原点搬到当前中心** —— 影子带量的是"最近一次
 *      换位以来的位移"，不是"起拖以来的位移"。否则往一个方向连拖 N 格后想反向，
 *      得先把手指拖回起拖点再走半个块才解锁（用户实测："往一个方向拖后不松手往
 *      另一个方向继续拖动就会变得迟钝和卡手"，且拖得越远越卡）。
 *   ④ **前后**：并排行仍用**横向中线**（左半 = 之前 / 右半 = 之后，用户与 e2e 都按它验收）；
 *      纵向流用**锁定方向**（往下拖 → 插到目标之后）。
 *   ⑤ **单调 + 一帧最多一格**：候选只取"沿锁定方向、插入位置严格超过当前落点"的项，
 *      取重叠最深的那个；前进量每帧最多一格（rbd 同款：一帧一次 impact）。
 *   ⑥ 拖出列表：沿锁定方向已经没有重叠候选时，若矩形中心已越过首/末块的中心 → 落到首/末位
 *      （"拖到末尾"要靠它）。
 *
 * ── 返回值：**"移除被拖项之后**的插入位置" ───────────────────────────
 * 调用方是把 id `splice` 出来再插到 `to`，所以 `to` 是"去掉被拖项之后那个数组"里的下标：
 * 锚点在被拖项**之后**要减一（`shifted`），在被拖项**之前**下标不变。少了这步补偿，
 * 表现就是"往下拖一格，实际落到了再下面一格"。
 */
export interface DropBox {
  /** 左边界（与调用方给被拖矩形的坐标系一致即可，纯相对量） */
  left: number;
  /** 上边界 */
  top: number;
  /** 宽 */
  width: number;
  /** 高 */
  height: number;
}

/**
 * 拖动开始时的几何快照。**调用方负责"什么时候重测"**（起拖一次；容器尺寸/滚动变化时重测）。
 * 本模块是纯函数，自己不存状态、也不碰 DOM。
 */
export interface DragSnapshot {
  /** 每个块的布局矩形（顺序 = DOM 顺序 = 可见顺序） */
  boxes: readonly DropBox[];
  /** 被拖块在 `boxes` 里的下标；`-1` = 不知道（不做移除补偿） */
  from: number;
}

/** 拖动状态：调用方逐帧回传（纯函数靠它记住"锁到哪个轴了、当前落点在哪"） */
export interface DragState {
  /** 锁定的主轴：`0` = 还在死区里没锁；`1` = 横向；`2` = 纵向 */
  axis: 0 | 1 | 2;
  /** 锁定方向：`-1` 往前（上/左）、`+1` 往后（下/右）、`0` = 还没锁 */
  dir: -1 | 0 | 1;
  /** 当前被接受的插入位置（"移除被拖项之后"的下标空间） */
  index: number;
  /** 量死区用的原点（被拖矩形中心，**与 rect 同一坐标系**）；解锁时会被重设 */
  origin: { x: number; y: number };
}

/**
 * 死区的比例：**被拖块自身尺寸的一半**。
 *
 * 出处是 AndroidX `ItemTouchHelper.getMoveThreshold()` 的默认值 `.5f`（源码注释写明
 * "A float value that denotes the fraction of the View size"）—— 平台级默认值，
 * 比我们自己拍的数字可信：139px 的块要 69.5px 才开始动，而不是现在的 17px。
 */
export const DEAD_ZONE_FRACTION = 0.5;

/**
 * 死区的绝对下限（px）。内嵌槽位只有 17~22px，`0.5 × 22 = 11px` 太小（等于没有死区，
 * 手指微动就换位），所以小元素走 24px 这一档 —— 与上一版的 `REVERSE_MARGIN` 同量级。
 */
export const DEAD_ZONE_MIN = 24;

/**
 * 影子带：解锁反向所需位移的**比例上限**（配合下面的 `SHADOW_MAX_FRACTION` 取小者）。
 *
 * 语义来自 rbd 的"门限平移一个 displacement"与 SortableJS 的 `targetMoveDistance`：
 * **换位之后，反方向要再走一段才算数**，否则手指微抖就会把坑来回翻。
 *
 * ⚠️ 但"一段"取多大有讲究（v3.5.2 实测修正）：旧实现取 `0.5 × 主轴尺寸`，在 91px 高的
 * 块上就是 45.5px；再叠加"解锁后死区重新计费"的另 45.5px，用户一次反向实际要走
 * **160px**（真机反馈的"往一个方向拖后不松手往另一个方向继续拖动就会变得迟钝和卡手"）。
 * 现在这一笔被**夹到 10%**（见 `SHADOW_CAP_FRACTION`），与 GridStack 同口径。
 */
export const SHADOW_FRACTION = 0.5;

/**
 * 影子带的**绝对上限**：`≤ 10% × 主轴尺寸`（GridStack 的做法，
 * `gridstack-core.ts:3100-3119`：`mTop/mBottom` 被 `Math.min(m*, Math.round(cellHeight*0.1))` 夹住，
 * 注释写明 "need to pass mid point by margin"）。
 *
 * 与 `SHADOW_FRACTION` 取小者、再套 `DEAD_ZONE_MIN` 下限：
 * `band = max(24, min(0.5×主轴, 0.1×主轴))` —— 对 22~240px 的块实际上就是 24px。
 * 于是"反向要付的那一笔"从"半个块"降到"24px"，且与块高解耦（大块不再特别木）。
 */
export const SHADOW_CAP_FRACTION = 0.1;

/** 相交厚度小于它的当作"没相交"（亚像素边界噪声：实测相邻块差 0.5px） */
const MIN_OVERLAP = 1;

/**
 * 同一行的判定容差（px）。
 *
 * 不能拿"top 相等"当同行判据：块的纵向节奏来自各自的 `margin-top`
 * （`.d-hero` 2px、`.d-tags` 10px，疏密档位还会再变），同一网格行里
 * 两个块的 top 可以差十几像素。所以用**垂直区间是否重叠**判定。
 */
const SAME_ROW_EPS = 2;

function centerOf(b: DropBox): { x: number; y: number } {
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}

/** 两个矩形的相交面积（任一轴厚度不足 `MIN_OVERLAP` 的按 0 处理） */
function overlapArea(a: DropBox, b: DropBox): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w >= MIN_OVERLAP && h >= MIN_OVERLAP ? w * h : 0;
}

/**
 * 按**视觉行**给盒子分组（顺序 = 传入顺序 = DOM 顺序 = 可见顺序）。
 *
 * 判据：与当前行已累积的垂直区间重叠超过容差 → 同一行；否则起新行。
 * 网格行之间不会重叠（行高由内容决定），所以这个判据在网格里是稳的。
 */
export function groupRows(boxes: readonly DropBox[]): number[][] {
  const rows: number[][] = [];
  let cur: number[] = [];
  let bottom = 0;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const bBottom = b.top + b.height;
    if (cur.length === 0) {
      cur = [i];
      bottom = bBottom;
      continue;
    }
    if (b.top < bottom - SAME_ROW_EPS) {
      cur.push(i);
      bottom = Math.max(bottom, bBottom);
    } else {
      rows.push(cur);
      cur = [i];
      bottom = bBottom;
    }
  }
  if (cur.length > 0) rows.push(cur);
  return rows;
}

/**
 * 朝 `dir` 方向、离被拖块**最近**的那一块（用作起拖门槛的"目标参照"）。
 *
 * 有它才能让门槛"按目标算"：起拖那一帧还不知道落点会落在谁身上，但"朝行进方向最近的一块"
 * 就是最可能的第一个目标。拿不到（该方向上没有别的块）时调用方退回"被拖块自己的尺寸"。
 */
function nearestAhead(snap: DragSnapshot, from: number, axis: 1 | 2, dir: number, rect: DropBox): DropBox | null {
  const c = centerOf(rect);
  const ck = axis === 2 ? c.y : c.x;
  let best: DropBox | null = null;
  let bestD = Infinity;
  for (let i = 0; i < snap.boxes.length; i++) {
    if (i === from) continue;
    const b = snap.boxes[i];
    const bc = axis === 2 ? b.top + b.height / 2 : b.left + b.width / 2;
    const d = dir > 0 ? bc - ck : ck - bc;
    if (d < 0) continue; // 不在行进方向上
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

/**
 * 被拖矩形的**前沿**是否越过了目标在该轴上的**中线**（rbd 的判据；v3.5.3 的"每格门槛"）。
 *
 * ⚠️ 这是一个**位置判据**，不是"手指走了多少"的位移判据 —— 这一点很关键：
 * 位置判据允许"手指停住之后，坑继续朝指针所在的位置逐帧追赶"（一帧一格，追到就停），
 * 而位移判据会让"快速拖很远再停手"只换一格、坑永远追不上指针（实测踩过）。
 *
 * 方向：纵向 `dir>0`（向下）前沿是**下缘**，`dir<0` 是**上缘**；两者都等价于
 * "越过目标中线"。横向同理（右缘/左缘）。
 */
function crossedCentre(rect: DropBox, t: DropBox, axis: 1 | 2, dir: number): boolean {
  if (axis === 2) {
    const mid = t.top + t.height / 2;
    return dir > 0 ? rect.top + rect.height >= mid : rect.top <= mid;
  }
  const mid = t.left + t.width / 2;
  return dir > 0 ? rect.left + rect.width >= mid : rect.left <= mid;
}

/** 起拖时的初始状态：落点 = 原位、未锁轴、原点 = 被拖矩形中心 */
export function initialState(snap: DragSnapshot, rect: DropBox): DragState {
  const c = centerOf(rect);
  return {
    axis: 0,
    dir: 0,
    index: snap.from >= 0 ? snap.from : 0,
    origin: { x: c.x, y: c.y }
  };
}

/**
 * 某个候选块（快照下标 `i`）对应的插入位置。
 *
 * 并排行 → **横向中线**（左半 = 之前、右半 = 之后；用户与 e2e 都按这一轴验收，别动）；
 * 纵向流 → **锁定方向**（往下拖 = 插到它之后）。
 *
 * ⚠️ 并排行用**指针**（没给指针才退回被拖矩形中心）判左右半，而不是一律用矩形中心：
 * 被拖块常常比目标**宽得多**（一个满宽块拖到半宽块上），它的中心会在目标右半边之外，
 * 于是"落在左半"会被判成"之后"（e2e `slot-layout` 用例⑦ 实测撞到）。
 * 指针才是"用户把东西放在哪"的真值。
 */
function insertPosOf(
  snap: DragSnapshot,
  rows: number[][],
  i: number,
  rect: DropBox,
  dir: -1 | 0 | 1,
  pointer?: { x: number; y: number }
): number {
  const row = rows.find((r) => r.indexOf(i) >= 0) || [i];
  const horizontal = row.length > 1;
  const t = snap.boxes[i];
  const ref = pointer || centerOf(rect);
  const after = horizontal ? ref.x >= t.left + t.width / 2 : dir > 0;
  const shifted = snap.from >= 0 && i > snap.from ? i - 1 : i;
  return after ? shifted + 1 : shifted;
}

/**
 * 推进一帧：给定**快照**、被拖矩形当前位置、上一帧状态 → 新状态。
 *
 * 幂等：同一个 `(snap, rect, state)` 反复调用结果相同（纯函数，没有隐藏的活几何输入）。
 * 落点没变时返回**同一个对象引用**，调用方据此跳过重渲染。
 */
export function dragStep(snap: DragSnapshot, rect: DropBox, st: DragState, pointer?: { x: number; y: number }): DragState {
  const n = snap.boxes.length;
  if (n <= 1) return st;
  const from = snap.from;
  const dragged = from >= 0 ? snap.boxes[from] : null;
  const sizeX = dragged ? dragged.width : rect.width;
  const sizeY = dragged ? dragged.height : rect.height;

  const c = centerOf(rect);
  const dx = c.x - st.origin.x;
  const dy = c.y - st.origin.y;

  /**
   * ── 门槛参照物：**按目标算**（v3.5.3 / 批次 C1，路线 2）────────────────────────
   *
   * 旧口径是 AndroidX `ItemTouchHelper.getMoveThreshold()` 的默认值 —— **被拖 View 自身**
   * 尺寸的一半。实测它的后果（见调研报告 §3.2 的相关性表）：
   *   · 门槛与**被拖块尺寸**的相关性 **r=0.98**、与**目标**的相关性只有 **r=−0.14**
   *     ⇒ "拖大块永远木"（各块实测门槛 24~87px），用户原话"往一个方向拖后…变得迟钝和卡手"。
   * 新口径：**朝行进方向最近那一块**的尺寸（rbd 的"越过目标中线"、GridStack 的 `Math.round(left/cellWidth)`
   * 都是"目标参照"；13 家 Web 实现里只有 AndroidX 一家是按被拖块的）。
   * 语义也更直白：**"你要跨过那一段，就得走过它的一半"** —— 走过高的块要多走，走过矮的块就能快。
   *
   * ⚠️ 这是**有意偏离 AndroidX 默认值**的一处：依据是上面那组实测相关性 + 用户的"大块木"症状。
   * 拿不到前方块（该方向没有别的块）时退回旧口径。
   */
  const aheadY = nearestAhead(snap, from, 2, dy >= 0 ? 1 : -1, rect);
  const aheadX = nearestAhead(snap, from, 1, dx >= 0 ? 1 : -1, rect);
  const needX = Math.max(DEAD_ZONE_MIN, DEAD_ZONE_FRACTION * (aheadX ? aheadX.width : sizeX));
  const needY = Math.max(DEAD_ZONE_MIN, DEAD_ZONE_FRACTION * (aheadY ? aheadY.height : sizeY));

  let axis = st.axis;
  let dir = st.dir;
  let origin = st.origin;

  if (axis === 0) {
    /* ① 死区：**每个轴各自比自己的死区**（`max(24px, 0.5 × 被拖块在该轴的尺寸)`），
       谁越过的量（超出各自门槛的部分）多，谁拿下本次拖动。
       ⚠️ 不能要求"该轴同时是主导轴"：斜着拖时两轴都过不了"主导"这一关，于是死区永远不解除
       —— 实测撞到过（e2e `slot-layout` 用例⑦：拖一个满宽块到半宽块上，dy 与 dx 量级接近，
       而 dx 的门槛是 0.5×满宽 = 179px，于是两条分支都不成立、**落点一动不动**）。 */
    const overY = Math.abs(dy) - needY;
    const overX = Math.abs(dx) - needX;
    if (overY >= 0 && overY >= overX) {
      axis = 2;
      dir = dy > 0 ? 1 : -1;
    } else if (overX >= 0) {
      axis = 1;
      dir = dx > 0 ? 1 : -1;
    } else {
      return st; // 死区内：手指在动，落点**一动不动**
    }
  } else {
    /* ② 影子带（v3.5.2 改：**反向只付一笔**，且这一笔有上限）
    
       · **上限**：`band = max(24, min(0.5×主轴, 0.1×主轴))` = 24px（22~240px 的块）。
         旧实现是 `max(24, 0.5×主轴)`：91px 的块要 45.5px、139px 的块要 69.5px，
         而且它与"块多大"绑定 → 大块特别木（实测各块门槛 24~87px）。
         出处：GridStack 把方向滞回夹到 ≤10% 格（`gridstack-core.ts:3100-3119`）。
       · **只付一笔**：解锁时把 `origin` 沿当前位移方向**推过死区**
         （`origin = c − sign(位移) × 死区`）。旧实现只把 `origin` 重设到当前中心，
         于是下一帧轴回到"未锁"状态、**死区要重新付一遍** —— 一次反向实际是
         "影子带 + 死区"两笔串联，这就是"拖得越远越卡"的量化来源。
         推过死区之后，反向的那一帧就能直接锁定反向轴、进入候选选择。
       同向推进不受影响（单调推进只看插入位置）。 */
    const along = axis === 2 ? dy : dx;
    const main = axis === 2 ? sizeY : sizeX;
    const band = Math.max(DEAD_ZONE_MIN, Math.min(SHADOW_FRACTION * main, SHADOW_CAP_FRACTION * main));
    if (dir !== 0 && along * dir < 0 && Math.abs(along) > band) {
      const sx = axis === 2 ? 0 : Math.sign(dx);
      const sy = axis === 2 ? Math.sign(dy) : 0;
      return { axis: 0, dir: 0, index: st.index, origin: { x: c.x - sx * needX, y: c.y - sy * needY } };
    }
  }

  /* ③ 目标：**优先看指针落在谁的格子里**（jQuery-UI 的 `pointer` 容差模式），
        没有指针/指针不在任何块里（拖在缝隙或列表外）才退回"重叠最深"。

        为什么以指针优先（这条是 e2e 逼出来的）：被拖块与目标**尺寸差很大**时，
        "重叠最深"会被尺寸骗到 —— 实测 `slot-layout` 用例⑦：拖一个满宽块到半宽行上，
        目标 `actors` 高 54、邻居 `tags` 高 106，同一个 y 下 tags 的重叠比 actors 更深；
        更糟的是镜像高出 4.5px 就越过了上面一行的边界，"重叠最深"于是又给出 hero
        → 一路棘到列表顶端（实测 `["action","hero","actors",…]`，期望 `["hero","action","actors",…]`）。
        指针才是"用户把东西放在哪"的真值；几何重叠只作兜底。 */
  let pointerTarget = -1;
  if (pointer) {
    for (let i = 0; i < n; i++) {
      if (i === from) continue;
      const b = snap.boxes[i];
      if (
        pointer.x >= b.left && pointer.x <= b.left + b.width &&
        pointer.y >= b.top && pointer.y <= b.top + b.height
      ) {
        pointerTarget = i;
        break;
      }
    }
  }

  const rows = groupRows(snap.boxes);
  let bestPos = -1;
  let bestArea = 0;
  let bestBox = -1;
  if (pointerTarget >= 0) {
    const pos = insertPosOf(snap, rows, pointerTarget, rect, dir, pointer);
    if (dir > 0 ? pos > st.index : pos < st.index) { bestPos = pos; bestBox = pointerTarget; }
  } else {
    for (let i = 0; i < n; i++) {
      if (i === from) continue;
      const area = overlapArea(rect, snap.boxes[i]);
      if (area <= 0) continue;
      const pos = insertPosOf(snap, rows, i, rect, dir, pointer);
      if (dir > 0 ? pos <= st.index : pos >= st.index) continue;
      if (area > bestArea) {
        bestArea = area;
        bestPos = pos;
        bestBox = i;
      }
    }
  }

  if (bestPos >= 0) {
    /* ④ 单调推进，且**一帧最多一格**（rbd 同款：一帧一次 impact）。
       ⚠️ 换位被接受时**必须把原点搬到当前中心**（v3.5.1）：
       死区与影子带都从 `origin` 量起，而它只在"起拖 / 解锁 / 容器几何变化"时被重设 ——
       若换位不重设，往一个方向连拖 N 格后想反向，得先把手指拖回**起拖点**再走半个块
       才解锁（实测表现："往一个方向拖后不松手往另一个方向继续拖动就会变得迟钝和卡手"，
       且拖得越远越卡）。重设之后，"反向走半个块才解锁"从头到尾都是**最近一次换位**的
       半个块 —— 与上面 ③ 的文档语义一致。同向不受影响：单调推进本来就只看插入位置。 */
    const p = dir > 0 ? Math.min(bestPos, st.index + 1) : Math.max(bestPos, st.index - 1);
    const clamped = Math.max(0, Math.min(n - 1, p));
    if (clamped === st.index) return st;
    /**
     * ── **每一格都要付门槛**（v3.5.3 / 批次 C2）──────────────────────────────
     * 旧实现只在**起拖那一次**收门槛（死区），之后每换一格只看"重叠最深"翻转 ——
     * 实测第二次起**只要 32px 就换一格**，于是换位间隔落到 33~68ms，
     * 而让位动画是 150ms ⇒ **每次动画都在跑完前被打断**、每次牵动 7 个元素同时动
     * —— 这就是用户说的"拖动中画面抖 / 抽搐 / 跳格"的机器级来源（实测 10 个间隔里 7 个 <150ms）。
     *
     * 现在：**每一次**换位都要"被拖块前沿越过这一格目标的中线"（rbd 的判据，位置型）。
     * 效果：换位间隔随目标尺寸拉开（相邻块 ≈ 半个块高 + 间隙，实测 32px → 约 100px），
     * 让位动画有机会跑完；同时"手指停住后坑追到指针位置就停"，不会无休止地换。
     * 只对**纵向流**启用：并排行的左右语义本来就是"指针 vs 目标中线"（已经按目标），
     * 且被拖块常比目标宽得多，用矩形前沿判会误判（见 `insertPosOf` 的说明）。
     */
    if (axis === 2) {
      const tb = bestBox >= 0 ? snap.boxes[bestBox] : null;
      if (tb && !crossedCentre(rect, tb, axis, dir)) return st;
    }
    return { axis, dir, index: clamped, origin: c };
  }

  /* ⑤ 没有任何重叠候选：拖出列表 → 落到首/末位（"拖到末尾"靠它兜底）。
     判据用**列表自身的范围**（纵向：首块上边 / 末块下边；横向：`from` 所在行的最左/最右边缘），
     不用"最后一块的中心"—— 2D 网格里最后一块可能在中间，那个比较会误判（实测踩过：
     `MIXED` 场景里横向拖 100px 就被判成"拖出列表到末位"）。
     同样受"一帧最多一格"约束：一口气拖到列表外也要逐帧推进。
     与 ④ 同一条纪律：换位被接受 → 原点搬到当前中心（v3.5.1，理由见 ④）。 */
  if (axis === 2) {
    let top = snap.boxes[0].top;
    let bottom = snap.boxes[0].top + snap.boxes[0].height;
    for (const b of snap.boxes) {
      if (b.top < top) top = b.top;
      if (b.top + b.height > bottom) bottom = b.top + b.height;
    }
    if (dir > 0 && c.y > bottom && st.index < n - 1) return { axis, dir, index: st.index + 1, origin: c };
    if (dir < 0 && c.y < top && st.index > 0) return { axis, dir, index: st.index - 1, origin: c };
  } else {
    const row = rows.find((r) => r.indexOf(from) >= 0) || [];
    if (row.length > 0) {
      let left = Infinity;
      let right = -Infinity;
      for (const i of row) {
        const b = snap.boxes[i];
        if (b.left < left) left = b.left;
        if (b.left + b.width > right) right = b.left + b.width;
      }
      if (dir > 0 && c.x > right && st.index < n - 1) return { axis, dir, index: st.index + 1, origin: c };
      if (dir < 0 && c.x < left && st.index > 0) return { axis, dir, index: st.index - 1, origin: c };
    }
  }
  return { axis, dir, index: st.index, origin };
}
