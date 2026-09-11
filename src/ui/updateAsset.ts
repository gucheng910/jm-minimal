// 应用内更新：按「当前安装的是哪个包」挑选 GitHub Release 里的 APK 资产。
// 为什么必须显式区分：modern 与 compat 两个包 **文件名不同、versionName 相同**，
// 老内核机型装了 modern 包会白屏，所以不能"随便挑一个 apk"。

export interface UpdateAsset {
  name: string;
  browser_download_url: string;
}

/**
 * 从 Release 资产中挑出与当前构建变体匹配的 APK。
 * @param assets Release 的 assets 列表（可能字段缺失）
 * @param flavor 当前构建变体："modern" | "compat" | "legacy"（来自 core/constants 的 BUILD_VARIANT）
 * @returns 命中的资产；只有唯一一个 APK 时兜底返回它；多包且都匹配不上时返回 null
 */
export function pickApkAsset(assets: UpdateAsset[] | undefined | null, flavor: string): UpdateAsset | null {
  const list = Array.isArray(assets) ? assets : [];
  const apks = list.filter((a) => a && typeof a.name === "string" && /\.apk$/i.test(a.name));
  if (apks.length === 0) return null;
  const want = String(flavor || "modern").toLowerCase();
  const hit = apks.find((a) => {
    const n = a.name.toLowerCase();
    // 兼容中英命名：modern/现代、compat/兼容、legacy/老安卓
    if (want === "compat") return n.includes("compat") || a.name.includes("兼容");
    if (want === "legacy") return n.includes("legacy") || a.name.includes("老安卓");
    return n.includes("modern") || a.name.includes("现代");
  });
  if (hit) return hit;
  // 只发了一个包（历史 Release / 紧急修复）时兜底，避免用户完全无法更新
  return apks.length === 1 ? apks[0] : null;
}
