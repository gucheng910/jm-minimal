import { useEffect, useState } from "react";
import { emit, on } from "../core/bus";
import type { ToastKind } from "../core/bus";

export type { ToastKind };

interface ToastItem { id: number; text: string; kind: ToastKind; action?: string }

interface ToastDetail { text?: string; kind?: ToastKind; action?: string }

/** 全局轻提示：操作结果反馈（不打断内容流，自动消失）；action 时点击可执行跳转 */
export function pushToast(text: string, kind: ToastKind = "info", action?: string) {
  emit("jm:toast", { text, kind, action });
}

export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const handler = (d: ToastDetail) => {
      const text = d && d.text;
      if (!text) return;
      const id = Date.now() + Math.random();
      const isErr = d && d.kind === "err";
      setItems((prev) => [...prev.slice(-2), { id, text, kind: (d && d.kind) || "info", action: d && d.action }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, isErr ? 4200 : 2400);
    };
    return on("jm:toast", handler);
  }, []);

  function onClick(t: ToastItem) {
    if (t.action === "goto-dns") {
      // 通知 App 跳转到会员页 DNS 卡（App 监听）
      emit("jm:gotoDns");
    }
  }

  if (items.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <button key={t.id}
          className={"toast " + t.kind + (t.action ? " toast-action" : "")}
          onClick={() => onClick(t)}>
          {t.text}{t.action ? " ›" : ""}
        </button>
      ))}
    </div>
  );
}
