import { Sheet } from "../blocks";

/**
 * 阅读器「更快的源」弹层。
 *
 * 从 Reader.tsx 里搬出来的（原来内联在 1294-1328）。搬的时候**没有改任何语义**：
 * 顶部文案、行内三段拼接（host / ms / 不可用）、切换中转圈、测速/切换期间整层禁用，全部按原样保留。
 * 所有状态仍由 Reader 持有，这里只接"已经算好的值"，因此它是个纯展示组件。
 */

/** 一行图源：host / 耗时 / 可用性都可缺省（测速未回来时就是缺省状态） */
export interface ReaderSourceRow {
  key: string;
  title: string;
  host?: string;
  ms?: number;
  ok?: boolean;
}

export interface ReaderSourceSheetProps {
  open: boolean;
  onClose: () => void;
  /** 正在测速：顶部文案变「正在测速…」，每行的耗时位置显示「测速中…」 */
  testing: boolean;
  rows: ReaderSourceRow[];
  /** 当前生效的图源 key（对应行显示「（当前）」+ ✓） */
  currentKey: string;
  /** 正在切换的那一项的 key；非空时整层不可操作、该行显示转圈 */
  busyKey: string | null;
  onChangeSource: (key: string) => void;
  onRetest: () => void;
}

export function ReaderSourceSheet({
  open, onClose, testing, rows, currentKey, busyKey, onChangeSource, onRetest
}: ReaderSourceSheetProps) {
  const busy = Boolean(busyKey);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="更快的源"
      showClose
      backdropClassName="reader-sheet-backdrop"
      panelClassName="reader-sheet"
    >
      <p className="muted">{testing ? "正在测速…" : "已自动选择最快图源"}</p>
      <div className="list sheet-list">
        {rows.map((s) => {
          const active = currentKey === s.key;
          return (
            <button
              key={s.key}
              className={"sheet-row" + (active ? " active" : "")}
              disabled={busy}
              aria-busy={busyKey === s.key ? "true" : undefined}
              onClick={() => onChangeSource(s.key)}
            >
              <div>
                <div className="title">{s.title}{active ? "（当前）" : ""}</div>
                <div className="muted">{busyKey === s.key ? "正在切换…" : [s.host, s.ms != null ? s.ms + " ms" : (testing ? "测速中…" : ""), s.ok === false && !testing ? "不可用" : ""].filter(Boolean).join(" · ")}</div>
              </div>
              {busyKey === s.key
                ? <span className="row-spin" aria-hidden="true" />
                : <span className={"badge" + (active ? " ok" : "")}>{active ? "✓" : ""}</span>}
            </button>
          );
        })}
      </div>
      <div className="row sheet-actions">
        {/* 包一层箭头函数：直接把回调交给 onClick 会把点击事件当成第一个实参传进去，
            而 onRetest 在调用方是 runSpeedTest(gen, opts) —— gen 会被污染成事件对象 */}
        <button disabled={testing || busy} onClick={() => onRetest()}>{testing ? "测速中…" : "重新测速"}</button>
      </div>
    </Sheet>
  );
}
