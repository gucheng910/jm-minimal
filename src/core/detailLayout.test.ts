// @vitest-environment jsdom
/**
 * 详情页展示编排参数层（core/detailLayout）。
 *
 * 这一层是"详情页版面可配置"的地基，所以测的重点不是"能读能写"，而是**它对脏数据的自愈能力**：
 * 用户在旧版本存的配置、被手改过的 localStorage、多出来的/少掉的模块 id —— 都必须收敛成一份合法配置，
 * 否则表现是"详情页少了几个区块"或"整页白"，而且没有报错。
 *
 * 对应关系：与 core/tapZones.test.ts 同一套写法（纯函数 + localStorage）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "./constants";
import {
  DEFAULT_DETAIL_LAYOUT,
  DETAIL_BLOCK_FORMS,
  DETAIL_BLOCK_IDS,
  DETAIL_LAYOUT_VERSION,
  DETAIL_LAYOUT_VERSION_SLOTS,
  DETAIL_NODE_META,
  DETAIL_PANEL_IDS,
  FACT_IDS,
  formsFor,
  GRID_COLS,
  MIN_VISIBLE_PANELS,
  SPAN_ALLOWED,
  SPAN_OPTIONS,
  blockForm,
  blockOffset,
  blockSpan,
  defaultFormOf,
  isHidden,
  isSlotted,
  loadDetailLayout,
  moveDetailNode,
  moveDetailNodeTo,
  moveVisibleBlockTo,
  moveVisibleNodeTo,
  normalizeDetailLayout,
  packRows,
  packedVisibleRows,
  resetDetailLayout,
  rowOffsetFromCentre,
  saveDetailLayout,
  setDetailBlockForm,
  setDetailBlockOffset,
  setDetailBlockSpan,
  setDetailNodeHidden,
  visibleBlocks,
  visibleFacts,
  visibleHeroInfoSlots,
  visibleHeroSlots,
  visibleListOf,
  visiblePanels
} from "./detailLayout";
import type { DetailBlockId, SlotSpan } from "./detailLayout";

afterEach(() => { localStorage.clear(); });

describe("默认版面 = 改造前（v7.1）的实际顺序", () => {
  it("顶层区块顺序与 v7.1 的 JSX 顺序逐字一致（7 块；notice 已下线，见 core/detailLayout）", () => {
    // 这条断言是本次重构的验收线：改这个数组 = 改默认版面 = 用户看到的初始样子变了
    // v3.4（Wave I）：`notice`（付费提示）并入动作区主按钮，不再是区块 → 从 8 块变 7 块。
    expect(DEFAULT_DETAIL_LAYOUT.blocks).toEqual([
      "back", "hero", "actors", "tags", "action", "desc", "detail"
    ]);
  });

  it("notice 已下线：不在默认区块清单里，且**不可隐藏**（否则老存档的 hidden 条目会变成哑状态）", () => {
    expect(DETAIL_BLOCK_IDS).not.toContain("notice");
    expect(DETAIL_NODE_META.notice.hideable).toBe(false);
    // 类型里仍留着它（老存档读得出来），所以 normalize 必须**静默丢弃**而不是抛
    const legacy = normalizeDetailLayout({
      version: 3,
      blocks: ["back", "hero", "actors", "tags", "notice", "action", "desc", "detail"],
      spans: { tags: 6, notice: 3 },
      hidden: ["notice"]
    });
    expect(legacy.blocks).toEqual(["back", "hero", "actors", "tags", "action", "desc", "detail"]);
    expect(legacy.spans).toEqual({ tags: 6 });   // notice 的跨格一并丢弃
    expect(legacy.hidden).toEqual([]);           // 不可隐藏 → 老存档里那条被清掉
  });

  it("主视觉左右栏 = 封面在左、信息栏在右", () => {
    expect(DEFAULT_DETAIL_LAYOUT.heroSlots).toEqual(["cover", "info"]);
  });

  it("信息栏内 = 标题 / 四宫格 / 数据条", () => {
    expect(DEFAULT_DETAIL_LAYOUT.heroInfoSlots).toEqual(["title", "facts", "stat"]);
  });

  it("四宫格 = 作者 / 话数 / JM号 / 收录（2×2 行优先）", () => {
    expect(DEFAULT_DETAIL_LAYOUT.facts).toEqual(["author", "chapCount", "jmId", "addDate"]);
  });

  it("默认没有任何隐藏项", () => {
    expect(DEFAULT_DETAIL_LAYOUT.hidden).toEqual([]);
  });

  it("可见区块 = 全部区块（默认态）", () => {
    expect(visibleBlocks(DEFAULT_DETAIL_LAYOUT)).toEqual(DEFAULT_DETAIL_LAYOUT.blocks);
    expect(visibleFacts(DEFAULT_DETAIL_LAYOUT)).toEqual([...FACT_IDS]);
    expect(visibleHeroSlots(DEFAULT_DETAIL_LAYOUT)).toEqual(["cover", "info"]);
    expect(visibleHeroInfoSlots(DEFAULT_DETAIL_LAYOUT)).toEqual(["title", "facts", "stat"]);
  });
});

describe("normalize：脏数据自愈", () => {
  it("未知 id 直接丢掉（旧版本删掉的模块不会渲染出 undefined）", () => {
    const c = normalizeDetailLayout({ blocks: ["hero", "nope", "action"] });
    expect(c.blocks).not.toContain("nope" as never);
    expect(c.blocks).toContain("hero");
    expect(c.blocks).toContain("action");
  });

  it("缺失 id 补到尾部 —— 将来新增区块，老用户的配置会自动带上它", () => {
    const c = normalizeDetailLayout({ blocks: ["action", "hero"] });
    // 前两个是用户排的顺序，其余按内置顺序补齐
    expect(c.blocks.slice(0, 2)).toEqual(["action", "hero"]);
    expect(c.blocks).toHaveLength(DEFAULT_DETAIL_LAYOUT.blocks.length);
    expect(new Set(c.blocks).size).toBe(c.blocks.length); // 无重复、无遗漏
    expect(c.blocks).toContain("desc");
  });

  it("重复 id 去重", () => {
    const c = normalizeDetailLayout({ facts: ["jmId", "jmId", "author"] });
    expect(c.facts).toEqual(["jmId", "author", "chapCount", "addDate"]);
  });

  it("非字符串 / 数组里的杂项被忽略", () => {
    const c = normalizeDetailLayout({ blocks: [1, null, {}, "hero"] as unknown[] });
    expect(c.blocks[0]).toBe("hero");
    expect(c.blocks).toHaveLength(DEFAULT_DETAIL_LAYOUT.blocks.length);
  });

  it("【关键】动作区不允许隐藏（藏了就走不出去）；v3.3 起 back 允许隐藏", () => {
    const c = normalizeDetailLayout({ hidden: ["back", "action", "tags"] });
    // back 改为可隐藏是**用户明确要求**（"手机上其实一些用户用不上"）——
    // 它不再是"藏了就走不出去"的节点：编辑器有顶栏返回、系统返回键也仍在
    expect(c.hidden).toContain("back");
    expect(c.hidden).not.toContain("action"); // 唯一还钉死的出口
    expect(c.hidden).toContain("tags");       // 其余的照常生效
  });

  it("hidden 里的未知 id 被丢掉", () => {
    const c = normalizeDetailLayout({ hidden: ["tags", "ghost-id"] });
    expect(c.hidden).toEqual(["tags"]);
  });

  it("完全不是对象 / 是 null / 是字符串 → 回落默认", () => {
    for (const bad of [null, undefined, "nope", 42, [], true]) {
      const c = normalizeDetailLayout(bad);
      expect(c.blocks).toEqual(DEFAULT_DETAIL_LAYOUT.blocks);
      expect(c.facts).toEqual(DEFAULT_DETAIL_LAYOUT.facts);
      expect(c.hidden).toEqual([]);
    }
  });

  it("version 总是被写成当前版本（结构迁移的锚点）", () => {
    expect(normalizeDetailLayout({ version: 0 }).version).toBe(DETAIL_LAYOUT_VERSION);
    expect(normalizeDetailLayout(undefined).version).toBe(DETAIL_LAYOUT_VERSION);
  });
});

describe("变更：纯函数，入参不被改", () => {
  it("moveDetailNode 交换相邻两项", () => {
    const before = resetDetailLayout();
    const frozen = JSON.stringify(before);
    const after = moveDetailNode(before, "desc", -1);
    expect(after.blocks.indexOf("desc")).toBe(before.blocks.indexOf("desc") - 1);
    expect(JSON.stringify(before)).toBe(frozen); // 入参原封不动
  });

  it("moveDetailNode 在四宫格 / 主视觉 / 左右栏里同样生效", () => {
    const c = resetDetailLayout();
    // facts 默认 ["author","chapCount","jmId","addDate"] → jmId 前移一位 = 和 chapCount 换位
    expect(moveDetailNode(c, "jmId", -1).facts).toEqual(["author", "jmId", "chapCount", "addDate"]);
    expect(moveDetailNode(c, "stat", -1).heroInfoSlots).toEqual(["title", "stat", "facts"]);
    expect(moveDetailNode(c, "info", -1).heroSlots).toEqual(["info", "cover"]);
  });

  it("moveDetailNode 越界时原样返回（面板的上移/下移到头了就按不动）", () => {
    const c = resetDetailLayout();
    expect(moveDetailNode(c, "back", -1)).toBe(c);                                   // 已在首位
    expect(moveDetailNode(c, "detail", +1)).toBe(c);                                 // 已在末位
    expect(moveDetailNode(c, "author", -1)).toBe(c);                                 // 四宫格首位
  });

  it("moveDetailNode 对一个不在任何列表里的 id 返回原对象", () => {
    const c = resetDetailLayout();
    expect(moveDetailNode(c, "ghost" as never, 1)).toBe(c);
  });

  it("setDetailNodeHidden 能藏能显", () => {
    const a = setDetailNodeHidden(resetDetailLayout(), "tags", true);
    expect(a.hidden).toContain("tags");
    expect(visibleBlocks(a)).not.toContain("tags");
    const b = setDetailNodeHidden(a, "tags", false);
    expect(b.hidden).not.toContain("tags");
    expect(visibleBlocks(b)).toContain("tags");
  });

  it("setDetailNodeHidden 对不允许隐藏的节点是空操作（v3.3 起只剩 action / info）", () => {
    const c = resetDetailLayout();
    expect(setDetailNodeHidden(c, "action", true)).toBe(c);
    expect(setDetailNodeHidden(c, "info", true)).toBe(c);
    // back 已改为**可隐藏**（用户要求），所以它不再是空操作
    expect(setDetailNodeHidden(c, "back", true).hidden).toContain("back");
  });

  it("setDetailNodeHidden 重复设同一个值时返回原对象（避免无谓重渲）", () => {
    const c = setDetailNodeHidden(resetDetailLayout(), "tags", true);
    expect(setDetailNodeHidden(c, "tags", true)).toBe(c);
  });

  it("resetDetailLayout 回到默认且不共享数组引用", () => {
    const a = resetDetailLayout();
    a.blocks.length = 0;      // 掏空 a 的数组（若与默认共享引用，默认会被一起掏空）
    a.hidden.push("tags");
    const b = resetDetailLayout();
    expect(b.blocks).toEqual(DEFAULT_DETAIL_LAYOUT.blocks);
    expect(b.hidden).toEqual([]);
    // 默认值本身没被上一次的改动污染（v3.4：7 块 —— notice 已下线）
    expect(DEFAULT_DETAIL_LAYOUT.blocks).toHaveLength(7);
    expect(DEFAULT_DETAIL_LAYOUT.hidden).toEqual([]);
  });
});

describe("持久化：读时自愈", () => {
  it("没存过 → 返回默认版面", () => {
    expect(loadDetailLayout()).toEqual(DEFAULT_DETAIL_LAYOUT);
  });

  it("存了再读能往返（含隐藏与顺序）", () => {
    const cfg = setDetailNodeHidden(moveDetailNode(resetDetailLayout(), "desc", -1), "tags", true);
    saveDetailLayout(cfg);
    const back = loadDetailLayout();
    expect(back.hidden).toEqual(["tags"]);
    expect(back.blocks.indexOf("desc")).toBe(cfg.blocks.indexOf("desc"));
  });

  it("【关键】localStorage 里是坏 JSON → 回落默认，绝不抛", () => {
    localStorage.setItem(UI_KEYS.detailLayout, "{ 这不是 JSON");
    expect(() => loadDetailLayout()).not.toThrow();
    expect(loadDetailLayout()).toEqual(DEFAULT_DETAIL_LAYOUT);
  });

  it("【关键】localStorage 里是合法 JSON 但结构不对 → 走 normalize 自愈", () => {
    localStorage.setItem(UI_KEYS.detailLayout, JSON.stringify({ blocks: "全部", hidden: 5 }));
    const c = loadDetailLayout();
    expect(c.blocks).toEqual(DEFAULT_DETAIL_LAYOUT.blocks);
    expect(c.hidden).toEqual([]);
  });

  it("保存时也会 normalize（存进去的就是合法的）", () => {
    // 用 action 做样本：它是**唯一**仍然钉死的节点（v3.3 起 back 可隐藏了）
    saveDetailLayout({ version: 9, blocks: ["hero"], hidden: ["action"] } as never);
    const raw = JSON.parse(localStorage.getItem(UI_KEYS.detailLayout) as string);
    expect(raw.blocks).toHaveLength(DEFAULT_DETAIL_LAYOUT.blocks.length);
    expect(raw.hidden).toEqual([]); // action 不可隐藏（藏了就走不出去）
  });

  it("用的 key 是 UI_KEYS.detailLayout（别处按这个 key 清数据）", () => {
    saveDetailLayout(resetDetailLayout());
    expect(localStorage.getItem(UI_KEYS.detailLayout)).toBeTruthy();
  });
});

/**
 * v3「流式槽位」：每块可设 12 列里的**有界档位**，两个半宽块自然并排。
 *
 * 这一组的重点同样是**红线**而不是功能：默认/老配置下 `isSlotted()` 必须是 false，
 * 否则 `.detail-card` 会被切到 `display:grid`，改变 margin 折叠行为 →
 * "线上 DOM 逐字不变"破了（而且是只在真机慢速滚动时才看得出的那种破）。
 */
