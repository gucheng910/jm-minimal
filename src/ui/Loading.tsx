interface LoadingProps { text?: string; small?: boolean }
export default function Loading({ text = "加载中…", small = false }: LoadingProps) {
  return (
    <div className={small ? "loading-box small" : "loading-box"} role="status" aria-label="加载中">
      <span className="loading-spinner" />
      {!small && <span className="loading-text">{text}</span>}
    </div>
  );
}
