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
  /** 「去条纹」开关变化（当前没有监听者，保留契约） */
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
  /** 请求跳到会员页的 DNS 配置卡 */
  "jm:gotoDns": undefined;
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
