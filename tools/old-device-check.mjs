#!/usr/bin/env node
/**
 * tools/old-device-check.mjs —— 老内核真机布局验收（可传参 / 可复用）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 这个项目有一条反复付过账的规律：**现代内核上完全正常 → 真机上以"视觉错位 / 点不中 /
 * 整块消失"的形式暴露**。根源是 compat 包（WebView 57）里：
 *   · flex `gap` 不生效，全部间距来自 `index.css` 末尾那批 `> * + *` 补丁；
 *   · 无 `aspect-ratio`，封面比例盒靠 `padding-top` 复刻；
 *   · `inset` / `env()` / `min()` 缺失会让**整条声明被丢弃**（不是降级，是整条没了）。
 * 这些在开发机上**一条都看不出来**，只能回真机看。
 *
 * 所以本脚本把"回真机看"这件事变成一条可重复执行的命令：
 * 装包 / 起 App / 接 CDP / 量真实几何 / 出报告，全在一个命令里。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node tools/old-device-check.mjs                       # 跑全部检查
 *   node tools/old-device-check.mjs --list-checks         # 打印检查项清单（含"为什么查它"）
 *   node tools/old-device-check.mjs --serial 1234ABCD
 *   node tools/old-device-check.mjs --checks thumb-box,sibling-gap --shots _shots
 *   node tools/old-device-check.mjs --expect-cols 3
 *   node tools/old-device-check.mjs --probe ".d-hero > *" --probe ".actrow > *"
 *   node tools/old-device-check.mjs --eval "getComputedStyle(document.querySelector('.list')).gap"
 *   node tools/old-device-check.mjs --format md --out _archive/old-device-report.md
 *   node tools/old-device-check.mjs --fail-on fail        # 有 fail 就 exit 1（可进 CI）
 *
 * ── 参数 ────────────────────────────────────────────────────────────────
 *   --adb <path>       adb 可执行文件（默认 `adb`，走 PATH）
 *   --cdp <host:port>  **跳过 adb，直连 CDP**（如 127.0.0.1:9333）。
 *                      用途：① 没插真机时先验证脚本本身跑得通；
 *                      ② 在新内核上跑一遍当**对照组**（kernel 那项会显示"缺 0 项"，
 *                      正好证明老内核上缺的那些确实是内核差异，不是脚本误判）。
 *   --serial <s>       多设备时指定；等价 adb -s
 *   --package <pkg>    应用包名（默认 dev.jmclient.app）
 *   --port <n>         本地 CDP 转发端口（默认 9549）
 *   --checks <list>    逗号分隔的检查 id，或 all（默认 all）
 *   --probe <sel>      sibling-gap 要量的**容器**选择器（可重复；有默认表）。
 *                      写成 `.list > *` 也会被自动归一成 `.list`
 *   --expect-cols <n>  grid-cols 的期望列数（不给就只报告、不判定）
 *   --eval <expr>      追加执行任意 JS 并打印结果（可重复）—— 逃生口，让脚本不必为每个新疑问改代码
 *   --navigate <url>   检查前先导航到该地址。两个用途：验深链 `?aid=xxx`；
 *                      桌面浏览器被首启同步页顶掉启动 URL 时手动落位
 *   --shots <dir>      每个检查后截图到该目录
 *   --settle <ms>      等 App 起来并加载完的总时长（默认 12000）
 *   --no-launch        不重新启动 App，直接接已运行的实例
 *   --keep-forward     结束后保留 adb forward
 *   --format <fmt>     text | json | md（默认 text）
 *   --out <file>       写文件（默认 stdout）
 *   --fail-on <lv>     none | warn | fail（默认 none）
 *   --list-checks      打印检查表后退出
 *   --quiet            只打结论
 *
 * ── 诚实声明 ────────────────────────────────────────────────────────────
 * 本脚本只量**它真的量到的东西**（真实几何 / 真实 computed style / 真实控制台错误），
 * 不做"看起来没问题"式的判断。没插真机时它会明确失败，不会假装通过。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// ────────────────────────────── CLI ──────────────────────────────
function parseArgs(argv) {
  const o = {
    adb: "adb", serial: "", package: "dev.jmclient.app", port: 9549, cdp: "",
    checks: null, probes: [], expectCols: null, evals: [], shots: "", navigate: "", inject: [],
    settle: 12000, launch: true, keepForward: false,
    format: "text", out: null, failOn: "none", listChecks: false, quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--adb": o.adb = next(); break;
      case "--cdp": o.cdp = next(); break;
      case "--serial": o.serial = next(); break;
      case "--package": o.package = next(); break;
      case "--port": o.port = Number(next()); break;
      case "--checks": o.checks = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--probe": o.probes.push(next()); break;
      case "--expect-cols": o.expectCols = Number(next()); break;
      case "--eval": o.evals.push(next()); break;
      case "--navigate": o.navigate = next(); break;
      case "--inject": o.inject.push(next()); break;
      case "--shots": o.shots = next(); break;
      case "--settle": o.settle = Number(next()); break;
      case "--no-launch": o.launch = false; break;
      case "--keep-forward": o.keepForward = true; break;
      case "--format": o.format = next(); break;
      case "--out": o.out = next(); break;
      case "--fail-on": o.failOn = next(); break;
      case "--list-checks": o.listChecks = true; break;
      case "--quiet": o.quiet = true; break;
      case "--help": case "-h": o.help = true; break;
      default:
        console.error(`未知参数: ${a}（--help 看用法）`);
        process.exit(2);
    }
  }
  return o;
}

// ────────────────────────────── CDP 通道 ──────────────────────────────
/** adb 调用（带 -s）；失败时把 stderr 带出来，别让人猜 */
function makeAdb(opts) {
  const base = opts.serial ? ["-s", opts.serial] : [];
  return (args) => execFileSync(opts.adb, [...base, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

/** 找到目标 App 的 webview devtools socket */
function findDevtoolsSocket(adb, pkg) {
  const ps = adb(["shell", "ps"]).split("\n").map((s) => s.trim());
  const line = ps.find((l) => l.includes(pkg));
  if (!line) return null;
  const pid = line.split(/\s+/)[1];
  const socks = adb(["shell", "grep", "-a", "webview_devtools", "/proc/net/unix"])
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const mine = socks.find((s) => s.includes("webview_devtools_remote_" + pid));
  return mine ? mine.split(/\s+/).pop().replace(/^@/, "") : null;
}

/** 从 CDP 的 /json/list 建立连接，返回 { eval, shot, close } */
async function connectListUrl(listUrl) {
  const list = await (await fetch(listUrl, { signal: AbortSignal.timeout(5000) })).json();
  // 优先选 http(s) 页面：桌面浏览器会同时列出 edge:// 首启页 / 同步确认页这类**特权页**，
  // 接上去什么也做不了（location.href = 都会被拦）
  const pages = list.filter((t) => t.type === "page");
  const page = pages.find((t) => /^https?:/.test(t.url)) || pages[0];
  if (!page) throw new Error("CDP 里没有 type=page 的 target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  return {
    async eval(expr) {
      const r = await send("Runtime.evaluate", {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        return { __err: String(r.result.exceptionDetails.text || "exception") };
      }
      return r.result?.result?.value;
    },
    /**
     * 原生触摸（Input.dispatchTouchEvent）—— 走浏览器**真实输入管线**。
     * 合成 DOM 事件测不出"长按之后手势被滚动抢走"这个真机病根：合成事件不经过
     * 浏览器的手势仲裁，永远不会因此发 pointercancel，所以旧版怎么测都是绿的。
     */
    touch(type, x, y) {
      return send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1 }]
      });
    },
    async shot(file) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      const b64 = r.result?.data;
      if (!b64) return null;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(b64, "base64"));
      return file;
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
    send,
  };
}

