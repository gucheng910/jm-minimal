// 返回键统一注册：监听 jm:back 并按层级消费（返回 false 表示不消费）
import { useEffect } from "react";

export function useBackHandler(handler: () => void | false, deps: unknown[]) {
  useEffect(() => {
    const onBack = (ev: Event) => {
      const d = (ev as CustomEvent<{ consumed: boolean }>).detail;
      if (!d || d.consumed) return;
      const result = handler();
      if (result !== false) d.consumed = true;
    };
    window.addEventListener("jm:back", onBack);
    return () => window.removeEventListener("jm:back", onBack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
