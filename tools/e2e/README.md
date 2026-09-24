# tools/e2e —— 端到端回归测试台

无头 Edge + CDP 驱动真实页面，用**桩数据**覆盖导航栈、搜索层、阅读器、下拉刷新等交互路径。
它抓到过两个真 bug（推拉转场与异步数据的竞态、抽屉赞助区在 `/payment` 形状不全时整屏崩），
所以放进仓库长期维护。

## 跑

```bash
npm run e2e                      # 自己起 dev server（5199）→ 导航 + 登录态 + 缓存/离线 + 连载/足迹 + 下拉刷新
E2E_URL=http://127.0.0.1:5199/ npm run e2e    # 复用已在跑的 server
E2E_SKIP_PTR=1 npm run e2e       # 跳过下拉刷新
EDGE_PATH="C:/.../chrome.exe" npm run e2e     # 换浏览器（Edge / Chromium 均可）

npm run build:compat && npm run e2e:compat    # 兼容包（老内核）自检：见下
```

> **兼容包自检**（`npm run e2e:compat`）：把 `dist-compat` 复制到临时目录并**改造成"模拟老浏览器"页面**
> （删掉现代入口 `<script type="module" src=index-*.js>` 与设置 `__vite_is_modern_browser` 的探测脚本），
> 起静态服务器后用 harness 跑 `driver-legacy.js`，断言应用确实是由 **ES5 legacy 包 + SystemJS** 渲染出来的。
> 这是"compat 包真的能在老内核跑"的唯一可信验证方式（现代浏览器默认会走现代包，看不出差别）。

产物（gitignore）：`_archive/e2e/last-run.png` 截图、`_archive/e2e/profile-*/` 浏览器 profile。

## 组成

| 文件 | 作用 |
|---|---|
| `stub.js` | 注入页面的桩：线路表缓存、18+ 免确认、`window.fetch` 假接口（含请求记录 `window.__reqs`、错误记录 `window.__errs`） |
| `driver.js` | 页面内跑的回归脚本：首页 → 周榜 → 分类 → 搜索 tab → 详情 → 标签搜索 → 逐级返回 → 杀后台 → 阅读器 → 相关漫画/登场人物/协议漂移 |
| `driver-auth.js` | 登录态一致性：会员页 vs 详情页（`?e2eauth=1` 种过期会话） |
| `driver-cache.js` | 缓存中心/离线详情页：同书多话合并成一行、目录缓存徽标、未缓存话联网读、返回后目录仍在、已缓存话离线读（`?e2ecache=1` 预置 IDB + Cache API 数据）。**空 cache 必须判为「未缓存」**（stub 故意给第3话留了个空 cache，模拟历史版本 `caches.open` 副作用） |
| `driver-history.js` | 连载详情补全书级作者/简介、足迹按「书」合并成一条、点足迹回到最后阅读的一话 |
| `driver-reader.js` | 阅读器内弹窗：「更快的源」自动测速且弹窗不关闭、换话（标题/请求/按钮同步）、选话缓存（默认只选当前话 + 全选/反选 + 已缓存徽标 + 确认入队）；整本缓存后工具栏按钮变「已缓存」且 disabled |
| `driver-paid.js` | 付费漫画购买闭环：购买前显示应付 JCoin、点购买发 `POST /coin_buy_comics`、**购买成功后动作行刷新为正常详情页（`立即阅读` + `收藏`）**、返回列表重进依旧已解锁。桩 `aid=70001`：购买前 `purchased=false`、购买后 `purchased="0"`（官方语义里"已购"的形态，见 docs/32） |
| `driver-entry.js` | 进入详情页的转场：① 搜索层 → 详情时，搜索层与详情页必须在 VT 期间**瞬间到位**（否则 VT 的"新快照"抓到"搜索层仍盖着屏幕"的中间态 → 读者看不到详情推入，观感"不丝滑"）；② 在搜索层**连点两张卡片**后只按一次返回必须回到搜索层（否则等于多压了一层详情 → "点多了错乱"）；顺带记录 rAF 帧耗时会话值（>32ms 帧数） |
| `driver-rapid.js` | 手快/连点时转场不许硬跳：以 rAF 采样搜索层/详情页位置算**速度**（px/ms），>12px/ms 记为硬跳（缓动 `cubic-bezier(0.2,0.9,0.25,1)` 峰速约 6px/ms，实测冲淡到 7.4；真正的"动画被吞掉"是 16~22）。覆盖三种时序：进入详情后 80ms 就返回、打开搜索层后 80ms 就返回、搜索层连点两张卡片 + 连按两次返回。守的是 2026-09-24 那次"多次快速点击后偶现动效问题"：入场用 keyframes 时，动画被移除会瞬间回到底位（实测 `sr 85→420` 一帧内 = 16px/ms），改为 transition（可被打断、从当前位移续播）后消失 |
| `driver-legacy.js` | 兼容包自检：断言 `System` 已加载、`__vite_is_modern_browser` 未置位、React 已挂载、首页列表渲染出来 |
| `driver-srloop.js` | 搜索层列表稳定性：反复「点同一个漫画 → 返回」后，文档不许出现横向溢出（`scrollWidth ≤ clientWidth`）、视口宽度与卡片宽度不许漂移。守的是 2026-09-24 真机那个"卡片越来越大、每次跳一下"：返回时给详情页加 `translateX(+24%)` 会让非 fixed 元素向右伸出视口 → `scrollWidth` 变大 → 移动端视口被撑宽 → `inset:0` 的搜索层跟着变宽 → 卡片等比变大（自我放大） |
| `compat.mjs` | `npm run e2e:compat` 的编排：改造 dist-compat → 起静态服务器 → 跑 driver-legacy → 清理 |
| `harness.mjs` | CDP 外壳：起浏览器、注入桩、执行 driver、打印结构化日志；收尾按本次 profile 路径杀浏览器进程树（防残留） |
| `ptr.mjs` | 下拉刷新专项：用 CDP 原生触摸（合成 DOM TouchEvent 在无触摸环境下 React 不挂监听） |
| `run.mjs` | 编排：起 dev server → 跑全部用例 → 关 server |

