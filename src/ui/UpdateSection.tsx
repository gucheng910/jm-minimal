// 版本与更新（设置页那一行按钮）——
//
// ⚠️ v3.16 起**逻辑全部搬去了 `core/updateAndroid.ts`**：现在有两个入口要用同一条链路
//    （这里的按钮 + 进入软件后自动弹出来的更新提示），逻辑留在组件里必然分叉。
//    这个文件从此只做渲染。
//
// ⚠️ v3.17 又搬走了一样东西：**阶段 → 文案** 的映射（原来是这里的两张 Record 表 + 一个内联后缀），
//    现在是 `core/updateAndroid.ts` 的纯函数 `nativeLabel`。原因见那个函数的注释：
//    `ready`（安装完成但失败）这个阶段原来不显示 error，按钮会一直写「下载完成，点击安装」。
//
// 平台差异（搬走时一并保留的说明）：
//   · Android：从 GitHub Releases 检查新版本 → 下载 APK → 系统安装（AppUpdater 原生插件）；
//   · iOS：**不能**自己装 ipa（无越狱的 iOS 上没有任何 API 允许 App 下载并安装另一个 App），
//          但**可以跳浏览器下载**：把 Release 里 ipa 的直链交给系统浏览器，Safari 下完的 .ipa
//          进「下载」列表/「文件」App，用户点它时 iOS 会把 SideStore 列为可选打开方式
//          （SideStore 注册了 com.apple.itunes.ipa），由 SideStore 完成签名安装。
//          绝不去调 AppUpdater —— 那个插件在 iOS 没有实现，调用会 reject，而 main.tsx 的全局兜底
//          会把未捕获拒绝渲染成底部红条；更糟的是它要等 3 条通道 × 45s 才失败，最后还给出
//          「网络不通」这种与真实原因无关的误导提示。
import { useEffect, useState } from "react";
import { pushToast } from "./toast";
import { openExternal } from "../core/openExternal";
import { isIos, RELEASES_URL } from "../core/platform";
import { iosIpaTarget, nativeLabel, nativeUpdate } from "../core/updateAndroid";
import type { NativeUpdSnapshot } from "../core/updateAndroid";

export default function UpdateSection() {
  const isIosPlatform = isIos();
  const [s, setS] = useState<NativeUpdSnapshot>(() => nativeUpdate.get());

  useEffect(() => {
    nativeUpdate.revive();
    const offState = nativeUpdate.subscribe(setS);
    // 提示语照样弹 toast —— 与搬家前逐字一致（"直连下载不通，改走镜像 1…"）
    const offNotice = nativeUpdate.onNotice((text, kind) => pushToast(text, kind));
    return () => { offState(); offNotice(); nativeUpdate.dispose(); };
  }, []);

  const state = s.phase;
  // ⚠️ "latest"（已是最新）**不算忙**：以前把它也算 busy，于是"检查一次之后按钮就灰了，
  // 今天不是最新、明天就是最新"——用户必须重开应用才能再查。现在点它 = 再查一次。
  const busy = state === "checking" || state === "downloading" || state === "installing";

  async function onClick() {
    if (state === "idle" || state === "latest") { void nativeUpdate.check(); return; }
    if (state === "available") {
      if (isIosPlatform) {
        const t = iosIpaTarget(s);
        pushToast(t.text, "info");
        void openExternal(t.url);
        return;
      }
      const next = await nativeUpdate.download();
      if (next.error) pushToast("下载失败：" + next.error + "，可到 GitHub 发行页手动下载", "err");
      return;
    }
    if (state === "ready") {
      const next = await nativeUpdate.install();
      if (next.error) pushToast(next.error, "err");
    }
  }

  return (
    <div className="row" style={{ marginTop: 6 }}>
      <button className="menu-link update-btn" disabled={busy} onClick={() => void onClick()}>
        {nativeLabel(s, isIosPlatform)}
      </button>
      {state === "available" && s.pageUrl && s.pageUrl !== RELEASES_URL && (
        <button className="menu-link" onClick={() => void openExternal(s.pageUrl)}>发布页 ↗</button>
      )}
    </div>
  );
}