describe("v3 流式槽位：跨格宽度（v3.3 起窄屏降级已取消）", () => {
  it("默认配置：spans 为空、版本仍是 v1（不自动升级）", () => {
    expect(DEFAULT_DETAIL_LAYOUT.spans).toEqual({});
    expect(DEFAULT_DETAIL_LAYOUT.version).toBe(DETAIL_LAYOUT_VERSION);
    expect(isSlotted(DEFAULT_DETAIL_LAYOUT)).toBe(false);
  });

  it("【红线】老配置（version 1）即使带着 spans 字段也不认，版本也不变", () => {
    const c = normalizeDetailLayout({ version: 1, blocks: ["hero", "tags"], spans: { tags: 6 } });
    expect(c.version).toBe(1);
    expect(c.spans).toEqual({});
    expect(isSlotted(c)).toBe(false);
  });

  it("版本缺失 / 被手改成 9 → 都回落 v1（只有显式 3 才认）", () => {
    expect(normalizeDetailLayout({ spans: { tags: 6 } }).version).toBe(1);
    expect(normalizeDetailLayout({ version: 9, spans: { tags: 6 } }).version).toBe(1);
    expect(normalizeDetailLayout({ version: "3", spans: { tags: 6 } }).version).toBe(1);
  });

  it("v3：合法档位保留；非法值**丢弃并回落 12**（不是夹取）；等于 12 的不入表", () => {
    const c = normalizeDetailLayout({
      version: 3,
      spans: { tags: 6, actors: 4, hero: 7, desc: 12, notice: "x", back: null }
    });
    expect(c.spans).toEqual({ tags: 6, actors: 4 });
    expect(blockSpan(c, "hero")).toBe(12);   // 非法 7 → 回默认，而不是变成 7 或 3
    expect(blockSpan(c, "desc")).toBe(12);
    expect(blockSpan(c, "notice")).toBe(12);
  });

  it("isSlotted：v3 但全是满宽 → **不**切网格（只改过顺序的用户不吃 margin 折叠差异）", () => {
    const c = normalizeDetailLayout({ version: 3, blocks: ["hero", "tags"], spans: {} });
    expect(c.version).toBe(3);
    expect(isSlotted(c)).toBe(false);
  });

  it("isSlotted：有窄块才切；窄块被隐藏 → 不切", () => {
    expect(isSlotted(normalizeDetailLayout({ version: 3, spans: { tags: 6 } }))).toBe(true);
    expect(isSlotted(normalizeDetailLayout({ version: 3, spans: { tags: 6 }, hidden: ["tags"] }))).toBe(false);
  });

  it("setDetailBlockSpan：改值升到 v3；设回 12 删键；值没变返回同引用", () => {
    const c = setDetailBlockSpan(DEFAULT_DETAIL_LAYOUT, "tags", 6);
    expect(c.version).toBe(3);
    expect(c.spans).toEqual({ tags: 6 });
    expect(setDetailBlockSpan(c, "tags", 6)).toBe(c);        // 同引用 → 不触发重渲染
    expect(setDetailBlockSpan(DEFAULT_DETAIL_LAYOUT, "tags", 12)).toBe(DEFAULT_DETAIL_LAYOUT);
    const back = setDetailBlockSpan(c, "tags", 12);
    expect(back.spans).toEqual({});
    expect(isSlotted(back)).toBe(false);                     // 全满宽 → 退回纵向流
  });

  it("【v3.3】返回块可隐藏（用户要求）；动作区仍钉死（藏了就走不出去）", () => {
    expect(DETAIL_NODE_META.back.hideable).toBe(true);
    expect(DETAIL_NODE_META.action.hideable).toBe(false);
    // 藏了要真的进 hidden 名单（normalize 的闸门也放它过去）
    const c = setDetailNodeHidden(DEFAULT_DETAIL_LAYOUT, "back", true);
    expect(isHidden(c, "back")).toBe(true);
    expect(normalizeDetailLayout({ version: 3, hidden: ["back"] }).hidden).toEqual(["back"]);
    // 动作区仍然藏不动
    expect(setDetailNodeHidden(DEFAULT_DETAIL_LAYOUT, "action", true)).toBe(DEFAULT_DETAIL_LAYOUT);
    // 恢复默认把两者一起清掉
    expect(isHidden(resetDetailLayout(), "back")).toBe(false);
  });

  it("恢复默认：宽度清掉，回到「从没配过」的状态", () => {
    const c = setDetailBlockSpan(DEFAULT_DETAIL_LAYOUT, "tags", 4);
    expect(isSlotted(c)).toBe(true);
    const r = resetDetailLayout();
    expect(r.spans).toEqual({});
    expect(r).toEqual(DEFAULT_DETAIL_LAYOUT);
  });

  it("存盘/读盘往返：v3 的宽度不丢、不被升版也不被降版", () => {
    saveDetailLayout(setDetailBlockSpan(DEFAULT_DETAIL_LAYOUT, "actors", 6));
    const back = loadDetailLayout();
    expect(back.version).toBe(3);
    expect(blockSpan(back, "actors")).toBe(6);
    expect(isSlotted(back)).toBe(true);
  });

  it("隐藏的窄块仍保留 span（取消隐藏后并排回来），只是不参与门控", () => {
    const c = setDetailBlockSpan(DEFAULT_DETAIL_LAYOUT, "tags", 6);
    const h = setDetailNodeHidden(c, "tags", true);
    expect(isSlotted(h)).toBe(false);
    expect(blockSpan(h, "tags")).toBe(6);
    expect(isSlotted(setDetailNodeHidden(h, "tags", false))).toBe(true);
  });

  it("四个档位都被接受，且互不干扰", () => {
    let c = DEFAULT_DETAIL_LAYOUT;
    for (const [id, span] of [["tags", 6], ["actors", 4], ["desc", 3], ["detail", 8]] as const) {
      c = setDetailBlockSpan(c, id, span);
    }
    expect(c.spans).toEqual({ tags: 6, actors: 4, desc: 3, detail: 8 });
    expect(blockSpan(c, "action")).toBe(12);
  });
});

