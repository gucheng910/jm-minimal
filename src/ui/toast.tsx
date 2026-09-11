import { useEffect, useRef, useState } from "react";
import { emit, on } from "../core/bus";
import type { ToastKind } from "../core/bus";

export type { ToastKind };

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
  action?: string;
  /** 入场起始态（双 rAF 后转 false，触发过渡）；用状态位而不是 @starting-style，老内核也能有入场 */
  entering?: boolean;
  /** 正在出场：仍在 DOM 里，播完 180ms 过渡才移除 */
  leaving?: boolean;
}

interface ToastDetail { text?: string; kind?: ToastKind; action?: string }

/** 全局轻提示：操作结果反馈（不打断内容流，自动消失）；action 时点击可执行跳转 */
export function pushToast(text: string, kind: ToastKind = "info", action?: string) {
  emit("jm:toast", { text, kind, action });
}

/** 出场过渡时长，必须与 index.css 里 .toast[data-leaving] 的 transition-duration 一致 */
const EXIT_MS = 180;

export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);

  useEffect(() => {
    const handler = (d: ToastDetail) => {
      const text = d && d.text;
      if (!text) return;
      const id = Date.now() + Math.random();
      const isErr = d && d.kind === "err";
      const life = isErr ? 4200 : 2400;
      setItems((prev) => [...prev.slice(-2), { id, text, kind: (d && d.kind) || "info", action: d && d.action, entering: true }]);
      // 双 rAF：先让浏览器画出起始态，再去掉标记触发入场过渡
      // （单 rAF 时挂载与改类同帧，过渡不触发；同 SearchResultPage / useSheetTransition）
      requestAnimationFrame(() => requestAnimationFrame(() => {
        setItems((prev) => prev.map((t) => (t.id === id ? { ...t, entering: false } : t)));
      }));
      // 两段式移除：先标记出场，播完再真正删除（原来是直接 filter，出场硬切）
      timers.current.push(window.setTimeout(() => {
        setItems((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      }, life));
      timers.current.push(window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, life + EXIT_MS));
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
          data-entering={t.entering ? "" : undefined}
          data-leaving={t.leaving ? "" : undefined}
          onClick={() => onClick(t)}>
          {t.text}{t.action ? " ›" : ""}
        </button>
      ))}
    </div>
  );
}
