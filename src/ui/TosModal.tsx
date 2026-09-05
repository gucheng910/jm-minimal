import { useEffect, useState } from "react";
import { TOS_PARAGRAPHS } from "../core/tos";
import { openExternal } from "../core/openExternal";

export default function TosModal({
  open,
  requireWait,
  onAccept
}: {
  open: boolean;
  requireWait: boolean;
  onAccept: () => void;
}) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!open) return;
    if (!requireWait) { setLeft(0); return; }
    setLeft(5);
    const iv = window.setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
    return () => window.clearInterval(iv);
  }, [open, requireWait]);
  if (!open) return null;
  const ready = !requireWait || left === 0;
  return (
    <div className="tos-backdrop">
      <div className="tos-card">
        <h2>使用须知</h2>
        <div className="tos-scroll">
          {TOS_PARAGRAPHS.map((p, i) => (
            <p key={i}>
              {p.split(/(https?:\/\/[^\s，。；！？（）()、：:，。“”]+)/g).map((part, j) => {
                if (/^https?:\/\//.test(part)) {
                  return (
                    <a key={j} className="tos-link" href={part}
                      onClick={(e) => { e.preventDefault(); openExternal(part); }}>
                      {part}
                    </a>
                  );
                }
                return part;
              })}
            </p>
          ))}
        </div>
        <button className="tos-accept" disabled={!ready} onClick={onAccept}>
          {ready ? "我已知悉以上内容" : "我已知悉以上内容（" + left + "s）"}
        </button>
      </div>
    </div>
  );
}