/**
 * 画布拖拽的落点（`moveVisibleBlockTo`）。
 *
 * 断言一律看**可见顺序**（`visibleBlocks`）而不是原始数组 —— 用户看到、
 * 能拖的就是可见顺序，原始数组里那些隐藏项他既看不见也拖不着。
 */
describe("画布拖拽落点：可见顺序下标 → 原始数组（Slot-2）", () => {
  /** 可见顺序（= 画布上的块顺序） */
  const vis = (c: ReturnType<typeof normalizeDetailLayout>) => visibleBlocks(c);

  it("无隐藏块：拖到可见下标 1 = 落在第二个可见块之前", () => {
    const c = moveVisibleBlockTo(DEFAULT_DETAIL_LAYOUT, "back", 1);
    expect(vis(c).slice(0, 3)).toEqual(["hero", "back", "actors"]);
  });

  it("无隐藏块：拖到 rest.length = 追加到末尾", () => {
    // 7 个可见块里把 back 拖走 → rest 有 6 个，所以"末尾"这个下标是 6（v3.4 前是 7）
    const c = moveVisibleBlockTo(DEFAULT_DETAIL_LAYOUT, "back", 6);
    expect(vis(c)[vis(c).length - 1]).toBe("back");
    expect(vis(c)[0]).toBe("hero");
  });

  it("**有隐藏块时也落在同一可见位置**（这条是本次修的病根）", () => {
    // 隐藏 hero（它在原始数组里排在 back 之后、tags 之前）
    const base = setDetailNodeHidden(DEFAULT_DETAIL_LAYOUT, "hero", true);
    expect(vis(base)).toEqual(["back", "actors", "tags", "action", "desc", "detail"]);

    // 把 back 拖到"可见下标 1" = 落在 actors 之后、tags 之前
    const c = moveVisibleBlockTo(base, "back", 1);
    expect(vis(c).slice(0, 3)).toEqual(["actors", "back", "tags"]);

    // 对照：把同一个"可见下标"喂给按原始数组取号的旧函数 → back 会跑到可见第 0 位（偏一位）
    const wrong = moveDetailNodeTo(base, "back", 1);
    expect(vis(wrong)[0]).toBe("back");
  });

  it("隐藏块在末尾时，追加到末尾仍落在所有可见块之后", () => {
    const base = setDetailNodeHidden(DEFAULT_DETAIL_LAYOUT, "detail", true);
    const c = moveVisibleBlockTo(base, "back", 6);
    expect(vis(c)[vis(c).length - 1]).toBe("back");
  });

  it("原地不动 → 返回同引用（不触发重渲染）", () => {
    expect(moveVisibleBlockTo(DEFAULT_DETAIL_LAYOUT, "back", 0)).toBe(DEFAULT_DETAIL_LAYOUT);
  });

  it("不是可见的顶层块 → 原样返回", () => {
    // 藏起来的块画布上根本不渲染，也就不该被拖：真被传进来必须原样返回、不产生变更
    const hiddenTags = setDetailNodeHidden(DEFAULT_DETAIL_LAYOUT, "tags", true);
    expect(moveVisibleBlockTo(hiddenTags, "tags", 1)).toBe(hiddenTags);
    expect(moveVisibleBlockTo(DEFAULT_DETAIL_LAYOUT, "hero", 99) === DEFAULT_DETAIL_LAYOUT).toBe(false);
  });

  it("下标越界被夹住，不会抛错也不会丢块", () => {
    const N = visibleBlocks(DEFAULT_DETAIL_LAYOUT).length; // 7（v3.4：notice 下线后）
    for (const p of [-5, -1, 999]) {
      const c = moveVisibleBlockTo(DEFAULT_DETAIL_LAYOUT, "back", p);
      expect(vis(c).length).toBe(N);
      expect(new Set(vis(c)).size).toBe(N);
    }
  });
});