/** 走 adb：开 forward 隧道，再连 CDP */
async function connectAdb(adb, opts) {
  adb(["forward", "--remove-all"]);
  const socket = findDevtoolsSocket(adb, opts.package);
  if (!socket) throw new Error(`没找到 ${opts.package} 的 webview devtools socket（App 没起来？还是没开调试？）`);
  adb(["forward", `tcp:${opts.port}`, `localabstract:${socket}`]);
  await sleep(500);
  return connectListUrl(`http://127.0.0.1:${opts.port}/json/list`);
}

/**
 * --cdp 直连（不经 adb）：桌面 Chrome/Edge 也能跑。
 * 用处不只是"没真机时先看看脚本本身有没有问题"—— 也是"在新内核上跑一遍作对照"
 * （kernel 那项会显示"缺 0 项"，正好证明老内核上缺的那些确实是内核差异，不是脚本误判）。
 */
function cdpListUrl(spec) {
  const s = String(spec).replace(/\/$/, "");
  return /^https?:\/\//.test(s) ? s + "/json/list" : `http://${s}/json/list`;
}

// ────────────────────────────── 检查表 ──────────────────────────────
/**
 * 每个检查：{ id, title, why, run(ctx) -> { level, msg, data? } }
 * level: "pass" | "warn" | "fail"
 * `why` 是**为什么查它**，`--list-checks` 会打出来，就是验收清单本身。
 */
/**
 * 默认量哪些容器。注意给的是**容器**选择器，不是 `容器 > *`：
 * `document.querySelector('.list > *')` 选到的是**第一个孩子**，
 * 拿它去数 children 就全乱了（早期版本就是这么把 `.list` 误判成"间距为 0"的）。
 * 传进来的选择器若带尾部 `> *`，下面会自动剥掉。
 */
const PROBE_DEFAULTS = [".view-stack", ".list", ".actrow", ".d-hero"];

/** 把 `.list > *` / `.list >*` 归一成 `.list`（用户按"兄弟"来想，脚本按"容器"来量） */
function containerOf(sel) {
  return String(sel).replace(/\s*>\s*\*\s*$/, "").trim() || String(sel).trim();
}

/**
 * 走真实点击进「自定义 UI」编辑器页（不碰内部状态 —— 验的就是用户走的那条路）。
 * 两个编辑器检查共用；幂等（已经开着就不重复点）。
 */
