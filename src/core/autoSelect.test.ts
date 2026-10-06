// @vitest-environment jsdom
// （需要 localStorage：selectLine 会往 sessionStore.apiUrl 落盘）
/**
 * 启动选优（runAutoSelect）的行为回归 —— 对应 2.2.6 的 A2/A3/A4/A5。
 *
 * 只测**决策逻辑**，不碰网络：线路耗时用脚本化的 probeLineOnce 喂进去，
 * 图床探测把 measureImages 换成空样本（本文件关心的是"选哪条线路"）。
 *
 * 锁定的四条契约：
 *   1) 线路排名按**多轮中位数**，不是第一轮的单次采样（单次会被抖动主导，实测选对率 30%）；
 *   2) 每线确实跑了 LINE_PROBE_ROUNDS 轮；
 *   3) setting 已给出图源清单时，不再为 FALLBACK_SHUNT_KEYS 里的 key 额外发探测（A4 的"减量"）；
 *   4) 全失败时不写记忆（否则死图源会被 restoreBestSelection 恢复回来）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./speed", async (importOriginal) => {
  const real = await importOriginal<typeof import("./speed")>();
  return { ...real, measureImages: vi.fn(async () => []) };
});

const { client } = await import("./api");
const { LINE_PROBE_ROUNDS } = await import("./constants");

/** 把 JMClient 的私有成员当测试夹具用（不导出、也不该导出） */
type Internals = {
  probeLineOnce: (host: string) => Promise<number | null>;
  probeImageHost: (key: string | number) => Promise<string>;
  getSetting: () => Promise<unknown>;
  runAutoSelect: () => Promise<boolean>;
  hostConfig: unknown;
  saveBestSelection: () => void;
};
const jm = client as unknown as Internals;

const LINES: Array<[string, string]> = [["slow.test", "線路1"], ["fast.test", "線路2"]];
/** 第一轮故意让 slow 最快，中位数才是 fast：单次采样会选错，多轮中位数应该选对 */
const SCRIPT: Record<string, number[]> = {
  "slow.test": [200, 900, 950],
  "fast.test": [400, 300, 250]
};

let probeCalls: string[] = [];
let imgCalls: string[] = [];
let saved = 0;

beforeEach(() => {
  probeCalls = [];
  imgCalls = [];
  saved = 0;
  client.apiBase = "https://initial.test/";
  jm.hostConfig = { jm3_Server: LINES };
  client.setting = { app_shunts: [{ key: "1" }], img_host: "https://img-slow.test" } as unknown as typeof client.setting;
  const round = new Map<string, number>();
  jm.probeLineOnce = async (host: string) => {
    probeCalls.push(host);
    const n = round.get(host) || 0;
    round.set(host, n + 1);
    return SCRIPT[host]?.[n] ?? null;
  };
  jm.probeImageHost = async (key: string | number) => {
    imgCalls.push(String(key));
    return "img" + key + ".test";
  };
  jm.getSetting = async () => client.setting;
  jm.saveBestSelection = () => { saved += 1; };
  (client as unknown as { selecting: unknown }).selecting = null;
});

afterEach(() => { vi.restoreAllMocks(); });

describe("runAutoSelect 的线路选择", () => {
  it("按多轮中位数选线（单次采样会选中 slow.test）", async () => {
    await jm.runAutoSelect();
    expect(client.apiBase).toBe("https://fast.test/");
  });

  it(`每线跑满 ${LINE_PROBE_ROUNDS} 轮`, async () => {
    await jm.runAutoSelect();
    for (const [host] of LINES) {
      expect(probeCalls.filter((h) => h === host).length).toBe(LINE_PROBE_ROUNDS);
    }
  });

  it("setting 已给图源清单时不为兜底 key 额外探测（只探 0 + 清单里的 key）", async () => {
    await jm.runAutoSelect();
    expect(imgCalls).toEqual(["0", "1"]);
  });

  it("全部线路失败：不写记忆、不改线路", async () => {
    jm.probeLineOnce = async () => null;
    const ok = await jm.runAutoSelect();
    expect(ok).toBe(false);
    expect(saved).toBe(0);
    expect(client.apiBase).toBe("https://initial.test/");
  });
});