/**
 * v3 内嵌可拖：同一套折算要能用在**内嵌的三张表**上（heroSlots / heroInfoSlots / facts）。
 *
 * 这里最要紧的一条是 `stat` 的**条件渲染**：`heroInfoSlots` 的配置恒为
 * `[title, facts, stat]`，但 `views || likes` 都为 0 时 `.d-stat` 根本不渲染，
 * DOM 里只有 `[title, facts]` —— 于是"DOM 下标"与"配置下标"不是一回事。
 * `moveVisibleNodeTo` 取的是"移除被拖项之后的第 p 个"（纯顺序语义），所以不受影响；
 * 这几条用例就是钉住这条性质的。
 */
describe("内嵌槽位落点：可见顺序下标 → 配置下标（v3 内嵌可拖）", () => {
  it("heroInfoSlots：把 title 拖到可见下标 1 → 落在 facts 之后、stat 之前", () => {
    const c = moveVisibleNodeTo(DEFAULT_DETAIL_LAYOUT, "title", 1);
    expect(c.heroInfoSlots).toEqual(["facts", "title", "stat"]);
  });

  it("heroInfoSlots：stat 未渲染（DOM 只有 [title,facts]）时，把 facts 拖到 0 仍落在 title 之前", () => {
    // 配置是 [title, facts, stat]，但画布上只有两项。顺序语义必须仍然正确。
    const c = moveVisibleNodeTo(DEFAULT_DETAIL_LAYOUT, "facts", 0);
    expect(c.heroInfoSlots).toEqual(["facts", "title", "stat"]);
  });

  it("heroInfoSlots：拖到末位（追加）→ stat 落在最后", () => {
    const c = moveVisibleNodeTo(DEFAULT_DETAIL_LAYOUT, "title", 2);
    expect(c.heroInfoSlots).toEqual(["facts", "stat", "title"]);
  });

  it("heroSlots：把 info 拖到 0 → 封面换到右边（左右互换）", () => {
    const c = moveVisibleNodeTo(DEFAULT_DETAIL_LAYOUT, "info", 0);
    expect(c.heroSlots).toEqual(["info", "cover"]);
    expect(c.blocks).toEqual(DEFAULT_DETAIL_LAYOUT.blocks); // 别的表一个字都不许动
  });

  it("facts：把 JM号 拖到 0 → 四宫格行优先序跟着变", () => {
    const c = moveVisibleNodeTo(DEFAULT_DETAIL_LAYOUT, "jmId", 0);
    expect(c.facts).toEqual(["jmId", "author", "chapCount", "addDate"]);
  });

  it("facts：藏掉一个字段后，可见空间的下标仍然落对", () => {
    const base = setDetailNodeHidden(DEFAULT_DETAIL_LAYOUT, "author", true);
    // 可见顺序 = [chapCount, jmId, addDate]；把 addDate 拖到可见下标 0
    const c = moveVisibleNodeTo(base, "addDate", 0);
    expect(visibleFacts(c)).toEqual(["addDate", "chapCount", "jmId"]);
    // 被藏的字段仍然在原始数组里（隐藏 ≠ 删除），且总数不变
    expect(c.facts).toContain("author");
    expect(c.facts.length).toBe(4);
  });

  it("原地不动 → 返回同引用（不触发重渲染）", () => {
    expect(moveVisibleNodeTo(DEFAULT_DETAIL_LAYOUT, "title", 0)).toBe(DEFAULT_DETAIL_LAYOUT);
    expect(moveVisibleNodeTo(DEFAULT_DETAIL_LAYOUT, "author", 0)).toBe(DEFAULT_DETAIL_LAYOUT);
  });

  it("自身被隐藏 / 不在任何表里 → 原样返回", () => {
    const hiddenTitle = setDetailNodeHidden(DEFAULT_DETAIL_LAYOUT, "title", true);
    expect(moveVisibleNodeTo(hiddenTitle, "title", 1)).toBe(hiddenTitle);
    expect(moveVisibleNodeTo(DEFAULT_DETAIL_LAYOUT, "back", 99) === DEFAULT_DETAIL_LAYOUT).toBe(false);
  });

  it("顶层块走同一条路（回归保护：委托不能改变既有语义）", () => {
    expect(moveVisibleNodeTo(DEFAULT_DETAIL_LAYOUT, "back", 1)).toEqual(
      moveVisibleBlockTo(DEFAULT_DETAIL_LAYOUT, "back", 1)
    );
  });
});

