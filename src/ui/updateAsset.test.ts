import { describe, it, expect } from "vitest";
import { pickApkAsset, pickIpaAsset, type UpdateAsset } from "./updateAsset";

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

// iOS 侧：不能自己装 ipa（无越狱没有任何 API 允许 App 安装另一个 App），
// 但可以跳浏览器下载 → 下载件点开交给 SideStore 装。所以要挑出 ipa 的**直链**。
describe("pickIpaAsset", () => {
  const IPA = a("jm-minimal-ios-2.2.6.ipa");
  const FULL = [a("jm-minimal-modern-2.2.6.apk"), a("jm-minimal-compat-2.2.6.apk"), a("jm-minimal-setup-2.2.6.exe"), a("latest.yml"), IPA];

  it("从完整 Release 里挑出 ipa，且不受 apk/exe/yml 干扰", () => {
    expect(pickIpaAsset(FULL)?.name).toBe("jm-minimal-ios-2.2.6.ipa");
    expect(pickIpaAsset(FULL)?.browser_download_url).toContain(".ipa");
  });

  it("Release 里还没有 ipa → null（上层退化成打开 Release 页手动下载）", () => {
    expect(pickIpaAsset([a("jm-minimal-modern-2.2.6.apk")])).toBeNull();
    expect(pickIpaAsset([])).toBeNull();
    expect(pickIpaAsset(undefined)).toBeNull();
  });

  it("多个 ipa 时只认 ios 命名的那个（不能把别的平台的包推给 iPhone）", () => {
    const assets = [a("vbox-2.2.6.ipa"), IPA];
    expect(pickIpaAsset(assets)?.name).toBe("jm-minimal-ios-2.2.6.ipa");
  });

  it("只有一个 ipa 但名字里没有 ios 也兜底返回（紧急发布只挂了单包）", () => {
    expect(pickIpaAsset([a("jm-minimal-2.2.6.ipa")])?.name).toBe("jm-minimal-2.2.6.ipa");
  });

  it("多个 ipa 且都不含 ios → null（宁可让用户去发布页自己看，也不推错包）", () => {
    expect(pickIpaAsset([a("a-1.ipa"), a("b-2.ipa")])).toBeNull();
  });

  it("大小写不敏感，且忽略非 ipa 资产", () => {
    expect(pickIpaAsset([a("JM-Minimal-IOS-2.2.6.IPA")])?.name).toContain("IOS");
    expect(pickIpaAsset([a("jm-minimal-ios-1.ipa.zip")])).toBeNull();
  });

  it("空/异常输入不抛错", () => {
    expect(pickIpaAsset([{ name: 123 } as unknown as UpdateAsset])).toBeNull();
    expect(pickIpaAsset([{ name: null } as unknown as UpdateAsset])).toBeNull();
  });
});
