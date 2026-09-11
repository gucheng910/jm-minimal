// 换源浮层（顶栏闪电）：图源 / 线路 / 一键测速并切换
// 极简约束：一个入口只做一件事——这里只管"换源"，线路与图源都在同一个浮层里选完即走；
// 测速复用启动时那套 client.autoSelectBest()，不新增探测逻辑。
import { useState } from "react";
import { useSheetTransition } from "../hooks/useSheetTransition";
import { CheckIcon } from "./icons";
import { zh } from "../core/zh";

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
  onPickShunt: (key: string) => void;
  onPickLine: (host: string) => void;
  /** 一键测速并应用最快线路/图源，resolve 一行结果文案 */
  onAutoTest: () => Promise<string>;
}

export default function SourceSheet({
  open, onClose, shunts, currentShunt, lines, currentHost, busy, onPickShunt, onPickLine, onAutoTest
}: Props) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState("");
  const { mounted, entering, closing } = useSheetTransition(open);

  if (!mounted) return null;

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
    <div className="drawer-backdrop" data-entering={entering ? "" : undefined} data-closed={closing ? "" : undefined} onClick={onClose}>
      <div className="source-drawer app-sheet" data-entering={entering ? "" : undefined} data-closed={closing ? "" : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>换源</h3>
          <button type="button" className="sheet-close" aria-label="关闭" onClick={onClose}>×</button>
        </div>

        <p className="sheet-sec">图源</p>
        <div className="sheet-list">
          {shunts.length === 0 && <p className="sheet-empty">配置尚未就绪，稍后重试</p>}
          {shunts.map((s) => {
            const on = String(s.key) === String(currentShunt);
            return (
              <button
                key={s.key}
                type="button"
                className={"opt-row" + (on ? " on" : "")}
                onClick={() => { onPickShunt(String(s.key)); onClose(); }}
              >
                <CheckIcon size={18} className="ck" />
                <span className="nm">{zh(s.title)}</span>
                <span className="mu">{on ? "当前" : ""}</span>
              </button>
            );
          })}
        </div>

        <p className="sheet-sec">线路</p>
        <div className="sheet-list">
          {lines.length === 0 && <p className="sheet-empty">线路表未就绪</p>}
          {lines.map(([host, name]) => {
            const on = host === currentHost;
            return (
              <button
                key={host}
                type="button"
                className={"opt-row" + (on ? " on" : "")}
                onClick={() => { onPickLine(host); onClose(); }}
              >
                <CheckIcon size={18} className="ck" />
                <span className="nm">{zh(name)}</span>
                <span className="mu">{on ? "当前" : host}</span>
              </button>
            );
          })}
        </div>

        <div className="row sheet-actions">
          <button type="button" disabled={busy || testing} onClick={() => { void runTest(); }}>
            {testing ? "测速中…" : "一键测速并切换"}
          </button>
        </div>
        {result && <p className="sheet-result">{result}</p>}
      </div>
    </div>
  );
}