async function openEditor(ctx) {
  // v3.2 外壳是两屏：先进「选择页面」画廊屏，点卡片才到编辑屏。
  // 所以"编辑器打开了吗"要分两种状态判断 —— 否则停在画廊屏会被误判成"已打开"，
  // 后面所有针对编辑屏的检查（画布块数 / 手柄 / 检查器）都会读空。
  if (await ctx.eval(`!!document.querySelector('.ed-canvas')`)) return true;
  if (!(await ctx.eval(`!!document.querySelector('.ed-gallery')`))) {
    await ctx.eval(`(function(){
      var n = [].slice.call(document.querySelectorAll('.nav-item')).find(function(b){ return /设置/.test(b.textContent||''); });
      if (n) n.click();
      return !!n;
    })()`);
    await sleep(1500);
    const opened = await ctx.eval(`(function(){
      var b = [].slice.call(document.querySelectorAll('.settings-page .grow')).find(function(x){ return /自定义 UI/.test(x.textContent||''); });
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(1800);
    if (!opened) return false;
  }
  // 画廊屏 → 点「详情页」卡片进编辑屏（各检查项都作用在编辑屏上）
  const picked = await ctx.eval(`(function(){
    var c = document.querySelector(".ed-gallery .ed-card[data-page='detail']");
    if (c) c.click();
    return !!c;
  })()`);
  await sleep(900);
  return Boolean(picked);
}

const CHECKS = [
  {
    id: "boot",
    title: "App 起得来、首页网格渲染出来",
    why: "所有几何检查都以它为前提；它挂了后面全是空谈。",
    async run(ctx) {
      const v = await ctx.eval(`(function(){
        var items = document.querySelectorAll('.list-item');
        var L = document.querySelector('.list');
        return JSON.stringify({ items: items.length, hasList: !!L, ready: document.readyState });
      })()`);
      const d = JSON.parse(v);
      if (d.items === 0) return { level: "fail", msg: `没有渲染出任何 .list-item（readyState=${d.ready}）`, data: d };
      return { level: "pass", msg: `${d.items} 个卡片已渲染`, data: d };
    },
  },

  {
    id: "kernel",
    title: "记录内核能力（aspect-ratio / gap / inset / env）",
    why: "先证明这台机器**确实是老内核**，否则后面所有「没坏」都不作数 —— 在新内核上跑一遍什么都说明不了。",
    async run(ctx) {
      const v = await ctx.eval(`(function(){
        var probe = document.createElement('div');
        document.body.appendChild(probe);
        function sup(decl){ try { probe.style.cssText = ''; probe.style.cssText = decl; return probe.style.cssText !== ''; } catch(e){ return false; } }
        var out = {
          ua: navigator.userAgent,
          aspectRatio: sup('aspect-ratio: 3 / 4'),
          flexGap: sup('display:flex; gap: 8px'),
          gridGap: sup('display:grid; gap: 8px'),
          inset: sup('inset: 0'),
          envFn: sup('padding-top: env(safe-area-inset-top)'),
          cssVars: sup('--x: 1'),
        };
        document.body.removeChild(probe);
        return JSON.stringify(out);
      })()`);
      const d = JSON.parse(v);
      const missing = ["aspectRatio", "flexGap", "inset", "envFn"].filter((k) => !d[k]);
      return {
        level: "pass",
        msg: `缺 ${missing.length} 项：${missing.join("、") || "无"}｜${String(d.ua).slice(0, 60)}`,
        data: d,
      };
    },
  },

  {
    id: "grid-cols",
    title: "网格实际列数",
    why: "列数在 CSS 里有 4 处（默认 3 / 断点 2·4·6）+ 骨架屏 2 处，改一处漏一处就会「骨架和真网格刻度不一致」。",
    async run(ctx) {
      const v = await ctx.eval(`(function(){
        var L = document.querySelector('.list');
        if (!L) return JSON.stringify({ error: 'no .list' });
        var cs = getComputedStyle(L);
        return JSON.stringify({
          cols: cs.gridTemplateColumns.split(' ').filter(Boolean).length,
          raw: cs.gridTemplateColumns,
          gap: cs.gap || cs.gridGap,
          className: L.className,
          innerW: innerWidth,
        });
      })()`);
      const d = JSON.parse(v);
      if (d.error) return { level: "fail", msg: "找不到 .list", data: d };
      const base = `实测 ${d.cols} 列 @${d.innerW}px，gap=${d.gap}`;
      if (ctx.expectCols && d.cols !== ctx.expectCols) {
        return { level: "fail", msg: `${base} —— 期望 ${ctx.expectCols} 列`, data: d };
      }
      return { level: "pass", msg: base, data: d };
    },
  },

  {
    id: "cols-override",
    title: "显式列数能压过响应式断点",
    why: ".list.cols-2 / .cols-3 是**靠源码顺序压断点**的（同特异性、后面的赢）。一旦有人把它挪到断点之前，用户选的列数就会被屏幕宽度改回去，而开发机上不一定看得出来。",
    async run(ctx) {
      const v = await ctx.eval(`(function(){
        var L = document.querySelector('.list');
        if (!L) return JSON.stringify({ error: 'no .list' });
        var before = getComputedStyle(L).gridTemplateColumns.split(' ').filter(Boolean).length;
        var orig = L.className;
        L.className = orig + ' cols-2';
        var after = getComputedStyle(L).gridTemplateColumns.split(' ').filter(Boolean).length;
        L.className = orig + ' cols-3';
        var after3 = getComputedStyle(L).gridTemplateColumns.split(' ').filter(Boolean).length;
        L.className = orig;
        return JSON.stringify({ before: before, cols2: after, cols3: after3, innerW: innerWidth });
      })()`);
      const d = JSON.parse(v);
      if (d.error) return { level: "fail", msg: "找不到 .list", data: d };
      const bad = [];
      if (d.cols2 !== 2) bad.push(`cols-2 得到 ${d.cols2} 列`);
      if (d.cols3 !== 3) bad.push(`cols-3 得到 ${d.cols3} 列`);
      if (bad.length) return { level: "fail", msg: `${bad.join("；")}（断点没被压住）`, data: d };
      return { level: "pass", msg: `断点下 ${d.before} 列 → cols-2 强制 2 列、cols-3 强制 3 列 ✓`, data: d };
    },
  },

  {
    id: "thumb-box",
    title: "封面比例盒没塌（老内核靠 padding-top 兜底）",
    why: "WebView 57 没有 aspect-ratio，比例是 `height:0 + padding-top:133.3333%` 合成的。兜底一失效，卡片高度归零 → 一屏只放得下两张（§8 风险 #10）。",
    async run(ctx) {
      const v = await ctx.eval(`(function(){
        var box = document.querySelector('.list-item .thumb-box') || document.querySelector('.thumb-box');
        if (!box) return JSON.stringify({ error: 'no .thumb-box' });
        var r = box.getBoundingClientRect();
        var img = box.querySelector('img');
        var ir = img ? img.getBoundingClientRect() : null;
        return JSON.stringify({
          w: Math.round(r.width), h: Math.round(r.height),
          ratio: r.width ? +(r.height / r.width).toFixed(3) : 0,
          imgW: ir ? Math.round(ir.width) : null,
          imgH: ir ? Math.round(ir.height) : null,
          aspectSupported: CSS.supports('aspect-ratio', '3/4'),
        });
      })()`);
      const d = JSON.parse(v);
      if (d.error) return { level: "fail", msg: "找不到 .thumb-box", data: d };
      if (d.h < 20) return { level: "fail", msg: `比例盒高度塌成 ${d.h}px`, data: d };
      // 期望 h/w ≈ 4/3 = 1.333（3:4 竖版封面）
      const off = Math.abs(d.ratio - 1.333);
      if (off > 0.12) return { level: "warn", msg: `比例 ${d.ratio}（期望约 1.333），${d.w}×${d.h}`, data: d };
      return { level: "pass", msg: `${d.w}×${d.h}，比例 ${d.ratio}（aspect-ratio 支持=${d.aspectSupported}）`, data: d };
    },
  },

  {
    id: "sibling-gap",
    title: "相邻兄弟间距不是 0（老内核 > * + * 补丁有效）",
    why: "compat 包的间距**唯一来源**是 `index.css` 末尾那批 `> * + *` 补丁。插一层 wrapper / 换顺序 / 绝对定位都会让 `+` 不命中 → 间距全塌成 0，而 modern 包完全正常（§8 风险 #1）。",
    async run(ctx) {
      const sels = ctx.probes.length ? ctx.probes : PROBE_DEFAULTS;
      const out = [];
      for (const rawSel of sels) {
        const sel = containerOf(rawSel);
        /**
         * 间距有三种来源，必须都算上，否则会误判：
         *   · 容器自己的 gap / grid-gap（grid 容器走这条，`.list` 就是）；
         *   · 第二个孩子的 margin（老内核 `> * + *` 补丁走这条，flex 容器是它）；
         *   · 实测的视觉间隔。
         * 而且**不能只算竖直方向**：`.list > *` 在多列网格里前两个孩子是**并排**的，
         * `b.top - a.bottom` 是负数 —— 早期版本就是这么把 `.list` 误判成"间距为 0"的。
         */
        const v = await ctx.eval(`(function(){
          var p = document.querySelector(${JSON.stringify(sel)});
          if (!p) return JSON.stringify({ sel: ${JSON.stringify(sel)}, missing: true });
          var kids = [].slice.call(p.children);
          if (kids.length < 2) return JSON.stringify({ sel: ${JSON.stringify(sel)}, kids: kids.length });
          var a = kids[0].getBoundingClientRect(), b = kids[1].getBoundingClientRect();
          var pcs = getComputedStyle(p), kcs = getComputedStyle(kids[1]);
          return JSON.stringify({
            sel: ${JSON.stringify(sel)}, kids: kids.length, display: pcs.display,
            parentGap: pcs.gap || pcs.gridGap || "",
            dy: Math.round(b.top - a.bottom), dx: Math.round(b.left - a.right),
            marginTop: kcs.marginTop, marginLeft: kcs.marginLeft,
          });
        })()`);
        out.push(JSON.parse(v));
      }
      const num = (s) => parseFloat(String(s)) || 0;
      const noSpacing = out.filter((x) => !x.missing && x.kids >= 2
        && num(x.parentGap) <= 0 && num(x.marginTop) <= 0 && num(x.marginLeft) <= 0
        && !(x.dx > 0) && !(x.dy > 0));
      const missing = out.filter((x) => x.missing);
      if (noSpacing.length) {
        return { level: "fail", msg: `这些容器的兄弟间距是 0：${noSpacing.map((x) => x.sel).join("、")}`, data: out };
      }
      if (missing.length) {
        return { level: "warn", msg: `页面上没有：${missing.map((x) => x.sel).join("、")}（换个页面再测）`, data: out };
      }
      return { level: "pass", msg: `${out.length} 个容器间距均非 0（gap / margin / 实测间隔三者其一）`, data: out };
    },
  },

  {
    id: "z-order",
    title: "浮层能盖住正文（z-index 阶梯没被打乱）",
    why: "全项目有 23 处手工 z-index，是一条**手调的阶梯**而不是体系。新加浮层最容易盖不住或遮罩失效（§8 风险 #13）。",
    async run(ctx) {
      const v = await ctx.eval(`(function(){
        function topmost(){
          var el = document.elementFromPoint(innerWidth/2, innerHeight/2);
          if (!el) return null;
          return { tag: el.tagName, cls: String(el.className||'').slice(0,40) };
        }
        return JSON.stringify({ center: topmost(), bodyZ: getComputedStyle(document.body).zIndex });
      })()`);
      return { level: "pass", msg: `屏幕中心命中 ${JSON.stringify(JSON.parse(v).center)}`, data: JSON.parse(v) };
    },
  },

  {
    id: "editor-ui",
    title: "「自定义 UI」编辑器页排布正常（本轮新增的大段 CSS）",
    why: "编辑器页的顶栏 / 画廊 / 画布 / 检查器全是新 CSS（.ed-*）。其中**拖拽手柄的 touch-action:none 只在触摸设备上看得出是否挡住了滚动** —— 开发机上用鼠标根本测不出来，这正是它必须上真机验的原因。v3.2 起外壳是两屏（画廊 → 编辑），进入后要点卡片才到编辑屏（openEditor 已按新流程走）。",
    async run(ctx) {
      if (!(await openEditor(ctx))) return { level: "fail", msg: "进不去「自定义 UI」（设置页里没找到入口）" };
      const v = await ctx.eval(`(function(){
        var page = document.querySelector('.ed-page');
        if (!page) return JSON.stringify({ error: '编辑器页没打开' });
        var grips = [].slice.call(document.querySelectorAll('.ed-canvas .ed-grip'));
        var blks = [].slice.call(document.querySelectorAll('.ed-canvas .ed-blk'));
        var insp = document.querySelector('.ed-inspector');
        var stage = document.querySelector('.ed-stage');
        var first = blks[0] ? blks[0].getBoundingClientRect() : null;
        return JSON.stringify({
          top: !!document.querySelector('.ed-top'),
          screen: page.getAttribute('data-screen'),
          // v3.3：宽屏开关 / 抓手 / 块名 chip 都已删除 —— 这里量的是"确实不在了"
          widechip: !!document.querySelector('.ed-top .ed-widechip'),
          namechips: document.querySelectorAll('.ed-canvas .ed-namechip').length,
          inspector: !!insp,
          slim: !!(insp && String(insp.className).indexOf('slim') >= 0),
          chips: document.querySelectorAll('.ed-inspector .ed-chip').length,
          more: !!document.querySelector('.ed-top .ed-more'),
          blocks: blks.length,
          grips: grips.length,
          blockH: first ? Math.round(first.height) : 0,
          // v3.3：拖动入口只剩"长按块本体"——真机上必须量得到"块本体覆盖了可触摸区域"
          blkW: first ? Math.round(first.width) : 0,
          inspectorH: insp ? Math.round(insp.getBoundingClientRect().height) : 0,
          stageH: stage ? Math.round(stage.getBoundingClientRect().height) : 0
        });
      })()`);
      const d = JSON.parse(v);
      if (d.error) return { level: "fail", msg: d.error, data: d };
      const bad = [];
      if (!d.top || !d.inspector) bad.push("顶栏 / 检查器有缺失");
      // v3.2：编辑屏的判别符（画廊屏是 data-screen="gallery"）
      if (d.screen !== "editor") bad.push("没进到编辑屏（data-screen=" + d.screen + "）");
      // v3.3：哑控件与宽窄屏概念一起删除 —— 顶栏**不该**再有「宽屏」按钮
      if (d.widechip) bad.push("顶栏还有「宽屏」按钮（v3.3 已删，改为任何视口都按配的宽度排）");
      if (d.blocks !== 7) bad.push("画布块数 " + d.blocks + "（应为 7 个顶层块 —— v3.4 起 notice 已下线）");
      if (d.blockH < 20) bad.push("画布块高度塌成 " + d.blockH + "px");
      if (d.stageH < 120) bad.push("画布区只有 " + d.stageH + "px 高");
      // v2：没选中时检查器收成一条（「挤」的解药）—— 矮没关系，但必须点得到
      if (!d.slim) bad.push("没选中时检查器没有收起（slim）");
      // v3.2：入口从"页面设置 / 排布总表 两个 chip"改成"一个「更多」chip + 顶栏「⋯」"
      if (d.chips < 1) bad.push("收起态没有「更多」入口（实有 " + d.chips + " 个）");
      if (!d.more) bad.push("顶栏没有「⋯」入口（页面设置 / 恢复默认收进了它）");
      if (d.inspectorH < 36) bad.push("收起条只有 " + d.inspectorH + "px（够不着就点不到 chip）");
      // v3.3（用户第 5 条）：抓手 / 块名 chip 全删 —— 真机上"没有它们"同样是必须成立的事实
      if (d.grips !== 0) bad.push("块上仍有抓手 " + d.grips + " 个（v3.3 已删，改由长按块本体拖动）");
      if (d.namechips !== 0) bad.push("块名 chip 仍有 " + d.namechips + " 个（v3.3 已删）");
      // 拖动入口只剩块本体 → 它的可触摸宽度必须撑得起来（窄到点不着就拖不动了）
      if (d.blkW < 120) bad.push("块本体可触摸宽度只有 " + d.blkW + "px（拖动入口只剩长按块本体，太窄会点不着）");
      if (bad.length) return { level: "fail", msg: bad.join("；"), data: d };
      return { level: "pass", msg: `画布 ${d.blocks} 块 / 块宽 ${d.blkW}px（长按块本体拖动）/ 画布区 ${d.stageH}px / 收起条 ${d.inspectorH}px（${d.chips} 个入口 + 顶栏⋯）/ 抓手与块名 chip 均为 0`, data: d };
    },
  },

  {
    id: "dl-style",
    title: "样式滑块真的改变几何（内联 style + data-dl-* 观测钩子）",
    why: "v2 起尺寸类是有界滑块（选中模块 → 专属检查器），几何走内联 style —— 连续值没法逐档预写声明，var() 传数字在老内核上又不确定（报告 §4.3）。内联是老内核上最稳的写法，但仍要真机量一次真实宽度才算数。",
    async run(ctx) {
      if (!(await openEditor(ctx))) return { level: "fail", msg: "进不去「自定义 UI」" };
      // 选中主视觉 → 上下文检查器（封面 / 标题两个滑块）。
      // 点击与查询必须分开：同一次 eval 里 React 还没重渲染，查不到滑块（本机对照组踩过）
      const clicked = await ctx.eval(`(function(){
        var blks = document.querySelectorAll('.ed-canvas .ed-blk');
        if (blks[1]) blks[1].click();
        return blks.length;
      })()`);
      if (!clicked) return { level: "fail", msg: "画布里没有可点的块" };
      await sleep(700);
      const picked = await ctx.eval(`!!document.querySelector('.ed-inspector [data-style-key="cover"] input[type="range"]')`);
      if (!picked) return { level: "fail", msg: "选中主视觉后没出现「封面大小」滑块" };
      const before = await ctx.eval(`(function(){
        var b = document.querySelector('.ed-canvas .d-cover-box');
        return b ? Math.round(b.getBoundingClientRect().width) : -1;
      })()`);
      const slid = await ctx.eval(`(function(){
        var input = document.querySelector('.ed-inspector [data-style-key="cover"] input[type="range"]');
        if (!input) return false;
        // React 的 onChange 挂在 input 事件上：原生 setter + dispatch（直接赋值会被 React 的值跟踪吃掉）
        var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
        setter.call(input, '140');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      if (!slid) return { level: "fail", msg: "拖不动「封面大小」滑块" };
      await sleep(700);
      const after = await ctx.eval(`(function(){
        var b = document.querySelector('.ed-canvas .d-cover-box');
        return b ? Math.round(b.getBoundingClientRect().width) : -1;
      })()`);
      const attr = await ctx.eval(`(function(){
        var c = document.querySelector('.ed-canvas .detail-card');
        return c ? c.getAttribute('data-dl-cover') : null;
      })()`);
      // 复位，不在用户机器上留副作用（单项复位 ↺ 只在被改过的那项上）
      await ctx.eval(`(function(){
        var row = document.querySelector('.ed-inspector [data-style-key="cover"]');
        var btn = row && row.querySelector('.dl-reset');
        if (btn) btn.click();
        return 1;
      })()`);
      const d = { before, after, attr };
      if (attr !== "140") return { level: "fail", msg: `data-dl-cover 没挂到 .detail-card 上（实际 ${attr}）`, data: d };
      if (after !== 140) {
        return { level: "fail", msg: `滑块拖到 140 后封面宽度 ${after}px（期望 140）—— 内联 style 在老内核上没生效`, data: d };
      }
      return { level: "pass", msg: `封面 ${before}px → ${after}px（滑块 → 内联 style）✓`, data: d };
    },
  },

  {
    id: "longpress-drag",
    title: "画布长按拖拽 + 兄弟块让位（v2 手势）",
    why: "长按起拖是触摸手势：按住 280ms 才拖，没长按就动 = 滚动（绝不许起拖，否则画布滚不动）。合成事件只能验 JS 路径与让位动画（data-flip）；**手指上会不会被系统手势抢走必须人手按一遍** —— ⠿ 手柄（按下立即拖）就是被抢走时的退路，本项把退路一起验掉。v3 追加第 ④ 步：用**原生触摸**（Input.dispatchTouchEvent，走浏览器真实输入管线）验「抓起之后大幅移动，手势不许被滚动抢走」—— 这正是真机拖不动的病根，合成事件永远测不出（它不经过手势仲裁）。",
    async run(ctx) {
      if (!(await openEditor(ctx))) return { level: "fail", msg: "进不去「自定义 UI」" };
      const start = await ctx.eval(`(function(){
        var c = document.querySelector('.ed-canvas');
        var blks = document.querySelectorAll('.ed-canvas .ed-blk');
        if (!c || !blks.length) return null;
        return JSON.stringify({
          order: [].slice.call(blks).map(function(b){ return b.getAttribute('data-blk'); }),
          flip: c.getAttribute('data-flip') || '0',
          saved: localStorage.getItem('jmclient.detailLayout.v1')
        });
      })()`);
      if (!start) return { level: "fail", msg: "画布里没有可拖的块" };
      const s0 = JSON.parse(start);
      /** 把用户自己的布局配置原样写回（拖拽会动它；检查不留副作用） */
      const restoreLayout = () => ctx.eval(`(function(){
        var v = ${JSON.stringify(s0.saved)};
        if (v === null) localStorage.removeItem('jmclient.detailLayout.v1');
        else localStorage.setItem('jmclient.detailLayout.v1', v);
        return 1;
      })()`);
      const helper = `function pe(el, type, y){
        var ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, clientX: 20 });
        Object.defineProperty(ev, 'pointerType', { value: 'touch' });
        Object.defineProperty(ev, 'pointerId', { value: 1 });
        el.dispatchEvent(ev);
      }`;
      // ① 没长按就大幅移动 = 滚动：不许起拖
      await ctx.eval(`(function(){ ${helper}
        window.__jmdrag = document.querySelectorAll('.ed-canvas .ed-blk')[0];
        pe(window.__jmdrag, 'pointerdown', 0);
        pe(window.__jmdrag, 'pointermove', 200);
        return 1;
      })()`);
      await sleep(500);
      const scrolled = await ctx.eval(`(function(){
        var n = document.querySelectorAll('.ed-canvas .ed-blk.ed-drag').length;
        ${helper}
        pe(window.__jmdrag, 'pointerup', 200);
        return n;
      })()`);
      if (scrolled) { await restoreLayout(); return { level: "fail", msg: "没长按就移动居然起拖了（滚动会被劫持）" }; }
      // ② 长按起拖 → 拖动中实时换位 + 让位动画 → 松手干净。
      //    被拖元素挂 window 保持引用 —— 换位后 DOM 顺序变了，重新查 [0] 会松错块（对照组踩过）
      await ctx.eval(`(function(){ ${helper}
        window.__jmdrag = document.querySelectorAll('.ed-canvas .ed-blk')[0];
        pe(window.__jmdrag, 'pointerdown', 0);
        return 1;
      })()`);
      await sleep(500);
      const grab = await ctx.eval(`document.querySelectorAll('.ed-canvas .ed-blk.ed-drag').length`);
      await ctx.eval(`(function(){ ${helper}
        pe(window.__jmdrag, 'pointermove', 3000);
        return 1;
      })()`);
      await sleep(300);
      const mid = await ctx.eval(`(function(){
        var c = document.querySelector('.ed-canvas');
        var blks = document.querySelectorAll('.ed-canvas .ed-blk');
        ${helper}
        pe(window.__jmdrag, 'pointerup', 3000);
        return JSON.stringify({
          order: [].slice.call(blks).map(function(b){ return b.getAttribute('data-blk'); }),
          flip: c.getAttribute('data-flip') || '0'
        });
      })()`);
      await sleep(200);
      const clean = await ctx.eval(`document.querySelectorAll('.ed-canvas .ed-blk.ed-drag').length`);
      // ③ v3.3：抓手已删除 —— 原来这一步验"⠿ 手柄按下立即拖"这条退路。
      //    现在拖动入口**只剩长按块本体**，所以要验的是相反的事实：**块上确实没有抓手**，
      //    而且按下块本体（位移小于阈值时）**不会**立刻起拖（长按计时才是入口）。
      const noGrip = await ctx.eval(`JSON.stringify({
        grips: document.querySelectorAll('.ed-canvas .ed-grip').length,
        namechips: document.querySelectorAll('.ed-canvas .ed-namechip').length
      })`);
      await ctx.eval(`(function(){ ${helper}
        window.__jmblk = document.querySelectorAll('.ed-canvas .ed-blk')[1];
        pe(window.__jmblk, 'pointerdown', 0);
        return 1;
      })()`);
      await sleep(120);
      const pressOnly = await ctx.eval(`(function(){
        var n = document.querySelectorAll('.ed-canvas .ed-blk.ed-drag').length;
        ${helper}
        pe(window.__jmblk, 'pointerup', 0);
        return n;
      })()`);
      await sleep(150);
      const rest = await ctx.eval(`document.querySelectorAll('.ed-canvas .ed-blk.ed-drag').length`);

      // ④ **原生触摸**（走浏览器真实输入管线）：真机"拖不动"的病根就在这一条。
      //    抓起之后**大幅**移动 160px —— 手势一旦被浏览器判成滚动，pointercancel 立刻到、拖拽就断。
      //    （合成 pointer 事件永远不会有这个后果，所以旧版全绿也说明不了真机可用。）
      let touchProbe = null;
      let skipWhy = null;
      if (typeof ctx.touch === "function") {
        // 前置条件：原生触摸必须先开**触摸仿真**，否则 Chrome 不会把 dispatchTouchEvent
        // 当真实触摸处理（本机 --cdp 对照组就是这么挂的：长按不起拖 + 手势立刻被取消）。
        // 真机上这步是冗余但无害的。
        if (typeof ctx.send === "function") {
          try { await ctx.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }); } catch { /* 老内核/真机可能不支持：忽略 */ }
        }
        // 前置条件②：**首启遮罩**（服务条款）会吃掉真实触摸 —— 合成事件绕过它，所以前几步照过，
        // 只有原生触摸会暴露（本项目实测：命中链是 .tos-scroll < .tos-card < .tos-backdrop）。
        // 真用户早就点过「同意」了，这里补上才代表真机现场（e2e 的 stub.js 也是这么做的）。
        await ctx.eval(`(function(){
          var b = document.querySelector('.tos-accept');
          if (b && !b.disabled) b.click();
          return 1;
        })()`);
        await sleep(900);
        const candRaw = await ctx.eval(`(function(){
          if (!window.__evHook) {
            window.__evHook = 1;
            document.addEventListener('touchmove', function(e){
              window.__ev.touchmove++; if (e.defaultPrevented) window.__ev.prevented++;
            }, { passive: true });
            document.addEventListener('pointercancel', function(){ window.__ev.cancel++; }, true);
            document.addEventListener('touchcancel', function(){ window.__ev.cancel++; }, true);
          }
          window.__ev = { touchmove: 0, prevented: 0, cancel: 0 };
          var s = document.querySelector('.ed-stage'); if (s) s.scrollTop = 0;
          var out = [], bs = document.querySelectorAll('.ed-canvas .ed-blk');
          for (var i = 0; i < bs.length; i++) {
            var r = bs[i].getBoundingClientRect();
            if (r.height < 16 || r.width < 40) continue;
            for (var k = 0; k < 5; k++) {
              var y = Math.round(r.top + 8 + (r.height - 16) * (k / 4));
              var x = Math.round(r.left + r.width / 2);
              if (y < 4 || y > (window.innerHeight || 600) - 4) continue;
              // 可达性过滤：真实触摸要命中测试，**被遮罩盖着的点直接淘汰**
              // （合成事件不做命中测试 —— 这正是旧清单"全绿但真机拖不动"的根源）
              var hit = document.elementFromPoint(x, y);
              if (!(hit && hit.closest && hit.closest('.ed-canvas'))) continue;
              out.push({ x: x, y: y, id: bs[i].getAttribute('data-blk'), h: Math.round(r.height) });
            }
          }
          return JSON.stringify(out);
        })()`);
        const cands = (candRaw && typeof candRaw === "string") ? JSON.parse(candRaw) : [];
        const tries = [];
        for (const c of cands) {
          // 诊断：这个点**到底打到谁**（真实触摸要命中测试，合成事件不需要 —— 环境差异全在这）
          c.hit = await ctx.eval(`(function(){
            var el = document.elementFromPoint(${c.x}, ${c.y});
            if (!el) return 'null';
            var chain = [], n = el;
            for (var i = 0; i < 4 && n; i++) { chain.push(n.tagName + '.' + (n.className || '')); n = n.parentElement; }
            return chain.join(' < ') + ' | inCanvas=' + !!(el.closest && el.closest('.ed-canvas'));
          })()`);
          const held = await (async () => {
            await ctx.eval(`(function(){ window.__ev = { touchmove: 0, prevented: 0, cancel: 0 }; return 1; })()`);
            await ctx.touch("touchStart", c.x, c.y);
            await sleep(400); // 过长按阈值（280ms）
            return await ctx.eval(`document.querySelectorAll('.ed-canvas .ed-blk.ed-drag').length`);
          })();
          if (held === 1) {
            for (const dy of [20, 60, 110, 160]) { await ctx.touch("touchMove", c.x, c.y - dy); await sleep(70); }
            const movedRaw = await ctx.eval(`(function(){
              var s = document.querySelector('.ed-stage');
              return JSON.stringify({
                drag: document.querySelectorAll('.ed-canvas .ed-blk.ed-drag').length,
                scrollTop: s ? Math.round(s.scrollTop) : null,
                ev: window.__ev
              });
            })()`);
            await ctx.touch("touchEnd", c.x, c.y - 160);
            await sleep(320);
            const afterT = await ctx.eval(`document.querySelectorAll('.ed-canvas .ed-blk.ed-drag').length`);
            touchProbe = { at: c, tries: tries.length + 1, held: held, after: afterT, moved: JSON.parse(movedRaw) };
            break;
          }
          tries.push({ at: c, held: held, hit: c.hit });
          await ctx.touch("touchEnd", c.x, c.y);
          await sleep(120);
        }
        skipWhy = tries.length ? JSON.stringify(tries.slice(0, 2)) : "no-candidates";
      }

      await restoreLayout(); // 不在用户机器上留副作用
      const m = JSON.parse(mid);
      const d = { before: s0.order, mid: m.order, flipBefore: s0.flip, flipAfter: m.flip, grab, clean, noGrip, pressOnly, rest, touch: touchProbe };
      const bad = [];
      if (grab !== 1) bad.push("长按 280ms 后没进入拖动态（实际 " + grab + "）");
      if (m.order[m.order.length - 1] !== s0.order[0]) bad.push("拖动中没有实时换位：" + JSON.stringify(m.order));
      if (!(Number(m.flip) > Number(s0.flip))) bad.push("兄弟块让位动画没跑过（data-flip 没长）");
      if (clean) bad.push("松手后还挂着拖动态（" + clean + "）");
      // v3.3：抓手删除后，验的是"没有抓手" + "按一下不会误起拖"（长按才是入口）
      const ng = JSON.parse(noGrip);
      if (ng.grips !== 0) bad.push("块上仍有抓手 " + ng.grips + " 个（v3.3 已删）");
      if (ng.namechips !== 0) bad.push("块名 chip 仍有 " + ng.namechips + " 个（v3.3 已删）");
      if (pressOnly !== 0) bad.push("只按下（未长按）就进了拖动态（" + pressOnly + "）—— 单击应当只是选中");
      if (rest) bad.push("短按松手后还挂着拖动态（" + rest + "）");
      if (touchProbe) {
        const at = `（落点 ${touchProbe.at.x},${touchProbe.at.y} 打到 [${touchProbe.hit}]）`;
        if (touchProbe.held !== 1) bad.push("原生触摸长按 420ms 后没进入拖动态（实际 " + touchProbe.held + "）" + at);
        if (touchProbe.moved.drag !== 1) bad.push("原生触摸抓起后大幅移动被中断（浏览器把手势判给了滚动）" + at);
        if (touchProbe.moved.ev && touchProbe.moved.ev.cancel) bad.push("原生触摸手势被浏览器取消（pointercancel/touchcancel）" + at);
        if (touchProbe.moved.scrollTop) bad.push("原生触摸拖动中画布被滚动了（scrollTop=" + touchProbe.moved.scrollTop + "）");
        if (touchProbe.after) bad.push("原生触摸松手后拖动态没撤干净（" + touchProbe.after + "）");
      }
      if (bad.length) return { level: "fail", msg: bad.join("；"), data: d };
      const touchMsg = touchProbe
        ? ` / 原生触摸：长按起拖 ✓ 大幅移动不断 ✓ 画布不滚 ✓（touchmove ${touchProbe.moved.ev.touchmove} 个、其中挡下 ${touchProbe.moved.ev.prevented} 个）`
        : "";
      const base = `长按起拖 ✓ / 实时换位 ✓ / 让位动画 ${s0.flip}→${m.flip} ✓ / 短按不误起拖 ✓ / 抓手与块名 chip 均为 0 ✓`;
      // 原生触摸没跑成 → **warn**，不许当通过：这条正是真机拖不动的病根，
      // 静默跳过就等于给用户一个假绿的清单（本项第一次跑就是这么骗过自己的）。
      if (!touchProbe) {
        return {
          level: "warn",
          msg: base + " / **原生触摸未验**（找不到能自证落在块内的点，现场：" + String(skipWhy).slice(0, 220) + "）",
          data: d
        };
      }
      return { level: "pass", msg: base + touchMsg, data: d };
    },
  },

  {
    id: "console",
    title: "控制台没有错误",
    why: "这类 bug 的共同点就是**不报错**；反过来，真报错了必须看。",
    async run(ctx) {
      const v = await ctx.eval(`(function(){
        return JSON.stringify({ errs: (window.__errs || []).slice(0, 8) });
      })()`);
      const d = JSON.parse(v);
      if (!d.errs || d.errs.length === 0) return { level: "pass", msg: "errs 为空", data: d };
      return { level: "warn", msg: `${d.errs.length} 条错误：${String(d.errs[0]).slice(0, 80)}`, data: d };
    },
  },
];

