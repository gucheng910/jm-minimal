// 展示用格式化：详情页数据条（浏览/喜欢）与日期（收录）
// 纯函数、无 DOM 依赖 —— 详情页（pages/AlbumDetail）与以后任何列表页共用。

/** 计数显示：12345 → "1.2 万"；0 / 缺失 / 非法 → 空串（调用方直接不显示这一段） */
export function fmtCount(v: number | string | undefined | null): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, "") + " 亿";
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + " 万";
  return n.toLocaleString("zh-CN");
}

/**
 * 日期显示：统一到 YYYY-MM-DD。
 * 官方字段可能是时间戳（秒或毫秒）也可能是 "2024-05-11 12:00" 这类字符串；
 * 认不出的原样返回，绝不显示 Invalid Date。
 */
export function fmtDate(v: number | string | undefined | null): string {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return s;
  const d = new Date(n > 1e12 ? n : n * 1000);
  if (Number.isNaN(d.getTime())) return s;
  const pad = (x: number) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
