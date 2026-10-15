/**
 * `core/layoutOrder.ts` 的纯函数。
 *
 * 重点是 `moveToInList` —— 拖拽排序的正确性**全部压在它身上**：
 * 手指拖到哪儿就落到哪儿，越界要夹住，"拖回原位"不能产生新数组（否则会白白触发一次重渲染）。
 */
import { describe, expect, it } from "vitest";
import { moveInList, moveToInList, orderize } from "./layoutOrder";

const ABC = ["a", "b", "c", "d"] as const;

describe("moveToInList（拖拽排序）", () => {
  it("拖到前面 / 中间 / 后面都按目标下标落位", () => {
    expect(moveToInList(ABC, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveToInList(ABC, "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveToInList(ABC, "b", 3)).toEqual(["a", "c", "d", "b"]);
  });

  it("拖回原位返回同一个引用（不重建数组，避免无谓的重渲染）", () => {
    expect(moveToInList(ABC, "b", 1)).toBe(ABC);
  });

  it("越界夹到合法范围，不报错也不乱动", () => {
    expect(moveToInList(ABC, "a", 99)).toEqual(["b", "c", "d", "a"]);
    expect(moveToInList(ABC, "d", -99)).toEqual(["d", "a", "b", "c"]);
    // 手指拖出容器外是常态，这一条必须稳
    expect(moveToInList(ABC, "c", Number.POSITIVE_INFINITY)).toEqual(["a", "b", "d", "c"]);
  });

  it("小数下标四舍五入（拖拽算出来的下标是浮点）", () => {
    expect(moveToInList(ABC, "a", 2.4)).toEqual(["b", "c", "a", "d"]);
    expect(moveToInList(ABC, "a", 2.6)).toEqual(["b", "c", "d", "a"]);
  });

  it("不在这个列表里返回 null（调用方据此换下一张表）", () => {
    expect(moveToInList(ABC, "zzz" as "a", 0)).toBeNull();
  });

  it("不改入参（纯函数）", () => {
    const src = ["a", "b", "c"] as const;
    const copy = [...src];
    moveToInList(src, "c", 0);
    expect([...src]).toEqual(copy);
  });
});

describe("moveInList（▲▼ 的 ±1）", () => {
  it("前后移动一位", () => {
    expect(moveInList(ABC, "a", 1)).toEqual(["b", "a", "c", "d"]);
    expect(moveInList(ABC, "d", -1)).toEqual(["a", "b", "d", "c"]);
  });

  it("到头了返回同一个引用", () => {
    expect(moveInList(ABC, "a", -1)).toBe(ABC);
    expect(moveInList(ABC, "d", 1)).toBe(ABC);
  });

  it("不在表里返回 null", () => {
    expect(moveInList(ABC, "zzz" as "a", 1)).toBeNull();
  });
});

describe("orderize（脏数据自愈）", () => {
  it("丢掉未知 id、去重、把缺失的补到尾部", () => {
    expect(orderize(["c", "x", "c", "a"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  });

  it("非数组 / 非字符串项都不崩", () => {
    expect(orderize(null, ["a", "b"])).toEqual(["a", "b"]);
    expect(orderize([1, null, "a"], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("空输入得到完整默认顺序", () => {
    expect(orderize([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});
