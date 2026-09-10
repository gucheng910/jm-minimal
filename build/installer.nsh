# 自定义 NSIS 钩子（由 package.json 的 build.nsis.include 引入）
#
# 背景（2026-09-10 本机实测复现）：electron-builder 的升级安装会先静默卸载旧版；
# 旧版卸载器在 --updated 模式下用「逐文件改名到 $PLUGINSDIR\old-install」的方式腾空安装目录
# （见 app-builder-lib/templates/nsis/uninstaller.nsh 的 un.atomicRMDir），
# 只要有一个文件改不动就 RestoreFiles + Abort（退出码 2）→ installUtil.nsh 的
# handleUninstallResult 再 SetErrorLevel 2 + Quit → **整个安装器失败**。
# 现象：应用内更新点「重启并安装」后 App 退出、安装器一闪而过、版本没变；
#       手动重装同样报错。而此时旧目录其实是完好的（RestoreFiles 已还原）。
#
# 这里覆盖 electron-builder 的卸载结果检查：卸载失败也让安装继续，
# 旧目录里的残留文件随后会被新安装包覆盖（我们每次发布都是完整包，文件集稳定）。
# 代价：极少数情况下旧版遗留的多余文件不会被清掉——比"永远更新不了"划算。

!macro customUnInstallCheck
  DetailPrint "旧版卸载返回 $R0；按兼容策略忽略并继续安装（残留文件将被新包覆盖）"
!macroend

!macro customUnInstallCheckCurrentUser
  DetailPrint "旧版卸载返回 $R0；按兼容策略忽略并继续安装（当前用户）"
!macroend
