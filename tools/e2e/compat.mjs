// 兼容包（老内核）验证：npm run e2e:compat
//   1) 把 dist-compat 复制到临时目录并改造成「模拟老浏览器」页面：
//      去掉 <script type="module" src=index-*.js>（现代入口）与设置 __vite_is_modern_browser 的探测脚本，
//      剩下的 legacy 加载器就会按老内核路径加载 ES5 包 + polyfills；
//   2) 起一个静态服务器提供该目录；
//   3) 用 harness 跑 driver-legacy.js（断言应用确实被 legacy 包渲染出来）；
//   4) 清理临时目录与服务器。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const SRC = path.join(ROOT, "dist-compat");
const WORK = path.join(os.tmpdir(), "jm-compat-check");
const WEB_PORT = Number(process.env.E2E_COMPAT_PORT || 5333);
const CDP_PORT = Number(process.env.E2E_PORT || 9355);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(SRC, "index.html"))) {
  console.error("缺少 dist-compat —— 先跑 npm run build:compat");
  process.exit(2);
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.cpSync(SRC, WORK, { recursive: true });
fs.rmSync(path.join(WORK, "sw.js"), { force: true });
const htmlPath = path.join(WORK, "index.html");
let html = fs.readFileSync(htmlPath, "utf8");
html = html
  .replace(/<script type="module" crossorigin src="\/assets\/index-[^"]+"><\/script>\s*/, "")
  .replace(/<script type="module">import'data:text\/javascript,[\s\S]*?__vite_is_modern_browser=true<\/script>\s*/, "");
fs.writeFileSync(htmlPath, html);
if (!/polyfills-legacy/.test(html)) {
  console.error("dist-compat 里没有 legacy 产物（确认用 npm run build:compat 构建）");
  process.exit(1);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(WORK, p);
  if (!file.startsWith(WORK) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(WEB_PORT, "127.0.0.1", r));
console.log("老内核模拟页: http://127.0.0.1:" + WEB_PORT + "/（已去掉现代入口与探测脚本）");

const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(HERE, "harness.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DRIVER: "driver-legacy.js", TEST_URL: "http://127.0.0.1:" + WEB_PORT + "/", E2E_PORT: String(CDP_PORT) }
  });
  child.on("exit", (c) => resolve(c ?? 1));
});

server.close();
fs.rmSync(WORK, { recursive: true, force: true });
console.log(code === 0 ? "\n兼容包自检 ✓（应用由 ES5 legacy 包正常启动）" : "\n兼容包自检 ✗");
process.exit(code);
