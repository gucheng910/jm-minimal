#!/usr/bin/env node
/**
 * scan-hang-risks.mjs —— 「可能永不落定 / 静默卡死」静态扫描器
 *
 * 起因：2026-10-11 实测到一个真故障 —— `navTransition` 的 `update()` 只在
 * `startViewTransition` 的更新回调里被调用，而调用方 `await` 的 Promise 等的是
 * `resolveApplied()`。浏览器不调那个回调时，两件事同时坏掉：页面不切换、Promise
 * 永不落定 —— 表现为「点卡片什么都不发生、也不发请求、控制台 errs 还是空的」。
 * 已在 core/viewTransition.ts 加看门狗修掉（见该文件头注释）。
 *
 * 本脚本的目的：**把这一类问题一次找全**，而不是等下一次真机踩到。
 * 「这一类」= *某个 await / Promise 没有可靠的落定保证*，出问题时不抛错、不报网络错，
 * 只是永远停在"加载中"，属于最难查的一类故障。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node tools/scan-hang-risks.mjs                        # 扫 src，文本输出
 *   node tools/scan-hang-risks.mjs --root src --root electron
 *   node tools/scan-hang-risks.mjs --rules promise-no-settle,silent-catch
 *   node tools/scan-hang-risks.mjs --format md --out report.md
 *   node tools/scan-hang-risks.mjs --fail-on high         # 达到 high 就 exit 1（可进 CI）
 *   node tools/scan-hang-risks.mjs --write-baseline tools/.hang-risks-baseline.json
 *   node tools/scan-hang-risks.mjs --baseline tools/.hang-risks-baseline.json   # 只报新增
 *
 * ── 参数 ────────────────────────────────────────────────────────────────
 *   --root <dir>        扫描根（可重复；默认 src）
 *   --ext <list>        扩展名，逗号分隔（默认 ts,tsx,js,mjs,cjs,jsx）
 *   --include <glob>    只扫匹配（可重复，简单 * / ** 通配）
 *   --exclude <glob>    排除（可重复；默认已排测试文件、node_modules、dist、build）
 *   --rules <list>      只启用这些规则 id（逗号分隔）
 *   --min-level <lv>    只显示 >= 该级别（low|medium|high|critical；默认 low）
 *   --format <fmt>      text | json | md（默认 text）
 *   --out <file>        写到文件（默认 stdout）
 *   --context           附带源码行
 *   --stats             只输出统计，不列明细
 *   --baseline <file>   与基线比对，只报新增命中
 *   --write-baseline <file>  把本次结果写成基线
 *   --fail-on <lv>      none|low|medium|high|critical（默认 none，即不因命中而失败）
 *   --list-rules        打印规则表后退出
 *   --quiet             只打结论行
 *
 * ── 边界（诚实声明）─────────────────────────────────────────────────────
 * 这是**静态启发式**，不是证明。它做两件事：
 *   ① 报告"结构性可疑"——Promise 没有落定路径、await 了已知会不回调的 API、
 *      catch 静默吞掉、忙态没复位；
 *   ② 标出**人工必须确认**的项（结果里 `heuristic: true`）。
 * 它**不能**证明"这段一定不会卡"。反过来，命中≠就是 bug —— 很多是有意为之
 * （例如 `new Promise(() => {})` 是测试桩）。所以输出里的每一行都要人过一眼。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, extname } from "node:path";

// ────────────────────────────── 级别 ──────────────────────────────
const LEVELS = { low: 1, medium: 2, high: 3, critical: 4 };
const LEVEL_LABEL = { low: "低", medium: "中", high: "高", critical: "严重" };
function normLevel(v, dflt) {
  const k = String(v || "").toLowerCase();
  if (k === "none") return 0;
  return LEVELS[k] ?? dflt;
}

// ────────────────────────────── 规则表 ──────────────────────────────
/**
 * run(ctx) 收到：
 *   ctx.file     相对路径
 *   ctx.raw      原始源码
 *   ctx.code     已抹掉字符串/注释/正则内容的等长源码（结构分析用）
 *   ctx.report({ rule, level, line, col, msg, why, fix, heuristic, snippet })
 */