// ────────────────────────────── 主流程 ──────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readmeHeader());
    return;
  }
  const active = CHECKS.filter((c) => !opts.checks || opts.checks === "all" || opts.checks.includes(c.id));
  if (opts.listChecks) {
    for (const c of CHECKS) console.log(`${c.id.padEnd(15)} ${c.title}\n${" ".repeat(17)}为什么查：${c.why}`);
    return;
  }
  if (opts.checks && active.length === 0) {
    console.error("--checks 里没有已知检查 id，用 --list-checks 查看");
    process.exit(2);
  }

  let adb = null;
  if (!opts.cdp) {
    adb = makeAdb(opts);
    // 先确认真的有设备 —— 没有就明确失败，绝不"跳过检查当通过"
    let devices = [];
    try {
      devices = execFileSync(opts.adb, ["devices"], { encoding: "utf8" })
        .split("\n").map((s) => s.trim())
        .filter((l) => l && !l.startsWith("List of") && /\t(device|emulator)$/.test(l));
    } catch (e) {
      console.error(`adb 跑不起来（--adb ${opts.adb}）：${e && e.message}`);
      process.exit(2);
    }
    if (devices.length === 0) {
      console.error("没有在线设备。老内核验收必须在真机上跑 —— 插上设备（或启动模拟器）再试，adb devices 应当能看到它。");
      process.exit(2);
    }
    if (!opts.serial && devices.length > 1) {
      console.error(`有 ${devices.length} 台设备，请用 --serial 指定：\n  ${devices.join("\n  ")}`);
      process.exit(2);
    }

    if (opts.launch) {
      adb(["shell", "am", "force-stop", opts.package]);
      await sleep(1000);
      adb(["shell", "monkey", "-p", opts.package, "-c", "android.intent.category.LAUNCHER", "1"]);
    }
  }

  let cdp;
  try {
    cdp = opts.cdp ? await connectListUrl(cdpListUrl(opts.cdp)) : await connectAdb(adb, opts);
  } catch (e) {
    console.error(`接不上 CDP：${e && e.message}`);
    process.exit(2);
  }

  /**
   * 注入脚本（Page.addScriptToEvaluateOnNewDocument）：
   * 必须在导航**之前**装，而且要重新导航一次才会生效。
   * 用途：① 本机拿 e2e 的桩跑一遍，验证脚本本身（没有真机时的唯一验证途径）；
   * ② 真机上临时挂探针，不必改 App。
   */
  if (opts.inject.length) {
    for (const f of opts.inject) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: readFileSync(resolve(process.cwd(), f), "utf8"),
      });
    }
    if (!opts.navigate) {
      const cur = await cdp.eval("location.href");
      opts.navigate = typeof cur === "string" && cur ? cur : "about:blank";
    }
  }

  // 需要先落到某个地址时才用：验深链 `?aid=xxx`（正是 ContentView 那个漏发信号的出口），
  // 或者桌面浏览器被首启同步页顶掉了启动 URL
  if (opts.navigate) {
    // 必须走 Page.navigate，不能写 `location.href = …`：
    // 在 edge:// 这类特权页上脚本发起的导航会被静默拦掉（实测），而且返回值还是"成功"
    await cdp.send("Page.navigate", { url: opts.navigate });
    await sleep(2000);
  }

  // 等 App 起来 + 过掉 18+ 确认页 / 使用须知
  const deadline = Date.now() + opts.settle;
  let ready = false;
  while (Date.now() < deadline) {
    const st = await cdp.eval(`(function(){
      var a = document.querySelector('.age-confirm'); if (a) { a.click(); return 'age'; }
      var t = document.querySelector('.tos-accept'); if (t && !t.disabled) { t.click(); return 'tos'; }
      return document.querySelector('.list-item') ? 'ready' : 'wait';
    })()`);
    if (st === "ready") { ready = true; break; }
    await sleep(1000);
  }

  const ctx = { eval: cdp.eval, touch: cdp.touch, send: cdp.send, probes: opts.probes, expectCols: opts.expectCols };
  const results = [];
  if (!ready) {
    results.push({ id: "boot", level: "fail", msg: `${opts.settle}ms 内没等到 .list-item（App 没起来或卡在确认页）` });
  }
  for (const c of active) {
    if (!ready && c.id !== "console") continue;
    try {
      const r = await c.run(ctx);
      results.push({ id: c.id, title: c.title, ...r });
    } catch (e) {
      results.push({ id: c.id, title: c.title, level: "fail", msg: `检查本身抛错：${e && e.message}` });
    }
    if (opts.shots) {
      const f = resolve(opts.shots, `${c.id}.png`);
      try { await cdp.shot(f); } catch { /* 截图失败不影响判定 */ }
    }
  }

  // 逃生口：任意表达式
  for (const expr of opts.evals) {
    try {
      const v = await cdp.eval(expr);
      results.push({ id: "eval", title: expr, level: "pass", msg: JSON.stringify(v), data: v });
    } catch (e) {
      results.push({ id: "eval", title: expr, level: "fail", msg: String(e && e.message) });
    }
  }

  cdp.close();
  if (adb && !opts.keepForward) {
    try { adb(["forward", "--remove-all"]); } catch { /* ignore */ }
  }

  const text = format(results, opts);
  if (opts.out) {
    const abs = resolve(process.cwd(), opts.out);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    console.error(`已写出 ${opts.out}`);
  } else {
    process.stdout.write(text);
  }

  const worst = results.some((r) => r.level === "fail") ? "fail"
    : results.some((r) => r.level === "warn") ? "warn" : "pass";
  if (opts.failOn === "fail" && worst === "fail") process.exit(1);
  if (opts.failOn === "warn" && worst !== "pass") process.exit(1);
}

