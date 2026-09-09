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
| `jm-minimal-modern-1.7.2.apk` | Android 10+ / 新系统（targetSdk 36） | [下载](https://github.com/gucheng910/jm-minimal/releases/download/v1.7.2/jm-minimal-modern-1.7.2.apk) |
| `jm-minimal-compat-1.7.2.apk` | 旧 Android / 带安卓兼容层的鸿蒙 2~4 | [下载](https://github.com/gucheng910/jm-minimal/releases/download/v1.7.2/jm-minimal-compat-1.7.2.apk) |
| `jm-minimal-portable-1.7.2.exe` | Windows 7+ x64（免安装便携版） | [下载](https://github.com/gucheng910/jm-minimal/releases/download/v1.7.2/jm-minimal-portable-1.7.2.exe) |
| `jm-minimal-setup-1.7.2.exe` | Windows 7+ x64（NSIS 安装包） | [下载](https://github.com/gucheng910/jm-minimal/releases/download/v1.7.2/jm-minimal-setup-1.7.2.exe) |

> 注意：HarmonyOS NEXT（纯血鸿蒙）不支持 APK，请使用官方支持的渠道；兼容版适用于 HarmonyOS 2~4 等带 Android 兼容层的系统。

App 内「左侧菜单 → 版本 → 检查更新」同样读取本仓库最新 Release，可一键下载更新。

## 使用须知

感谢使用本应用。请在使用前阅读以下说明：

1. 本应用为 AI 辅助开发的开源作品，仅供学习与技术交流使用，不构成任何实际用途承诺。
2. 本应用完全开源，GitHub 仓库地址：[gucheng910/jm-minimal](https://github.com/gucheng910/jm-minimal)。本应用本身不存在任何收费行为；如您是在其他平台付费获取的，请立即退款，并前往上述 GitHub 仓库获取最新版本。
3. 本应用仅作为 JM 官方服务的客户端，站内所有内容均通过官方接口获取，版权归原平台及作者所有。
4. 应用内的赞助入口与广告位均指向 JM 官方渠道，收益归官方所有，与本应用开发者无关。
5. JM 属于每一位热爱它的用户。为了缓解 JM 的经济压力，如条件允许，欢迎打开应用左上角菜单，适当点击官方广告；在经济条件允许时，也可选择赞助 JM，共同支持平台长久发展。西门！🙏🙏🙏
6. 出于轻量化考虑，本应用不得不砍掉包括注册、信箱等在内的大部分功能，仅保留部分基础功能，更适合 JM 轻量使用者在特殊情况下作临时替代。如需使用更多功能，请移步 [JM 官方发布页](https://18comic.vip/stray/) 下载官方版本，感谢您的配合。
7. 由于不同图源对不同漫画的速度可能有差异，图源测速已放到漫画阅读器内：若漫画加载缓慢，可点击「测速切换」按钮，将自动切换到该漫画当前最快的图源。
8. 阅读器新增「去条纹」：通过简单算法尝试去除部分漫画中的条纹（本地图像处理，**不消耗额外流量**，默认开启）。按钮亮 = 显示修复后效果，灭 = 显示原图，点击即可对照。
9. 详情页的**作者与标签已变成可点击的蓝字**：点一下直接按作者 / 标签搜索，进入一个独立的搜索结果页（搜索词不可修改，只能返回）。该页只列出结果，点漫画进详情；在详情里再点作者 / 标签会重新搜索（旧的搜索结果页会被替换，避免层层套娃），返回依次回到详情页 → 列表页。
10. 页面切换改用**推拉动效**：列表进详情、详情返回列表、详情进搜索结果页都有「新页从右侧推入、旧页后退缩小变暗」的转场（系统开启「减少动态效果」时自动关闭）。

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