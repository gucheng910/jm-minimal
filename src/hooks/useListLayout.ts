import { useEffect, useState } from "react";
import { on } from "../core/bus";
import { loadListLayout } from "../core/listLayout";
import type { ListLayoutConfig } from "../core/listLayout";

/**
 * 订阅列表页展示编排（卡片副标题字段 / 每行列数）。
 *
 * 只在 **AlbumGrid 一处**调用 —— 所有卡片网格都从那里出来，
 * 所以在网格上订阅一次、再把配置当 prop 传给每张卡片，
 * 比让每张卡片各自订阅（一屏几十个监听器）省得多。
 *
 * 与 `useDetailLayout` 是同一套模式：真值在 localStorage，事件只播"变了"。
 */
export function useListLayout(): ListLayoutConfig {
  const [cfg, setCfg] = useState<ListLayoutConfig>(() => loadListLayout());
  useEffect(() => on("jm:listLayout", () => setCfg(loadListLayout())), []);
  return cfg;
}