const RULES = [
  {
    id: "promise-no-settle",
    level: "high",
    title: "Promise 的 executor 里没有调用 resolve/reject",
    why: "这种 Promise 永不落定。任何 await 它的地方都会永久停住，且不抛错。",
    fix: "补落定路径；若确实要「永不落定」（测试桩），用注释显式写明。",
    heuristic: false,
    run(ctx) {
      forEachMatch(ctx.code, /new\s+Promise\s*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\(/g, (m) => {
        const open = ctx.code.indexOf("(", m.index);
        const close = matchPair(ctx.code, open, "(", ")");
        if (close < 0) return;
        const arrow = ctx.code.slice(open + 1, close);
        const raw = arrow;
        let paramsRaw = "";
        let body = raw;
        // executor 有两种写法：箭头 `(res) => {...}` / `res => {...}`，以及 `function (res) {...}` / `async function (res) {...}`
        const arrowM = raw.match(/^\s*(?:async\s*)?(?:\(\s*([^)]*?)\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*/);
        const fnM = raw.match(/^\s*(?:async\s+)?function\s*[\w$]*\s*\(\s*([^)]*?)\s*\)\s*(?::[^{]*)?\{/);
        if (arrowM) {
          paramsRaw = arrowM[1] ?? arrowM[2] ?? "";
          body = raw.slice(arrowM[0].length);
        } else if (fnM) {
          paramsRaw = fnM[1] ?? "";
          body = raw.slice(fnM[0].length - 1);
        } else if (!/^\s*[{(]/.test(raw)) {
          return; // executor 是标识符/调用（如 new Promise(resolveThing)），静态看不出来，交给人工
        }
        const params = paramsRaw.split(",").map((s) => s.trim().replace(/[:=].*$/, "").replace(/^\.\.\./, "")).filter(Boolean);
        const bodyEnd = body.startsWith("{") ? (matchPair(body, 0, "{", "}") ?? body.length) : body.length;
        const inner = body.slice(0, bodyEnd + 1);
        if (params.length === 0) {
          // 完全没有落定参数 —— 要么是桩，要么是漏了
          ctx.report({
            rule: "promise-no-settle", level: "high", line: lineOf(ctx.code, m.index),
            msg: "new Promise 没有任何落定参数，必然是永不落定",
            why: "任何 await 它的地方永久停住；在生产代码里几乎一定是漏了 resolve。",
            fix: "补 resolve/reject；确为有意则在注释里写明「故意永不落定」。",
            heuristic: !/永不落定|never settle|测试桩|stub/i.test(ctx.raw.slice(Math.max(0, m.index - 200), close + m.index + 200)),
            snippet: ctx.raw.slice(m.index, Math.min(ctx.raw.length, close + 1)).split("\n")[0],
          });
          return;
        }
        const used = params.filter((p) => new RegExp("\\b" + esc(p) + "\\b").test(inner));
        if (used.length === 0) {
          ctx.report({
            rule: "promise-no-settle", level: "high", line: lineOf(ctx.code, m.index),
            msg: `executor 声明了 ${params.join("/")}，但函数体里一次都没用 → 永不落定`,
            why: "任何 await 它的地方永久停住，且不抛错、不打日志。",
            fix: "补落定调用；若是桩，用注释显式写明。",
            heuristic: false,
            snippet: ctx.raw.slice(m.index, Math.min(ctx.raw.length, close + 1)).split("\n")[0],
          });
        }
      });
    },
  },

  {
    id: "promise-race-forgotten",
    level: "medium",
    title: "await 了可能永不落定的第三方 / 原生 API，且所在函数没有超时兜底",
    why: "View Transitions 回调、原生插件调用、decode()/fonts.ready 这类接口「不回调」是已知现象（本项目在 viewTransition 上实测过一次）。",
    fix: "Promise.race 一个超时，或抽成带 timeout 参数的包装（参考 core/fetchTimeout.ts）。",
    heuristic: true,
    run(ctx) {
      const RISKY = [
        "startViewTransition", ".finished", "requestIdleCallback", "navigator.locks",
        "fonts.ready", ".decode()", "Browser.open", "Filesystem.", "StatusBar.", "SplashScreen.",
        "Keyboard.", "Share.", "Haptics.", "Network.", "App.addListener",
      ];
      const guardRe = /Promise\.race\s*\(|setTimeout\s*\(|withTimeout|AbortController|timeoutMs|TIMEOUT|watchdog|WATCHDOG/i;
      forEachMatch(ctx.code, /\bawait\s+[^;)\n]+/g, (m) => {
        const expr = m[0];
        const hit = RISKY.find((k) => expr.includes(k));
        if (!hit) return;
        const fn = enclosingFunction(ctx.code, m.index);
        const scope = fn ? ctx.code.slice(fn.start, fn.end) : ctx.code.slice(Math.max(0, m.index - 2500), m.index + 2500);
        if (guardRe.test(scope)) return;
        ctx.report({
          rule: "promise-race-forgotten", level: "medium", line: lineOf(ctx.code, m.index),
          msg: `await 了 ${hit}，所在函数没有超时/中止兜底`,
          why: "该接口可能不回调；届时这一行后面的代码全部不执行，且不抛错。",
          fix: "用 Promise.race 包一个超时，或复用 core/fetchTimeout.ts 的写法。",
          heuristic: true,
          snippet: expr.trim(),
        });
      });
    },
  },

  {
    id: "deferred-await-unsettled",
    level: "high",
    title: "await 了「延迟落定」的模块级 Promise，且没有超时兜底",
    why: "模块级 `let resolveX; const p = new Promise(r => resolveX = r)` 这种「完成信号」，全靠别处显式调用 resolveX()。任何一条提前返回的路径漏调，await 它的地方就永久停住。",
    fix: "调用方包 Promise.race 超时；发出方把 resolveX() 放进 try/finally 保证一定调到。",
    heuristic: true,
    run(ctx) {
      // 找"executor 里把 resolver 赋给外部变量"的模式
      const deferred = new Set();
      forEachMatch(ctx.code, /new\s+Promise\s*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\(/g, (m) => {
        const open = ctx.code.indexOf("(", m.index);
        const close = matchPair(ctx.code, open, "(", ")");
        if (close < 0) return;
        const body = ctx.code.slice(open + 1, close);
        const am = body.match(/^\s*(?:\(\s*([^)]*?)\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*/);
        if (!am) return;
        const param = (am[1] ?? am[2] ?? "").split(",")[0].trim().replace(/[:=].*$/, "");
        if (!param) return;
        // body 里出现 `X = param` / `X = param;`，X 是外部 let/const 名
        const asg = new RegExp("([A-Za-z_$][\\w$]*)\\s*=\\s*" + esc(param) + "\\b").exec(body);
        if (!asg) return;
        // 反查 Promise 被赋给谁
        const left = ctx.code.lastIndexOf("const ", m.index) > ctx.code.lastIndexOf("let ", m.index)
          ? ctx.code.lastIndexOf("const ", m.index) : ctx.code.lastIndexOf("let ", m.index);
        const decl = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)/.exec(ctx.code.slice(left, m.index));
        if (decl) deferred.add(decl[1]);
      });
      if (deferred.size === 0) return;
      const guardRe = /Promise\.race\s*\(|setTimeout\s*\(|withTimeout|watchdog|WATCHDOG|timeoutMs/i;
      forEachMatch(ctx.code, /\bawait\s+([A-Za-z_$][\w$]*)\b/g, (m) => {
        const name = m[1];
        if (!deferred.has(name)) return;
        const fn = enclosingFunction(ctx.code, m.index);
        const scope = fn ? ctx.code.slice(fn.start, fn.end) : ctx.code.slice(Math.max(0, m.index - 1500), m.index + 1500);
        if (guardRe.test(scope)) return;
        ctx.report({
          rule: "deferred-await-unsettled", level: "high", line: lineOf(ctx.code, m.index),
          msg: `await ${name}（延迟落定的完成信号）没有任何超时兜底`,
          why: "发出方只要有一条路径没调 resolve，这里就永久停住 —— 与 viewTransition 那次故障同一类。",
          fix: "包 Promise.race 超时；或保证发出方在 finally 里一定落定。",
          heuristic: true,
          snippet: m[0].trim(),
        });
      });
    },
  },

  {
    id: "signal-not-in-finally",
    level: "medium",
    title: "「完成信号」只在正常路径上发出，提前 return / 异常路径会漏发",
    why: "调用方 await 的是这个信号。一旦函数从 return 或 catch 走掉而没发信号，调用方就永久等待（或要等很久的超时）。",
    fix: "把信号调用挪进 try/finally，或在每条出口都发。",
    heuristic: true,
    run(ctx) {
      /**
       * 只认**真信号** —— 判据是"它最终会不会落定一个 Promise"（见 buildSignalIndex）：
       *   ① 跨文件索引判定它是落定信号；或
       *   ② 名字是 announce / signal 一族（索引看不到第三方定义时的兜底）。
       *
       * 刻意**不认**这些，早期版本按名字认全是误报：
       *   · resolve* / finish* / done* —— 本仓库里大量是取值函数或方法
       *     （resolveDomain / resolveFile / resolveReaderScrollHost / resolvePages / finishFastTrack）；
       *   · notify* —— 常常是**观察者广播**（core/cacheTasks.ts 的 notify 就是 emit("jm:caches")），
       *     没人 await 它，漏发不会卡住任何人。
       */
      const isSignal = (name) =>
        (typeof ctx.isSettleSignal === "function" && ctx.isSettleSignal(name, ctx.file)) ||
        /^(announce|signal)[A-Za-z]*$/.test(name);
      const fns = findFunctions(ctx.code);
      for (const fn of fns) {
        const body = ctx.code.slice(fn.start, fn.end);
        const calls = [];
        forEachMatch(body, /\b([A-Za-z_$][\w$]*)\s*\(/g, (m) => {
          if (!isSignal(m[1])) return;
          // 方法调用（`x.announce()`）不是本规则要管的全局完成信号
          if (m.index > 0 && body[m.index - 1] === ".") return;
          calls.push({ name: m[1], at: fn.start + m.index });
        });
        if (calls.length === 0) continue;
        /**
         * 只报**单一发出点**：同一个信号在函数里发了多次，说明作者已经在多条出口上处理过
         * （viewTransition 的 resolveApplied 就是两处各发一次），没必要再提醒。
         * 单点发出 + 有提前出口 = 这个函数只有一条路径会通知到调用方 —— 那才是高风险形态。
         */
        const byName = new Map();
        for (const c of calls) { const a = byName.get(c.name) || []; a.push(c); byName.set(c.name, a); }
        const singletons = [...byName.values()].filter((a) => a.length === 1).map((a) => a[0]);
        if (singletons.length === 0) continue;
        // finally 里已经发过的不算
        const finallyIdx = [];
        forEachMatch(body, /\bfinally\s*\{/g, (m) => {
          const o = body.indexOf("{", m.index);
          const c = matchPair(body, o, "{", "}");
          if (c > 0) finallyIdx.push([o, c]);
        });
        const isInFinally = (at) => {
          const rel = at - fn.start;
          return finallyIdx.some(([a, b]) => rel > a && rel < b);
        };
        const leftover = singletons.filter((c) => !isInFinally(c.at));
        if (leftover.length === 0) continue;
        // 有提前 return / catch 却没在 finally 发 → 可疑
        const hasEarlyReturn = /\breturn\b/.test(body.replace(/\breturn\b\s*;?\s*$/, ""));
        const hasCatch = /\bcatch\b/.test(body);
        if (!hasEarlyReturn && !hasCatch) continue;
        const names = [...new Set(leftover.map((c) => c.name))].join("、");
        ctx.report({
          rule: "signal-not-in-finally", level: "medium", line: lineOf(ctx.code, leftover[0].at),
          msg: `${names} 只在正常路径发出；函数里有提前 return 或 catch，可能漏发`,
          why: "漏发 = 调用方永久等待。这类 bug 不报错，只是「卡在加载中」。",
          fix: "挪进 try/finally 发出，或保证每条出口都发一次（本次涉及：" + names + "）。",
          heuristic: true,
          snippet: ctx.raw.slice(leftover[0].at, leftover[0].at + 60).split("\n")[0],
        });
      }
    },
  },

  {
    id: "unguarded-fetch",
    level: "medium",
    title: "直接 fetch()，没走 fetchWithTimeout",
    why: "裸 fetch 在弱网下可能长时间不落定；本项目已有 core/fetchTimeout.ts 作为统一入口。",
    fix: "改用 fetchWithTimeout(url, opts, timeoutMs)。",
    heuristic: false,
    run(ctx) {
      forEachMatch(ctx.code, /(^|[^.\w$])fetch\s*\(/g, (m) => {
        const at = m.index + m[1].length;
        const fn = enclosingFunction(ctx.code, at);
        // 找不到所属函数时退化成"调用点前后各 40 行"，避免把整个文件的兜底当成没有兜底
        const scope = fn ? ctx.code.slice(fn.start, fn.end) : lineWindow(ctx.code, at, 40);
        if (/AbortController|signal\s*:|timeout/i.test(scope)) return;
        ctx.report({
          rule: "unguarded-fetch", level: "medium", line: lineOf(ctx.code, at),
          msg: "裸 fetch()，没有超时/中止",
          why: "弱网下可能长期 pending，界面停在加载中。",
          fix: "用 core/fetchTimeout.ts 的 fetchWithTimeout。",
          heuristic: false,
          snippet: ctx.raw.slice(at, at + 70).split("\n")[0],
        });
      });
    },
  },

  {
    id: "loop-await-no-escape",
    level: "medium",
    title: "死循环里有 await，循环体内看不到出口",
    why: "任何一次「条件永远不成立」都会变成无限等待/无限空转。",
    fix: "加最大次数/最大时长，或补 break 条件。",
    heuristic: true,
    run(ctx) {
      forEachMatch(ctx.code, /\b(?:while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\))/g, (m) => {
        const o = ctx.code.indexOf("{", m.index);
        if (o < 0) return;
        const c = matchPair(ctx.code, o, "{", "}");
        if (c < 0) return;
        const body = ctx.code.slice(o, c);
        if (!/\bawait\b/.test(body)) return;
        if (/\bbreak\b|\breturn\b|\bthrow\b/.test(body)) return;
        ctx.report({
          rule: "loop-await-no-escape", level: "medium", line: lineOf(ctx.code, m.index),
          msg: "while(true)/for(;;) 内有 await，但没有 break/return/throw",
          why: "条件不成立时会无限等待。",
          fix: "加最大次数或最大时长。",
          heuristic: true,
          snippet: ctx.raw.slice(m.index, m.index + 60).split("\n")[0],
        });
      });
    },
  },

  {
    id: "busy-never-reset",
    level: "high",
    title: "忙态被置位，但函数里没有 finally 复位",
    why: "一旦中途抛出或某个 await 不落定，界面永远停在「处理中」，且不报错。",
    fix: "try { ... } finally { setBusy(false); }",
    heuristic: true,
    run(ctx) {
      const BUSY = /^set[A-Z]\w*(Busy|Loading|Pending|Switching|Waiting|Working)$/i;
      const fns = findFunctions(ctx.code);
      for (const fn of fns) {
        const body = ctx.code.slice(fn.start, fn.end);
        const setters = new Map();
        forEachMatch(body, /\b(set[A-Z][\w$]*)\s*\(\s*(true|false)\s*\)/g, (m) => {
          if (!BUSY.test(m[1])) return;
          const arr = setters.get(m[1]) || [];
          arr.push({ value: m[2], at: fn.start + m.index });
          setters.set(m[1], arr);
        });
        for (const [name, sites] of setters) {
          const truthy = sites.filter((s) => s.value === "true");
          const falsyInFinally = sites.some((s) => s.value === "false" && inFinally(ctx.code, fn, s.at));
          if (truthy.length === 0 || falsyInFinally) continue;
          const hasAnyFalse = sites.some((s) => s.value === "false");
          ctx.report({
            rule: "busy-never-reset", level: hasAnyFalse ? "low" : "high", line: lineOf(ctx.code, truthy[0].at),
            msg: hasAnyFalse
              ? `${name}(true) 有复位但不在 finally 里 —— 中途抛出/不落定时会漏复位`
              : `${name}(true) 在整个函数里没有对应的复位`,
            why: "界面永久停在「处理中」，不报错、控制台为空。",
            fix: `try { ... } finally { ${name}(false); }`,
            heuristic: true,
            snippet: ctx.raw.slice(truthy[0].at, truthy[0].at + 60).split("\n")[0],
          });
        }
      }
    },
  },

  {
    id: "silent-catch",
    level: "low",
    title: "catch 静默吞掉（无日志、无状态反馈）",
    why: "本身不一定是问题，但「出错后什么都不做」正是静默失败的温床；值得人过一眼。",
    fix: "至少留一行说明为什么可以忽略；若影响 UI 状态，要有反馈。",
    heuristic: true,
    run(ctx) {
      forEachMatch(ctx.code, /\bcatch\s*(?:\([^)]*\))?\s*\{/g, (m) => {
        const o = ctx.code.indexOf("{", m.index);
        const c = matchPair(ctx.code, o, "{", "}");
        if (c < 0) return;
        const body = ctx.code.slice(o + 1, c);
        if (body.trim() === "") {
          ctx.report({
            rule: "silent-catch", level: "low", line: lineOf(ctx.code, m.index),
            msg: "catch {} 空块，连注释都没有",
            why: "出错完全无声；后续排查无从下手。",
            fix: "写明为什么可以忽略。",
            heuristic: true,
            snippet: ctx.raw.slice(m.index, o + 1).replace(/\s+/g, " "),
          });
          return;
        }
        if (/\b(throw|console\.|set[A-Z]|push|emit|return|reject|rejects|mark|log)/.test(body)) return;
        if (body.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").trim() === "") {
          // 只有注释 —— 有说明，算可接受，但仍然列出来供人复核
          ctx.report({
            rule: "silent-catch", level: "low", line: lineOf(ctx.code, m.index),
            msg: "catch 只有一行注释（无任何补偿动作）",
            why: "有说明可接受；确认它真的「什么都不用做」。",
            fix: "无需改动时可忽略。",
            heuristic: true,
            snippet: ctx.raw.slice(m.index, c + 1).replace(/\s+/g, " ").slice(0, 90),
          });
        }
      });
    },
  },
];

// ────────────────────────────── 结构辅助 ──────────────────────────────
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function matchPair(s, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === openCh) depth++;
    else if (s[i] === closeCh) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function lineOf(s, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}

/** 取 idx 前后各 n 行作为"作用域兜底"（找不到所属函数时用） */
function lineWindow(s, idx, n) {
  const lines = s.split("\n");
  const at = lineOf(s, idx) - 1;
  return lines.slice(Math.max(0, at - n), at + n + 1).join("\n");
}

function forEachMatch(text, re, fn) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    fn(m);
    if (m[0].length === 0) re.lastIndex++;
  }
}

/** 把字符串 / 注释 / 正则字面量的内容抹成空格（保留换行与长度），结构分析就不会被字面量骗到 */
function maskCode(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let prev = "";
  const blank = (from, to) => { for (let k = from; k < to && k < n; k++) if (src[k] !== "\n" && src[k] !== "\r") out[k] = " "; };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { let j = i; while (j < n && src[j] !== "\n") j++; blank(i, j); i = j; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); const stop = e < 0 ? n : e + 2; blank(i, stop); i = stop; continue; }
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === q) break;
        if (q === "`" && src[j] === "$" && src[j + 1] === "{") {
          // 模板插值：内部是正常代码，递归抹掉其中的字面量，但保留其语法
          const o = j + 1;
          const cl = matchPair(src, o, "{", "}");
          if (cl < 0) { j = n; break; }
          const inner = maskCode(src.slice(o + 1, cl));
          for (let k = 0; k < inner.length; k++) out[o + 1 + k] = inner[k];
          j = cl + 1;
          continue;
        }
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      prev = q;
      continue;
    }
    if (c === "/" && /[(,=:[!&|?{};\n+\-*%~^<>]/.test(prev || "\n")) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      if (src[j] === "/") { blank(i + 1, j); i = j + 1; prev = "/"; continue; }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/** 找出「延迟落定」Promise 的 resolver 句柄名：executor 里出现 `X = <resolverParam>` 的那些 X */
function deferredResolvers(code) {
  const out = new Set();
  forEachMatch(code, /new\s+Promise\s*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\(/g, (m) => {
    const open = code.indexOf("(", m.index);
    const close = matchPair(code, open, "(", ")");
    if (close < 0) return;
    const raw = code.slice(open + 1, close);
    const am = raw.match(/^\s*(?:async\s*)?(?:\(\s*([^)]*?)\s*\)|([A-Za-z_$][\w$]*))\s*=>\s*/);
    const fm = raw.match(/^\s*(?:async\s+)?function\s*[\w$]*\s*\(\s*([^)]*?)\s*\)/);
    const paramsRaw = am ? (am[1] ?? am[2] ?? "") : fm ? (fm[1] ?? "") : "";
    const param = paramsRaw.split(",")[0].trim().replace(/[:=].*$/, "").replace(/^\.\.\./, "");
    if (!param) return;
    const asg = new RegExp("(?:^|[^.\\w$])([A-Za-z_$][\\w$]*)\\s*=\\s*" + esc(param) + "\\b").exec(raw);
    if (asg) out.add(asg[1]);
  });
  return out;
}

/**
 * 跨文件建立「谁是落定信号」的索引。
 *
 * 判据不是名字，而是**它最终会不会落定一个 Promise**：
 *   ① 本身就是 new Promise executor 赋出去的 resolver 句柄；或
 *   ② 它的函数体（递归有限层）会调用 ①。
 *
 * 为什么必须这样：`notify()` 这种名字在很多项目里是**观察者广播**（本仓库 core/cacheTasks.ts
 * 的 notify 就是 emit("jm:caches")），没人 await 它，漏不漏发都不会"卡住"。
 * 按名字认会把它当完成信号 —— 那是 3 条纯噪声。而 `announceStartupReady` 的函数体
 * 直接调 `resolveStartup()`（真 resolver），跨文件也能认出来。
 */
function buildSignalIndex(docs) {
  // 一律按 `文件:名字` 索引 —— 只按名字建全局 Map 会被重名函数串味：
  // `run` 这个名字在 useAlbumDetail / useHomeFeed / release.mjs / viewTransition.ts 里各有一个，
  // 而 viewTransition 那个确实会调 resolveApplied（真 resolver），
  // 于是**所有**叫 run 的函数都被判成落定信号（实测多出 6 条噪声）。
  const fnBodies = new Map();   // "file:name" -> body
  const nameFiles = new Map();  // name -> Set(file)，用于"全局唯一"才跨文件解析
  const resolvers = new Set();  // "file:name"
  for (const d of docs) {
    for (const r of deferredResolvers(d.code)) resolvers.add(d.rel + ":" + r);
    const grab = (m) => {
      const o = m.index + m[0].length - 1;
      const c = matchPair(d.code, o, "{", "}");
      if (c <= 0) return;
      fnBodies.set(d.rel + ":" + m[1], d.code.slice(o, c));
      const s = nameFiles.get(m[1]) || new Set();
      s.add(d.rel);
      nameFiles.set(m[1], s);
    };
    forEachMatch(d.code, /(?:^|[^.\w$])(?:export\s+)?(?:async\s+)?function\s+([\w$]+)\s*\([^)]*\)\s*(?::[^{]*)?\{/g, grab);
    forEachMatch(d.code, /(?:^|[^.\w$])(?:export\s+)?const\s+([\w$]+)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*\{/g, grab);
  }
  // 解析"这个名字在哪个文件里的定义"：优先同文件；否则要求全局唯一才认
  const locate = (name, fromFile) => {
    if (fnBodies.has(fromFile + ":" + name)) return fromFile + ":" + name;
    const s = nameFiles.get(name);
    if (s && s.size === 1) return [...s][0] + ":" + name;
    return null;
  };
  return function isSettleSignal(name, fromFile, depth = 0) {
    if (resolvers.has(fromFile + ":" + name)) return true;
    if (depth > 3) return false;
    const fnKey = locate(name, fromFile);
    if (!fnKey) return false;
    const body = fnBodies.get(fnKey);
    if (!body) return false;
    const ownerFile = fnKey.slice(0, fnKey.lastIndexOf(":"));
    let hit = false;
    forEachMatch(body, /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g, (m) => {
      if (hit || m[1] === name) return;
      if (isSettleSignal(m[1], ownerFile, depth + 1)) hit = true;
    });
    return hit;
  };
}

/** 找出函数体范围（function 声明 / 箭头函数），返回 {start,end} 或 null */
function findFunctions(code) {
  const out = [];
  const push = (start, end) => { if (end > start) out.push({ start, end }); };
  // 注意：TypeScript 允许写返回类型注解 —— `function f(a: T): Promise<R> {`
  // 少了 `(?::[^{]*)?` 这一段，整个带返回类型的函数都会识别不到（曾把 core/fetchTimeout.ts 误判成"裸 fetch"）。
  forEachMatch(code, /\bfunction\s*[\w$]*\s*\([^)]*\)\s*(?::[^{]*)?\{/g, (m) => {
    // 必须用**正则命中的那个 `{`**。用 indexOf("{", m.index) 会撞上默认参数里的对象字面量
    // （`init: RequestInit = {}`），把函数体识别成那 2 个字符 —— 曾因此误报 core/fetchTimeout.ts。
    const o = m.index + m[0].length - 1;
    const c = matchPair(code, o, "{", "}");
    if (c > 0) push(o, c);
  });
  forEachMatch(code, /=>\s*\{/g, (m) => {
    const o = m.index + m[0].length - 1;
    const c = matchPair(code, o, "{", "}");
    if (c > 0) push(o, c);
  });
  // 同一区域可能被父子函数都包含，按 start 排序、去掉被完全包含的外层重复不必；保留全部即可
  return out;
}

function enclosingFunction(code, idx) {
  let best = null;
  for (const fn of findFunctions(code)) {
    if (idx > fn.start && idx < fn.end) {
      if (!best || fn.end - fn.start < best.end - best.start) best = fn;
    }
  }
  return best;
}

function inFinally(code, fn, at) {
  const body = code.slice(fn.start, fn.end);
  const rel = at - fn.start;
  let hit = false;
  forEachMatch(body, /\bfinally\s*\{/g, (m) => {
    const o = body.indexOf("{", m.index);
    const c = matchPair(body, o, "{", "}");
    if (c > 0 && rel > o && rel < c) hit = true;
  });
  return hit;
}

// ────────────────────────────── 文件收集 ──────────────────────────────
function globToRe(glob) {
  const g = glob.replace(/\\/g, "/");
  let re = "^";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += esc(c);
  }
  return new RegExp(re + "$");
}

function walk(dir, out, opts) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = opts.cwd ? relative(opts.cwd, full).replace(/\\/g, "/") : full.replace(/\\/g, "/");
    if (e.isDirectory()) {
      if (opts.exclude.some((g) => g.test(rel) || g.test(rel + "/"))) continue;
      walk(full, out, opts);
    } else if (e.isFile()) {
      if (opts.ext.length && !opts.ext.includes(extname(e.name).replace(".", "").toLowerCase())) continue;
      if (opts.include.length && !opts.include.some((g) => g.test(rel))) continue;
      if (opts.exclude.some((g) => g.test(rel))) continue;
      out.push({ rel, full });
    }
  }
}

// ────────────────────────────── CLI ──────────────────────────────
function parseArgs(argv) {
  const o = {
    roots: [], ext: ["ts", "tsx", "js", "mjs", "cjs", "jsx"],
    include: [],
    exclude: ["**/*.test.*", "**/*.spec.*", "**/node_modules/**", "**/dist/**", "**/build/**"].map(globToRe),
    rules: null, minLevel: 1, format: "text", out: null, context: false, stats: false,
    baseline: null, writeBaseline: null, failOn: 0, listRules: false, quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--root": o.roots.push(next()); break;
      case "--ext": o.ext = next().split(",").map((s) => s.trim().replace(/^\./, "")).filter(Boolean); break;
      case "--include": o.include.push(globToRe(next())); break;
      case "--exclude": o.exclude.push(globToRe(next())); break;
      case "--rules": o.rules = new Set(next().split(",").map((s) => s.trim()).filter(Boolean)); break;
      case "--min-level": o.minLevel = normLevel(next(), 1); break;
      case "--format": o.format = next(); break;
      case "--out": o.out = next(); break;
      case "--context": o.context = true; break;
      case "--stats": o.stats = true; break;
      case "--baseline": o.baseline = next(); break;
      case "--write-baseline": o.writeBaseline = next(); break;
      case "--fail-on": o.failOn = normLevel(next(), 0); break;
      case "--list-rules": o.listRules = true; break;
      case "--quiet": o.quiet = true; break;
      case "--help": case "-h": o.help = true; break;
      default:
        if (a.startsWith("-")) { console.error(`未知参数: ${a}（--help 看用法）`); process.exit(2); }
        else o.roots.push(a);
    }
  }
  if (o.roots.length === 0) o.roots = ["src"];
  return o;
}

// ────────────────────────────── 主流程 ──────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (opts.help) {
    const head = readFileSync(new URL(import.meta.url), "utf8").split("*/")[0];
    console.log(head.replace(/^\/\*\*?/, "").replace(/^\s*\*=?/gm, ""));
    return;
  }
  if (opts.listRules) {
    for (const r of RULES) console.log(`${r.id.padEnd(24)} ${r.level.padEnd(9)} ${r.title}`);
    return;
  }

  const active = RULES.filter((r) => !opts.rules || opts.rules.has(r.id));
  if (active.length === 0) { console.error("--rules 里没有任何已知规则 id，用 --list-rules 查看"); process.exit(2); }

  const files = [];
  for (const root of opts.roots) {
    const abs = resolve(cwd, root);
    if (!existsSync(abs)) { console.error(`--root 不存在: ${root}`); process.exit(2); }
    const st = statSync(abs);
    if (st.isFile()) files.push({ rel: relative(cwd, abs).replace(/\\/g, "/"), full: abs });
    else walk(abs, files, { ...opts, cwd });
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  // 第一遍：读入 + 抹字面量，并建立「谁是落定信号」的跨文件索引
  const docs = [];
  for (const f of files) {
    let raw;
    try { raw = readFileSync(f.full, "utf8"); } catch { continue; }
    docs.push({ rel: f.rel, raw, code: maskCode(raw) });
  }
  const isSettleSignal = buildSignalIndex(docs);

  // 第二遍：跑规则
  const hits = [];
  const seen = new Set();
  for (const d of docs) {
    const rawLines = d.raw.split(/\r?\n/);
    const ctx = {
      file: d.rel, raw: d.raw, code: d.code, isSettleSignal,
      report(h) {
        const rec = {
          file: d.rel, rule: h.rule, level: h.level, line: h.line,
          msg: h.msg, why: h.why, fix: h.fix, heuristic: !!h.heuristic,
          snippet: (h.snippet || (rawLines[h.line - 1] || "").trim()).trim(),
        };
        // 去重：嵌套函数会让同一个调用点被外层函数再报一次
        const k = key(rec) + ":" + rec.msg;
        if (seen.has(k)) return;
        seen.add(k);
        hits.push(rec);
      },
    };
    for (const r of active) {
      try { r.run(ctx); } catch (err) {
        console.error(`规则 ${r.id} 在 ${d.rel} 上出错：${err && err.message}`);
      }
    }
  }

  // 过滤
  let shown = hits.filter((h) => LEVELS[h.level] >= opts.minLevel);
  if (opts.baseline && existsSync(opts.baseline)) {
    // 基线里存的就是 key 字符串（见 --write-baseline），直接当字符串比
    const base = new Set(JSON.parse(readFileSync(opts.baseline, "utf8")));
    shown = shown.filter((h) => !base.has(key(h)));
  }
  shown.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  if (opts.writeBaseline) {
    const dir = dirname(resolve(cwd, opts.writeBaseline));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(cwd, opts.writeBaseline), JSON.stringify(hits.map((h) => key(h)).sort(), null, 1));
    console.error(`基线已写入 ${opts.writeBaseline}（${hits.length} 条）`);
  }

  const out = format(shown, opts, hits, files);
  if (opts.out) {
    const abs = resolve(cwd, opts.out);
    const dir = dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(abs, out);
    console.error(`已写出 ${opts.out}`);
  } else {
    process.stdout.write(out);
  }

  const worst = shown.reduce((a, h) => Math.max(a, LEVELS[h.level]), 0);
  if (opts.failOn > 0 && worst >= opts.failOn) {
    console.error(`\n[fail-on] 最高级别 ${levelName(worst)} >= 阈值 ${levelName(opts.failOn)}，退出码 1`);
    process.exit(1);
  }
}

function key(h) { return `${h.file}:${h.line}:${h.rule}`; }
function levelName(v) { return Object.keys(LEVELS).find((k) => LEVELS[k] === v) || String(v); }

function format(items, opts, all, files) {
  const byRule = new Map();
  for (const h of all) byRule.set(h.rule, (byRule.get(h.rule) || 0) + 1);

  if (opts.format === "json") {
    return JSON.stringify({ scanned: files.length, findings: items, stats: Object.fromEntries(byRule) }, null, 1) + "\n";
  }
  const lines = [];
  const push = (s) => lines.push(s);

  if (opts.format === "md") {
    push(`# 静默失败 / 永不落定 扫描报告`);
    push("");
    push(`- 扫描文件：**${files.length}**`);
    push(`- 命中（过滤后）：**${items.length}**（全量 ${all.length}）`);
    push("");
    push(`| 级别 | 规则 | 位置 | 说明 |`);
    push(`|---|---|---|---|`);
    for (const h of items) {
      push(`| ${LEVEL_LABEL[h.level]} | \`${h.rule}\` | ${h.file}:${h.line} | ${h.msg.replace(/\|/g, "\\|")} |`);
    }
  } else {
    if (!opts.quiet) {
      push(`扫描 ${files.length} 个文件，命中 ${items.length} 条（全量 ${all.length} 条）`);
      push("");
    }
    let curFile = "";
    for (const h of items) {
      if (h.file !== curFile) { curFile = h.file; push(`── ${h.file}`); }
      const tag = LEVEL_LABEL[h.level].padEnd(3);
      push(`  ${tag} ${h.line}: [${h.rule}] ${h.msg}${h.heuristic ? "  〔启发式，需人工确认〕" : ""}`);
      if (opts.context) {
        push(`       代码: ${h.snippet}`);
        push(`       原因: ${h.why}`);
        push(`       建议: ${h.fix}`);
      }
    }
    push("");
    push("按规则统计（全量）：");
    for (const [id, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
      const r = RULES.find((x) => x.id === id);
      push(`  ${String(n).padStart(4)}  ${id.padEnd(24)} ${r ? r.title : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

main();
