// @vitest-environment node
/**
 * 评论分页合并（对应 2026-09-13 的"评论未展示完全"修复）。
 *
 * 背景（打真实接口量出来的）：
 *   · GET /forum?aid= 每页固定 10 条，total 是真实总数
 *     实测 aid=283429：page=1/2/3 各 10 条、互不重复，total=478
 *   · 但评论很少时，超出范围的 page 会把第一页原样返回
 *     实测 aid=1472364：total=1，page=2 与 page=3 返回的仍是同一条 CID
 * 所以追加时必须按 CID 去重，否则会出现重复条目、且 list.length 永远追不上 total。
 */
import { describe, expect, it } from "vitest";
import { mergeCommentPage } from "./useAlbumDetail";
import type { ForumComment } from "../core/types";

const c = (cid: number, content = "c" + cid): ForumComment => ({ CID: cid, content });

describe("mergeCommentPage", () => {
  it("第一页：直接落地，total 透传", () => {
    const r = mergeCommentPage(null, { list: [c(1), c(2)], total: 478 });
    expect(r.list.map((x) => x.CID)).toEqual([1, 2]);
    expect(r.total).toBe(478);
  });

  it("第二页：追加而不是替换，顺序保持（旧的在前）", () => {
    const p1 = mergeCommentPage(null, { list: [c(1), c(2)], total: 30 });
    const p2 = mergeCommentPage(p1, { list: [c(3), c(4)], total: 30 });
    expect(p2.list.map((x) => x.CID)).toEqual([1, 2, 3, 4]);
    expect(p2.total).toBe(30);
  });

  it("服务端把第一页原样返回时去重：不产生重复条目", () => {
    const p1 = mergeCommentPage(null, { list: [c(1)], total: 1 });
    const p2 = mergeCommentPage(p1, { list: [c(1)], total: 1 });
    expect(p2.list.map((x) => x.CID)).toEqual([1]);
  });

  it("跨页去重：重复的那条被丢掉，新的那条留下", () => {
    const p1 = mergeCommentPage(null, { list: [c(1), c(2)], total: 40 });
    const p2 = mergeCommentPage(p1, { list: [c(2), c(3)], total: 40 });
    expect(p2.list.map((x) => x.CID)).toEqual([1, 2, 3]);
  });

  it("没有 CID 的条目（服务端异常数据）不参与去重，也不会丢", () => {
    const p1 = mergeCommentPage(null, { list: [{ content: "a" }, { content: "b" }], total: 2 });
    const p2 = mergeCommentPage(p1, { list: [{ content: "a" }], total: 2 });
    expect(p2.list.length).toBe(3);
  });

  it("以 CID 为主键，回落到 id", () => {
    const p1 = mergeCommentPage(null, { list: [{ id: 9 }], total: 20 });
    const p2 = mergeCommentPage(p1, { list: [{ id: 9 }, { id: 10 }], total: 20 });
    expect(p2.list.map((x) => x.id)).toEqual([9, 10]);
  });
});

/**
 * 由 list/total 推导 hasMore 的规则（与 hook 内联的那行保持一致）。
 * 单独写出来是为了把"到底了按钮就该消失"这个契约钉死。
 */
const hasMoreOf = (list: ForumComment[], total: number) => list.length > 0 && list.length < total;

describe("hasMore 推导", () => {
  it("已加载 10 / 共 478 → 还有更多", () => {
    expect(hasMoreOf(Array.from({ length: 10 }, (_, i) => c(i)), 478)).toBe(true);
  });
  it("已加载 478 / 共 478 → 到底，按钮消失", () => {
    expect(hasMoreOf(Array.from({ length: 478 }, (_, i) => c(i)), 478)).toBe(false);
  });
  it("没有评论 → 不显示按钮", () => {
    expect(hasMoreOf([], 0)).toBe(false);
  });
  it("total 缺失（服务端没给）→ 不显示按钮，绝不无限点", () => {
    expect(hasMoreOf([c(1)], 0)).toBe(false);
  });
});
