import { useEffect, useState } from "react";

export type ToastKind = "info" | "ok" | "err";

interface ToastItem { id: number; text: string; kind: ToastKind }

/** 全局轻提示：操作结果反馈（不打断内容流，自动消失） */
export function pushToast(text: string, kind: ToastKind = "info") {
  window.dispatchEvent(new CustomEvent("jm:toast", { detail: { text, kind } }));
}

export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const d = (ev as CustomEvent<{ text?: string; kind?: ToastKind }>).detail;
      const text = d && d.text;
      if (!text) return;
      const id = Date.now() + Math.random();
      const isErr = d && d.kind === "err";
      setItems((prev) => [...prev.slice(-2), { id, text, kind: (d && d.kind) || "info" }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, isErr ? 4200 : 2400);
    };
    window.addEventListener("jm:toast", handler);
    return () => window.removeEventListener("jm:toast", handler);
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={"toast " + t.kind}>{t.text}</div>
      ))}
    </div>
  );
}