桩数据开关（拼在 URL 上）：`?e2eauth=1` 过期会话、`?e2ecache=1` 预置「已缓存 2 话的连载书」、
`?e2epaid=1` 种已登录会话（付费购买用例需要登录才会出现购买入口）；
连载桩 `/album?id=90000{1,2,3}` 刻意复刻真实形状——**话级 payload 的 author/description 为空**，
用来验证书级补全逻辑。

## 加用例

改 `driver.js`，往 `log` 里 push 结构化结果即可；断言失败就 `throw`（harness 会打印 PAGE ERROR 并以非 0 退出）。
新接口在 `stub.js` 里补分支，**假数据的形状要和真实接口一致**——抽屉崩溃就是靠"形状不对"暴露出来的。

## 注意

- 不要用 `getProcess(msedge).kill()` 之类按镜像名杀浏览器（会误杀用户正在用的浏览器）；
  本测试台只用 `--user-data-dir` 指向自己的 profile，并且只 kill 自己 spawn 的进程。
- 本机访问 GitHub 资产域名可能被墙，与测试台无关；测试台只打本地 dev server。

---

## 深色模式颜色审计（2026-09-13 加）

```powershell
# 模拟系统深色 + 不预置主题（stub.js 默认会锁浅色，?e2edark= 用来跳过）
$env:DRIVER='driver-color-audit.js'; $env:E2E_DARK='1'; $env:TEST_URL='http://127.0.0.1:5199/?e2edark=1'
node tools/e2e/harness.mjs
```

它会把首页与详情页关键元素的**计算后颜色与真实对比度**打出来（逐级向上找不透明背景再算）。
之所以需要它：`[data-theme="dark"] button { color: … }` 这类规则的权重是 (0,1,1)，
会悄悄压过 `.link` / `.backtxt` / `.d-more` 这些 (0,1,0) 的类规则 ——
2026-09-13 就是它把详情页作者/标签的蓝字染成了 #1C1B1A（1.04:1，等于看不见），
而浅色模式完全看不出来（基类只有 (0,0,1)，输给类规则）。
结构约束现已由 `src/core/themeCss.test.ts` 守住：主题规则不许把裸标签当主体。
