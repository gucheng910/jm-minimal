import { describe, expect, it } from "vitest";
import { pickFastestSource, type SpeedSample } from "./speed";

const s = (tag: string, ms: number, ok = true): SpeedSample => ({ label: tag, url: "https://h" + tag + "/x.jpg", ms, ok, tag });

describe("pickFastestSource", () => {
  it("官方源里挑最快的可用源（不依赖入参顺序）", () => {
    const samples = [s("1", 900), s("2", 120), s("0", 300), s("3", 450)];
    expect(pickFastestSource(samples)?.tag).toBe("2");
  });

  it("express（tag=0）更快也不用它：官方源可用就优先官方（正文图只有官方给）", () => {
    const samples = [s("0", 40), s("1", 800), s("2", 500)];
    expect(pickFastestSource(samples)?.tag).toBe("2");
  });

  it("官方源全不可用才回落到 express", () => {
    const samples = [s("1", 90, false), s("2", 80, false), s("0", 640, true)];
    expect(pickFastestSource(samples)?.tag).toBe("0");
  });

  it("测速失败的样本再快也不算数", () => {
    const samples = [s("1", 10, false), s("2", 700, true)];
    expect(pickFastestSource(samples)?.tag).toBe("2");
  });

  it("全部失败返回 null（调用方据此不切源并提示）", () => {
    expect(pickFastestSource([s("0", 10, false), s("1", 20, false)])).toBeNull();
    expect(pickFastestSource([])).toBeNull();
  });

  it("没有 tag 的样本不会和 express 混淆", () => {
    const samples: SpeedSample[] = [{ label: "a", url: "u", ms: 50, ok: true }, s("0", 20)];
    expect(pickFastestSource(samples)?.label).toBe("a");
  });
});
