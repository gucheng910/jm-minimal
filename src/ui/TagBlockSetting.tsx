// 标签屏蔽 UI：会员中心卡内插入
// 限制（按 07-标签屏蔽功能分析.md）：
//   1. 仅在登录态可用（父组件 gated by member 存在）
//   2. 服务端需 level_ok>=1（默认门槛 8）才能提交
//   3. 服务端 cooldown 控制：editable=0 时显示倒计时，按钮禁用
//   4. 屏蔽生效完全由服务端过滤（我们在请求里不再带 saved_tags，全凭 JWT 识别）
// UI 视觉对齐现有会员页：橙品牌色 + pill chip + ghost 次按钮 + card 容器

import { useCallback, useEffect, useMemo, useState } from "react";
import { getTagBlockForm, submitTagBlock, type TagBlockItem, type TagBlockState } from "../core/tagBlock";
import { pushToast } from "./toast";

interface Props {
  /** 父组件传入，便于异步刷新后父组件感知 */
  onBusyChange?: (busy: boolean) => void;
}

/** 把服务端 "YYYY-MM-DD HH:mm:ss" 解析为本地 Date，无效则回退到 now */
function parseServerTime(s: string): Date {
  if (!s) return new Date();
  // 兼容 "YYYY-MM-DD HH:mm:ss" 和 ISO "YYYY-MM-DDTHH:mm:ss"
  const norm = s.replace(" ", "T");
  const d = new Date(norm);
  return isNaN(d.getTime()) ? new Date() : d;
}

function fmtCountdown(targetMs: number, nowMs: number): string {
  let s = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);   s -= m * 60;
  if (h > 0) return h + " 小时 " + m + " 分";
  if (m > 0) return m + " 分 " + s + " 秒";
  return s + " 秒";
}