/**
 * v3.4：宽度加 3/4 档（9 列）+ 行内位置（offset）+ 行排布算法（packRows）。
 *
 * 用户第 7 条原话：「宽度加 3/4 档；同一行只有一个组件且不满宽时该行空处要有空占位，
 * 使 1/2 宽区块可固定在该行中间而不是必须顶格。」→ 位置必须进模型、必须能在线上渲染，
 * 且**默认（offset 全 0）时排布与旧版 auto-placement 逐项相同**（红线）。
 */
describe("v3.4 宽度 3/4 档", () => {
  it("白名单与档位表都含 9，且顺序是「大 → 小」", () => {
    expect(SPAN_ALLOWED).toContain(9);
    const spans = SPAN_OPTIONS.map((o) => o.span);
    expect(spans).toEqual([12, 9, 8, 6, 4, 3]);
    expect(SPAN_OPTIONS.find((o) => o.span === 9)?.label).toBe("3/4");
  });

  it("normalize 认 9（v3 配置）；非法值仍然丢弃", () => {
    const c = normalizeDetailLayout({ version: 3, blocks: ["hero", "tags"], spans: { tags: 9 } });
    expect(c.spans.tags).toBe(9);
    expect(blockSpan(c, "tags")).toBe(9);
    expect(normalizeDetailLayout({ version: 3, spans: { tags: 5 } }).spans.tags).toBeUndefined();
  });

  it("9 + 3 刚好凑满一行（这就是 9 这个档位的语义）", () => {
    const c = normalizeDetailLayout({ version: 3, blocks: ["hero", "tags"], spans: { hero: 9, tags: 3 } });
    const rows = packRows(c, ["hero", "tags"]);
    expect(rows.length).toBe(1);
    expect(rows[0].slots.map((s) => [s.col, s.span])).toEqual([[0, 9], [9, 3]]);
    expect(rows[0].gaps).toEqual([]);
  });
});

describe("v3.4 行内位置（offset）", () => {
  it("默认 0；范围夹在 0 ~ 12-span（满宽块恒 0）", () => {
    expect(blockOffset(DEFAULT_DETAIL_LAYOUT, "tags")).toBe(0);
    const c = setDetailBlockOffset(setDetailBlockSpan(DEFAULT_DETAIL_LAYOUT, "tags", 6), "tags", 99);
    expect(blockOffset(c, "tags")).toBe(GRID_COLS - 6); // 12-6 = 6
    expect(blockOffset(setDetailBlockSpan(DEFAULT_DETAIL_LAYOUT, "tags", 6), "tags")).toBe(0);
    expect(blockOffset(DEFAULT_DETAIL_LAYOUT, "hero")).toBe(0);
  });

  it("set 会写进配置并升到 v3；回 0 会把字段删掉（顶格 = 不写）", () => {
    const six = setDetailBlockSpan(DEFAULT_DETAIL_LAYOUT, "tags", 6);
    const mid = setDetailBlockOffset(six, "tags", 3);
    expect(mid.version).toBe(DETAIL_LAYOUT_VERSION_SLOTS);
    expect(mid.offsets).toEqual({ tags: 3 });
    expect(setDetailBlockOffset(mid, "tags", 0).offsets).toEqual({});
  });

  it("【红线】老配置（version 1）带 offset 也不认，且不升版本", () => {
    const c = normalizeDetailLayout({ version: 1, spans: { tags: 6 }, offsets: { tags: 3 } });
    expect(c.version).toBe(1);
    expect(c.offsets).toEqual({});
    expect(isSlotted(c)).toBe(false);
  });

  it("normalize：满宽块的 offset 丢弃；超范围的夹回；非法类型丢弃", () => {
    const c = normalizeDetailLayout({
      version: 3,
      spans: { tags: 6 },
      offsets: { tags: 3, hero: 4, desc: "2" }
    });
    expect(c.offsets).toEqual({ tags: 3 });          // hero 满宽 → 丢；desc 不是数字 → 丢
    const clamped = normalizeDetailLayout({ version: 3, spans: { tags: 6 }, offsets: { tags: 99 } });
    expect(clamped.offsets.tags).toBe(6);
    const neg = normalizeDetailLayout({ version: 3, spans: { tags: 6 }, offsets: { tags: -3 } });
    expect(neg.offsets).toEqual({});
  });

  it("宽度改回满宽时位置一起清掉（不留自相矛盾的存档）", () => {
    const mid = setDetailBlockOffset(setDetailBlockSpan(DEFAULT_DETAIL_LAYOUT, "tags", 6), "tags", 3);
    const full = setDetailBlockSpan(mid, "tags", 12);
    expect(full.offsets).toEqual({});
    expect(full.spans).toEqual({});
    expect(isSlotted(full)).toBe(false);
  });

  it("reset 把位置一起清掉", () => {
    const mid = setDetailBlockOffset(setDetailBlockSpan(DEFAULT_DETAIL_LAYOUT, "tags", 6), "tags", 3);
    expect(resetDetailLayout().offsets).toEqual({});
    expect(resetDetailLayout()).not.toEqual(mid);
  });
});

