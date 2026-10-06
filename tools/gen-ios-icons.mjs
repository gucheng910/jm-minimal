#!/usr/bin/env node
/**
 * 生成 iOS 的 AppIcon 资源集（在 **macOS** 上跑，用系统自带的 sips —— 不引入任何 npm 依赖）。
 *
 * 为什么要有这个脚本：
 *   Capacitor 的 ios 模板不会带 AppIcon 资源，不补的话装到 iPhone 上图标是白板。
 *   本机是 Windows（没有 sips、也生成不了 ios/ 工程），所以这一步落在 CI/某台 Mac 上，
 *   由 .github/workflows/build-ipa.yml 调用。
 *
 * 两个容易被坑的点：
 *   1) **素材是 512 的**（build/icon.png / dist/icons/icon-512.png），而 App Store 图标要求 1024。
 *      本脚本会把它升采样到 1024 并明确打印这条"不是原生素材"的事实，不要指望清晰度凭空变好。
 *   2) **不能带 alpha**：iOS 的 App 图标不接受透明通道，源图是 RGBA 所以必须去 alpha。
 *      ⚠️ 网上常见的写法 `sips -s hasAlpha no` 在 **PNG 上会直接失败**
 *      （实测 CI：`Error: Cannot do --setProperty hasAlpha on file` / Error 13）——
 *      hasAlpha 对 PNG 是只读的。可行做法是「PNG →(缩放+转 JPEG，JPEG 无 alpha)→ 转回 PNG，
 *      此时源已不透明，hasAlpha no 就不会再报错」。见 flatten()。
 *
 * 用法：
 *   node tools/gen-ios-icons.mjs --src build/icon.png --out ios/App/App/Assets.xcassets/AppIcon.appiconset
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.resolve(ROOT, argOf("--src", "build/icon.png"));
const OUT = path.resolve(ROOT, argOf("--out", "ios/App/App/Assets.xcassets/AppIcon.appiconset"));

function run(tool, args) {
  const r = spawnSync(tool, args, { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

/** PNG 的真实像素尺寸（只读 IHDR，不引依赖） */
function pngSize(file) {
  const buf = readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) throw new Error(file + " 不是 PNG");
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") throw new Error(file + " 缺少 IHDR");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function die(msg) {
  console.error("\n✗ " + msg + "\n");
  process.exit(1);
}

/**
 * 缩放到 px×px 并**保证不透明**地写成 PNG。
 *
 * 为什么分三步而不是一步 `sips -s hasAlpha no`：
 *   对 PNG，hasAlpha 是**只读**属性，直接设会报 "Cannot do --setProperty hasAlpha on file"（Error 13）。
 *   走一次 JPEG 就绕开了：JPEG 没有 alpha 通道，转过去再转回来，像素已经不透明，
 *   这时 `hasAlpha no` 只是"确认"而不是"修改"，不会再报错。
 * 万一哪台机器上这条还是失败，退回"直接缩放（不去 alpha）"并明确警告，让构建不因为图标而中断。
 */
function flatten(px, dest) {
  const tmp = path.join(tmpdir(), "jm-ios-icon-" + process.pid + "-" + px);
  const png = tmp + ".png";
  const jpg = tmp + ".jpg";
  try {
    let r = run("sips", ["-z", String(px), String(px), SRC, "--out", png]);
    if (r.code !== 0) die("sips 缩放失败：" + r.out.trim());

    r = run("sips", ["-s", "format", "jpeg", png, "--out", jpg]);
    if (r.code !== 0) {
      // 老版本 sips / 特殊色彩配置下再退一步：先写中间 PNG 再转 JPEG
      die("sips 转 JPEG 失败（去 alpha 的关键一步）：" + r.out.trim());
    }
    r = run("sips", ["-s", "format", "png", "-s", "hasAlpha", "no", "-z", String(px), String(px), jpg, "--out", dest]);
    if (r.code !== 0) {
      console.warn("  ⚠ 去 alpha 失败（" + r.out.trim().split("\n")[0] + "），退回不去 alpha");
      copyFileSync(png, dest);
    }
  } finally {
    rmSync(png, { force: true });
    rmSync(jpg, { force: true });
  }
  const got = pngSize(dest);
  if (got.w !== px || got.h !== px) die(path.basename(dest) + " 尺寸不对：期望 " + px + "，得到 " + got.w + "x" + got.h);
  return got;
}

