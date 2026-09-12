# JM极简版（jm-minimal）

[![Stars](https://img.shields.io/github/stars/gucheng910/jm-minimal?style=flat-square&label=Stars&color=181717)](https://github.com/gucheng910/jm-minimal/stargazers)
[![Release](https://img.shields.io/github/v/release/gucheng910/jm-minimal?style=flat-square&label=Release&color=00b578)](https://github.com/gucheng910/jm-minimal/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/gucheng910/jm-minimal/total?style=flat-square&label=Downloads&color=orange)](https://github.com/gucheng910/jm-minimal/releases/latest)
[![Platform](https://img.shields.io/badge/Platform-Android%20%7C%20Windows-1677ff?style=flat-square)]()

> 轻量、简洁的 JM 客户端 · 仅保留最基本的浏览与阅读能力

在学习 ai 的过程中，尝试构建了本项目，通过仅保留核心功能和线路及源的自动测速以获得了清爽的 jm 使用体验，如果觉得本项目有用的话请给我打个 star 吧(๑╹ヮ╹๑)ﾉ

## 下载（Download）

最新发行版：
（戳下方链接下载）(https://github.com/gucheng910/jm-minimal/releases/latest)

无需自行构建，直接下载对应平台的安装包即可：

| 文件 | 适用 | 下载 |
|---|---|---|
| `jm-minimal-modern-2.1.0.apk` | Android 7.0+，**系统 WebView 80 以上**（绝大多数机型） | [下载](https://github.com/gucheng910/jm-minimal/releases/download/v2.1.0/jm-minimal-modern-2.1.0.apk) |
| `jm-minimal-compat-2.1.0.apk` | **Android 6.0（API 23）及以上**，老内核 / 无法更新 WebView / 老安卓机型（WebView 57 以上；含 ES5 兼容产物，关动效、不含去条纹，一切为流畅让步） | [下载](https://github.com/gucheng910/jm-minimal/releases/download/v2.1.0/jm-minimal-compat-2.1.0.apk) |
| `jm-minimal-portable-2.1.0.exe` | Windows 7+ x64（免安装便携版） | [下载](https://github.com/gucheng910/jm-minimal/releases/download/v2.1.0/jm-minimal-portable-2.1.0.exe) |
| `jm-minimal-setup-2.1.0.exe` | Windows 7+ x64（NSIS 安装包） | [下载](https://github.com/gucheng910/jm-minimal/releases/download/v2.1.0/jm-minimal-setup-2.1.0.exe) |

> **系统要求（按包区分）**：
> - **modern**：Android 7.0+，系统 WebView / Chromium **80+**；
> - **compat**：**Android 6.0（API 23）及以上**，系统 WebView **57+** —— 内置 ES5 产物，并针对老内核做了 CSS / Web API 兜底（flex gap、inset、aspect-ratio、AbortController、Element.scrollTo 等）；minSdk 23、关闭动效与按压反馈、不含去条纹，在这类机器上优先保证流畅。**2.1.0 起原 legacy 包并入 compat，只有这两个安卓包**；
> - WebView 低于 57 的极老机型（Android 6 出厂自带的 44~46）请先更新「Android System WebView」，否则应用会提示「请更新系统 WebView」；
> - **HarmonyOS 2~4**（基于 Android 10~12）两个包都能装；**HarmonyOS NEXT（纯血鸿蒙）**不再兼容 APK，请走官方渠道。
> - 打不开或白屏时：先更新「Android System WebView」，仍不行就换 compat 包（对老内核最宽容）。

App 内「左侧菜单 → 版本 → 检查更新」同样读取本仓库最新 Release，可一键下载更新（直连 GitHub 下载不畅时会自动改用镜像通道；若全部通道都不通，请到本页面手动下载）。

## 使用须知

感谢使用本应用。请在使用前阅读以下说明：

1. 本应用为 AI 辅助开发的开源作品，仅供学习与技术交流使用，不构成任何实际用途承诺。
2. 本应用完全开源，GitHub 仓库地址：[gucheng910/jm-minimal](https://github.com/gucheng910/jm-minimal)。本应用本身不存在任何收费行为；如您是在其他平台付费获取的，请立即退款，并前往上述 GitHub 仓库获取最新版本。
3. 本应用仅作为 JM 官方服务的客户端，站内所有内容均通过官方接口获取，版权归原平台及作者所有。
4. 应用内的赞助入口与广告位均指向 JM 官方渠道，收益归官方所有，与本应用开发者无关。
5. JM 属于每一位热爱它的用户。为了缓解 JM 的经济压力，如条件允许，欢迎打开应用左上角菜单，适当点击官方广告；在经济条件允许时，也可选择赞助 JM，共同支持平台长久发展。西门！🙏🙏🙏
6. 出于轻量化考虑，本应用不得不砍掉包括注册、信箱等在内的大部分功能，仅保留部分基础功能，更适合 JM 轻量使用者在特殊情况下作临时替代。如需使用更多功能，请移步 [JM 官方发布页](https://18comic.vip/stray/) 下载官方版本，感谢您的配合。
7. **图源选择与测速已合并为「更快的源」**：阅读器里点一下就会自动测速并切到该漫画最快的图源，测速完成后弹窗不会自动关闭，可以手动改选；**关闭弹窗即停止测速**，不会在后台偷偷换源。
8. 阅读器新增「去条纹」：通过简单算法尝试去除部分漫画中的条纹（本地图像处理，**不消耗额外流量**，默认开启）。按钮亮 = 显示修复后效果，灭 = 显示原图，点击即可对照。去条纹在**进入视口后由后台空闲时逐页处理**，不影响翻页与首屏可读速度。
9. 详情页的**作者与标签已变成可点击的蓝字**：点一下直接按作者 / 标签搜索，进入一个独立的搜索结果页（搜索词不可修改，只能返回）。该页只列出结果，点漫画进详情；在详情里再点作者 / 标签会重新搜索（旧的搜索结果页会被替换，避免层层套娃），返回依次回到详情页 → 列表页。**「相关漫画」「登场人物」同样可点。**
10. 页面切换改用**推拉动效**：列表进详情、详情返回列表、详情进搜索结果页都有「新页从右侧推入、旧页后退缩小变暗」的转场（系统开启「减少动态效果」时自动关闭）。
11. **连载多话合并**：足迹和缓存里的连载作品不再按「话」重复收录，同一本书只占一条。足迹显示「读到 第 N 话」，点一下回到最后阅读的那一话；缓存管理按「书」分组，展开可单独暂停 / 重下 / 删除某一话。
12. **离线元数据与离线详情页**：缓存漫画时会把简介、标签、作者、目录一起存到本地，断网也能看。在缓存管理里点已缓存漫画的封面，先进的是**离线详情页**——目录标出哪些话已缓存，已缓存的话直接离线阅读，未缓存的话走网络；从一话退回来目录和滚动位置都还在。
13. **阅读器内可换话与选话缓存**：连载作品的工具栏会显示当前话数，点开可直接切换；点「缓存」会先询问要缓存哪些话（默认只选当前话，支持全选 / 反选，已缓存的话显示 ✓ 且不可重复选择）；只有一话时不会询问。

感谢您的理解与支持。


## 构建

> 普通用户请直接从上方「下载」获取安装包，以下内容面向开发者。

```bash
npm install
npm run build        # 产出 dist/
npm run cap:sync     # 同步 Android
npm run pc:pack      # 打包 Windows 便携版
```

Android 正式包：`android/app/build/outputs/apk/release/app-release.apk`

## 许可

代码仅供学习交流。请遵守所在地法律与目标平台的服务条款；请勿将本仓库用于任何商业或违规用途。