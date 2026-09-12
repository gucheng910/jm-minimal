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
 * @param flavor 当前构建变体："modern" | "compat"（来自 core/constants 的 BUILD_VARIANT）
 * @returns 命中的资产；只有唯一一个 APK 时兜底返回它；多包且都匹配不上时返回 null
 *
 * 2.1.0 起 legacy 并入 compat，只有两个安卓包。历史 Release 里残留的 *-legacy-*.apk
 * 不会再被任何变体匹配到（宁可让老包用户看到"未找到对应安装包"去手动下载，也不能推错包）。
 */
export function pickApkAsset(assets: UpdateAsset[] | undefined | null, flavor: string): UpdateAsset | null {
  const list = Array.isArray(assets) ? assets : [];
  const apks = list.filter((a) => a && typeof a.name === "string" && /\.apk$/i.test(a.name));
  if (apks.length === 0) return null;
  const want = String(flavor || "modern").toLowerCase();
  const isCompat = want === "compat";
  const isModern = want === "modern";
  if (!isCompat && !isModern) return null; // 未知变体（例如历史 legacy 包）不推任何包
  const hit = apks.find((a) => {
    const n = a.name.toLowerCase();
    // 兼容中英命名：modern/现代、compat/兼容
    return isCompat ? n.includes("compat") || a.name.includes("兼容") : n.includes("modern") || a.name.includes("现代");
  });
  if (hit) return hit;
  // 只发了一个包（历史 Release / 紧急修复）时兜底，避免用户完全无法更新
  return apks.length === 1 ? apks[0] : null;
}
