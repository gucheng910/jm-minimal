// 标签屏蔽协议层：参照 E:/JMComic-RE/40-notes/07-标签屏蔽功能分析.md
// GET /tag_block?action=form 拉取标签列表；POST /tag_block { tags: [] } 提交屏蔽设置
// 等级门槛 8 与冷却机制均由服务端返回字段驱动，客户端只做 UI 呈现与提交

import { client } from "./api";

export interface TagBlockItem {
  tag: string;
  tag_label: string;
  blocked: boolean;
}

export interface TagBlockState {
  tag_list: TagBlockItem[];
  saved_tags: string[];
  editable: number;          // 0=冷却中, 1=可编辑
  last_confirm_at: string;
  next_editable_at: string;
  unlocked: number;
  level: number;             // 门槛等级（服务端下发，通常 8）
  level_ok: number;          // 0=等级不足, 1=够
  lock_reason: string;
}

export const API_TAG_BLOCK = "tag_block";

export async function getTagBlockForm(): Promise<TagBlockState> {
  // GET /tag_block?action=form：对齐官方 memberReducer 的 tagBlockSetting 结构
  try {
    const resp = await client.request<TagBlockState>(API_TAG_BLOCK, { action: "form" }, {
      timeoutMs: 12000,
      retries: 2
    });
    return normalizeTagBlock(resp);
  } catch (err) {
    throw new Error("拉取标签屏蔽设置失败：" + String(err).replace(/^Error: /, ""));
  }
}

export async function submitTagBlock(tags: string[]): Promise<string> {
  // POST /tag_block  JSON body: { "tags": [...] }，官方 thunk 同参
  try {
    // Query 类型允许标量，但官方需要 JSON 数组 body；屏蔽 TS 类型（运行时 JSON.stringify 仍正确序列化数组）
    const resp = await client.request<{ msg?: string; status?: string }>(API_TAG_BLOCK, { tags: tags as unknown as string }, {
      method: "POST",
      json: true,
      timeoutMs: 15000,
      retries: 2
    });
    return String(resp?.msg || resp?.status || "成功设置");
  } catch (err) {
    throw new Error("提交屏蔽设置失败：" + String(err).replace(/^Error: /, ""));
  }
}

/** 归一化服务端可能缺失/变形的字段，保证 UI 层健壮 */
function normalizeTagBlock(s: TagBlockState): TagBlockState {
  return {
    tag_list: Array.isArray(s?.tag_list) ? s.tag_list : [],
    saved_tags: Array.isArray(s?.saved_tags) ? s.saved_tags : [],
    editable: Number(s?.editable) === 1 ? 1 : 0,
    last_confirm_at: s?.last_confirm_at || "",
    next_editable_at: s?.next_editable_at || "",
    unlocked: Number(s?.unlocked) === 1 ? 1 : 0,
    level: Number(s?.level) || 8,
    level_ok: Number(s?.level_ok) === 1 ? 1 : 0,
    lock_reason: String(s?.lock_reason || "")
  };
}