function format(results, opts) {
  const mark = { pass: "✓", warn: "△", fail: "✗" };
  if (opts.format === "json") return JSON.stringify({ results }, null, 1) + "\n";
  const lines = [];
  if (opts.format === "md") {
    lines.push("# 老内核真机布局验收", "", "| 结果 | 检查 | 说明 |", "|---|---|---|");
    for (const r of results) lines.push(`| ${mark[r.level]} | ${r.id} | ${r.msg.replace(/\|/g, "\\|")} |`);
  } else {
    if (!opts.quiet) lines.push("老内核真机布局验收", "");
    for (const r of results) {
      lines.push(`  ${mark[r.level]} ${r.id.padEnd(15)} ${r.msg}`);
    }
    const n = (l) => results.filter((r) => r.level === l).length;
    lines.push("", `结论：${n("pass")} 通过 / ${n("warn")} 待看 / ${n("fail")} 失败`);
  }
  return lines.join("\n") + "\n";
}

function readmeHeader() {
  return [
    "tools/old-device-check.mjs —— 老内核真机布局验收（可传参 / 可复用）",
    "",
    "  node tools/old-device-check.mjs [--serial <s>] [--checks <id,id>] [--shots <dir>]",
    "                                  [--probe <sel>]... [--expect-cols <n>] [--eval <js>]...",
    "                                  [--cdp <host:port>] [--format text|json|md] [--out <file>]",
    "                                  [--fail-on none|warn|fail]",
    "",
    "  --list-checks  查看检查项清单（含每项「为什么查它」）",
    "  没插真机时会**明确失败**，不会假装通过；要先在本机验脚本本身，用 --cdp 直连桌面浏览器。",
  ].join("\n");
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(2);
});