describe("v3.5.2 rowOffsetFromCentre：拖动落进行内空位（用户第 2 条反馈）", () => {
  /* 行宽 372（390 视口减边距）、12 列、无间隙 → 列距 31。与 e2e 的 390 视口同量级。 */
  const ROW = { left: 0, pitch: 372 / 12 };
  const colW = ROW.pitch;

  it("【核心】1/2（span 6）块心在行正中 → 落到居中列 3（两侧各 3 列空位）", () => {
    expect(rowOffsetFromCentre(ROW, 6, 186)).toBe(3);
  });

  it("【核心】1/3（span 4）块心在行正中 → 居中列 4；块心到行末 → 最右列 8", () => {
    expect(rowOffsetFromCentre(ROW, 4, colW * 6)).toBe(4);
    expect(rowOffsetFromCentre(ROW, 4, colW * 12)).toBe(12 - 4);
  });

  it("【v3.5.2 修正】块心不动 → 列不变（所以**抓左缘/抓右缘都一样**）", () => {
    // 本函数只吃"块心"，抓取点天然不参与 —— 旧的 rowOffsetFromPointer 吃**指针绝对位置**，
    // 抓右缘起拖时 col 会立刻变成 12−span（实测 span6 跳 3 列 ≈ 91px，手指还没动）。
    // "调用点必须传块心、不许传指针"这条契约由 e2e（editor-shell 的抓右缘用例）钉住。
    expect(rowOffsetFromCentre(ROW, 6, colW * 5)).toBe(2);
    expect(rowOffsetFromCentre(ROW, 6, colW * 5)).toBe(rowOffsetFromCentre(ROW, 6, colW * 5));
  });

  it("就近（50%）吸附：分界在两列中点（round），不是「过列分界线才跳」", () => {
    // span 6：列 c 的中心 = (c + 3) × 列距 → 列 0/1 分界 = 3.5 列距、列 1/2 分界 = 4.5 列距
    expect(rowOffsetFromCentre(ROW, 6, colW * 3.5 - 0.5)).toBe(0);
    expect(rowOffsetFromCentre(ROW, 6, colW * 3.5 + 0.5)).toBe(1);
    expect(rowOffsetFromCentre(ROW, 6, colW * 4.5 - 0.5)).toBe(1);
    expect(rowOffsetFromCentre(ROW, 6, colW * 4.5 + 0.5)).toBe(2);
  });

  it("有界：块心越出行（负 / 超宽）夹回端点列，不产生非法值", () => {
    expect(rowOffsetFromCentre(ROW, 6, -50)).toBe(0);
    expect(rowOffsetFromCentre(ROW, 6, colW * 12 + 50)).toBe(12 - 6);
  });

  it("满宽（span 12）→ 恒 0；列距量不到（0）→ 回顶格不猜", () => {
    expect(rowOffsetFromCentre(ROW, 12, colW * 6)).toBe(0);
    expect(rowOffsetFromCentre({ left: 0, pitch: 0 }, 6, 100)).toBe(0);
  });

  it("【v3.5.2 修正】行左缘不为 0 时按**行的左缘**算（旧实现拿被拖块左缘当行起点 → 居中块一抓掉回最左）", () => {
    const row = { left: 24, pitch: colW };
    expect(rowOffsetFromCentre(row, 6, 24 + colW * 6)).toBe(3); // 行正中 → 居中
    expect(rowOffsetFromCentre(row, 6, 24 + colW * 9)).toBe(6); // 行右缘 → 最右
    expect(rowOffsetFromCentre(row, 6, 24 + colW * 3)).toBe(0); // 行首 → 顶格
  });
});

describe("v3.4 packRows：行排布 + 空占位", () => {
  /** 造一份"只关心这几块"的配置 */
  const cfgWith = (spans: Record<string, number>, offsets: Record<string, number> = {}) =>
    normalizeDetailLayout({ version: 3, blocks: Object.keys(spans), spans, offsets });
  const idsOf = (spans: Record<string, number>) => Object.keys(spans) as DetailBlockId[];

  it("offset 全 0 时 = 旧版 auto-placement（sparse，不回头、放不下就换行）", () => {
    // v3.4：原来这里用 notice 当那个 4 格块 —— 它已下线（不是区块了），换成 detail（同为 4 格），
    // 几何形状与这条用例的意图完全不变，只是 id 名字换了。
    const c = cfgWith({ hero: 12, actors: 6, tags: 6, desc: 8, detail: 4, back: 3, action: 3 });
    const rows = packRows(c, ["hero", "actors", "tags", "desc", "detail", "back", "action"]);
    expect(rows.map((r) => r.slots.map((s) => [s.id, s.col]))).toEqual([
      [["hero", 0]],
      [["actors", 0], ["tags", 6]],
      [["desc", 0], ["detail", 8]],
      [["back", 0], ["action", 3]]
    ]);
    // 满行不留空位；不满的行把剩下的列报成 gap
    expect(rows[0].gaps).toEqual([]);
    expect(rows[1].gaps).toEqual([]);
    expect(rows[3].gaps).toEqual([{ col: 6, width: 6 }]);
  });

  it("放不下就换行（不动前面那行的空位）：8 后面跟 6", () => {
    const c = cfgWith({ desc: 8, tags: 6 });
    const rows = packRows(c, ["desc", "tags"]);
    expect(rows[0].slots).toEqual([{ id: "desc", col: 0, span: 8 }]);
    expect(rows[0].gaps).toEqual([{ col: 8, width: 4 }]);
    expect(rows[1].slots).toEqual([{ id: "tags", col: 0, span: 6 }]);
  });

  it("单个 1/2 块 + offset=3 → 停在第 4 列起，两侧都是空占位（用户要的那个效果）", () => {
    const c = cfgWith({ tags: 6 }, { tags: 3 });
    const rows = packRows(c, ["tags"]);
    expect(rows[0].slots).toEqual([{ id: "tags", col: 3, span: 6 }]); // 占 4~9 列 → 视觉居中
    expect(rows[0].gaps).toEqual([{ col: 0, width: 3 }, { col: 9, width: 3 }]);
  });

  it("光标已经越过显式起点时不回头（否则两块会叠在一起）", () => {
    // hero(9) 先把光标推到 9；tags 想从第 4 列起，但光标在 9 → 只能放到 9 起，
    // 9+6 放不下 → 换行，而不是叠在 hero 上面
    const c = cfgWith({ hero: 9, tags: 6 }, { tags: 3 });
    const rows = packRows(c, ["hero", "tags"]);
    expect(rows[0].slots).toEqual([{ id: "hero", col: 0, span: 9 }]);
    expect(rows[1].slots).toEqual([{ id: "tags", col: 3, span: 6 }]);
  });

  it("每一项都落在 [0, 12-span]，且同一行内不重叠（穷举一批组合）", () => {
    const combos: Array<[Record<string, number>, Record<string, number>]> = [
      [{ back: 12, hero: 12 }, {}],
      [{ back: 6, hero: 6, actors: 6 }, { hero: 3 }],
      [{ back: 3, hero: 3, actors: 3, tags: 3, detail: 3 }, { hero: 1, tags: 5 }],
      [{ back: 9, hero: 3, actors: 4, tags: 4, detail: 4 }, { actors: 2 }]
    ];
    for (const [spans, offsets] of combos) {
      const c = cfgWith(spans, offsets);
      const ids = idsOf(spans);
      for (const row of packRows(c, ids)) {
        let prevEnd = -1;
        for (const s of row.slots) {
          expect(s.col).toBeGreaterThanOrEqual(0);
          expect(s.col + s.span).toBeLessThanOrEqual(GRID_COLS);
          expect(s.col).toBeGreaterThanOrEqual(prevEnd); // 不重叠、且顺序不乱
          prevEnd = s.col + s.span;
        }
        // 空位 = 12 - 实际占用
        const used = row.slots.reduce((n, s) => n + s.span, 0);
        expect(row.gaps.reduce((n, g) => n + g.width, 0)).toBe(GRID_COLS - used);
      }
    }
  });

  it("默认配置（全是满宽）→ 每块一行、没有任何空位（与旧版逐项相同）", () => {
    const rows = packedVisibleRows(DEFAULT_DETAIL_LAYOUT);
    expect(rows.length).toBe(visibleBlocks(DEFAULT_DETAIL_LAYOUT).length);
    for (const r of rows) {
      expect(r.slots.length).toBe(1);
      expect(r.slots[0].col).toBe(0);
      expect(r.gaps).toEqual([]);
    }
  });
});

