// 显示层简体化：官方线路表返回的是繁体名（線路1…線路5），界面统一显示简体。
// 只在渲染时转换，匹配/选择逻辑仍用原始字符串，避免改坏线路识别。
const MAP: Array<[RegExp, string]> = [
  [/線路/g, "线路"],
  [/線/g, "线"],
  [/圖源/g, "图源"],
  [/圖/g, "图"]
];

/** 把官方文案里的繁体词转成简体（当前只覆盖已知的线路/图源） */
export function zh(text: unknown): string {
  let out = String(text ?? "");
  for (const [re, to] of MAP) out = out.replace(re, to);
  return out;
}
