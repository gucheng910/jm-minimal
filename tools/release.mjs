#!/usr/bin/env node
/**
 * tools/release.mjs —— JM极简版发版一条龙
 *
 * 用法：
 *   node tools/release.mjs 1.7.1                 # 只做本地：版本同步 → web 构建 → APK → PC 包（不上传）
 *   node tools/release.mjs 1.7.1 --publish       # 额外创建 GitHub Release（draft → 上传 → 发布 → 校验）
 *   node tools/release.mjs 1.7.1 --dry-run       # 只打印将要改什么/做什么，不落盘
 *   node tools/release.mjs 1.7.1 --skip-pc       # 跳过 Electron 打包（只想出 APK 时）
 *   node tools/release.mjs 1.7.1 --skip-android  # 跳过 Android 打包
 *   node tools/release.mjs 1.7.1 --verify-only  # 只校验已发布的 Release（走 gh API，本机被墙也能用）
 *
 * 编码进去的坑（都是踩过的）：
 *   1) cap sync 必须在仓库根跑，否则静默用旧 web 资源 → 脚本会比对 dist 与 android 资产的哈希
 *   2) 版本号四处同步：package.json / build.gradle / BUILDING.md 表 / README 下载表
 *   3) gh release 走 draft → 逐个上传（失败重试）→ publish（84MB 的 portable 曾中途断过）
 *   4) 发布后自动做 BUILDING §5.4 校验：线上 latest.yml sha512 对比 + 资产 HEAD 200
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs, { readFileSync, writeFileSync, copyFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";
const REPO = "gucheng910/jm-minimal";

const argv = process.argv.slice(2);
const version = argv.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const PUBLISH = flags.has("--publish");
const DRY = flags.has("--dry-run");
const SKIP_PC = flags.has("--skip-pc");
const SKIP_ANDROID = flags.has("--skip-android");
const VERIFY_ONLY = flags.has("--verify-only");
const notesArg = argv.indexOf("--notes");

const log = (...a) => console.log(...a);
const step = (t) => log("\n" + "=".repeat(4) + " " + t);
const die = (msg) => { console.error("\n[失败] " + msg); process.exit(1); };
const exe = (name) => (IS_WIN ? name + ".cmd" : name);

// Windows 上 .cmd/.bat 必须经 cmd /c 启动（Node 20+ 不允许直接 spawn .cmd）
function shellOf(cmd, args) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(cmd)) return { cmd: "cmd", args: ["/c", cmd, ...args] };
  return { cmd, args };
}
function run(cmd, args, opts = {}) {
  const s = shellOf(cmd, args);
  const r = spawnSync(s.cmd, s.args, { cwd: opts.cwd || ROOT, stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8" });
  if (r.status !== 0) die((opts.what || cmd + " " + args.join(" ")) + " 退出码 " + r.status);
  return (r.stdout || "").trim();
}
function capture(cmd, args, opts = {}) {
  const s = shellOf(cmd, args);
  try {
    return execFileSync(s.cmd, s.args, { cwd: opts.cwd || ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) {
    if (opts.optional) return "";
    die((opts.what || cmd) + " 执行失败：" + (e.stderr || e.message));
  }
}
const readText = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const writeText = (rel, text) => { if (!DRY) writeFileSync(path.join(ROOT, rel), text); };
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const mb = (p) => (statSync(p).size / 1048576).toFixed(2) + " MB";
const semver = (v) => v.split(".").map(Number);

function assertNewer(next, cur) {
  const a = semver(next), b = semver(cur);
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return; if (a[i] < b[i]) die("版本号 " + next + " 不大于当前 " + cur); }
  die("版本号与当前相同：" + cur);
}

// ---------------------------------------------------------------- 预检
step("预检");
if (!version) die("用法：node tools/release.mjs <x.y.z> [--publish|--dry-run|--skip-pc|--skip-android]");
const pkg = JSON.parse(readText("package.json"));
const curVersion = pkg.version;
// --skip-pc --skip-android = 复用上一轮产物发布，此时版本号必然与当前一致（不再要求递增）
const reuseOnly = (SKIP_PC && SKIP_ANDROID) || VERIFY_ONLY;
if (reuseOnly) {
  if (version !== curVersion) die("复用产物发布时版本号必须与 package.json 一致（当前 " + curVersion + "，传入 " + version + "）");
} else {
  assertNewer(version, curVersion);
}

const gradlePath = "android/app/build.gradle";
const gradle = readText(gradlePath);
const mCode = gradle.match(/versionCode\s+(\d+)/);
const mName = gradle.match(/versionName\s+"([^"]+)"/);
if (!mCode || !mName) die("解析 " + gradlePath + " 失败");
const nextCode = Number(mCode[1]) + 1;

// 只拦「已跟踪文件被改」，未跟踪的新文件（如本脚本自身）不算脏
const dirty = capture("git", ["status", "--porcelain", "--untracked-files=no"]);
if (dirty && !DRY) die("工作区有未提交改动，先提交或 stash：\n" + dirty);
const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (PUBLISH && branch !== "main") die("发布只允许在 main 上（当前 " + branch + "）");
if (PUBLISH && !capture("gh", ["auth", "status"], { optional: true })) die("gh 未登录");
const jbr = "C:/Program Files/Android/Android Studio/jbr";
if (!SKIP_ANDROID && IS_WIN && !existsSync(jbr)) die("找不到 Android Studio JBR：" + jbr);

log("仓库      " + ROOT);
log("版本      " + curVersion + "  →  " + version);
log("versionCode " + mCode[1] + "  →  " + nextCode);
log("模式      " + (DRY ? "dry-run（不写文件）" : PUBLISH ? "本地构建 + 发布 GitHub" : "仅本地构建（不上传）"));
log("分支      " + branch + (dirty ? "（有未提交改动）" : "（干净）"));

if (VERIFY_ONLY) {
  // 只校验已发布的 Release：不构建、不改版本号
  const candidates = [
    ["jm-minimal-modern-" + version + ".apk", path.join(ROOT, "release/jm-minimal-modern-" + version + ".apk")],
    ["jm-minimal-compat-" + version + ".apk", path.join(ROOT, "release/jm-minimal-compat-" + version + ".apk")],
    ["jm-minimal-setup-" + version + ".exe", path.join(ROOT, "release-pc/jm-minimal-setup-" + version + ".exe")],
    ["jm-minimal-setup-" + version + ".exe.blockmap", path.join(ROOT, "release-pc/jm-minimal-setup-" + version + ".exe.blockmap")],
    ["latest.yml", path.join(ROOT, "release-pc/latest.yml")],
    ["jm-minimal-portable-" + version + ".exe", path.join(ROOT, "release-pc/jm-minimal-portable-" + version + ".exe")]
  ];
  assets.push(...candidates.filter(([n, f]) => {
    if (existsSync(f)) return true;
    log("  ! 本地缺少产物，跳过比对：" + n);
    return false;
  }));
  verifyRelease();
  process.exit(0);
}

// ---------------------------------------------------------------- 版本同步
// 复用产物发布（--skip-pc --skip-android）时产物已按当前版本号构建好，
// 再改版本号会与实际产物对不上（尤其 versionCode 会凭空 +1）
step(reuseOnly ? "复用产物发布：跳过版本号同步" : "同步版本号（4 处 + BUILD_TAG）");
const today = new Date();
const stamp = "v" + today.getFullYear() + String(today.getMonth() + 1).padStart(2, "0") + String(today.getDate()).padStart(2, "0") + "-" + version;

const edits = [];
// 1) package.json（只改第一个 version 字段）
const pkgNew = readText("package.json").replace(/"version":\s*"[^"]+"/, '"version": "' + version + '"');
edits.push(["package.json", pkgNew]);
// 1b) package-lock.json（根 version + packages[""].version 两处）
let lockNew = readText("package-lock.json");
let hit = 0;
lockNew = lockNew.replace(/"version":\s*"([^"]+)"/g, (m, v) => (v === curVersion && hit++ < 2 ? m.replace(curVersion, version) : m));
edits.push(["package-lock.json", lockNew]);
// 2) build.gradle
edits.push([gradlePath, gradle.replace(/versionCode\s+\d+/, "versionCode " + nextCode).replace(/versionName\s+"[^"]+"/, 'versionName "' + version + '"')]);
// 3) BUILDING.md 版本表
edits.push(["BUILDING.md", readText("BUILDING.md")
  .replace(/(\| PC \+ 前端 \| package\.json → version \| )[^|]+(\|)/, "$1" + version + " $2")
  .replace(/(\| Android \| android\/app\/build\.gradle → defaultConfig \| )[^|]+(\|)/, "$1versionName " + version + " / versionCode " + nextCode + " $2")]);
// 4) README 下载表与链接
edits.push(["README.md", readText("README.md").split("-" + curVersion).join("-" + version).split("v" + curVersion + "/").join("v" + version + "/")]);
// 5) BUILD_TAG
edits.push(["src/core/constants.ts", readText("src/core/constants.ts").replace(/export const BUILD_TAG = "[^"]*";/, 'export const BUILD_TAG = "' + stamp + '";')]);

for (const [f, text] of reuseOnly ? [] : edits) {
  const changed = text !== readText(f);
  log((changed ? "  ✎ " : "  · ") + f + (changed ? "" : "（无变化）"));
  if (changed) writeText(f, text);
}

if (DRY) {
  step("dry-run：到此为止");
  log("将要执行：npm run build → npx cap sync android（含资产哈希比对）→ build-rel.cmd");
  if (!SKIP_PC) log("           → npm run pc:pack（nsis + portable）→ 校验 latest.yml 版本与 size");
  log(PUBLISH ? "           → gh release create(draft) → 上传 6 个资产(重试) → publish → §5.4 校验" : "           → 跳过发布（未加 --publish）");
  process.exit(0);
}

// ---------------------------------------------------------------- web 构建
step("构建 web 产物（tsc --noEmit + vite build）");
run(exe("npm"), ["run", "build"]);

// ---------------------------------------------------------------- Android
let apkPath = "";
if (!SKIP_ANDROID) {
  step("同步 Android 资产（必须在仓库根执行）");
  run(exe("npx"), ["cap", "sync", "android"]);

  const distAssets = readdirSync(path.join(ROOT, "dist/assets")).sort();
  const androidAssets = readdirSync(path.join(ROOT, "android/app/src/main/assets/public/assets")).sort();
  if (distAssets.join("|") !== androidAssets.join("|")) {
    die("dist 与 android 资产不一致（cap sync 没生效？）\n  dist:    " + distAssets.join(",") + "\n  android: " + androidAssets.join(","));
  }
  const main = distAssets.find((f) => /^index-.*\.js$/.test(f));
  const h1 = sha256(path.join(ROOT, "dist/assets", main));
  const h2 = sha256(path.join(ROOT, "android/app/src/main/assets/public/assets", main));
  if (h1 !== h2) die("主 bundle 哈希不一致，android 里是旧资源：" + main);
  log("  ✓ 资产一致，主 bundle " + main + " sha256 " + h1.slice(0, 12) + "…");

  step("构建正式 APK（gradlew assembleRelease）");
  run("cmd", ["/c", path.join(ROOT, "build-rel.cmd")], { cwd: path.join(ROOT, "android") });

  apkPath = path.join(ROOT, "android/app/build/outputs/apk/release/app-release.apk");
  if (!existsSync(apkPath)) die("没找到 APK：" + apkPath);
  const modern = path.join(ROOT, "release/jm-minimal-modern-" + version + ".apk");
  const compat = path.join(ROOT, "release/jm-minimal-compat-" + version + ".apk");
  if (!DRY) { copyFileSync(apkPath, modern); copyFileSync(apkPath, compat); }
  log("  ✓ " + path.basename(modern) + "  " + mb(apkPath) + "  sha256 " + sha256(apkPath).slice(0, 16) + "…");
  log("  ✓ " + path.basename(compat) + "（同字节，官方「双名上传」约定）");

  // 校验 APK 内的版本号（apkanalyzer 存在才查）
  // 注意：Windows 上 apkanalyzer 是 .bat，必须拿 where 解析出的完整路径再走 cmd /c（直接 spawn 名字会静默失败）
  const aapt = (IS_WIN ? capture("where", ["apkanalyzer"], { optional: true }) : capture("which", ["apkanalyzer"], { optional: true }))
    .split(/\r?\n/)[0].trim();
  if (aapt) {
    const vn = capture(aapt, ["manifest", "version-name", apkPath], { optional: true });
    const vc = capture(aapt, ["manifest", "version-code", apkPath], { optional: true });
    if (vn && vn !== version) die("APK 内 versionName=" + vn + " 与目标 " + version + " 不一致");
    log("  ✓ APK versionName=" + (vn || "?") + " versionCode=" + (vc || "?"));
  }
}

// ---------------------------------------------------------------- PC
let pcFiles = [];
if (!SKIP_PC) {
  step("构建 PC 包（electron-builder nsis + portable）");
  run(exe("npm"), ["run", "pc:pack"]);
  const ymlPath = path.join(ROOT, "release-pc/latest.yml");
  if (!existsSync(ymlPath)) die("缺少 release-pc/latest.yml");
  const yml = readFileSync(ymlPath, "utf8");
  const ymlVer = (yml.match(/^version:\s*(.+)$/m) || [])[1];
  if (ymlVer !== version) die("latest.yml 版本 " + ymlVer + " ≠ " + version);
  const setup = path.join(ROOT, "release-pc/jm-minimal-setup-" + version + ".exe");
  const portable = path.join(ROOT, "release-pc/jm-minimal-portable-" + version + ".exe");
  const blockmap = setup + ".blockmap";
  for (const f of [setup, blockmap, portable]) if (!existsSync(f)) die("缺少产物：" + f);
  const ymlSize = Number((yml.match(/size:\s*(\d+)/) || [])[1]);
  const realSize = statSync(setup).size;
  if (ymlSize !== realSize) die("latest.yml 里的 size(" + ymlSize + ") 与 setup exe(" + realSize + ") 不一致（混搭了旧 latest.yml？）");
  log("  ✓ latest.yml 版本与 size 一致（" + realSize + " 字节）");
  pcFiles = [
    ["jm-minimal-setup-" + version + ".exe", setup],
    ["jm-minimal-setup-" + version + ".exe.blockmap", blockmap],
    ["latest.yml", ymlPath],
    ["jm-minimal-portable-" + version + ".exe", portable]
  ];
  for (const [n, p] of pcFiles) log("  · " + n + "  " + mb(p));
}

// ---------------------------------------------------------------- 发布
// 产物清单按“磁盘上真实存在”发现：支持先 --skip-* 复用上一次的产物再 --publish
const assetCandidates = [
  ["jm-minimal-modern-" + version + ".apk", path.join(ROOT, "release/jm-minimal-modern-" + version + ".apk")],
  ["jm-minimal-compat-" + version + ".apk", path.join(ROOT, "release/jm-minimal-compat-" + version + ".apk")],
  ["jm-minimal-setup-" + version + ".exe", path.join(ROOT, "release-pc/jm-minimal-setup-" + version + ".exe")],
  ["jm-minimal-setup-" + version + ".exe.blockmap", path.join(ROOT, "release-pc/jm-minimal-setup-" + version + ".exe.blockmap")],
  ["latest.yml", path.join(ROOT, "release-pc/latest.yml")],
  ["jm-minimal-portable-" + version + ".exe", path.join(ROOT, "release-pc/jm-minimal-portable-" + version + ".exe")]
];
const assets = assetCandidates.filter(([n, f]) => {
  if (!existsSync(f)) {
    log("  ! 产物不存在，跳过：" + n);
    return false;
  }
  // latest.yml 是 PC 自动更新的元数据，版本不符会害老用户，必须校验后再上传
  if (n === "latest.yml") {
    const v = (readFileSync(f, "utf8").match(/^version:\s*(.+)$/m) || [])[1];
    if (v !== version) {
      log("  ! latest.yml 里是 " + v + "，与目标 " + version + " 不符，跳过（先跑完整打包生成新的）");
      return false;
    }
  }
  return true;
});

/** §5.4 发布后校验：走 gh API（资产下载域名在本机可能被墙） */
function verifyRelease() {
  const tag = "v" + version;
  step("发布后校验（BUILDING §5.4）");
  // 直接拿 JSON 自己解析：jq 表达式里的转义在 JS 字符串里极易写坏
  const onlineJson = capture("gh", ["release", "view", tag, "--repo", REPO, "--json", "assets"], { what: "gh release view" });
  const onlineSizes = new Map(((JSON.parse(onlineJson) || {}).assets || []).map((a) => [a.name, a.size]));
  for (const [name, file] of assets) {
    const size = statSync(file).size;
    const got = onlineSizes.get(name);
    if (got === undefined) die("线上缺少资产：" + name);
    if (got !== size) die("线上资产大小不符：" + name + " 线上 " + got + " / 本地 " + size);
    log("  ✓ " + name + "  " + size + " 字节（线上一致）");
  }
  const tmp = path.join(ROOT, "_archive/.verify");
  fs.mkdirSync(tmp, { recursive: true });
  run("gh", ["release", "download", tag, "--repo", REPO, "--pattern", "latest.yml", "--dir", tmp, "--clobber"], { quiet: true });
  const onlineYml = readFileSync(path.join(tmp, "latest.yml"), "utf8");
  const localSha = (readFileSync(path.join(ROOT, "release-pc/latest.yml"), "utf8").match(/sha512:\s*(\S+)/) || [])[1];
  const onlineSha = (onlineYml.match(/sha512:\s*(\S+)/) || [])[1];
  if (!onlineSha || onlineSha !== localSha) die("线上 latest.yml 的 sha512 与本地不一致（老用户差分更新会失败）");
  log("  ✓ latest.yml sha512 一致：" + onlineSha.slice(0, 16) + "…");
  for (const [name] of assets) {
    try {
      const code = capture("curl", ["-sIL", "-o", IS_WIN ? "NUL" : "/dev/null", "-w", "%{http_code}", "--max-time", "30", "https://github.com/" + REPO + "/releases/download/" + tag + "/" + name], { optional: true });
      log(code === "200" ? "  ✓ " + name + " → 200" : "  ! " + name + " HEAD " + code + "（本机网络受限，以 gh API 结果为准）");
    } catch {
      log("  ! " + name + " 可达性检查失败（本机网络受限，以 gh API 结果为准）");
    }
  }
  log("\nRelease: https://github.com/" + REPO + "/releases/tag/" + tag);
}

