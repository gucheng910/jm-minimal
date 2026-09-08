# JM极简版 · 发布与开发工作流手册（BUILDING）

> 更新：2026-09 · 覆盖 v1.4.2（含阅读器浮标修复 + 会员页收藏/足迹点击响应修复）
> 当前实况：源码/Android 已到 **1.6.0（versionCode 37）**；
> 线上 GitHub Release 仍为 **v1.4.0（2026-09-07，Latest）**——下次发版按 §1 打 v1.4.2。
> 修复记录：docs/24（1.4.1 阅读器浮标+计数器）、docs/25（1.4.2 收藏/足迹点击无响应）。
> 用途：给"下次开发/发版"的人看——怎么打 PC 包、怎么打 Android 包、往 GitHub 传什么、怎么传、本机常用命令、以及踩过的坑。
> 定位：本文是**操作 runbook + 教训库**；设计/协议/里程碑记录在 docs/00~24（部分历史已归档至 docs/_archive），代码侧见 README.md。

---

## 0. 相关文档导航（先看这里）

| 文档 | 内容 | 什么时候看 |
|---|---|---|
| **docs/00-索引与逆向资源导航.md** | 全库地图：文档阅读顺序 + 归档清单 + 原 app 逆向资料(E:/JMComic-RE)入口 | 新接手/找文件优先 |
| docs/01-新版客户端设计.md | 架构与协议总纲（host 解密/Token/AES 响应） | 想改 core/API 层 |
| docs/03~08、11、12、17~21、23 | 里程碑与模块实录（登录/内容流/阅读器/连载/账号/社区/UI 迭代等；顶部已标现状） | 改对应模块前 |
| docs/09-线路与圖源协议实现.md、docs/14-移动壳与路由.md | 合并页：线路/圖源/测速；移动壳与路由（旧 09+10、14+15 已归档） | 线路/壳层 |
| docs/22-P6回归与重打包.md、docs/24-阅读器页进度浮标与计数器修复.md | Android 真机回归（历史 debug 注）；1.4.1 阅读器浮标+计数器修复 | 回归/阅读器 |
| docs/_archive/ | 已归档历史文档（旧 02/09/10/13/14/15/16 等），内容保留 | 考古/追溯 |
| **E:/JMComic-RE/（本机旁库）** | 原 app v2.1.5 逆向工作区：APK/apktool/jadx/40-notes 协议报告/99-scripts | 需要“原版怎么实现”的事实依据 |
| README.md | 给用户的下载说明（表格链接约定与本手册 §5.3 绑定） | 发版前核对 |
| 本机 AGENTS.md（机器记忆，DSH ~/.dsh 相关目录） | 网络/hosts/gh/工具链等本机环境事实 | 网络相关操作前 |
| **本文 BUILDING.md** | 发版全流程 + 命令 + 坑 | 每次发版 |

---

## 1. 发版 Checklist（PC + Android + GitHub 一次发布）

1. 升版本号（见 §2，PC 与 Android 两处同步）
2. npm run build（tsc 类型检查 + vite 产物 dist/）
3. PC 安装版：npx electron-builder --win nsis
4. PC 便携版：npx electron-builder --win portable
5. Android：npx cap sync android → 在 android/ 执行 build-rel.cmd（gradlew assembleRelease）
6. 产物改名（§5.3）：APK → jm-minimal-{modern,compat}-{ver}.apk（字节相同即同一文件双名）
7. 打 tag 并发布（§5.1）：gh release create vX.Y.Z <files>
8. 校验（§5.4）：gh release view assets / curl latest.yml / sha512 比对
9. 实测：已装旧版点「检查更新」能收到新版本

> ⚠️ 第 9 步是硬门槛：**不升版本号用户永远收不到更新**（electron-updater 同版本判定"已是最新"，见 §6）。
> 若只更新同版本资产（替换安装包/补元数据），走 gh release upload --clobber（§5.2），并同步核对 latest.yml 的 sha512（§5.4）。