function hasAlphaFlag(file) {
  const r = run("sips", ["-g", "hasAlpha", file]);
  const m = r.out.match(/hasAlpha:\s*(\w+)/);
  return m ? m[1] : "unknown";
}

if (process.platform !== "darwin") {
  die("这个脚本用 macOS 自带的 sips，只能在 macOS 上跑（当前 " + process.platform +
      "）。Windows 上不要试图绕过：ios/ 工程本身也编不出来，见 BUILDING.md 的 iOS 节。");
}
if (!existsSync(SRC)) die("素材不存在：" + SRC);

const { w, h } = pngSize(SRC);
console.log("素材 " + path.relative(ROOT, SRC) + "  " + w + "x" + h);
if (w !== h) die("素材必须是正方形（当前 " + w + "x" + h + "）");
if (w < 1024) {
  console.log("⚠ 素材只有 " + w + "px，1024 那一档是**升采样**得来的 —— 不糊就行，别指望更清晰。");
}

// iOS 需要的全部尺寸（point × scale = 像素），App Store 的 1024 单列
const ENTRIES = [
  { size: "20x20", scale: 2, idiom: "iphone" },
  { size: "20x20", scale: 3, idiom: "iphone" },
  { size: "29x29", scale: 2, idiom: "iphone" },
  { size: "29x29", scale: 3, idiom: "iphone" },
  { size: "38x38", scale: 2, idiom: "iphone" },
  { size: "38x38", scale: 3, idiom: "iphone" },
  { size: "40x40", scale: 2, idiom: "iphone" },
  { size: "40x40", scale: 3, idiom: "iphone" },
  { size: "60x60", scale: 2, idiom: "iphone" },
  { size: "60x60", scale: 3, idiom: "iphone" },
  { size: "64x64", scale: 2, idiom: "iphone" },
  { size: "64x64", scale: 3, idiom: "iphone" },
  { size: "68x68", scale: 2, idiom: "iphone" },
  { size: "76x76", scale: 2, idiom: "ipad" },
  { size: "83.5x83.5", scale: 2, idiom: "ipad" },
  { size: "20x20", scale: 1, idiom: "ipad" },
  { size: "20x20", scale: 2, idiom: "ipad" },
  { size: "29x29", scale: 1, idiom: "ipad" },
  { size: "29x29", scale: 2, idiom: "ipad" },
  { size: "40x40", scale: 1, idiom: "ipad" },
  { size: "40x40", scale: 2, idiom: "ipad" },
  { size: "76x76", scale: 1, idiom: "ipad" },
  { size: "1024x1024", scale: 1, idiom: "ios-marketing" }
];

mkdirSync(OUT, { recursive: true });

const images = [];
let alphaWarn = 0;
for (const e of ENTRIES) {
  const pt = parseFloat(e.size);
  const px = Math.round(pt * e.scale);
  const file = (px === 1024) ? "icon-1024.png" : "icon-" + e.size.replace(".", "_") + "@" + e.scale + "x.png";
  const dest = path.join(OUT, file);
  flatten(px, dest);
  const alpha = hasAlphaFlag(dest);
  if (alpha === "yes") alphaWarn += 1;
  images.push({ idiom: e.idiom, size: e.size, scale: String(e.scale), filename: file });
  console.log("  ✓ " + file.padEnd(26) + px + "x" + px + "  hasAlpha=" + alpha);
}

writeFileSync(path.join(OUT, "Contents.json"), JSON.stringify({ images, info: { author: "xcode", version: 1 } }, null, 2) + "\n");
console.log("\n✓ AppIcon 资源集已生成：" + path.relative(ROOT, OUT) + "（" + images.length + " 张）");
if (alphaWarn > 0) {
  // 不让构建直接挂，但把问题摆到明面上（iOS 图标带 alpha 在归档/上架阶段会被拒）
  console.warn("⚠ 有 " + alphaWarn + " 张仍带 alpha —— iOS 图标不接受透明，上架/归档可能被拒");
}