describe("v3.5 形态（forms）：注册表驱动 · 默认不写 · 脏数据自愈", () => {
  it("【红线】老配置（没有 forms 这个键）→ 默认形态，且 normalize 的其它输出一字未变", () => {
    const c = normalizeDetailLayout({ blocks: ["hero", "detail"], facts: ["jmId"] });
    expect(c.forms).toEqual({});                       // 默认形态 = 不写
    expect(blockForm(c, "detail")).toBe("tabs");       // 注册表第一项就是默认（= 改造前的现状）
    expect(defaultFormOf("detail")).toBe("tabs");
    // 没有形态可选的块返回空串 —— UI 据此"整行不渲染"（只有一个形态 = 哑控件）
    // ⚠️ v3.8 起 `hero` / `tags` 也有形态了，所以这条改用**至今没有形态**的 `actors` 来钉：
    //    判据（"没形态的块必须返回空串"）没变，只是举的例子换了。
    expect(blockForm(c, "actors")).toBe("");
    expect(DETAIL_BLOCK_FORMS.actors).toBeUndefined();
  });

  it("注册表第一项 = 默认形态（这条不变量一破，老用户看到的页面就变了）", () => {
    for (const [id, list] of Object.entries(DETAIL_BLOCK_FORMS)) {
      expect(list && list.length).toBeGreaterThan(1);   // 只有一个形态的块不该登记（没得选）
      expect(defaultFormOf(id as DetailBlockId)).toBe(list![0].id);
    }
  });

  it("未知区块 id / 未知形态 id 一律丢弃；等于默认形态的项不写进配置", () => {
    const c = normalizeDetailLayout({
      forms: { hero: "whatever", detail: "不存在的形态", ghost: "folded" }
    });
    expect(c.forms).toEqual({});                        // hero 的 "whatever" 不是它的形态、detail 的形态未知
    // 明确写默认形态 = 等同于没配过（往返必须闭合）
    expect(normalizeDetailLayout({ forms: { detail: "tabs" } }).forms).toEqual({});
    expect(normalizeDetailLayout({ forms: { detail: "folded" } }).forms).toEqual({ detail: "folded" });
  });

  it("形态的归一化往返：写 → normalize → 相等（每一种形态都过一遍）", () => {
    for (const opt of DETAIL_BLOCK_FORMS.detail!) {
      const cfg = normalizeDetailLayout({ forms: { detail: opt.id } });
      expect(blockForm(cfg, "detail")).toBe(opt.id);
      // 再过一次 normalize（= 存盘后被读回来的路径）仍然是同一个形态
      expect(normalizeDetailLayout(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
    }
  });

  it("setDetailBlockForm：设默认形态 = 删键；未知形态原样返回（不静默改成别的）", () => {
    const off = setDetailBlockForm(DEFAULT_DETAIL_LAYOUT, "detail", "folded");
    expect(off.forms).toEqual({ detail: "folded" });
    expect(blockForm(off, "detail")).toBe("folded");
    expect(setDetailBlockForm(off, "detail", "tabs").forms).toEqual({});
    // 未知形态：既不写、也不抛、更不"顺手改成默认"（那会让用户以为点了）
    expect(setDetailBlockForm(off, "detail", "nope")).toBe(off);
    // 没有形态可选的块：原样返回（v3.8 起 hero/tags 有形态了，改用 actors 举例）
    expect(setDetailBlockForm(off, "actors", "folded")).toBe(off);
  });

  it("【红线】只换形态**不升 version**：不动宽度的用户不该被切进网格渲染", () => {
    const off = setDetailBlockForm(DEFAULT_DETAIL_LAYOUT, "detail", "folded");
    expect(off.version).toBe(DETAIL_LAYOUT_VERSION);
    expect(isSlotted(off)).toBe(false);                // 仍是纵向流，没被带成网格
  });

  it("复位把形态一起清掉（「恢复全部默认」要能真的回到没配过）", () => {
    const off = setDetailBlockForm(DEFAULT_DETAIL_LAYOUT, "detail", "folded");
    expect(resetDetailLayout().forms).toEqual({});
    expect(resetDetailLayout()).not.toEqual(off);
    // 存盘往返也成立（saveDetailLayout 会 normalize）
    saveDetailLayout(off);
    expect(JSON.parse(localStorage.getItem(UI_KEYS.detailLayout) || "{}").forms).toEqual({ detail: "folded" });
  });
});

describe("v3.8 形态第一批（调研 TOP8）：标签横滑 · 信息区紧凑表 · **形态按宽度过滤**", () => {
  /** 把一个块设成给定宽度档（形态的可用性跟着它变） */
  const withSpan = (id: DetailBlockId, span: SlotSpan) => setDetailBlockSpan(DEFAULT_DETAIL_LAYOUT, id, span);

  it("【不变量】注册表第一项（默认档）**不许声明 spans** —— 默认档必须任何宽度都可用，回落链才有终点", () => {
    for (const [, list] of Object.entries(DETAIL_BLOCK_FORMS)) {
      expect(list![0].spans).toBeUndefined();
    }
  });

  it("两个新形态都在注册表里，且每档都写了 label + hint（面板要显示；其它块只加数据不动代码）", () => {
    expect(DETAIL_BLOCK_FORMS.tags!.map((f) => f.id)).toEqual(["wrap", "scroll"]);
    expect(DETAIL_BLOCK_FORMS.hero!.map((f) => f.id)).toEqual(["cards", "infoTable"]);
    for (const id of ["tags", "hero"] as const) {
      for (const o of DETAIL_BLOCK_FORMS[id]!) {
        expect(o.label.length).toBeGreaterThan(0);
        expect(o.hint.length).toBeGreaterThan(0);
      }
    }
  });

  it("`formsFor` 按当前宽度档过滤：hero 的「紧凑两列表」在 3/4 列宽下消失、6 列及以上回来；tags 两档不受宽度限制", () => {
    expect(formsFor(withSpan("hero", 3), "hero").map((f) => f.id)).toEqual(["cards"]);
    expect(formsFor(withSpan("hero", 4), "hero").map((f) => f.id)).toEqual(["cards"]);
    for (const s of [6, 8, 9, 12] as SlotSpan[]) {
      expect(formsFor(withSpan("hero", s), "hero").map((f) => f.id)).toEqual(["cards", "infoTable"]);
    }
    for (const s of [3, 6, 12] as SlotSpan[]) {
      expect(formsFor(withSpan("tags", s), "tags").map((f) => f.id)).toEqual(["wrap", "scroll"]);
    }
  });

  it("★ 宽度不支持时**读时回落**，而且**不改写配置值** —— 宽度改回去，选过的形态自己回来", () => {
    let cfg = setDetailBlockForm(withSpan("hero", 12), "hero", "infoTable");
    expect(blockForm(cfg, "hero")).toBe("infoTable");     // 12 列：生效
    cfg = setDetailBlockSpan(cfg, "hero", 3);
    expect(blockForm(cfg, "hero")).toBe("cards");         // 3 列：回落默认
    expect(cfg.forms.hero).toBe("infoTable");             // ★ 配置值**没被改写**（不然"改了下宽度选择就永久丢了"）
    cfg = setDetailBlockSpan(cfg, "hero", 12);
    expect(blockForm(cfg, "hero")).toBe("infoTable");     // 改回 12 列 → 自己回来
  });

  it("★ 面板的输入（formsFor）与读出来生效的（blockForm）**永远一致** —— 不会「面板不给选、读出来却是它」", () => {
    for (const s of [3, 4, 6, 8, 9, 12] as SlotSpan[]) {
      const cfg = setDetailBlockForm(withSpan("hero", s), "hero", "infoTable");
      expect(blockForm(cfg, "hero") === "infoTable").toBe(formsFor(cfg, "hero").some((f) => f.id === "infoTable"));
    }
  });

  it("两个新形态的归一化往返：写 → normalize → 读回来仍是它（存盘路径）", () => {
    for (const id of ["tags", "hero"] as const) {
      const off = DETAIL_BLOCK_FORMS[id]![1].id;
      const cfg = normalizeDetailLayout({ forms: { [id]: off } });
      expect(blockForm(cfg, id)).toBe(off);
      expect(normalizeDetailLayout(JSON.parse(JSON.stringify(cfg)))).toEqual(cfg);
    }
  });
});

describe("v3.5 detail 面板：各自可隐藏 · 顺序可调 · 至少留一个", () => {
  it("默认三个都可见，顺序 = 目录 / 评论 / 相关漫画", () => {
    expect(visiblePanels(DEFAULT_DETAIL_LAYOUT)).toEqual(["dir", "cmt", "rel"]);
    // 老配置（连 panels 这个键都没有）读出来同样是三个都可见
    expect(visiblePanels(normalizeDetailLayout({ blocks: ["detail"] }))).toEqual(["dir", "cmt", "rel"]);
  });

  it("隐藏一个 → 只剩两个；再隐藏一个 → 只剩一个（这就是用户要的『隐藏其中一个或两个』）", () => {
    const one = setDetailNodeHidden(DEFAULT_DETAIL_LAYOUT, "cmt", true);
    expect(visiblePanels(one)).toEqual(["dir", "rel"]);
    const two = setDetailNodeHidden(one, "rel", true);
    expect(visiblePanels(two)).toEqual(["dir"]);
    // 隐藏项仍留在顺序表里（不是从 panels 删掉）→ 再打开时回到原位
    expect(two.panels).toEqual(["dir", "cmt", "rel"]);
    expect(visiblePanels(setDetailNodeHidden(two, "rel", false))).toEqual(["dir", "rel"]);
  });

  it("【关键】三个全关被拒：setDetailNodeHidden 原样返回（区块不许变空盒）", () => {
    const two = setDetailNodeHidden(setDetailNodeHidden(DEFAULT_DETAIL_LAYOUT, "cmt", true), "rel", true);
    expect(visiblePanels(two)).toEqual(["dir"]);
    const refused = setDetailNodeHidden(two, "dir", true);
    expect(refused).toBe(two);                          // **同一个对象**：什么都没发生
    expect(visiblePanels(refused)).toEqual(["dir"]);   // 目录还在 → 区块不会空
    expect(MIN_VISIBLE_PANELS).toBe(1);
  });

  it("【关键】手改过的存档三个全藏 → normalize 自愈，且保留的是**用户排序后的第一个**", () => {
    const c = normalizeDetailLayout({
      panels: ["rel", "dir", "cmt"],
      hidden: ["dir", "cmt", "rel"]
    });
    expect(visiblePanels(c)).toEqual(["rel"]);          // 尊重用户把 rel 排在最前
    // 不是"硬塞回目录"：硬塞会让用户"明明关掉的那个又自己回来了"
    expect(c.hidden).toEqual(["dir", "cmt"]);
  });

  it("未知面板 id 丢弃 / 缺失补齐到尾部 / 重复去重（与其它内层列表同一套 orderize）", () => {
    const c = normalizeDetailLayout({ panels: ["cmt", "ghost", "cmt"] });
    expect(c.panels).toEqual(["cmt", "dir", "rel"]);    // 未知丢掉、缺的补尾部、重复去重
    const empty = normalizeDetailLayout({ panels: [] });
    expect(empty.panels).toEqual([...DETAIL_PANEL_IDS]); // 空表 = 补齐，不是"一个都没有"
    expect(visiblePanels(empty)).toHaveLength(3);
  });

  it("面板顺序可调：moveVisibleNodeTo / moveDetailNode 都认 panels 这张表", () => {
    const moved = moveVisibleNodeTo(DEFAULT_DETAIL_LAYOUT, "rel", 0);
    expect(moved.panels).toEqual(["rel", "dir", "cmt"]);
    expect(moveDetailNode(moved, "rel", 1).panels).toEqual(["dir", "rel", "cmt"]);
    expect(moveDetailNodeTo(DEFAULT_DETAIL_LAYOUT, "cmt", 2).panels).toEqual(["dir", "rel", "cmt"]);
    // 顺序变了不影响可见性
    expect(visiblePanels(moved)).toEqual(["rel", "dir", "cmt"]);
  });

  it("visibleListOf 认 panels（检查器的『第 N / 共 M』按它算，不能给出 -1）", () => {
    expect(visibleListOf(DEFAULT_DETAIL_LAYOUT, "cmt")).toEqual(["dir", "cmt", "rel"]);
    const one = setDetailNodeHidden(DEFAULT_DETAIL_LAYOUT, "cmt", true);
    expect(visibleListOf(one, "dir")).toEqual(["dir", "rel"]);
    expect(visibleListOf(one, "cmt").indexOf("cmt")).toBe(-1); // 自己被藏：不在可见列表里（UI 据此禁用）
  });

  it("面板不是区块：不进 blocks、不参与 12 列网格、也不影响 isSlotted", () => {
    expect(DETAIL_BLOCK_IDS as readonly string[]).not.toContain("dir");
    expect(visibleBlocks(DEFAULT_DETAIL_LAYOUT)).not.toContain("dir" as never);
    expect(DETAIL_NODE_META.dir.group).toBe("详情面板");
    expect(DETAIL_NODE_META.dir.hideable).toBe(true);
    // 给一个面板设宽度是无效动作（它不在 spans 的白名单表里）
    const cfg = normalizeDetailLayout({ version: 3, spans: { dir: 6 } as never });
    expect(cfg.spans).toEqual({});
    expect(isSlotted(cfg)).toBe(false);
  });

  it("reset 把面板顺序与显隐一起复位", () => {
    const dirty = setDetailNodeHidden(moveVisibleNodeTo(DEFAULT_DETAIL_LAYOUT, "rel", 0), "cmt", true);
    expect(resetDetailLayout().panels).toEqual(["dir", "cmt", "rel"]);
    expect(resetDetailLayout().hidden).toEqual([]);
    expect(resetDetailLayout()).not.toEqual(dirty);
  });
});

