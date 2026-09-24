// navStack 单元测试：这里守的是「返回该回到哪一屏」——上一版就是在这里算错，
// 表现为真机上的"返回时回错页面、搜索页内容串了"。把它变成纯函数后，这类问题能被测试抓住。
import { describe, expect, it } from "vitest";
import {
  NAV_MAX_DEPTH,
  hasScreen,
  isDetail,
  isSearch,
  lastDetail,
  patchScreen,
  popScreen,
  pushScreen,
  screenById,
  topScreen
} from "./navStack";
import type { DetailScreen, Screen, SearchScreen } from "./navStack";
import type { AlbumDetail, AlbumSummary } from "./types";

let seq = 0;
function detail(name: string, id = ++seq): DetailScreen {
  return { k: "detail", id, snap: { id: String(id), name } as unknown as AlbumDetail, scroll: 0 };
}
function search(text: string, id = ++seq): SearchScreen {
  return {
    k: "search", id, srKind: "tag", text,
    items: [] as AlbumSummary[], page: 1, hasMore: false, busy: true, error: ""
  };
}

describe("页面栈：基本操作", () => {
  it("topScreen / isSearch / isDetail 认栈顶", () => {
    expect(topScreen([])).toBeNull();
    expect(isSearch(null)).toBe(false);
    expect(isDetail(null)).toBe(false);
    const d = detail("A");
    expect(topScreen([d])?.id).toBe(d.id);
    expect(isDetail(topScreen([d]))).toBe(true);
    expect(isSearch(topScreen([d]))).toBe(false);
  });

  it("lastDetail 取栈里最靠上的详情层（搜索层只是盖在它上面）", () => {
    const A = detail("A"), X = search("X"), B = detail("B"), Y = search("Y");
    expect(lastDetail([])).toBeNull();
    expect(lastDetail([A])?.id).toBe(A.id);
    expect(lastDetail([A, X])?.id).toBe(A.id); // 搜索层开着时，背后的详情仍是 A
    expect(lastDetail([A, X, B, Y])?.id).toBe(B.id); // 只有 B 在 Y 背后
  });

  it("popScreen 弹栈顶并原样返回剩余栈；空栈弹不出东西", () => {
    const A = detail("A"), X = search("X");
    const r = popScreen([A, X]);
    expect(r.popped?.id).toBe(X.id);
    expect(r.rest.map((s) => s.id)).toEqual([A.id]);
    expect(popScreen([])).toEqual({ rest: [], popped: null });
  });

  it("hasScreen / screenById：按 id 查层（异步回包守卫要用）", () => {
    const A = detail("A"), X = search("X");
    expect(hasScreen([A, X], X.id)).toBe(true);
    expect(hasScreen([A, X], 999999)).toBe(false);
    expect(screenById([A, X], X.id)?.k).toBe("search");
    expect(screenById([A, X], 999999)).toBeNull();
    const { rest } = popScreen([A, X]);
    expect(hasScreen(rest, X.id)).toBe(false); // 弹掉的层立刻"不存在"，过期回包自动作废
  });
});

