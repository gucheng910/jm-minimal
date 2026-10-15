// 换源浮层（顶栏闪电）：图源 / 线路 / 一键测速并切换
// 极简约束：一个入口只做一件事——这里只管"换源"，线路与图源都在同一个浮层里选完即走；
// 测速复用启动时那套 client.autoSelectBest()，不新增探测逻辑。
// 外壳走 ui/blocks 的 Sheet：切换中（pending）点遮罩不关，所以用 onBackdrop 而不是默认的 onClose。
import { useState } from "react";
import { CheckIcon } from "./icons";
import { zh } from "../core/zh";
import { SkeletonRows } from "./SkeletonRows";
import { Sheet } from "./blocks";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 官方 setting.app_shunts */
  shunts: Array<{ key: string; title: string }>;
  currentShunt: string;
  /** 官方线路表 jm3_Server：[[host, name], ...] */
  lines: Array<[string, string]>;
  currentHost: string;
  busy: boolean;
  /** 正在生效的那一项（图源 key 或线路 host）：该行显示转圈、整层不可操作 */
  pendingKey?: string | null;
  onPickShunt: (key: string) => void;
  onPickLine: (host: string) => void;
  /** 一键测速并应用最快线路/图源，resolve 一行结果文案 */
  onAutoTest: () => Promise<string>;
}

export default function SourceSheet({
  open, onClose, shunts, currentShunt, lines, currentHost, busy, pendingKey, onPickShunt, onPickLine, onAutoTest
}: Props) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState("");
  const pending = Boolean(pendingKey);

  async function runTest() {
    if (testing) return;
    setTesting(true);
    setResult("");
    try {
      setResult(await onAutoTest());
    } finally {
      setTesting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="换源"
      showClose
      closeDisabled={pending}
      /* 切换生效中点了遮罩也不关：否则用户看不到"正在切换"的反馈 */
      onBackdrop={() => { if (!pending) onClose(); }}
      panelClassName="app-sheet"
    >
      <p className="sheet-sec">图源</p>
      <div className="sheet-list">
        {shunts.length === 0 && (busy ? <SkeletonRows count={4} /> : <p className="sheet-empty">配置尚未就绪，稍后重试</p>)}
        {shunts.map((s) => {
          const on = String(s.key) === String(currentShunt);
          return (
            <button
              key={s.key}
              type="button"
              className={"opt-row" + (on ? " on" : "")}
              disabled={pending}
              aria-busy={pendingKey === String(s.key) ? "true" : undefined}
              onClick={() => onPickShunt(String(s.key))}
            >
              {pendingKey === String(s.key)
                ? <span className="row-spin" aria-hidden="true" />
                : <CheckIcon size={18} className="ck" />}
              <span className="nm">{zh(s.title)}</span>
              <span className="mu">{pendingKey === String(s.key) ? "切换中…" : on ? "当前" : ""}</span>
            </button>
          );
        })}
      </div>

      <p className="sheet-sec">线路</p>
      <div className="sheet-list">
        {lines.length === 0 && (busy ? <SkeletonRows count={3} /> : <p className="sheet-empty">线路表未就绪</p>)}
        {lines.map(([host, name]) => {
          const on = host === currentHost;
          return (
            <button
              key={host}
              type="button"
              className={"opt-row" + (on ? " on" : "")}
              disabled={pending}
              aria-busy={pendingKey === host ? "true" : undefined}
              onClick={() => onPickLine(host)}
            >
              {pendingKey === host
                ? <span className="row-spin" aria-hidden="true" />
                : <CheckIcon size={18} className="ck" />}
              <span className="nm">{zh(name)}</span>
              <span className="mu">{pendingKey === host ? "切换中…" : on ? "当前" : host}</span>
            </button>
          );
        })}
      </div>

      <div className="row sheet-actions">
        <button type="button" disabled={busy || testing || pending} onClick={() => { void runTest(); }}>
          {testing ? "测速中…" : "一键测速并切换"}
        </button>
      </div>
      {result && <p className="sheet-result">{result}</p>}
    </Sheet>
  );
}
