import type { AlbumDetail, AlbumSummary } from "../core/types";

/**
 * 「自定义 UI」画布用的样例内容。
 *
 * 为什么要样例：编辑器要在**没有网络、没有具体某本书**的情况下也能显示一个真实的页面。
 * 这也是所有页面搭建器的通用做法（GrapesJS 的 Block Manager / Webstudio 的 Components panel
 * 落进画布的都是样例内容）—— 预览的是**版面**，不是某本书的数据。
 *
 * 形状必须与真实接口一致（`core/types.ts`），否则画布渲染出来的不是真的那个页面。
 * 样例刻意"字段都填上"：这样每个模块都能看到，不会因为"这本恰好没标签"而少一块。
 */

export const SAMPLE_DETAIL: AlbumDetail = {
  id: 900001,
  name: "示例作品：自定义 UI 预览",
  addtime: "2026-01-01",
  description:
    "这是简介的示例文本，用来预览「简介行数」这一档的效果。" +
    "它写得足够长，所以在「2 行」「3 行」「4 行」几档下都会被截断并出现「展开」；" +
    "选「全部」则一次显示完整。真实作品的简介长度千差万别，所以用一段偏长的来试最有代表性。",
  total_views: 123456,
  total_photos: 3,
  likes: 7890,
  author: ["作者甲", "作者乙"],
  tags: ["韩漫", "完结", "彩色", "剧情", "恋爱", "日常", "校园"],
  actors: ["登场人物甲", "登场人物乙"],
  series: [
    { id: 1, name: "第 1 话" },
    { id: 2, name: "第 2 话" },
    { id: 3, name: "第 3 话" }
  ],
  is_favorite: false,
  liked: false
};

/** 列表页画布的样例卡片：8 张，够看满 2~3 行 */
export const SAMPLE_LIST: AlbumSummary[] = Array.from({ length: 8 }, (_, i) => ({
  id: 900100 + i,
  name: "示例作品 " + (i + 1),
  author: "作者" + "甲乙丙丁戊己庚辛"[i],
  category: { title: ["韩漫", "日漫", "美漫", "国漫"][i % 4] },
  sub: i % 3 === 0 ? "读到 第" + (i + 1) + "话" : undefined
}));