---

## 2. 版本号同步规则（重要）

版本号有 **2 个独立源**，发版必须都改：

| 位置 | 文件 | 现值 | 影响 |
|---|---|---|---|
| PC + 前端 | package.json → version | 1.6.0 | 安装包命名、latest.yml version、electron-updater 比较基准；vite 构建时注入 __APP_VERSION__（vite.config.ts）→ 前端 LOCAL_VERSION |
| Android | android/app/build.gradle → defaultConfig | versionName 1.6.0 / versionCode 37 | APK 版本；Android 应用内更新比较的 LOCAL_VERSION（原生 versionName 优先） |

> ⚠️ 现值 = **工作区状态**（1.6.0 本次发版）；线上 Release 为 1.5.0，本次发布后同步到 1.6.0。

规则：
- **每次都同步升**：PC 装包 / APK / 更新判断都依赖这两个值；只改一处会造成"新版拉不下来"或"显示已最新但下载的其实是旧协议版本"。
- versionCode 只增不减（应用商店语义），PC 端无此概念。
- Android 更新器按资产名匹配（modern/compat 子串），与版本号解耦但 Release 描述需一致。

---

## 3. PC 端打包

### 3.1 关键配置（package.json build 段，已就绪）

```json
"build": {
  "appId": "dev.jmclient.pc",
  "productName": "JM极简版",
  "publish": { "provider": "github", "owner": "gucheng910", "repo": "jm-minimal" },
  "directories": { "output": "release-pc" },
  "files": ["dist/**/*", "electron/**/*", "build/icon.png"],
  "main": "electron/main.cjs",
  "win": { "target": ["nsis", "portable"], "icon": "build/icon.png" },
  "nsis": { "artifactName": "jm-minimal-setup-${version}.${ext}",
            "oneClick": true, "perMachine": false },   // 默认即此：一键安装、无目录选择、装到 %LOCALAPPDATA%\\Programs\\jm-client
  "portable": { "artifactName": "jm-minimal-portable-${version}.${ext}" }
}
```
要点：
- publish 是 electron-updater 必需的：**只有配了它，打包才会在资源里生成 app-update.yml**，应用内"检查更新"才有源。不要删。
- oneClick: true（默认）＝安装器无向导、不能选目录。**想"任意位置"请用 portable 版**，别改 assisted（会让安装繁琐）。
- 桌面功能的桥都挂在 electron/preload.cjs + electron/main.cjs（jmDns 清洗桥、jmUpdate 更新桥等），改桌面端先看这两个文件。

### 3.2 命令与产物

```bash
npm run build          # tsc --noEmit && vite build  → dist/
npx electron-builder --win nsis       # 安装版（应用内更新的载体）
npx electron-builder --win portable   # 便携版（单文件，走系统浏览器下载更新）
```
产物目录 release-pc/：

| 文件 | 用途 | 发布时上传 | 备注 |
|---|---|---|---|
| jm-minimal-setup-<ver>.exe | NSIS 安装版 | ✅ 必须 | 更新器基于它（latest.yml 指向它） |
| jm-minimal-setup-<ver>.exe.blockmap | 差分更新元数据 | ✅ 必须 | 缺失→老用户只能整包下载 |
| latest.yml | 更新源元数据（版本/sha512/size） | ✅ 必须 | 缺失→"更新源缺少元数据" |
| jm-minimal-portable-<ver>.exe | 便携版 | ✅ 建议 | 不参与 latest.yml |
| win-unpacked/ | 未压缩调试目录 | ❌ 不传 | 含 resources/app-update.yml 与 app.asar，可本地验证（用完即删，可再生成） |

> app-update.yml 生成条件：必须有 publish 且 target 为 nsis。单独 --win dir（win-unpacked）**不会**生成，别用 dir target 判断。
> electron-updater 是**生产依赖**（在 dependencies，不在 devDependencies），否则 electron-builder 不会把它打进 asar → 启动即"组件缺失"。

### 3.3 本地验证打包结果

