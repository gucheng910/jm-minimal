import { md5Hex } from "./crypto";

export function scrambleSliceCount(albumId: number | string, pageName: string): number {
  const idStr = String(albumId);
  const hash = md5Hex(idStr + pageName);
  let code = hash.charCodeAt(hash.length - 1);
  const num = parseInt(idStr, 10);
  // 与官方一致：专辑 ID 分段决定对 hash 取模 10 或 8
  if (num >= 268850 && num <= 421925) code %= 10;
  else if (num >= 421926) code %= 8;
  const counts: Record<number, number> = { 0: 2, 1: 4, 2: 6, 3: 8, 4: 10, 5: 12, 6: 14, 7: 16, 8: 18, 9: 20 };
  return counts[code] ?? 10;
}

// 复刻官方 wR：把服务端“横向切块图”按倒序拼回 canvas
export function drawUnscrambled(img: HTMLImageElement, albumId: number | string, scrambleId: number | string): HTMLCanvasElement | null {
  if (img.src.includes(".gif") || parseInt(String(albumId), 10) < parseInt(String(scrambleId), 10)) return null;
  const nameMatch = img.alt && img.alt.length > 0 ? img.alt : pageNameFromUrl(img.src);
  const parts = scrambleSliceCount(albumId, nameMatch);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.className = img.className;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const baseH = Math.floor(h / parts);
  const rem = h % parts;
  for (let c = 0; c < parts; c++) {
    let sh = baseH;
    const sy = h - baseH * (c + 1) - rem;
    let dy: number;
    if (c === 0) { sh += rem; dy = 0; } else { dy = baseH * c + rem; }
    ctx.drawImage(img, 0, sy, w, sh, 0, dy, w, sh);
  }
  return canvas;
}

function pageNameFromUrl(url: string): string {
  const clean = url.split("?")[0].split("/").pop() || "";
  return clean.replace(/\.(webp|jpg|jpeg|png|gif)$/i, "");
}
