# 兼容包（老内核 + 老安卓）构建：--mode compat 的 ES5 产物 + minSdk 23 + 关 ServiceWorker + 不含去条纹
#
# 2.1.0 起原来的 legacy 并入 compat：只发 modern / compat 两个安卓包，
# compat 就是能装到 Android 6（API 23）的那一个（原 tools/build-legacy-apk.ps1 已合并到这里）。
# 并入时保留的四点 legacy 特性，全部在这份脚本里设置：
#   1) minSdk 24 → 23（@capacitor/android 依赖的 org.apache.cordova:framework:14.0.1 把 minSdk 钉在 24，
#      用合并器官方建议的 tools:overrideLibrary 放行；本项目没有任何 cordova 插件）
#   2) JM_NO_SW=1：Capacitor 的 Bridge 会调 android.webkit.ServiceWorkerController（API 24 才有），
#      Android 6 上启动即 NoClassDefFoundError → 关掉 ServiceWorker 代理
#   3) JM_NO_SEAM=1：去条纹（接缝修复）整块被摇掉 —— 每张正文图都要 canvas 重排，老机器负担不起
#   4) BUILD_VARIANT=compat（--mode compat）：应用内更新器据此挑 jm-minimal-compat-<ver>.apk
#
# 用法：pwsh -File tools/build-compat-apk.ps1 -Version 2.1.0
#       -SkipWebBuild   复用已构建的 dist-compat（调试时用）
#       -DebugWebView   打开 WebView DevTools（仅本地诊断；正式发布不要加）
# 产物：release/jm-minimal-compat-<Version>.apk（minSdk=23）
param(
  [string]$Version = "2.1.0",
  [switch]$SkipWebBuild,
  [switch]$DebugWebView
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$vars = "android\variables.gradle"
$mf = "android\app\src\main\AndroidManifest.xml"
$backup = @{}
foreach ($f in @($vars, $mf)) { $backup[$f] = Get-Content $f -Raw }
$nl = [char]13 + [char]10

try {
  Write-Host "=== 1) patch: minSdk 23 + overrideLibrary ===" -ForegroundColor Cyan
  (Get-Content $vars -Raw) -replace "minSdkVersion = 24", "minSdkVersion = 23" | Set-Content $vars -NoNewline
  $m = Get-Content $mf -Raw
  if ($m -notmatch "xmlns:tools") {
    $oldHead = '<manifest xmlns:android="http://schemas.android.com/apk/res/android">'
    $newHead = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"' + $nl + '          xmlns:tools="http://schemas.android.com/tools">'
    $m = $m.Replace($oldHead, $newHead)
  }
  if ($m -notmatch "overrideLibrary") {
    $openEnd = $m.IndexOf(">", $m.IndexOf("<manifest"))
    $useSdk = '    <uses-sdk tools:overrideLibrary="org.apache.cordova" />'
    $m = $m.Substring(0, $openEnd + 1) + $nl + $useSdk + $m.Substring($openEnd + 1)
  }
  Set-Content -Path $mf -Value $m -NoNewline
  Select-String -Path $mf -Pattern "tools:|overrideLibrary" | ForEach-Object { "  " + $_.Line.Trim() }

  if (-not $SkipWebBuild) {
    Write-Host "=== 2) build compat web bundle (dist-compat) ===" -ForegroundColor Cyan
    # 必须在 npm run build:compat 之前设：vite.config.ts 用它注入 __NO_SEAM__（构建期常量，整块逻辑才会被摇掉）
    $env:JM_NO_SEAM = "1"
    npm run build:compat 2>&1 | Select-Object -Last 2
  }
  Write-Host "=== 3) cap copy (dist-compat) ===" -ForegroundColor Cyan
  $env:JM_WEB_DIR = "dist-compat"
  if ($DebugWebView) { $env:JM_WEBVIEW_DEBUG = "1" } else { $env:JM_WEBVIEW_DEBUG = "0" }
  # 关掉 Capacitor 的 ServiceWorkerController 调用（API 24+，Android 6 上会崩）
  $env:JM_NO_SW = "1"
  npx cap copy android 2>&1 | Select-Object -Last 1

  Write-Host "=== 4) gradle assembleRelease ===" -ForegroundColor Cyan
  Push-Location android
  cmd /c ..\build-rel.cmd 2>&1 | Select-String "BUILD|error:|FAILURE|overrideLibrary|minSdk" | Select-Object -Last 10
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { Write-Host "build failed" -ForegroundColor Red; exit 1 }

  $built = "android\app\build\outputs\apk\release\app-release.apk"
  $out = "release\jm-minimal-compat-$Version.apk"
  Copy-Item $built $out -Force
  Write-Host "=== 5) artifact ===" -ForegroundColor Cyan
  Write-Host ("  " + $out + "  " + [math]::Round((Get-Item $out).Length/1MB,2) + " MB")
  Write-Host ("  sha256 " + (Get-FileHash $out -Algorithm SHA256).Hash)
  $aapt = (where.exe apkanalyzer 2>$null | Select-Object -First 1)
  if ($aapt) {
    Write-Host ("  minSdk=" + ((& $aapt manifest min-sdk $out 2>$null) | Select-Object -Last 1))
    Write-Host ("  version=" + ((& $aapt apk summary $out 2>$null) | Select-Object -Last 1))
  }
} finally {
  Write-Host "=== 6) restore ===" -ForegroundColor Cyan
  foreach ($f in $backup.Keys) { Set-Content -Path $f -Value $backup[$f] -NoNewline }
  $env:JM_WEB_DIR = "dist"
  $env:JM_WEBVIEW_DEBUG = "0"
  Remove-Item Env:JM_NO_SEAM -ErrorAction SilentlyContinue
  Remove-Item Env:JM_NO_SW -ErrorAction SilentlyContinue
  npx cap copy android 2>&1 | Select-Object -Last 1
}
