#!/usr/bin/env node
/**
 * 生成 iOS 的 AppIcon 资源集（在 **macOS** 上跑，用系统自带的 sips 缩放——不引入任何 npm 依赖）。
 *
 * 为什么要有这个脚本：
 *   Capacitor 的 ios 模板不会带 AppIcon 资源，不补的话装到 iPhone 上图标是白板。
 *   本机是 Windows（没有 sips、也生成不了 ios/ 工程），所以这一步落在 CI/某台 Mac 上，
 *   由 .github/workflows/build-ipa.yml 调用。
 *
 * 两个容易被坑的点：
 *   1) **素材是 512 的**（build/icon.png / dist/icons/icon-512.png），而 App Store 图标要求 1024。
 *      本脚本会把它升采样到 1024 并明确打印这条"不是原生素材"的事实，不要指望清晰度凭空变好。
 *   2) **不能带 alpha**：iOS 的 App 图标不接受透明通道。源图是 RGBA，所以每个尺寸都用
 *      `-s hasAlpha no` 落成不透明 PNG。少了这一步，Xcode 归档时会报
 *      "Invalid Image Path / App Store icon can't be transparent"。
 *
 * 用法：
 *   node tools/gen-ios-icons.mjs --src build/icon.png --out ios/App/App/Assets.xcassets/AppIcon.appiconset
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.resolve(ROOT, argOf("--src", "build/icon.png"));
const OUT = path.resolve(ROOT, argOf("--out", "ios/App/App/Assets.xcassets/AppIcon.appiconset"));

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
for (const e of ENTRIES) {
  const pt = parseFloat(e.size);
  const px = Math.round(pt * e.scale);
  const file = (px === 1024) ? "icon-1024.png" : "icon-" + e.size.replace(".", "_") + "@" + e.scale + "x.png";
  const dest = path.join(OUT, file);
  // sips 同时负责：缩放到 px、去掉 alpha（iOS 图标不接受透明）
  const r = spawnSync("sips", ["-s", "format", "png", "-s", "hasAlpha", "no", "-z", String(px), String(px), SRC, "--out", dest], {
    encoding: "utf8"
  });
  if (r.status !== 0) die("sips 失败（" + file + "）：" + (r.stderr || r.stdout));
  const got = pngSize(dest);
  if (got.w !== px || got.h !== px) die(file + " 尺寸不对：期望 " + px + "，得到 " + got.w + "x" + got.h);
  images.push({ idiom: e.idiom, size: e.size, scale: String(e.scale), filename: file });
  console.log("  ✓ " + file.padEnd(26) + px + "x" + px);
}

writeFileSync(path.join(OUT, "Contents.json"), JSON.stringify({ images, info: { author: "xcode", version: 1 } }, null, 2) + "\n");
console.log("\n✓ AppIcon 资源集已生成：" + path.relative(ROOT, OUT) + "（" + images.length + " 张）");