```bash
# asar 里有没有新模块/依赖（反斜杠与正则转义坑见 §8.10）
npx asar list release-pc/win-unpacked/resources/app.asar | findstr /C:"updater.cjs"
npx asar list release-pc/win-unpacked/resources/app.asar | findstr /C:"node_modules\\electron-updater"
# app-update.yml 内容（应为 github owner/repo）
type release-pc\win-unpacked\resources\app-update.yml
# 本地 sha512 应与 latest.yml 一致（示例版本号随发版替换）
node -e "const fs=require('fs'),c=require('crypto');const b=fs.readFileSync('release-pc/jm-minimal-setup-1.4.1.exe');console.log(c.createHash('sha512').update(b).digest('base64'))"
```
---

## 4. Android 端打包

现状事实（2026-09）：
- 单工程 android/，包名 dev.jmclient.app；minSdk 24 / targetSdk 36 / compileSdk 36（见 docs/00 → docs/_archive/16-Android打包.md 历史首包记录）。
- 签名走 android/keystore.properties（storeFile/storePassword/keyAlias/keyPassword，**不入库**）；缺失时 assembleRelease 会用 debug 签名，无法覆盖安装旧正式版。
- 正式构建命令：`cd android && ..\build-rel.cmd`（封装 JAVA_HOME → Android Studio JBR）＝ gradlew assembleRelease。
- **modern/compat 双名现状**：gradle 无变体，历史上（1.3.1/1.4.0）两 APK 字节相同，即**同一 APK 双名上传**。
  1.4.1 目前只本地构建了 jm-minimal-modern-1.4.1.apk（测试用）；正式发布时按 §5.3 双名上传（复制改名即可）。
  "compat 供旧系统/targetSdk29"的 README 说法与现状不符，属遗留文案，改版时注意（README 行文仍保留该表述）。

### 4.1 命令

```bash
npm run build            # 1) 前端产物
npx cap sync android     # 2) 同步 web 资源进 android 工程
cd android
..\build-rel.cmd         # 3) 构建正式 APK（assembleRelease，keystore 正式签名）
# 产物：android/app/build/outputs/apk/release/app-release.apk（约 4MB）
# 调试/模拟器：gradlew assembleDebug → …/apk/debug/app-debug.apk（仅开发）
```
> gradle wrapper 已切腾讯镜像（distributionUrl=…gradle-8.14.3-bin.zip），services.gradle.org 被墙不影响。
> Android 应用内更新（src/ui/UpdateSection.tsx + AppUpdaterPlugin）检查 GitHub Release，按资产名匹配 modern/compat。

---

## 5. GitHub Release 发布

仓库：gucheng910/jm-minimal（git remote 走 SSH-443；gh CLI 已登录 gucheng910，全 scope 存 keyring）。

### 5.1 新版本首次发布（推荐 gh，一条命令传全部）

```bash
cd E:/JMClient
# 先把 §3.2 的 PC 产物与 §4 的 APK 按 §5.3 改名准备好，再：
gh release create v1.4.1 ^
  "release-pc/jm-minimal-setup-1.4.1.exe" ^
  "release-pc/jm-minimal-setup-1.4.1.exe.blockmap" ^
  "release-pc/latest.yml" ^
  "release-pc/jm-minimal-portable-1.4.1.exe" ^
  "release/jm-minimal-modern-1.4.1.apk" ^
  "release/jm-minimal-compat-1.4.1.apk" ^
  --repo gucheng910/jm-minimal --title "JM极简版 1.4.1" --notes "变更说明…"
```
> latest.yml 必须与 setup exe **同一次 electron-builder 构建**产生（sha512/size 绑定）。混搭旧 latest.yml + 新 exe 会让老用户差分更新校验失败。
> 若某平台本次未构建（如只发 Android 测试版），发布清单按实际产物取舍；**PC 与 Android 更新各自独立**（见 §5.3 命名与 README 表格）。

### 5.2 更新已有 Release 的资产（替换/补传）

