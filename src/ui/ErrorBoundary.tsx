// 渲染错误边界：把 React 渲染异常变成可见提示，避免整屏白屏无法定位
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode; label?: string; /** 顶层用法：错误卡片自带页面留白（App 级兜底） */ fullPage?: boolean }
interface State { error: Error | null; nonce: number }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, nonce: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // logcat 可见：adb logcat -s Capacitor/Console | findstr jmd
    console.error("[jmd] render error:", error && error.message, "|", (info && info.componentStack || "").slice(0, 400));
  }

  render() {
    const { error, nonce } = this.state;
    if (!error) return <div key={nonce}>{this.props.children}</div>;
    const card = (
      <div className="card err">
        <h3>页面渲染出错（{this.props.label || "内容"}）</h3>
        <p className="muted" style={{ wordBreak: "break-all" }}>{String(error.message || error)}</p>
        <div className="row">
          <button onClick={() => this.setState({ error: null, nonce: nonce + 1 })}>重试</button>
        </div>
      </div>
    );
    return this.props.fullPage ? <div className="err-page">{card}</div> : card;
  }
}
