# tools/e2e —— 端到端回归测试台

无头 Edge + CDP 驱动真实页面，用**桩数据**覆盖导航栈、搜索层、阅读器、下拉刷新等交互路径。
它抓到过两个真 bug（推拉转场与异步数据的竞态、抽屉赞助区在 `/payment` 形状不全时整屏崩），
所以放进仓库长期维护。

## 跑

```bash
npm run e2e                      # 自己起 dev server（5199）→ 导航回归 + 下拉刷新
E2E_URL=http://127.0.0.1:5199/ npm run e2e    # 复用已在跑的 server
E2E_SKIP_PTR=1 npm run e2e       # 只跑导航回归
EDGE_PATH="C:/.../chrome.exe" npm run e2e     # 换浏览器（Edge / Chromium 均可）
```

产物（gitignore）：`_archive/e2e/last-run.png` 截图、`_archive/e2e/profile-*/` 浏览器 profile。

## 组成

| 文件 | 作用 |
|---|---|
| `stub.js` | 注入页面的桩：线路表缓存、18+ 免确认、`window.fetch` 假接口（含请求记录 `window.__reqs`、错误记录 `window.__errs`） |
| `driver.js` | 页面内跑的回归脚本：首页 → 周榜 → 分类 → 搜索 tab → 详情 → 标签搜索 → 逐级返回 → 杀后台 → 阅读器 → 相关漫画/登场人物/协议漂移 |
| `harness.mjs` | CDP 外壳：起浏览器、注入桩、执行 driver、打印结构化日志 |
| `ptr.mjs` | 下拉刷新专项：用 CDP 原生触摸（合成 DOM TouchEvent 在无触摸环境下 React 不挂监听） |
| `run.mjs` | 编排：起 dev server → 跑两项 → 关 server |

## 加用例

改 `driver.js`，往 `log` 里 push 结构化结果即可；断言失败就 `throw`（harness 会打印 PAGE ERROR 并以非 0 退出）。
新接口在 `stub.js` 里补分支，**假数据的形状要和真实接口一致**——抽屉崩溃就是靠"形状不对"暴露出来的。

## 注意

- 不要用 `getProcess(msedge).kill()` 之类按镜像名杀浏览器（会误杀用户正在用的浏览器）；
  本测试台只用 `--user-data-dir` 指向自己的 profile，并且只 kill 自己 spawn 的进程。
- 本机访问 GitHub 资产域名可能被墙，与测试台无关；测试台只打本地 dev server。
