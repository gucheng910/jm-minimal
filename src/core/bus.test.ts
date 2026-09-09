// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { emit, on } from "./bus";

describe("事件总线", () => {
  it("on 能收到 emit 的 detail，取消订阅后不再收到", () => {
    const seen: string[] = [];
    const off = on("jm:nav", (d) => seen.push(d));
    emit("jm:nav", "latest");
    emit("jm:nav", "ranking");
    off();
    emit("jm:nav", "ignored");
    expect(seen).toEqual(["latest", "ranking"]);
  });

  it("取消订阅函数可直接作为 useEffect 的清理函数使用", () => {
    const fn = vi.fn();
    on("jm:setting", fn)();
    emit("jm:setting");
    expect(fn).not.toHaveBeenCalled();
  });

  it("jm:back：detail 是同一个可变对象、按注册顺序消费，被消费后后者不再处理", () => {
    const order: string[] = [];
    const off1 = on("jm:back", (d) => { if (!d.consumed) { order.push("A"); d.consumed = true; } });
    const off2 = on("jm:back", (d) => { if (!d.consumed) order.push("B"); });
    const detail = { consumed: false };
    emit("jm:back", detail);
    expect(order).toEqual(["A"]);
    expect(detail.consumed).toBe(true); // 调用方拿到的是同一个对象，据此判断是否被消费
    off1();
    off2();
  });

  it("带结构的 detail 原样传递", () => {
    const fn = vi.fn();
    const off = on("jm:caches", fn);
    emit("jm:caches", { progress: true });
    expect(fn).toHaveBeenCalledWith({ progress: true });
    off();
  });

  it("多个订阅者都能收到", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = on("jm:immersive", a);
    const offB = on("jm:immersive", b);
    emit("jm:immersive", true);
    expect(a).toHaveBeenCalledWith(true);
    expect(b).toHaveBeenCalledWith(true);
    offA();
    offB();
  });
});
