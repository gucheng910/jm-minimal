// DNS 加速引导卡（移除"我已知悉"按钮，始终显示供配置 DoT）

import { useCallback, useEffect, useRef, useState } from "react";
import { pushToast } from "./toast";
import { client } from "../core/api";

const DOH_SERVERS = [
  { name: "阿里", dot: "dot.alidns.com" },
  { name: "腾讯", dot: "dot.pub" },
  { name: "Google", dot: "dns.google" },
];
const PROBE_PATH = "/static/jmapp3apk/version.json?t=";
const TIMEOUT_MS = 5000;

async function probeApi(path: string) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(path, { method: "GET", credentials: "omit", cache: "no-store", signal: ctrl.signal });
    clearTimeout(timer);
    return { ok: resp.ok, ms: Math.round(performance.now() - t0) };
  } catch {
    clearTimeout(timer);
    return { ok: false, ms: Math.round(performance.now() - t0) };
  }
}

export default function DnsGuide() {
  const [open, setOpen] = useState(true); // 默认展开，拒绝用户 dismiss
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; ms: number } | null>(null);
  const timer = useRef<number | null>(null);
  const [copied, setCopied] = useState("");

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // 监听 jm:gotoDns 跳转事件（App 触发）
  useEffect(() => {
    const h = () => {
      setOpen(true);
      setTimeout(() => {
        document.getElementById("dns-guide-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 150);
    };
    window.addEventListener("jm:gotoDns", h);
    return () => window.removeEventListener("jm:gotoDns", h);
  }, []);

  const runProbe = useCallback(async () => {
    if (!client.apiBase) return;
    setTesting(true);
    setResult(null);
    let res = await probeApi(client.apiBase + PROBE_PATH + Date.now());
    if (!res.ok) {
      const r2 = await probeApi(client.apiBase + PROBE_PATH + Date.now());
      if (r2.ok) res = r2;
    }
    setResult(res);
    setTesting(false);
  }, []);

  async function copyDoT(dot: string) {
    try {
      await navigator.clipboard.writeText(dot);
      setCopied(dot);
      pushToast("已复制：" + dot);
      timer.current = window.setTimeout(() => setCopied(""), 2000);
    } catch {}
  }

  return (
    <div id="dns-guide-card" className="card dns-card">
      <div className="dns-header" onClick={() => setOpen(o => !o)}>
        <h2 style={{ margin: 0 }}>DNS 加速（可选）</h2>
        <span className="dns-arrow">{open ? "▾" : "▸"}</span>
      </div>
      <p className="muted dns-summary" onClick={() => setOpen(o => !o)}>
        设为公共 DoT 可防止运营商 DNS 污染，提升解析速度。
      </p>

      {open && (
        <div className="dns-body">
          <div className="dns-section">
            <div className="row">
              <button disabled={testing || !client.apiBase} onClick={runProbe}>
                {testing ? "检测中…" : client.apiBase ? "一键检测" : "请先初始化"}
              </button>
              {result && (
                <span className={"muted " + (result.ok ? "dns-ok" : "dns-err")}>
                  {result.ok ? "✔ 连接正常" : "✘ 连接异常"}
                </span>
              )}
            </div>
          </div>

          <div className="dns-section">
            <h3>公共 DoT 地址</h3>
            <p className="muted">点击复制，进入手机设置的「私人 DNS」粘贴即可。</p>
            <div className="dns-servers">
              {DOH_SERVERS.map(s => (
                <div key={s.dot} className="dns-server-item">
                  <span className="dns-server-name">{s.name}</span>
                  <code className="dns-server-addr">{s.dot}</code>
                  <button className="ghost dns-copy-btn" onClick={() => copyDoT(s.dot)}>
                    {copied === s.dot ? "✔ 已复制" : "复制"}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="dns-section">
            <details>
              <summary className="dns-steps-summary">开启方式（Android 7+）</summary>
              <ol className="dns-steps">
                <li>复制上方 DoT 地址</li>
                <li>设置 → 网络和互联网 → 私人 DNS</li>
                <li>选择「私人 DNS 提供商主机名」，粘贴</li>
                <li>保存后回到 JMClient 点击「重新检测」</li>
              </ol>
              <p className="muted dns-restart-note">
                <b>⚠️ 提示</b>配置 DoT 后需<b>删除后台重新进入 App</b>才能生效
              </p>
              <p className="muted" style={{ marginTop: 8 }}>
                💡 <b>常开无碍</b>：DoT 仅影响 DNS 解析（TLS 加密一次握手后复用连接），对电量、流量、网速影响几乎为 0，可一直保持开启，还能防止运营商窥探你的访问记录。
              </p>
              <p className="muted" style={{ marginTop: 4 }}>
                若在部分公司/校园网无法连接，系统会自动回退普通 DNS，不影响上网。
              </p>
            </details>
          </div>
        </div>
      )}
    </div>
  );
}
