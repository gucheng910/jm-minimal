// @vitest-environment jsdom
/**
 * 阅读器观感层（core/readerStyle）。
 *
 * 测的重点与 detailStyle 那一层一致：
 *   · **默认配置 == 改造前的写死行为**（红线：滚动条完全隐藏、控制条 3 秒自动收起）；
 *   · **对脏数据自愈**（旧数据 / 手改过的 localStorage / 非法档位值）；
 *   · **只写非默认值到 DOM**（默认 = 属性不存在 —— 这样"没配过"的 DOM 与改造前逐字一致）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "./constants";
import {
  DEFAULT_READER_STYLE,
  READER_AUTOHIDE_MS,
  READER_STYLE_VERSION,
  applyReaderStyle,
  clearReaderStyle,
  isReaderStyleKeyDefault,
  isReaderStyleModified,
  loadReaderStyle,
  normalizeReaderStyle,
  resetReaderStyle,
  resetReaderStyleKey,
  saveReaderStyle,
  setReaderStyle
} from "./readerStyle";

afterEach(() => {
  localStorage.clear();
  clearReaderStyle();   // 别把 data-jm-rsb 留给下一个用例（它挂在 <html> 上）
});

describe("⓪ 默认 = 改造前的写死行为（红线）", () => {
  it("滚动条默认隐藏、控制条默认 3 秒收起", () => {
    expect(DEFAULT_READER_STYLE.scrollbar).toBe("hidden");
    expect(DEFAULT_READER_STYLE.autoHide).toBe("3s");
    // 3 秒是改造前 Reader.showChrome() 里写死的值 —— 改了这里就等于改了所有老用户的阅读手感
    expect(READER_AUTOHIDE_MS["3s"]).toBe(3000);
    // 0 = 不挂定时器（"不自动隐藏"）
    expect(READER_AUTOHIDE_MS.never).toBe(0);
  });

  it("版本号是显式常量", () => {
    expect(READER_STYLE_VERSION).toBe(1);
    expect(DEFAULT_READER_STYLE.version).toBe(READER_STYLE_VERSION);
  });

  it("默认配置不写任何 DOM 属性（属性不存在 = 与改造前一致）", () => {
    applyReaderStyle(DEFAULT_READER_STYLE);
    expect(document.documentElement.hasAttribute("data-jm-rsb")).toBe(false);
  });
});

describe("① 归一化：脏数据 / 旧数据自愈", () => {
  it("完全不是对象 → 回默认（不抛）", () => {
    for (const bad of [null, undefined, "hidden", 42, []]) {
      expect(normalizeReaderStyle(bad)).toEqual(DEFAULT_READER_STYLE);
    }
  });

  it("非法档位值 → 回该轴的默认（不是整份配置回默认）", () => {
    const cfg = normalizeReaderStyle({ scrollbar: "brand-new-value", autoHide: "6s" });
    expect(cfg.scrollbar).toBe("hidden");
    expect(cfg.autoHide).toBe("6s");   // 合法的那一项要保住
  });

  it("近似值不算数（`\"\"` / 数字 / 大小写不同都回默认）", () => {
    expect(normalizeReaderStyle({ scrollbar: "", autoHide: "" }).scrollbar).toBe("hidden");
    expect(normalizeReaderStyle({ scrollbar: "THIN" }).scrollbar).toBe("hidden");
    expect(normalizeReaderStyle({ autoHide: 3 }).autoHide).toBe("3s");
  });

  it("少一个字段（老数据比代码早）→ 缺的那项回默认，已有的保住", () => {
    const cfg = normalizeReaderStyle({ scrollbar: "thin" });
    expect(cfg.scrollbar).toBe("thin");
    expect(cfg.autoHide).toBe("3s");
  });
});

describe("② 编辑：等值返回同引用 / 单项复位 / 整体复位", () => {
  it("值没变 → **同一个引用**（调用方据此省掉重渲染与落盘）", () => {
    const cfg = resetReaderStyle();
    expect(setReaderStyle(cfg, "scrollbar", "hidden")).toBe(cfg);
    expect(resetReaderStyleKey(cfg, "autoHide")).toBe(cfg);
  });

  it("改一项 → 新对象，另一项不受影响", () => {
    const cfg = setReaderStyle(resetReaderStyle(), "scrollbar", "thin");
    expect(cfg.scrollbar).toBe("thin");
    expect(cfg.autoHide).toBe("3s");
    expect(isReaderStyleModified(cfg)).toBe(true);
    expect(isReaderStyleKeyDefault(cfg, "autoHide")).toBe(true);
    expect(isReaderStyleKeyDefault(cfg, "scrollbar")).toBe(false);
  });

  it("单项复位只复位那一项（负对照：别把两个轴一起清了）", () => {
    let cfg = setReaderStyle(resetReaderStyle(), "scrollbar", "auto");
    cfg = setReaderStyle(cfg, "autoHide", "never");
    const back = resetReaderStyleKey(cfg, "scrollbar");
    expect(back.scrollbar).toBe("hidden");
    expect(back.autoHide).toBe("never");
  });

  it("整体复位 → 与默认深相等，且不再是「改过」", () => {
    expect(resetReaderStyle()).toEqual(DEFAULT_READER_STYLE);
    expect(isReaderStyleModified(resetReaderStyle())).toBe(false);
  });
});

describe("③ 应用到 DOM（只写非默认值）", () => {
  it("非默认 → 属性值就是档位值", () => {
    applyReaderStyle(setReaderStyle(resetReaderStyle(), "scrollbar", "thin"));
    expect(document.documentElement.getAttribute("data-jm-rsb")).toBe("thin");
  });

  it("★ 改回默认 → 属性被**摘掉**（不是写成 \"hidden\"）", () => {
    applyReaderStyle(setReaderStyle(resetReaderStyle(), "scrollbar", "auto"));
    expect(document.documentElement.getAttribute("data-jm-rsb")).toBe("auto");
    applyReaderStyle(resetReaderStyle());
    expect(document.documentElement.hasAttribute("data-jm-rsb")).toBe(false);
  });

  it("负对照：只改自动隐藏那一项时，**滚动条属性不该出现**", () => {
    // 两个轴写的是两个东西（一个是 <html> 属性、一个是 Reader 里的定时器毫秒数），
    // 混在一起就会"改了自动隐藏却顺手把滚动条也打开"。
    applyReaderStyle(setReaderStyle(resetReaderStyle(), "autoHide", "6s"));
    expect(document.documentElement.hasAttribute("data-jm-rsb")).toBe(false);
  });

  it("`clearReaderStyle` 把标记清干净（退出阅读器时调用）", () => {
    applyReaderStyle(setReaderStyle(resetReaderStyle(), "scrollbar", "thin"));
    clearReaderStyle();
    expect(document.documentElement.hasAttribute("data-jm-rsb")).toBe(false);
  });
});

describe("④ 持久化（localStorage + 读时自愈）", () => {
  it("没配过 → 默认；存了再读 → 一致", () => {
    expect(loadReaderStyle()).toEqual(DEFAULT_READER_STYLE);
    saveReaderStyle(setReaderStyle(resetReaderStyle(), "scrollbar", "thin"));
    expect(loadReaderStyle().scrollbar).toBe("thin");
  });

  it("存的 JSON 坏了 → 回默认，不抛", () => {
    localStorage.setItem(UI_KEYS.readerStyle, "{ 这不是 JSON");
    expect(loadReaderStyle()).toEqual(DEFAULT_READER_STYLE);
  });

  it("存的是非法档位 → 读出来是合法配置（归一化在边界上真的跑了）", () => {
    localStorage.setItem(UI_KEYS.readerStyle, JSON.stringify({ scrollbar: "wide", autoHide: "0s" }));
    expect(loadReaderStyle()).toEqual(DEFAULT_READER_STYLE);
  });

  it("写盘时也会过一遍归一化（不许把脏值写进去）", () => {
    saveReaderStyle({ version: 0, scrollbar: "nope", autoHide: "6s" } as never);
    const raw = JSON.parse(localStorage.getItem(UI_KEYS.readerStyle) || "{}");
    expect(raw.scrollbar).toBe("hidden");
    expect(raw.autoHide).toBe("6s");
    expect(raw.version).toBe(READER_STYLE_VERSION);
  });

  it("用的 key 是 UI_KEYS.readerStyle（别处按这个 key 清数据）", () => {
    saveReaderStyle(resetReaderStyle());
    expect(UI_KEYS.readerStyle).toBe("jmclient.readerStyle.v1");
    expect(localStorage.getItem(UI_KEYS.readerStyle)).toBeTruthy();
  });
});
