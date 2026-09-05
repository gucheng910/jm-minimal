interface LoadingProps { text?: string; small?: boolean }
export default function Loading({ text = "加载中…", small = false }: LoadingProps) {
  return (
    <div className={small ? "loading-box small" : "loading-box"}>
      <img src="/loading.svg" alt="loading" className="loading-img" />
      {!small && <span>{text}</span>}
    </div>
  );
}