```bash
# 替换已存在同名资产：加 --clobber
gh release upload v1.4.1 release-pc/jm-minimal-setup-1.4.1.exe --clobber --repo gucheng910/jm-minimal
# 补传元数据/新文件：直接 upload（同名会报错，需 --clobber）
gh release upload v1.4.1 release-pc/latest.yml release-pc/jm-minimal-setup-1.4.1.exe.blockmap --repo gucheng910/jm-minimal
```
**应用内更新的最小上传集**：setup exe + latest.yml + blockmap（缺任一都有对应报错，§9）。
**若用 electron-builder 直传**：npx electron-builder --win nsis portable --publish always（等价于上面 PC 部分，自动传 latest.yml/blockmap/exe；APK 仍需手动 gh）。

### 5.3 命名约定（与 README 下载表 / 应用内更新器绑定，勿改）

| 平台 | 文件名 | 备注 |
|---|---|---|
| Android | jm-minimal-modern-<ver>.apk | 更新器匹配子串 "modern" |
| Android | jm-minimal-compat-<ver>.apk | 更新器匹配子串 "compat" |
| PC 安装 | jm-minimal-setup-<ver>.exe | electron-updater 严格按 latest.yml 找它 |
| PC 便携 | jm-minimal-portable-<ver>.exe | README 链接 |

### 5.4 发布后校验（必做）

```bash
gh release view v1.4.1 --repo gucheng910/jm-minimal --json tagName,assets --jq '.tagName, [.assets[].name]'
# 线上 latest.yml 与本地 exe sha512 一致（同版本替换资产后尤其要查）
curl -sL https://github.com/gucheng910/jm-minimal/releases/download/v1.4.1/latest.yml
# blockmap 可达
curl -sIL -o NUL -w "%{http_code}\n" https://github.com/gucheng910/jm-minimal/releases/download/v1.4.1/jm-minimal-setup-1.4.1.exe.blockmap
```
---

## 6. PC 应用内更新机制备忘（electron-updater）

代码位置：electron/updater.cjs（双模式：安装版自动更新 / 便携版引导下载）→ preload 桥 → src/ui/DesktopUpdate.tsx。

| 事实 | 说明 |
|---|---|
| 只有**安装版（NSIS）**支持自动更新 | portable 无此能力 → 走"查版本 + 系统浏览器下载"引导 |
| 判定只比 package.json version vs latest.yml version | **相等 = 已是最新，即使内容不同**（§2 教训来源） |
| 自动流程 | 检查 → 有新版本自动后台下载（差分，基于 blockmap）→ sha512 校验 → 就绪 → 「重启并安装」= quitAndInstall（先退出自己再跑安装器，天然避开"运行中报错"） |
| 数据保留 | 安装器内部走 --updated / keep-app-data，%APPDATA%\jm-client 用户数据不清除 |
| 更新源 | 打包生成的 app-update.yml（github）；JM_UPDATE_FEED 环境变量可覆盖为 generic（本地测试/未来镜像用，见 §8.6） |
| 开发态 | 未打包（npx electron .）时 updater 不可用，UI 提示"开发模式"——属正常 |
| 单实例 | requestSingleInstanceLock：重复启动直接退；安装器不会替你杀 App（§8.1 手动处理） |

---

## 7. 本机常用命令速查

