// 返回键统一注册：订阅 jm:back 并按层级消费（返回 false 表示不消费）
import { useEffect } from "react";
import { on } from "../core/bus";

export function useBackHandler(handler: () => void | false, deps: unknown[]) {
  useEffect(() => {
    // 注意：detail 是同一个可变对象、同步派发，注册顺序决定谁先处理
    return on("jm:back", (d) => {
      if (!d || d.consumed) return;
      const result = handler();
      if (result !== false) d.consumed = true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
