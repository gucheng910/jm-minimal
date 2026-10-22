import { LOCAL_VERSION } from "./constants";

/**
 * 内置更新日志（v3.16）。
 *
 * ── 为什么**内置**而不是运行时拉 GitHub Release 正文（用户拍板：内置）────
 * 这个日志的用途是"升级到新版本后第一次进入首页弹出来给你看" —— 那个时刻
 * **最可能没有网**（刚装完包、国内直连 GitHub 不通是常态），拉正文等于"该弹的时候弹不出来"。
 * 内置还顺带解决两件事：文案可控（Release 正文里常混着构建说明、hash、文件名），
 * 以及**发布时能被脚本强制校验**（见 `tools/release.mjs` 的 CHANGELOG 断言 ——
 * 没有当前版本的条目就直接拒绝出包，日志因此不可能烂掉）。
 *
 * ── 维护约定 ────────────────────────────────────────────────────────
 *   · 数组**从新到旧**；`version` 必须与 `LOCAL_VERSION` 逐字相等（带 `v` 不行）；
 *   · 每条 `items` 写给**用户**看，不写内部术语（不写"轴冲突""负对照"这类词），
 *     形式统一为"哪儿 + 能做什么"；
 *   · 只保留最近若干个版本（更老的删掉即可，界面不会因此缺东西 ——
 *     `changelogFor()` 找不到条目就返回空数组，弹窗直接不出现）。
 */
export interface ChangelogEntry {
  /** 版本号，必须与 LOCAL_VERSION 相同 */
  version: string;
  /** 展示用日期（YYYY-MM-DD） */
  date: string;
  /** 这一版的一句话主题（弹窗标题下面那行） */
  title: string;
  /** 更新条目（每条一行，界面按原样换行展示） */
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "2.3.2",
    date: "2026-10-22",
    title: "修复部分网络环境下登录失败",
    items: [
      "无"
    ]
  },
  {
    version: "2.3.1",
    date: "2026-10-22",
    title: "更顺一点：界面微调 + 加载更快",
    items: [
      "略微优化了界面",
      "优化了加载速度"
    ]
  },
  {
    version: "2.3.0",
    date: "2026-10-15",
    title: "自定义 UI 上线：各个页面都能自己调",
    items: [
      "新增自定义 UI：列表页 / 详情页 / 顶栏和底栏 / 阅读器都能自己调",
      "自定义入口放到了设置页最上方",
      "优化了部分界面观感",
      "优化了加载速度"
    ]
  }
];

/** 某个版本的更新日志（没有条目 → 空数组，调用方据此不弹） */
export function changelogFor(version: string, list: ChangelogEntry[] = CHANGELOG): ChangelogEntry | null {
  const v = String(version || "").trim();
  if (!v) return null;
  return list.find((e) => e.version === v) || null;
}

/** 当前版本的更新日志（弹窗用的就是它） */
export function currentChangelog(version = LOCAL_VERSION): ChangelogEntry | null {
  return changelogFor(version);
}

/**
 * 把条目拼成弹窗正文（一行一条，前面加 `·`）。
 * 单独抽出来是为了**单测能钉住格式**：`items` 为空时返回空串，
 * 弹窗那边据此不渲染空白内容块（"面板上看得见的 == 读出来生效的"）。
 */
export function changelogText(entry: ChangelogEntry | null): string {
  if (!entry || entry.items.length === 0) return "";
  return entry.items.map((s) => "· " + s).join("\n");
}