### 7.1 日常开发
```bash
npm run dev          # vite dev，浏览器调试（http://localhost:5173）
npm run build        # tsc 类型检查 + 产物 dist/
npm run preview      # 预览 dist
npx electron .       # 桌面壳跑 dist（未打包=开发态：DNS 清洗可用、更新不可用）
```
### 7.2 打包 / 发布（按 §3/§4/§5 顺序）
```bash
npx electron-builder --win nsis          # PC 安装版 → release-pc/
npx electron-builder --win portable      # PC 便携版
npx cap sync android                     # Android 同步
cd android && ..\build-rel.cmd           # APK（assembleRelease）
gh release create/upload …               # 见 §5
```
### 7.3 已安装应用的运维（本机实测有效）
```powershell
# 安装目录 / 卸载器（卸载器名含空格！）
$base = "$env:LOCALAPPDATA\Programs\jm-client"
& "$base\Uninstall JM极简版.exe" /S /currentuser     # 静默卸载（退出码 0 = 成功）
# 安装（静默）；GUI 程序必须用 Start-Process -Wait，PowerShell 直接 & 不会等 GUI 进程
Start-Process "E:\JMClient\release-pc\jm-minimal-setup-<ver>.exe" -ArgumentList '/S' -Wait -PassThru
# 升级/重装前必杀进程（1 个实例 = 4 个 electron 子进程，进程名含中文）
Get-Process -Name 'JM极简版' | Stop-Process -Force
# 启动已安装应用
Start-Process "$base\JM极简版.exe"
```
### 7.4 诊断与核对
```bash
node -p "require('./node_modules/electron/package.json').version"   # electron 版本
npx asar list release-pc/win-unpacked/resources/app.asar | findstr /C:"updater.cjs"
gh auth status && gh release view v1.4.1 --repo gucheng910/jm-minimal --json assets --jq '.assets[].name'
```
---

## 8. 经验教训（本仓库真实踩坑）

### 8.1 已安装过再装报错 —— 根因与正解
- 机制：electron-builder 安装器升级 = 先静默卸载旧版（uninstallOldVersion，installUtil.nsh）→ 再装；**旧版 App 运行中**则卸载器删不掉文件 → 循环 5 次失败 → 安装器退出码 2（handleUninstallResult）→ 用户看到"错误"。
- 正解：装前 Get-Process -Name 'JM极简版' | Stop-Process -Force；或交给应用内更新（先 quit 再装）。手动重装同理。
- 附加：旧卸载器单独跑 exit 0 也可能**留空目录**（%LOCALAPPDATA%\Programs\jm-client），装前 Remove-Item -Recurse -Force 兜底。

### 8.2 oneClick 安装器无目录选择
- NSIS 默认 oneClick=true（固定装 %LOCALAPPDATA%\Programs\jm-client，免管理员、无向导）。要自选位置 → 用 portable 版；不建议改 assisted。

### 8.3 latest.yml 元数据缺失 / 不一致
- Release 缺 latest.yml → 应用内"更新源缺少元数据"；缺 blockmap → 退化为整包下载；sha512/size 与 exe 不一致 → 下载后校验失败。
- 三者必须与**同一次构建**的 setup exe 配套；改了 exe 必须重跑 electron-builder 再传，别手改 yml。

### 8.4 同版本"已是最新"陷阱
- 更新判断只看版本号：**升级内容必须升版本号**。想给老用户发同版本但含新功能/新依赖的包是发不出去的——只能发下一版。发版前在 §1 第 9 步实测一次。

### 8.5 electron-updater 依赖位置
- 必须放 dependencies（生产依赖）才会进 asar；放 devDependencies 打包后 require 失败 → 更新不可用。

### 8.6 更新链路的本地测试法（不碰真实 Release）
1. 起本地目录服务：python -m http.server 18999 --directory feed
2. feed 里放 latest.yml（version 9.9.9 + sha512/size）+ 任意字节的 jm-minimal-setup-9.9.9.exe（sha512 必须算对，electron-updater 会校验）
3. 打包后的 exe 加环境变量 JM_UPDATE_FEED=http://127.0.0.1:18999/ 启动 → 应看到 发现→下载→就绪 全链路
- 注意：别点"重启并安装"（会真装一个测试版），测完手动卸载。

### 8.7 PowerShell 启动 GUI 程序不等待
- & exe 对 GUI 子系统程序立即返回 → 拿不到输出/退出码。用 Start-Process … -Wait -PassThru（-RedirectStandardOutput/-RedirectStandardError 重定向到文件再看）。

