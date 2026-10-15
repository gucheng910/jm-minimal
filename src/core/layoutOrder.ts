/**
 * 「展示编排」参数层的共用底座。
 *
 * detailLayout.ts（详情页）与 listLayout.ts（列表页）都需要同样三件事：
 *   · 把一份可能很脏的顺序表**归一化**（丢掉未知 id、去重、把新增的 id 补到尾部）；
 *   · 在某个列表里**前后移动**一项；
 *   · 判断某个 id 属于哪个列表。
 * 与其在两层里各写一遍，不如放这里。这个文件不认识任何具体页面 —— 只认"字符串顺序表"。
 */

/**
 * 配置面板要渲染的一样东西（一个可显隐 / 可排序的单元）。
 * 放在 core 而不是 ui：detailLayout 与 listLayout 都要产出它，
 * 而 core 不该反向依赖某个 React 组件文件。
 */
export interface LayoutItem {
  id: string;
  label: string;
  /** false = 面板上连开关都不画（画一个点了没反应的开关比不画更糟） */
  hideable: boolean;
  /** 可选的补充说明（例如"取自 album.author"） */
  note?: string;
}

/** 面板里的一个分区。分区 = 一个**独立的顺序表**，跨分区不会互相挤动。 */
export interface LayoutSection {
  key: string;
  label: string;
  hint: string;
  items: LayoutItem[];
}

/**
 * 按 known 的集合收拢 arr：
 *   1. 保留**合法**且**不重复**的项，顺序照用户给的来；
 *   2. 把 arr 里**缺的** known 项按 known 的顺序补到尾部。
 *
 * 第 2 条是关键：**将来给页面加一个新模块，老用户的配置会自动带上它**，
 * 否则新模块对老用户永远不出现 —— 是个很隐蔽的 bug（没有报错，只是"功能对我没用"）。
 */
export function orderize<T extends string>(arr: unknown, known: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  if (Array.isArray(arr)) {
    for (const v of arr) {
      if (typeof v !== "string") continue;
      if (!(known as readonly string[]).includes(v)) continue; // 未知 id 丢掉（旧版本删掉的模块）
      if (seen.has(v)) continue;                               // 去重
      seen.add(v);
      out.push(v as T);
    }
  }
  for (const k of known) if (!seen.has(k)) out.push(k);       // 缺失的补到尾部
  return out;
}

/**
 * 在 list 里把 id 前后移 delta 位。
 * 返回值刻意区分三种情况，调用方才能正确决定"要不要换掉这个列表"：
 *   · `null`      —— id 根本不在这个列表里（继续找下一个列表）
 *   · 同一个引用   —— 在，但已经到头了（不动，也不需要重建配置）
 *   · 新数组       —— 真的移动了
 */
export function moveInList<T extends string>(list: readonly T[], id: T, delta: number): readonly T[] | null {
  const i = list.indexOf(id);
  if (i < 0) return null;
  const j = i + delta;
  if (j < 0 || j >= list.length) return list;
  const next = list.slice();
  next[i] = next[j];
  next[j] = id;
  return next;
}

/**
 * 在 list 里把 id **拖到第 index 位**（拖拽排序用）。
 *
 * 与 `moveInList` 同样的返回值约定（`null` = 不在这个列表 / 同引用 = 不用动 / 新数组 = 真的动了），
 * 这样调用方能继续用同一套"逐个列表找归属"的写法。
 *
 * 为什么不能用 moveInList 凑：拖拽是**一次跳多位**，用 ±1 循环 N 次会在中途产生 N 个中间状态，
 * 每个都会触发布局重排（详情页的方块还带动画），拖起来就是一抖一抖的。
 */
export function moveToInList<T extends string>(list: readonly T[], id: T, index: number): readonly T[] | null {
  const from = list.indexOf(id);
  if (from < 0) return null;
  // 越界就夹到合法范围（手指拖出容器外是很常见的，不该报错也不该乱动）
  const to = Math.max(0, Math.min(list.length - 1, Math.round(index)));
  if (to === from) return list;
  const next = list.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
