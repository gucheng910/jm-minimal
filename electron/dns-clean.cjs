// JMClient 桌面端内置 DNS 清洗：DoH 解析（国内双上游、pin-IP 自举）
// + 本地 CONNECT 透传代理 + PAC 接入 Chromium（不做任何 MITM / 不改证书）
// 模块不依赖 electron，可独立测试；electron 侧只注入 applyProxy/clearProxy/onStatus。
"use strict";

const http = require("http");
const https = require("https");
const net = require("net");
const dns = require("dns");

// 上游：国内可达 DoH（实测 223.5.5.5 / 1.12.12.12 / 120.53.53.53 均支持
// GET /resolve JSON，证书完整，pin-IP + SNI 即可，无需系统 DNS 自举）
const DOH_UPSTREAMS = [
  { name: "阿里", host: "dns.alidns.com", ips: ["223.5.5.5"], path: "/resolve?name=" },
  { name: "腾讯", host: "doh.pub", ips: ["1.12.12.12", "120.53.53.53"], path: "/resolve?name=" }
];
const DOH_TIMEOUT_MS = 4000;
const CONNECT_TIMEOUT_MS = 7000;
const TTL_MIN_S = 60;
const TTL_MAX_S = 600;
const TTL_DEFAULT_S = 300;
const MAX_ROOTS = 100;

// ---- DoH 解析 ----
const cache = new Map();       // domain -> { ips, upstream, exp }
const inflight = new Map();    // domain -> Promise（单飞去重，避免首屏并发轰击上游）

function dohRequest(up, ip, domain) {
  return new Promise((resolve) => {
    const path = up.path + encodeURIComponent(domain) + "&type=A";
    const req = https.request({
      host: ip,
      port: 443,
      servername: up.host,
      path,
      method: "GET",
      headers: { Host: up.host, Accept: "application/dns-json", "User-Agent": "jm-minimal/1.3.1" },
      timeout: DOH_TIMEOUT_MS
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          const answers = j.Answer || j.answer || [];
          const ips = answers
            .filter((a) => (a.type === 1 || a.type === "A") && typeof a.data === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(a.data))
            .map((a) => a.data);
          const ttl = Number(answers.find((a) => a.type === 1 || a.type === "A")?.TTL || TTL_DEFAULT_S);
          resolve({ ok: true, ips, ttl: ttl > 0 ? ttl : TTL_DEFAULT_S });
        } catch { resolve({ ok: false, err: "bad-json" }); }
      });
      res.on("error", () => resolve({ ok: false, err: "resp-err" }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, err: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, err: e.code || "req-err" }));
    req.end();
  });
}

async function doResolve(domain) {
  const errors = [];
  for (const up of DOH_UPSTREAMS) {
    for (const ip of up.ips) {
      const r = await dohRequest(up, ip, domain);
      if (r.ok && r.ips.length > 0) {
        const ttl = Math.min(TTL_MAX_S, Math.max(TTL_MIN_S, Math.floor(r.ttl)));
        cache.set(domain, { ips: r.ips, upstream: up.name, exp: Date.now() + ttl * 1000 });
        return { ips: r.ips, upstream: up.name };
      }
      errors.push(up.name + "@" + ip + " " + (r.err || "no-a-record"));
    }
  }
  throw new Error("DoH 上游均失败: " + errors.slice(0, 3).join(" | "));
}

function resolveDomain(domain, force) {
  if (!force) {
    const hit = cache.get(domain);
    if (hit && hit.exp > Date.now()) return Promise.resolve({ ips: hit.ips, upstream: hit.upstream, cached: true });
    const pending = inflight.get(domain);
    if (pending) return pending;
  }
  const p = doResolve(domain).finally(() => inflight.delete(domain));
  inflight.set(domain, p);
  return p;
}

// ---- 清洗域名池（根域名，含子域匹配） ----
const cleanRoots = new Set();

function isCleanHost(host) {
  const h = String(host || "").toLowerCase();
  if (!h || /\s/.test(h)) return false;
  for (const root of cleanRoots) {
    if (h === root) return true;
    const dot = "." + root;
    if (h.length > dot.length && h.endsWith(dot)) return true;
  }
  return false;
}

// ---- 状态 ----
let enabled = false;
let port = 0;
let upstream = "";
let lastClean = null;   // { domain, upstream, ms }
let lastError = "";
let okCount = 0;
let failCount = 0;
let statusTimer = null;
let onStatus = null;
let dirty = false;

function snapshot() {
  return {
    enabled,
    port,
    domains: cleanRoots.size,
    upstream,
    lastClean,
    lastError,
    okCount,
    failCount
  };
}

function scheduleStatus() {
  dirty = true;
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    if (!dirty) return;
    dirty = false;
    if (onStatus) { try { onStatus(snapshot()); } catch { /* ignore */ } }
  }, 600);
}

function emitNow() {
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
  dirty = false;
  if (onStatus) { try { onStatus(snapshot()); } catch { /* ignore */ } }
}

// ---- 代理开关（fixed_servers：全量走本地透传代理，池外域名系统 DNS 直连透传）----
let applyProxy = null;
let clearProxy = null;

async function refreshProxy() {
  if (!applyProxy || !clearProxy) return;
  try {
    if (enabled) {
      await applyProxy();
      lastError = "";
    } else {
      await clearProxy();
    }
  } catch (e) {
    lastError = "代理应用失败: " + (e && e.message ? e.message : String(e));
  }
  scheduleStatus();
}

