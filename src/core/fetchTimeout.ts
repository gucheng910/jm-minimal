/**
 * 带超时的 fetch。
 *
 * 优先用 AbortController（能真正取消请求）；老内核没有这个 API（WebView / Chromium < 66，
 * 例如小米 4W 的 Android 6 + WebView 57）时退化成 Promise.race——请求不会被取消，但流程不会卡死。
 *
 * 为什么必须兜底（2026-09-11 实测）：没有它时老设备整机起不来，
 * 界面上只留一句「无法取得线路表: ReferenceError: AbortController is not defined」。
 * 注意：AbortController 属于 Web API，@vitejs/plugin-legacy 的 core-js polyfill 不覆盖它。
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<Response> {
  if (typeof AbortController !== "undefined") {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetch(input, init),
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout " + timeoutMs + "ms")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
