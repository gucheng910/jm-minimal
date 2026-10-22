/**
 * 封面图「取字节（带持久缓存）+ 解码 + 降采样」的 Worker 入口。
 *
 * 为什么要它：列表卡片的封面是 `<img>` 直接解码的 —— 一张 600×800 的 3:4 封面，
 * 在列表里只占 56×72（网格里 183×244 上下），**解码出来 48 万像素只用了 4 千个**。
 * 十几个卡片的解码全压在主线程上，就是首页/搜索结果首屏"图一张张蹦出来时滚不动"的原因。
 * 这里把三件事搬出主线程：`fetch` 字节 → `createImageBitmap(blob, { resizeWidth })` 边解码边缩放
 * → 直接把缩小后的 ImageBitmap 转移回主线程。
 *
 * **持久缓存**（core/coverCache）：首屏下载过的封面字节落在 IndexedDB 里，
 * 下次进列表（甚至下次启动）直接读盘 + 解码，**0 次网络请求** —— 这是"封面秒出"的关键；
 * 缓存读写都发生在这个 Worker 里，主线程不碰字节。缓存键就是完整 URL（封面地址带 `?t=<update_at>`，
 * 参数一变 URL 就变，天然失效）。
 *
 * 协议：
 *   主线程 → Worker：{ id, url, width, height, warm? }
 *     · `width` / `height` 是**目标显示盒**（CSS px × dpr，已由主线程算好并封顶）；
 *     · 只给宽度就按比例缩放（保真长宽比），`height` 仅用于日志/兜底；
 *     · `warm: true` = 只把字节取回来落盘（滚动预取用），**不解码、不回传位图**。
 *   Worker → 主线程：{ id, ok, bitmap?, w?, h?, cached?, error? }
 *     · `cached: true` 表示这一张来自本地缓存（0 网络）。
 *
 * ⚠️ 只有 **CORS 可用**的图床才走这条路（`fetch` 需要 ACAO；`<img>` 不需要）。
 * 调用方拿到 `ok:false` 就把该图床拉黑并退回 `<img>`，见 core/imageOffload.ts。
 */
import { coverGet, coverPut } from "./coverCache";

export interface CoverJob {
  id: number;
  url: string;
  /** 目标宽度（设备像素） */
  width: number;
  /** 目标高度（设备像素，仅兜底：宽度已经决定了缩放比） */
  height: number;
  /** 只预热（取字节落盘），不返回位图 */
  warm?: boolean;
}

export interface CoverReply {
  id: number;
  ok: boolean;
  bitmap?: ImageBitmap;
  /** 解码后的实际尺寸（主线程算 cover 裁切用；也可以直接用 bitmap.width/height） */
  w?: number;
  h?: number;
  /** 是否命中了本地缓存（诊断/测试用：证明这次没走网络） */
  cached?: boolean;
  error?: string;
}

/** 不引 WebWorker 的 lib（会和 DOM lib 的全局声明打架），只声明用到的那两个成员 */
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<CoverJob>) => void) | null;
  postMessage: (msg: CoverReply, transfer?: Transferable[]) => void;
};

/** 单张封面允许解出来的最大边（防止传进来一个离谱的目标尺寸把内存吃穿） */
const MAX_SIDE = 1600;

function targetWidth(w: number): number {
  return Math.max(1, Math.min(MAX_SIDE, Math.round(w || 1)));
}

/** 取字节：先本地缓存，miss 再网络（网络命中后落盘） */
async function bytesOf(url: string): Promise<{ blob: Blob; cached: boolean }> {
  const hit = await coverGet(url);
  if (hit && hit.size > 0) return { blob: hit, cached: true };
  const res = await fetch(url, { credentials: "omit", mode: "cors" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const blob = await res.blob();
  // 只缓存 http(s)：blob:/data: 的键（URL）在下次启动就失效了，存进去只是垃圾
  if (/^https?:/i.test(url)) void coverPut(url, blob);
  return { blob, cached: false };
}

scope.onmessage = (e: MessageEvent<CoverJob>) => {
  const job = e.data;
  void (async () => {
    try {
      const { blob, cached } = await bytesOf(job.url);
      if (job.warm) {
        // 预取：字节已经落盘就够了，不必解码/回传（省一次位图传输）
        scope.postMessage({ id: job.id, ok: true, cached });
        return;
      }
      // 只给 resizeWidth：高度按原比例自动算，主线程再做 object-fit: cover 的裁切，
      // 这样既不会拉变形，也和 `<img>` 的观感完全一致
      const bitmap = await createImageBitmap(blob, { resizeWidth: targetWidth(job.width), resizeQuality: "medium" });
      scope.postMessage({ id: job.id, ok: true, bitmap, cached, w: bitmap.width, h: bitmap.height }, [bitmap]);
    } catch (err) {
      scope.postMessage({ id: job.id, ok: false, error: String((err as { message?: string })?.message || err) });
    }
  })();
};