describe("页面栈：用户链路（这次的真机问题）", () => {
  it("列表→详情A→搜索X→详情B→搜索Y，逐层返回正好是 Y→B→X→A→列表", () => {
    const A = detail("A"), X = search("X"), B = detail("B"), Y = search("Y");
    let stack: Screen[] = [];
    stack = pushScreen(stack, A);
    stack = pushScreen(stack, X);
    stack = pushScreen(stack, B);
    stack = pushScreen(stack, Y);
    expect(stack.map((s) => s.k)).toEqual(["detail", "search", "detail", "search"]);

    // 返回①：弹掉 Y → 前面一屏是详情B
    let r = popScreen(stack);
    stack = r.rest;
    expect(r.popped?.id).toBe(Y.id);
    expect(isDetail(topScreen(stack))).toBe(true);
    expect(lastDetail(stack)?.id).toBe(B.id);

    // 返回②：弹掉 B → 前面一屏是搜索X，而 X 背后是详情A（上一版就在这里算成了 B → 回错页面）
    r = popScreen(stack);
    stack = r.rest;
    expect(r.popped?.id).toBe(B.id);
    expect(isSearch(topScreen(stack))).toBe(true);
    expect(lastDetail(stack)?.id).toBe(A.id);

    // 返回③：弹掉 X → 前面一屏是详情A
    r = popScreen(stack);
    stack = r.rest;
    expect(isDetail(topScreen(stack))).toBe(true);
    expect(lastDetail(stack)?.id).toBe(A.id);

    // 返回④：弹掉 A → 回列表
    r = popScreen(stack);
    stack = r.rest;
    expect(stack).toEqual([]);
    expect(topScreen(stack)).toBeNull();
  });

  it("搜索层里点进漫画：详情层压在搜索层之上，返回先回到搜索层（不是回列表）", () => {
    const A = detail("A"), X = search("X");
    let stack: Screen[] = [A, X];
    const B = detail("B");
    stack = pushScreen(stack, B); // 在 X 的结果里点了漫画B
    expect(lastDetail(stack)?.id).toBe(B.id);

    const r = popScreen(stack); // 从 B 返回
    expect(r.popped?.id).toBe(B.id);
    expect(isSearch(topScreen(r.rest))).toBe(true); // 回到搜索X，而不是列表
    expect(hasScreen(r.rest, X.id)).toBe(true);
  });
});

describe("页面栈：深度裁剪不变量", () => {
  it("常规超深：保留末尾 NAV_MAX_DEPTH 层，且仍以详情层开头", () => {
    let stack: Screen[] = [];
    for (let i = 0; i < 4; i++) {
      stack = pushScreen(stack, detail("d" + i));
      stack = pushScreen(stack, search("s" + i));
    }
    expect(stack.length).toBeLessThanOrEqual(NAV_MAX_DEPTH);
    expect(stack[0].k).toBe("detail");
    expect(lastDetail(stack)).not.toBeNull();
  });

  it("极端超深（在同一详情上连点很多次标签）：不丢掉背后的详情，也不无限增长", () => {
    let stack: Screen[] = [detail("A")];
    for (let i = 0; i < 30; i++) stack = pushScreen(stack, search("t" + i));
    expect(stack.length).toBeLessThanOrEqual(NAV_MAX_DEPTH);
    expect(lastDetail(stack)).not.toBeNull(); // 关键：搜索层永远有"背后的详情"可回
    expect(stack[0].k).toBe("detail");
  });

  it("未超深时原样追加（不裁剪、不改引用语义）", () => {
    const A = detail("A"), X = search("X");
    const stack = pushScreen(pushScreen([], A), X);
    expect(stack.map((s) => s.id)).toEqual([A.id, X.id]);
  });
});

describe("页面栈：patchScreen", () => {
  it("只改目标层，其它层引用保持不变", () => {
    const A = detail("A"), X = search("X"), Y = search("Y");
    const stack = [A, X, Y];
    const next = patchScreen(stack, X.id, { busy: false, items: [{ id: "1" } as AlbumSummary], page: 2 });
    expect((screenById(next, X.id) as SearchScreen).busy).toBe(false);
    expect((screenById(next, X.id) as SearchScreen).page).toBe(2);
    expect(next[0]).toBe(A); // 未命中的层不重建
    expect(next[2]).toBe(Y);
    expect(stack[1]).toBe(X); // 原数组不被改写（纯函数）
  });

  it("id 不存在时原样返回同一个数组引用（React 可据此跳过重渲）", () => {
    const A = detail("A");
    const stack = [A];
    expect(patchScreen(stack, 999999, { busy: false })).toBe(stack);
  });

  it("可记录详情层的滚动位置", () => {
    const A = detail("A");
    const next = patchScreen([A], A.id, { scroll: 1234 });
    expect(lastDetail(next)?.scroll).toBe(1234);
  });
});