### 8.8 electron 二进制下载
- node node_modules/electron/install.js 对 npmmirror 报证书错（got/根 CA）→ 设 NODE_OPTIONS=--use-system-ca；仍失败手动：curl -k -L …/electron-v<ver>-win32-x64.zip（npmmirror mirrors/electron/）→ tar -xf 到 node_modules/electron/dist → 写 path.txt 内容 electron.exe。
- electron-builder 二进制走 ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/（缓存 %LOCALAPPDATA%\electron-builder\Cache：nsis/nsis-resources/winCodeSign 已就绪）。

### 8.9 冒烟/自动化验证套路
- 临时钩子法：给 main.cjs 加 if (process.env.JM_SMOKE) 诊断块（打印状态/定时 app.exit），打包跑完即删。本次 DNS 清洗与更新链路均用此法验证。
- 更新事件由主进程推送渲染层；main 侧轮询 getState() 打日志最简单。

### 8.10 asar 列目录的坑
- npx asar list … | Select-String 里正则反斜杠/管道容易失配（曾出现"搜不到实际存在文件"的假阴性）。输出到文件后用 findstr /C:"…" 或 Select-String -SimpleMatch。

### 8.11 Android "modern/compat" 现状
- gradle 无变体、历史双 APK 字节相同（同一文件双名）；README 的 compat=旧 targetSdk 说明是遗留文案。若真要做 compat 需在 gradle 加变体/改 targetSdk 再构建，别直接复制改名假装支持。
- 1.4.1：本地仅构建并测试 jm-minimal-modern-1.4.1.apk，发布时仍按双名上传（§5.3）。

### 8.12 网络与证书（速记）
- api.github.com 稳定；github.com 网页/对象存储间歇被墙；下载 release 资产失败先重试或 hosts pin（详见本机 AGENTS.md 网络段）。
- 官方线路/图床域名 DNS 被污染 → PC 内置清洗（electron/dns-clean.cjs，会员页开关）自动 DoH 解析；渲染层涉及 src/core/dnsClean.ts + api.ts 注册钩子。

---

## 9. 症状 → 原因 → 解法速查

| 症状 | 原因 | 解法 |
|---|---|---|
| 应用内「更新源缺少元数据(latest.yml)」 | Release 缺 latest.yml | §5.2 补传（配 exe 同构建的 yml） |
| 「已是最新版本」但明知有新包 | 版本号未升 | §2 同步升 package.json + build.gradle |
| 下载完报校验失败 | latest.yml sha512 与 exe 不一致 | 同一次构建产物整体重传 |
| 手动重装报错 | 旧版进程在跑 / 卸载残留 | §8.1 杀进程 + 删残留目录后重装 |
| 安装器静默退出码 2 | 旧版卸载失败 | 手动跑旧卸载器 → 清理目录 → 重装 |
| PC 点检查更新提示"开发模式" | npx electron . 未打包态 | 装安装版测 |
| 装完没有「DNS 清洗」卡片 | 装的是旧构建 | 换新 setup（§3.2 产物） |
| GitHub 下载 asset 失败 | 对象存储间歇被墙 | 稍后重试 / hosts pin / gh api 备用（AGENTS.md） |
| Android 更新找不到安装包 | Release 缺 modern/compat 命名 APK | §5.3 命名上传 |

---

## 10. 下次发版动作速记

1. 升 package.json version **和** android/app/build.gradle versionName/versionCode
2. npm run build → electron-builder nsis + portable → npx cap sync android + build-rel.cmd
3. APK 按 §5.3 命名后随 gh release 上传
4. gh release create vX.Y.Z（§5.1 完整清单）→ §5.4 校验 → 装旧版的机器点「检查更新」实测
5. 更新 README 下载表（若改文件名/说明）与 docs/ 记录

> 悬而未决（当前工作区）：1.4.1 源码已含阅读器改动且版本号已升，**尚未 commit/tag/发布**；
> PC 端 1.4.1（nsis/portable/latest.yml）尚未构建；README 下载表仍指 1.4.0。
