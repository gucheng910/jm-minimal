"use strict";
/**
 * 本地静态服务的回归测试（node:test，不依赖 vitest / electron）。
 *   npm run test:electron
 *
 * 覆盖 2026-09-13 代码审查发现的两个缺陷：
 *   - 畸形百分号转义不能让主进程抛 URIError
 *   - 越界守卫必须挡住共享前缀的兄弟目录（dist-legacy / dist-compat）
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStaticServer, resolveFile, wantsHtml } = require("./static-server.cjs");

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** 造一个和真实布局同构的夹具：<tmp>/dist 与共享前缀的兄弟目录 <tmp>/dist-legacy */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jm-static-"));
  tmpDirs.push(root);
  const dist = path.join(root, "dist");
  const distLegacy = path.join(root, "dist-legacy");
  fs.mkdirSync(dist);
  fs.mkdirSync(distLegacy);
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>modern</title>");
  fs.writeFileSync(path.join(dist, "app.js"), "console.log('app')");
  fs.writeFileSync(path.join(distLegacy, "index.html"), "<!doctype html><title>LEGACY-SHOULD-NOT-LEAK</title>");
  fs.writeFileSync(path.join(root, "package.json"), '{"secret":"SHOULD-NOT-LEAK"}');
  return { root, dist };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function withServer(dist, fn) {
  const server = createStaticServer(dist);
  const port = await listen(server);
  try {
    return await fn(port);
  } finally {
    server.close();
  }
}

test("resolveFile: 根路径映射到 index.html", () => {
  const { dist } = makeFixture();
  assert.deepEqual(resolveFile(dist, "/"), { status: 200, file: path.join(dist, "index.html") });
});

test("resolveFile: 畸形百分号转义返回 400，不抛异常", () => {
  const { dist } = makeFixture();
  assert.equal(resolveFile(dist, "/%").status, 400);
  assert.equal(resolveFile(dist, "/%zz").status, 400);
});

test("resolveFile: 普通越界返回 403", () => {
  const { dist } = makeFixture();
  assert.equal(resolveFile(dist, "/../../package.json").status, 403);
  assert.equal(resolveFile(dist, "/%2e%2e/%2e%2e/package.json").status, 403);
});

test("resolveFile: 共享前缀的兄弟目录（dist-legacy）必须 403 —— 审查里那条 Critical", () => {
  const { dist } = makeFixture();
  // 旧写法 file.startsWith(DIST) 对这两个都会返回 true（"dist-legacy" 以 "dist" 开头）
  assert.equal(resolveFile(dist, "/../dist-legacy/index.html").status, 403);
  assert.equal(resolveFile(dist, "/..%2Fdist-legacy/index.html").status, 403);
});

test("resolveFile: Windows 上反斜杠越界也要挡住", { skip: path.sep !== "\\" }, () => {
  const { dist } = makeFixture();
  assert.equal(resolveFile(dist, "/..\\..\\package.json").status, 403);
});

test("HTTP: GET /% 不会再抛 URIError（旧实现会让主进程抛未捕获异常）", async () => {
  const { dist } = makeFixture();
  await withServer(dist, async (port) => {
    const res = await fetch("http://127.0.0.1:" + port + "/%");
    assert.equal(res.status, 400);
  });
});

test("HTTP: 越界到 dist-legacy 拿不到内容", async () => {
  const { dist } = makeFixture();
  await withServer(dist, async (port) => {
    const res = await fetch("http://127.0.0.1:" + port + "/..%2Fdist-legacy/index.html");
    assert.equal(res.status, 403);
    assert.equal((await res.text()).includes("SHOULD-NOT-LEAK"), false);
  });
});

test("HTTP: 正常静态资源带正确 Content-Type", async () => {
  const { dist } = makeFixture();
  await withServer(dist, async (port) => {
    const res = await fetch("http://127.0.0.1:" + port + "/app.js");
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get("content-type")), /javascript/);
  });
});

test("HTTP: 缺失的资源返回 404，而不是伪装成 HTML", async () => {
  const { dist } = makeFixture();
  await withServer(dist, async (port) => {
    const res = await fetch("http://127.0.0.1:" + port + "/missing.js", { headers: { Accept: "text/javascript,*/*;q=0.1" } });
    assert.equal(res.status, 404);
  });
});

test("HTTP: 页面导航仍然回退到 index.html（SPA 行为不变）", async () => {
  const { dist } = makeFixture();
  await withServer(dist, async (port) => {
    const res = await fetch("http://127.0.0.1:" + port + "/some/deep/route", { headers: { Accept: "text/html,application/xhtml+xml" } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /modern/);
  });
});

test("wantsHtml: 无 Accept 头视为导航，脚本请求视为资源", () => {
  assert.equal(wantsHtml({ headers: {} }), true);
  assert.equal(wantsHtml({ headers: { accept: "text/html" } }), true);
  assert.equal(wantsHtml({ headers: { accept: "text/javascript,*/*;q=0.1" } }), false);
});
