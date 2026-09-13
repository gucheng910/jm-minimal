"use strict";
/**
 * PC 壳的本地静态服务（纯 Node，不依赖 electron —— 这样才能被单元测试直接跑）。
 *
 * 2026-09-13 代码审查发现两个真实缺陷，都在这里修掉：
 *   1) `decodeURIComponent` 对畸形转义（如 `GET /%`）抛 URIError，而它发生在 request
 *      回调里 → 主进程未捕获异常。任何能访问 127.0.0.1:17932-17951 的本地进程、
 *      或用户访问的任意网页（一张 `<img src="http://127.0.0.1:17932/%">` 就够）都能触发。
 *   2) 越界守卫写的是 `file.startsWith(DIST)`，少了分隔符 → `dist-legacy` / `dist-compat`
 *      这类共享前缀的兄弟目录会被判定为"在根目录内"，实测能读到 `dist-legacy/index.html`。
 *
 * 回归用例见同目录 static-server.test.cjs（`npm run test:electron`）。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm"
};

/**
 * 把请求 URL 解析成磁盘路径。
 * @returns {{status:200, file:string} | {status:400} | {status:403}}
 */
function resolveFile(root, rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(String(rawUrl || "/").split("?")[0]);
  } catch {
    // 畸形百分号转义（/% 等）：400 而不是让 URIError 冒到主进程
    return { status: 400 };
  }
  if (pathname.indexOf("\0") !== -1) return { status: 400 };
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.normalize(path.join(root, rel));
  // 必须带上分隔符：只比 root 时，"E:\...\dist-legacy" 因为共享 "dist" 前缀会被放行
  if (file !== root && file.slice(0, root.length + path.sep.length) !== root + path.sep) {
    return { status: 403 };
  }
  return { status: 200, file };
}

/** 只有"页面导航"才允许回退到 index.html */
function wantsHtml(req) {
  const accept = String((req.headers && req.headers.accept) || "");
  return accept === "" || accept.indexOf("text/html") !== -1;
}

function createStaticServer(root) {
  return http.createServer((req, res) => {
    const resolved = resolveFile(root, req.url);
    if (resolved.status !== 200) {
      res.writeHead(resolved.status);
      res.end();
      return;
    }
    fs.readFile(resolved.file, (err, data) => {
      if (!err) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(resolved.file).toLowerCase()] || "application/octet-stream" });
        res.end(data);
        return;
      }
      // 给缺失的 .js / .css 返回 HTML，浏览器会把 HTML 当脚本解析，
      // 报错信息完全指不到真正的原因 —— 只有导航请求才回退。
      if (!wantsHtml(req)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      fs.readFile(path.join(root, "index.html"), (e2, d2) => {
        if (e2) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(d2);
      });
    });
  });
}

module.exports = { createStaticServer, resolveFile, wantsHtml, MIME };
