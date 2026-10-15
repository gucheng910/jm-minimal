import { describe, expect, it } from "vitest";
import { PAID_NOTICE_TEXT, actionButtonSpec } from "./actionButton";

/**
 * 动作区主按钮的三态（v3.3「付费提示与阅读按钮合并」的验收网）。
 *
 * 为什么这组测试是**唯一**能证明合并没做错的东西：样例作品是免费内容（`locked=false`），
 * 编辑器画布**永远走不到**付费态 —— 截图与 e2e 都看不见它。所以三态的文案与行为
 * 只能在这里钉住。
 */
describe("动作区主按钮：免费 / 付费已登录 / 付费未登录", () => {
  it("免费态：未读过说「立即阅读」，读过当前话才说「继续阅读」，且无提示文案", () => {
    const fresh = actionButtonSpec({ locked: false, logged: true, price: 0, resumedThis: false });
    expect(fresh.kind).toBe("read");
    expect(fresh.label).toBe("立即阅读");
    expect(fresh.title).toBe("");

    const resumed = actionButtonSpec({ locked: false, logged: true, price: 0, resumedThis: true });
    expect(resumed.kind).toBe("read");
    expect(resumed.label).toBe("继续阅读");
  });

  it("付费 + 已登录：主按钮就是购买按钮，且**金额必须写在按钮上**", () => {
    const s = actionButtonSpec({ locked: true, logged: true, price: 55, resumedThis: false });
    expect(s.kind).toBe("buy");
    expect(s.label).toBe("使用官方 JCoin 购买（55 JCoin）");
    expect(s.label).toContain("55");
  });

  it("付费 + 已登录 + 详情没给价：仍然说购买，只是不带金额（不显示「（0 JCoin）」这种假价）", () => {
    const s = actionButtonSpec({ locked: true, logged: true, price: 0, resumedThis: false });
    expect(s.kind).toBe("buy");
    expect(s.label).toBe("使用官方 JCoin 购买");
    expect(s.label).not.toContain("JCoin）");
  });

  it("【合并的关键一格】付费 + 未登录：以前是「提示文字 + 点了没用的阅读按钮」，现在是一个按钮", () => {
    const s = actionButtonSpec({ locked: true, logged: false, price: 30, resumedThis: false });
    expect(s.kind).toBe("buy");                 // 走购买路径，而不是阅读路径
    expect(s.label).toBe("登录后购买（30 JCoin）");
    expect(s.title).toBe(PAID_NOTICE_TEXT);     // 旧提示的文案没丢，挂到 title 上
  });

  it("付费态一律不给「继续阅读」：读过足迹也不能把付费内容说成能直接读", () => {
    const s = actionButtonSpec({ locked: true, logged: true, price: 10, resumedThis: true });
    expect(s.label).not.toContain("继续阅读");
    expect(s.label).not.toContain("立即阅读");
  });
});
