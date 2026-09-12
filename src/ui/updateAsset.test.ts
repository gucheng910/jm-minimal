import { describe, it, expect } from "vitest";
import { pickApkAsset, type UpdateAsset } from "./updateAsset";

const a = (name: string): UpdateAsset => ({ name, browser_download_url: "https://example.com/" + name });
const BOTH = [a("jm-minimal-modern-1.8.2.apk"), a("jm-minimal-compat-1.8.2.apk")];
// 2.1.0 起 legacy 已并入 compat；历史 Release（含 2.1.0 当天的版本）里可能还残留 legacy 资产
const WITH_STALE_LEGACY = [...BOTH, a("jm-minimal-legacy-1.8.2.apk")];

describe("pickApkAsset", () => {
  it("modern 构建必须挑 modern 包（不能挑到 compat）", () => {
    expect(pickApkAsset(BOTH, "modern")?.name).toBe("jm-minimal-modern-1.8.2.apk");
  });
  it("compat 构建必须挑 compat 包（不能挑到 modern）", () => {
    expect(pickApkAsset(BOTH, "compat")?.name).toBe("jm-minimal-compat-1.8.2.apk");
  });
  it("Release 里残留 legacy 资产时，modern/compat 仍各自命中自己的包", () => {
    expect(pickApkAsset(WITH_STALE_LEGACY, "modern")?.name).toBe("jm-minimal-modern-1.8.2.apk");
    expect(pickApkAsset(WITH_STALE_LEGACY, "compat")?.name).toBe("jm-minimal-compat-1.8.2.apk");
  });
  it("未知变体（历史 legacy 包的 BUILD_VARIANT）不推任何包，宁可让用户手动下载", () => {
    expect(pickApkAsset(BOTH, "legacy")).toBeNull();
    expect(pickApkAsset(WITH_STALE_LEGACY, "legacy")).toBeNull();
  });
  it("大小写与中文命名都兼容", () => {
    expect(pickApkAsset([a("JM-Minimal-COMPAT-1.8.2.apk")], "compat")?.name).toContain("COMPAT");
    expect(pickApkAsset([a("jm-兼容-1.8.2.apk"), a("jm-现代-1.8.2.apk")], "compat")?.name).toBe("jm-兼容-1.8.2.apk");
    expect(pickApkAsset([a("jm-兼容-1.8.2.apk"), a("jm-现代-1.8.2.apk")], "modern")?.name).toBe("jm-现代-1.8.2.apk");
  });
  it("忽略非 apk 资产（exe / latest.yml / blockmap）", () => {
    const assets = [a("jm-minimal-setup-1.8.2.exe"), a("latest.yml"), a("jm-minimal-compat-1.8.2.apk")];
    expect(pickApkAsset(assets, "compat")?.name).toBe("jm-minimal-compat-1.8.2.apk");
  });
  it("只有一个 apk 时兜底返回它（老 Release 只有单包）", () => {
    expect(pickApkAsset([a("jm-minimal-modern-1.7.1.apk"), a("jm-minimal-setup-1.7.1.exe")], "compat")?.name).toBe("jm-minimal-modern-1.7.1.apk");
  });
  it("多包且都匹配不上 → null（上层提示找不到对应安装包）", () => {
    expect(pickApkAsset([a("foo-1.apk"), a("bar-2.apk")], "compat")).toBeNull();
  });
  it("空/异常输入不抛错", () => {
    expect(pickApkAsset(undefined, "modern")).toBeNull();
    expect(pickApkAsset([], "modern")).toBeNull();
    expect(pickApkAsset([{ name: 123 } as unknown as UpdateAsset], "modern")).toBeNull();
  });
});
