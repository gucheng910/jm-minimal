/**
 * 详情页**动作区主按钮**的文案与行为（纯函数）。
 *
 * ── 为什么单独抽出来（v3.3）────────────────────────────────────────
 * 用户要求把「付费提示」和阅读按钮**合并成一个按钮**：
 * 「付费提示是直接隐形了，不如直接和阅读按钮共用一个按钮，需要付费的时候原阅读按钮那
 *   显示的就是付费嘛」。
 *
 * 合并之后，这一个按钮要承担三种状态（免费 / 需付费且已登录 / 需付费但未登录），
 * 而付费态**在样例数据里根本走不到**（样例作品 `locked=false`）—— 也就是说
 * "在画布上看一眼"永远验证不了它。所以文案与行为必须落在一个**可单测的纯函数**里：
 * 这是唯一能证明三种状态都对的办法，否则只能靠"读代码觉得对"。
 *
 * ── 与旧实现的关系（行为等价性）────────────────────────────────────
 * 旧的 `locked && logged` 分支本来就是"一个购买按钮"，文案与这里逐字一致
 * （`使用官方 JCoin 购买（N JCoin）`）。真正新增的是 `locked && !logged` 那一格：
 * 以前它是"一段提示文字 + 一个点了也没用的阅读按钮"，现在变成"一个登录后购买按钮"，
 * 提示文案（官方付费内容：请先登录…）挪进 `title`，信息不丢。
 */
export interface ActionButtonInput {
  /** 内容是否锁着（付费内容且未购买） */
  locked: boolean;
  /** 是否已登录（未登录时官方购买接口必然失败，所以按钮先讲"登录后购买"） */
  logged: boolean;
  /** 官方标价（JCoin）；<= 0 表示详情里没给价 */
  price: number;
  /** 足迹里读过**当前这一话** → 免费态的按钮说"继续阅读"而不是"立即阅读" */
  resumedThis: boolean;
}

export interface ActionButtonSpec {
  /** 这个按钮点下去走哪条路：翻页阅读，还是官方 JCoin 购买 */
  kind: "read" | "buy";
  /** 按钮上的字 */
  label: string;
  /** 长按 / 悬停提示。付费态把"为什么是购买按钮"讲清楚；免费态为空串（无提示也是对的） */
  title: string;
}

/** 官方付费内容的说明 —— 与旧「付费提示」区块的文案同源，现在挂在付费按钮的 title 上 */
export const PAID_NOTICE_TEXT = "官方付费内容：请先登录，再通过官方会员中心购买（本客户端不做绕过）";

export function actionButtonSpec({ locked, logged, price, resumedThis }: ActionButtonInput): ActionButtonSpec {
  if (!locked) {
    return {
      kind: "read",
      label: resumedThis ? "继续阅读" : "立即阅读",
      title: ""
    };
  }
  // 金额必须写在按钮上：官方花 JCoin 是真扣费，不标价等于让用户盲点
  const money = price > 0 ? "（" + String(price) + " JCoin）" : "";
  if (logged) {
    return {
      kind: "buy",
      label: "使用官方 JCoin 购买" + money,
      title: "立即用官方 JCoin 购买本话" + money
    };
  }
  return {
    kind: "buy",
    label: "登录后购买" + money,
    title: PAID_NOTICE_TEXT
  };
}