function fmtServerTime(s: string): string {
  if (!s) return "-";
  const d = parseServerTime(s);
  if (isNaN(d.getTime())) return s;
  // 与官方 zh-TW 文案对齐："YYYY-MM-DD HH:mm:ss" 风格
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
    + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

export default function TagBlockSetting({ onBusyChange }: Props) {
  const [state, setState] = useState<TagBlockState | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 客户端本地编辑态：以服务端 saved_tags 为初值，用户切换后记录差异
  const [pending, setPending] = useState<Record<string, boolean>>({});
  // 冷却倒计时重渲染节流（每 30s 重算一次，长冷却下不浪费 setState）
  const [, setTick] = useState(0);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const busy = loading || submitting;

  // 暴露 busy 给上层做 button 灰度（虽然卡内按钮已自带 disabled）
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const data = await getTagBlockForm();
      setState(data);
      const init: Record<string, boolean> = {};
      for (const t of data.tag_list) init[t.tag] = t.blocked;
      setPending(init);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 进入会员页时主动拉取一次
  useEffect(() => { load(); }, [load]);

  // 冷却倒计时：editable=0 时启动，30s 节流
  useEffect(() => {
    if (!state || state.editable === 1) return;
    const iv = window.setInterval(() => setTick((n) => n + 1), 30000);
    return () => window.clearInterval(iv);
  }, [state]);

  const isLevelLocked = !!state && state.level_ok !== 1;
  const isCooling = !!state && state.editable !== 1;
  // 是否有改动
  const dirty = useMemo(() => {
    if (!state) return false;
    for (const t of state.tag_list) {
      const want = !!pending[t.tag];
      if (want !== t.blocked) return true;
    }
    return false;
  }, [state, pending]);

  function toggle(tag: string) {
    setPending((p) => ({ ...p, [tag]: !p[tag] }));
  }

  async function confirm() {
    if (!state) return;
    if (isLevelLocked) {
      pushToast("等级 " + state.level + " 開放使用", "err");
      return;
    }
    if (isCooling) {
      pushToast("尚未到可再次屏蔽标签的時間", "err");
      return;
    }
    if (!dirty) {
      pushToast("请至少修改一個過濾标签", "err");
      return;
    }
    const tags = Object.entries(pending)
      .filter(([, on]) => on)
      .map(([tag]) => tag);
    setSubmitting(true);
    setErr("");
    setMsg("");
    try {
      const reply = await submitTagBlock(tags);
      setMsg(reply);
      pushToast(reply || "成功设置", "ok");
      // 提交成功后立即重拉最新 cooldown
      await load();
    } catch (e) {
      const text = String((e as Error)?.message || e);
      setErr(text);
      pushToast(text, "err");
    } finally {
      setSubmitting(false);
    }
  }

  // ---- 渲染分支 ----
  // 1) 加载中/出错
  if (loading && !state) {
    return (
      <div className="card tag-block-card">
        <h2>标签屏蔽</h2>
        <p className="muted">加载中…</p>
      </div>
    );
  }

  if (err && !state) {
    return (
      <div className="card tag-block-card">
        <h2>标签屏蔽</h2>
        <p className="err">{err}</p>
        <div className="row">
          <button onClick={load}>重试</button>
        </div>
      </div>
    );
  }

  if (!state) return null;

  // 2) 服务端尚未下发标签列表（空响应）
  if (state.tag_list.length === 0) {
    return (
      <div className="card tag-block-card">
        <h2>标签屏蔽</h2>
        <p className="muted">官方暂未下发可屏蔽标签列表。</p>
        <div className="row">
          <button className="ghost" onClick={load}>刷新</button>
        </div>
      </div>
    );
  }

  // 3) 等级门槛 / 4) 冷却 / 5) 正常可编辑
  const list = state.tag_list;

  return (
    <div className="card tag-block-card">
      <h2>标签屏蔽</h2>

      <p className="muted tag-block-tip">
        在首页/分类/搜索/推荐中过滤含所选标签的作品；屏蔽完全由官方服务端按账号生效。
      </p>

      {isLevelLocked && (
        <div className="tag-block-locked">
          <div className="tag-block-locked-mask" aria-hidden="true" />
          <div className="tag-block-locked-msg">
            等级 {state.level} 開放使用
          </div>
        </div>
      )}

      <div className={"tag-block-list" + (isLevelLocked ? " is-locked" : "")}>
        {list.map((t: TagBlockItem) => {
          const on = !!pending[t.tag];
          const label = t.tag_label || t.tag;
          return (
            <button
              key={t.tag}
              type="button"
              className={"chip tag-block-item" + (on ? " active" : "")}
              onClick={() => !isLevelLocked && toggle(t.tag)}
              aria-pressed={on}
              aria-label={"屏蔽标签 " + label}
              disabled={isLevelLocked || isCooling}
            >
              <span className={"tag-block-toggle" + (on ? " on" : "")} aria-hidden="true">
                <span className="tag-block-toggle-knob" />
              </span>
              <span className="tag-block-item-label">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="row tag-block-actions">
        <button
          disabled={submitting || isLevelLocked || isCooling || !dirty}
          onClick={confirm}
        >
          {submitting ? "提交中…" : "确认屏蔽"}
        </button>
        <button
          className="ghost"
          disabled={submitting || isLevelLocked || isCooling || !dirty}
          onClick={() => {
            const reset: Record<string, boolean> = {};
            for (const t of list) reset[t.tag] = t.blocked;
            setPending(reset);
          }}
        >
          撤销改动
        </button>
      </div>

      <div className="tag-block-meta">
        {state.last_confirm_at && (
          <p className="muted">上次屏蔽设置时间：{fmtServerTime(state.last_confirm_at)}</p>
        )}
        {isCooling && state.next_editable_at && (
          <p className="muted">
            下次可再次屏蔽标签時間：{fmtServerTime(state.next_editable_at)}
            （剩 {fmtCountdown(parseServerTime(state.next_editable_at).getTime(), Date.now())}）
          </p>
        )}
        {dirty && !isCooling && !isLevelLocked && (
          <p className="muted">已修改但未提交</p>
        )}
        {msg && <p className="msg">{msg}</p>}
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  );
}
