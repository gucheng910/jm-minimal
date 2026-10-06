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

/**
 * 从 Release 资产中挑出**给 iOS 用户下载的 ipa**。
 *
 * 为什么 iOS 要单独挑资产：无越狱的 iOS **不能自己装上 ipa**（没有任何 API 允许 App 安装另一个 App），
 * 但**可以跳浏览器下载** —— 下载完的 .ipa 会进「下载」列表/「文件」App，点它 iOS 会把 SideStore
 * 列为可选打开方式（SideStore 的 Info.plist 注册了 `com.apple.itunes.ipa`
 * 的 CFBundleDocumentTypes + ipa 的 UTImportedTypeDeclarations，LSHandlerRank=Alternate），
 * 由 SideStore 完成安装。所以 iOS 侧的正确动作是「把 ipa 直链丢给浏览器」而不是「打开 Release 页面」。
 *
 * 命名约定由 .github/workflows/build-ipa.yml 保证：`jm-minimal-ios-<version>.ipa`。
 * @returns 命中的 ipa；Release 里没有 ipa 时返回 null（调用方退化成"打开 Release 页"）
 */
export function pickIpaAsset(assets: UpdateAsset[] | undefined | null): UpdateAsset | null {
  const list = Array.isArray(assets) ? assets : [];
  const ipas = list.filter((a) => a && typeof a.name === "string" && /\.ipa$/i.test(a.name));
  if (ipas.length === 0) return null;
  // 多个 ipa（理论上不该有）时只认 ios 命名的那个，避免"随便挑一个"把 Android 用户的包推错
  return ipas.find((a) => /ios/i.test(a.name)) || (ipas.length === 1 ? ipas[0] : null);
}
