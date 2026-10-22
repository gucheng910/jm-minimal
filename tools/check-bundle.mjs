#!/usr/bin/env node
/**
 * tools/check-bundle.mjs —— 产物级校验（`dist/`、`dist-compat/`）
 *
 * 为什么需要它：`vite.config.ts` 里的 `__NO_SEAM__` 是**构建期**从环境变量读的
 * （`JM_NO_SEAM=1`）。忘设一次，compat 包就会悄悄带上整套去条纹代码 ——
 * 同样的命令、同样的版本号、真机才看得出来"老机器更卡了"。2026-10 这次重构就踩到这个坑
 * （compat 产物里「去条纹」从 2 条变成 7 条），而当时仓库里没有任何脚本会报警。
 *
 * 用法：
 *   node tools/check-bundle.mjs                                   # 查 dist/（现代包，应含去条纹）
 *   node tools/check-bundle.mjs --dir dist-compat --expect no-seam # 查老安卓包（不该含）
 *   node tools/check-bundle.mjs --dir dist-compat --expect auto    # 只报告，按实际内容判定
 *
 * 退出码：0 = 通过；1 = 有断言失败；2 = 参数/目录问题（dist 还没构建）。
 *
 * ── 判定口径（2026-10-22 实测校准）────────────────────────────────────
 * 「去条纹」这个字符串**不能简单按 0 条判**：设置面板的按钮提示
 * 「阅读设置：模式 / 去条纹 / 跳页」在 NO_SEAM 包里也保留（模式与跳页还在用），
 * 已发布的老安卓包实测就是 2 条。真正该消失的是**功能**文案与日志：
 *   · `去条纹已开启` / `去条纹已关闭`：切换开关的 toast（开关本身被摇掉了）
 *   · `去条纹 ✓`：设置面板里那个开关按钮
 *   · `（去条纹关闭）`：重排时的诊断日志后缀
 *   · `seam page=`：接缝修复的诊断日志前缀
 * 这四条任意一条出现在 NO_SEAM 产物里，就说明整块逻辑没被摇干净。
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const DIR = path.resolve(process.cwd(), argOf("--dir", "dist"));
const EXPECT = argOf("--expect", "with-seam"); // with-seam | no-seam | auto

/** NO_SEAM 构建里必须消失的四条功能文案/日志 */
const SEAM_ONLY = ["去条纹已开启", "去条纹已关闭", "去条纹 ✓", "（去条纹关闭）", "seam page="];
/** 只用来报告的数字（设置提示里那两条属于正常保留） */
const SEAM_ANY = "去条纹";

function fail(msg) {
  console.error("✗ " + msg);
  process.exitCode = 1;
}
function ok(msg) {
  console.log("✓ " + msg);
}
function info(msg) {
  console.log("· " + msg);
}

function main() {
  const assets = path.join(DIR, "assets");
  if (!fs.existsSync(assets)) {
    console.error("找不到 " + assets + "（先构建：" + (DIR.endsWith("compat") ? "npm run build:compat" : "npm run build") + "）");
    process.exit(2);
  }
  const files = fs.readdirSync(assets).filter((f) => f.endsWith(".js"));
  if (files.length === 0) { console.error(assets + " 里没有 js 产物"); process.exit(2); }

  const texts = new Map();
  for (const f of files) texts.set(f, fs.readFileSync(path.join(assets, f), "utf8"));
  const all = [...texts.values()].join("\n");

  // —— 1) Worker 分块：必须存在，且被主包引用 ——
  // 阅读器的切块重排/去条纹（scrambleWorker）与封面的解码降采样（imageWorker）各一个分块
  for (const name of ["scrambleWorker", "imageWorker"]) {
    const found = files.filter((f) => new RegExp("^" + name + "-.*\\.js$").test(f));
    if (found.length !== 1) fail(name + " 分块数量异常：" + found.length + " 个（期望 1）");
    else ok("worker 分块存在：" + found[0] + "（" + Math.round(fs.statSync(path.join(assets, found[0])).size / 1024) + " kB）");
    const ref = files.some((f) => f !== found[0] && texts.get(f).includes(found[0]));
    if (!ref) fail("没有任何主包引用 " + (found[0] || name + " 分块") + "（分块会被打进包里但永远不会加载）");
    else ok("主包引用了 " + name + " 分块");
  }

  // —— 2) 去条纹逻辑是否按构建变体摇干净 ——
  const hits = SEAM_ONLY.filter((s) => all.includes(s));
  const total = (all.match(new RegExp(SEAM_ANY, "g")) || []).length;
  let expect = EXPECT;
  if (expect === "auto") expect = hits.length === 0 ? "no-seam" : "with-seam";

  if (expect === "no-seam") {
    if (hits.length > 0) {
      fail("这是 NO_SEAM 构建，但产物里还留着去条纹代码：" + hits.map((s) => "「" + s + "」").join(" "));
      info("多半是构建前忘了 `JM_NO_SEAM=1`（vite.config.ts 在配置加载时读 process.env）");
    } else {
      ok("NO_SEAM 构建：去条纹功能文案已全部摇掉（「" + SEAM_ANY + "」残留 " + total + " 条，均为设置面板提示，属正常）");
    }
  } else if (expect === "with-seam") {
    const missing = SEAM_ONLY.filter((s) => !all.includes(s));
    if (missing.length > 0) fail("这是含去条纹的构建，但产物里缺：" + missing.map((s) => "「" + s + "」").join(" "));
    else ok("含去条纹构建：功能文案齐全（「" + SEAM_ANY + "」共 " + total + " 条）");
  } else {
    fail("--expect 只能是 with-seam / no-seam / auto，收到：" + EXPECT);
  }

  // —— 3) 占位符/冲突标记残留（大块替换的经典伤口）——
  // 注意：这里用 repeat 拼出来，不在源码里写成字面量 —— 否则本文件自己会被冲突标记扫描器误报
  const junk = ["<".repeat(7) + " ", ">".repeat(7) + " ", "0xFFXX", "__PLACEHOLDER__"];
  const found = junk.filter((s) => all.includes(s));
  if (found.length > 0) fail("产物里有残留物：" + found.join(" "));
  else ok("无占位符 / 冲突标记残留");

  info("检查目录 " + DIR + "（" + files.length + " 个 js）");
}

main();