// ---- 连接 ----
function tryConnectOnce(ip, portNo, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port: portNo });
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); resolve(null); } }, timeoutMs);
    sock.on("connect", () => {
      if (done) { sock.destroy(); return; }
      done = true;
      clearTimeout(timer);
      resolve(sock);
    });
    sock.on("error", () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
  });
}

async function connectByIps(ips, portNo) {
  for (const ip of ips) {
    const sock = await tryConnectOnce(ip, portNo, CONNECT_TIMEOUT_MS);
    if (sock) return { sock, ip };
  }
  return null;
}

function failTunnel(clientSocket, msg) {
  if (!clientSocket.destroyed) {
    try { clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: " + Buffer.byteLength(msg) + "\r\n\r\n" + msg); } catch { /* ignore */ }
  }
}

async function handleConnect(target, clientSocket, head) {
  clientSocket.on("error", () => { /* 防止未处理 error 崩溃 */ });
  const parts = String(target || "").split(":");
  const host = String(parts.shift() || "").toLowerCase();
  const portNo = Number(parts.join(":")) || 443;
  let upstreamName = "";
  let direct = false;
  try {
    let ips = null;
    if (isCleanHost(host)) {
      let r = null;
      try {
        const t0 = Date.now();
        r = await resolveDomain(host);
        upstreamName = r.upstream;
        ips = r.ips;
        const t1 = Date.now();
        lastClean = { domain: host, upstream: upstreamName, ms: t1 - t0 };
        scheduleStatus();
      } catch (e) {
        // 首轮失败：强制绕过缓存重解一次
        try {
          const t0 = Date.now();
          r = await resolveDomain(host, true);
          upstreamName = r.upstream;
          ips = r.ips;
          lastClean = { domain: host, upstream: upstreamName, ms: Date.now() - t0 };
          scheduleStatus();
        } catch (e2) {
          // DoH 全挂：退回系统解析（未污染网络不受影响；污染网络下大概率同样失败）
          direct = true;
        }
      }
      if (!direct && !ips) direct = true;
    } else {
      direct = true;
    }

    let sock = null;
    if (!direct && ips && ips.length) {
      const got = await connectByIps(ips, portNo);
      sock = got ? got.sock : null;
    }
    if (!sock && direct) {
      // 直接模式或 DoH 失败回退：系统 DNS
      let addr = null;
      try { const r = await dns.promises.lookup(host, { family: 4 }); addr = r.address; } catch { /* ignore */ }
      if (addr) {
        const got = await tryConnectOnce(addr, portNo, CONNECT_TIMEOUT_MS);
        sock = got;
      }
    }
    if (!sock && ips && ips.length && !direct) {
      // 所有已知 IP 连不上：怀疑 CDN 换 IP/被封锁 → 强制重解析后再试一轮
      try {
        const t0 = Date.now();
        const r = await resolveDomain(host, true);
        upstreamName = r.upstream;
        lastClean = { domain: host, upstream: upstreamName, ms: Date.now() - t0 };
        scheduleStatus();
        const got = await connectByIps(r.ips, portNo);
        sock = got ? got.sock : null;
      } catch { /* ignore */ }
    }

    if (!sock) {
      failCount += 1;
      lastError = "无法连接 " + host + ":" + portNo + (upstreamName ? "（清洗上游 " + upstreamName + "）" : "（系统 DNS 直连）");
      scheduleStatus();
      failTunnel(clientSocket, lastError);
      return;
    }

    okCount += 1;
    lastError = "";
    // 隧道打通：回 200 后纯字节透传（TLS/SNI 原样，无 MITM）
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length > 0) sock.write(head);
    sock.on("error", () => { try { clientSocket.destroy(); } catch { /* ignore */ } });
    sock.on("close", () => { try { clientSocket.destroy(); } catch { /* ignore */ } });
    clientSocket.on("close", () => { try { sock.destroy(); } catch { /* ignore */ } });
    sock.pipe(clientSocket);
    clientSocket.pipe(sock);
    scheduleStatus();
  } catch (e) {
    failCount += 1;
    lastError = "隧道失败 " + host + ": " + (e && e.message ? e.message : String(e));
    scheduleStatus();
    failTunnel(clientSocket, lastError);
  }
}

// ---- 入口 ----
function createDnsCleaner(options) {
  const o = options || {};
  applyProxy = typeof o.applyProxy === "function" ? o.applyProxy : null;
  clearProxy = typeof o.clearProxy === "function" ? o.clearProxy : null;
  onStatus = typeof o.onStatus === "function" ? o.onStatus : null;

  const server = http.createServer();
  server.on("connect", (req, socket, head) => {
    void handleConnect(req.url || "", socket, head);
  });
  // CONNECT 之外的常规请求（理论上不会出现）一律 400
  server.on("request", (req, res) => {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("dns-clean proxy: CONNECT only");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve({
        server,
        async setEnabled(v) {
          enabled = Boolean(v);
          if (!enabled) upstream = "";
          await refreshProxy();
          emitNow();
          return snapshot();
        },
        async syncDomains(roots) {
          let changed = false;
          for (const r of roots || []) {
            const root = String(r || "").toLowerCase().replace(/^\.+|\.+$/g, "");
            if (!root || !/^[a-z0-9.-]+$/.test(root)) continue;
            if (!cleanRoots.has(root)) {
              if (cleanRoots.size >= MAX_ROOTS) break;
              cleanRoots.add(root);
              changed = true;
            }
          }
          if (changed) scheduleStatus();
          return snapshot();
        },
        getState() { return snapshot(); }
      });
    });
    server.on("error", () => { /* listen 失败由调用方决定（一般不会发生） */ });
  });
}

module.exports = { createDnsCleaner, isCleanHost, resolveDomain };
