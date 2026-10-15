// 应用内事件总线：把散落在各处的 window.dispatchEvent(new CustomEvent("jm:xxx")) 收敛成一份类型化契约。
// 动机：事件名是裸字符串、detail 形状无约束，改名/改形状没有任何编译期保护（拆分 ContentView 时最容易踩）。
// 约定：
//   - 只收「渲染层内部的跨组件通知」；Capacitor 原生事件与 Electron IPC 通道不在这里。
//   - jm:back 的 detail 是可变对象、同步派发、按注册顺序处理，emit 必须原样传递同一对象引用。

export type ToastKind = "info" | "ok" | "err" | "action";

export interface AppEvents {
  /** 返回键（Android 原生 backButton / 页面内返回按钮）：消费方把 consumed 置 true */
  "jm:back": { consumed: boolean };
  /** 底部导航切换 / 跳页（latest、ranking、categories、search…） */
  "jm:nav": string;
  /** 子页面请求跳到某个列表（最新 / 排行） */
  "jm:goto": string;
  /** 从收藏 / 足迹点开某部漫画（由 home tab 的 ContentView 接收） */
  "jm:openAid": string;
  /** 沉浸模式开关（阅读器 / 离线阅读时隐藏顶栏底栏） */
  "jm:immersive": boolean;
  /** 「去条纹」开关变化（真值在 core/scramble 的模块状态里，阅读器订阅它同步按钮态） */
  "jm:deseam": boolean;
  /** 全局轻提示 */
  "jm:toast": { text?: string; kind?: ToastKind; action?: string };
  /** 离线缓存任务进度变化 */
  "jm:caches": { progress: boolean };
  /** setting / 图床配置就绪（封面等依赖 img_host 的渲染据此刷新） */
  "jm:setting": undefined;
  /** 线路切换完成（外壳同步当前线路显示） */
  "jm:lineChanged": undefined;
  /** JCoin 余额变化（购买成功后） */
  "jm:coinChanged": undefined;
  /** 底部导航再次点击「首页」：从详情/阅读退回列表并刷新推荐 */
  "jm:refreshHome": undefined;
  /** 请求跳到设置页的 DNS 配置卡 */
  "jm:gotoDns": undefined;
  /** 登录态变化（登录/登出/自动续期）——各页面据此同步登录相关 UI */
  "jm:authChanged": undefined;
  /** 请求打开换源浮层（设置页「诊断与线路」复用顶栏那一个浮层） */
  "jm:openSource": undefined;
  /**
   * 从收藏/足迹点开的详情页**真正打开了**。
   * 订阅方（App）据此把收藏/足迹浮层藏起来——必须等这一步，不能在点击瞬间就藏，
   * 否则详情还没渲染出来，中间会露出一下主页（真机反馈过这类"跳过一下"）。
   */
  "jm:detailOpened": undefined;
  /**
   * 从详情页退回到列表/主页（在读者里来回切不算）。
   * 订阅方据此把先前藏起来的收藏/足迹浮层重新揭开，列表内容与滚动位置都还在。
   */
  "jm:detailClosed": undefined;
  /**
   * 详情页展示编排被改动（显隐 / 顺序）。
   * 真值在 localStorage（core/detailLayout.ts），这里只播"变了"——
   * 详情页收到后重读配置重渲染，与 jm:deseam / jm:theme 同一套做法。
   */
  "jm:detailLayout": undefined;
  /**
   * 详情页**版面样式**被改动（封面大小 / 标题字号 / 简介行数 / 疏密 / 圆角）。
   * 与 jm:detailLayout 同一套做法：真值在 localStorage（core/detailStyle.ts），这里只播"变了"。
   * 订阅方是详情页（AlbumDetail）——它据此把 data-dl-* 挂到 .detail-card 上。
   */
  "jm:detailStyle": undefined;
  /**
   * 列表页展示编排被改动（卡片副标题字段 / 每行列数）。
   * 与 jm:detailLayout 同一套做法：真值在 localStorage（core/listLayout.ts），这里只播"变了"。
   * 订阅方是列表网格（AlbumGrid）与卡片（AlbumCard）。
   */
  "jm:listLayout": undefined;
  /**
   * 顶栏 / 底栏 / 阅读器控制条的单元编排被改动。
   * 与 jm:detailLayout 同一套做法：真值在 localStorage（core/chromeLayout.ts），这里只播"变了"。
   * 订阅方是 App（两个栏）与 Reader（控制条）。
   */
  "jm:chromeLayout": undefined;
  /**
   * 阅读器**观感**被改动（滚动条档位 / 控制条自动隐藏时长）。
   * 与 jm:detailStyle 同一套做法：真值在 localStorage（core/readerStyle.ts），这里只播"变了"。
   * 订阅方是阅读器（Reader）——它据此把 `data-jm-rsb` 挂到 <html> 上并调整自动隐藏时长。
   */
  "jm:readerStyle": undefined;
  /**
   * 更新流程状态变化（v3.16）。detail 不带载荷 —— 与其它层同一条纪律：
   * **真值在 `core/updateFlow` 的模块状态里**，订阅方收到事件后自己去读快照。
   * 订阅方是更新弹窗（ui/UpdateDialog）与设置页里的手动更新按钮（ui/UpdateSection）。
   */
  "jm:update": undefined;
  /**
   * 手动打开「更新日志」（v3.16）。
   * 为什么要它：日志默认只在**升级后第一次进首页**自动弹 —— 全新安装不弹（见 `appVersion.ts`），
   * 那就必须有一个常驻入口，否则用户永远看不到自己这一版改了什么。
   * 入口是侧边栏底部那行版本号（它本来就写着 `v2.2.7`，点它看日志是最自然的去处）。
   */
  "jm:showChangelog": undefined;
}

type EmitArgs<K extends keyof AppEvents> = AppEvents[K] extends undefined ? [] : [detail: AppEvents[K]];

/** 派发事件（detail 为 undefined 的事件可以不传第二个参数） */
export function emit<K extends keyof AppEvents>(type: K, ...args: EmitArgs<K>): void {
  if (typeof window === "undefined") return;
  const detail = (args.length > 0 ? args[0] : undefined) as AppEvents[K];
  window.dispatchEvent(new CustomEvent(type as string, { detail }));
}

/** 订阅事件；返回取消订阅函数（可直接 return 给 useEffect 做清理） */
export function on<K extends keyof AppEvents>(type: K, handler: (detail: AppEvents[K]) => void): () => void {
  if (typeof window === "undefined") return () => { /* noop */ };
  const listener = (ev: Event) => handler((ev as CustomEvent<AppEvents[K]>).detail);
  window.addEventListener(type as string, listener);
  return () => window.removeEventListener(type as string, listener);
}