if (PUBLISH) {
  step("创建 GitHub Release（draft → 上传 → 发布）");
  const tag = "v" + version;
  const notesFile = notesArg > -1 ? argv[notesArg + 1] : "";
  const createArgs = ["release", "create", tag, "--repo", REPO, "--draft", "--title", "JM极简版 " + version];
  if (notesFile && existsSync(notesFile)) createArgs.push("--notes-file", notesFile);
  else createArgs.push("--generate-notes");
  capture("gh", createArgs, { what: "gh release create" });
  log("  ✓ draft 已创建 " + tag);

  for (const [name, file] of assets) {
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        run("gh", ["release", "upload", tag, file, "--repo", REPO, "--clobber"], { quiet: true, what: "上传 " + name });
        ok = true;
        log("  ✓ 上传 " + name);
      } catch {
        log("  ! " + name + " 第 " + attempt + " 次失败，重试…");
      }
    }
    if (!ok) die("资产上传失败：" + name + "（draft 仍在，修好后可 gh release upload 补传）");
  }

  capture("gh", ["release", "edit", tag, "--repo", REPO, "--draft=false", "--latest"], { what: "gh release edit" });
  log("  ✓ 已发布 " + tag + " 并标记 Latest");

  verifyRelease();
} else {
  step("跳过发布（未加 --publish）");
  log("本地产物就绪。发布三步：");
  log("  1) 真机/本机验证产物");
  log("  2) git commit -am \"chore(release): " + version + "\" && git push");
  log("  3) node tools/release.mjs " + version + " --publish --skip-pc --skip-android");
  log("     （复用本次产物直接上传；--publish 要求工作区干净，故必须先提交版本号）");
}

// ---------------------------------------------------------------- 汇总
step("完成");
log("版本        " + version + "（versionCode " + nextCode + "）");
log("模式        " + (DRY ? "dry-run" : PUBLISH ? "已发布" : "仅本地"));
for (const [name, file] of assets) if (existsSync(file)) log("  " + name.padEnd(38) + mb(file) + "  sha256 " + sha256(file).slice(0, 16) + "…");
if (!DRY && !PUBLISH) log("\n提醒：版本号已写入工作区，未提交；确认产物后 git commit && git push，再跑 --publish。");
