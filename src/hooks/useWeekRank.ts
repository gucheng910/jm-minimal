// 周榜（排行）页的状态与数据：独立维护自己的列表，不再借用首页的 items
import { useCallback, useRef, useState } from "react";
import { client } from "../core/api";
import { PAGE_SIZE } from "../core/constants";
import type { AlbumSummary, WeekPayload } from "../core/types";

export interface WeekRankApi {
  payload: WeekPayload | null;
  items: AlbumSummary[];
  issue: string;
  type: string;
  busy: boolean;
  error: string;
  hasMore: boolean;
  /** 打开周榜：拉期号/类型列表并加载最新一期；返回 false 表示失败（调用方不要切页） */
  open: () => Promise<boolean>;
  load: (issueId: string, typeId: string, page?: number, replace?: boolean) => Promise<void>;
  loadMore: () => void;
  setIssue: (v: string) => void;
  setType: (v: string) => void;
  /** 离开周榜：作废在途回包 */
  reset: () => void;
}

export function useWeekRank(): WeekRankApi {
  const [payload, setPayload] = useState<WeekPayload | null>(null);
  const [items, setItems] = useState<AlbumSummary[]>([]);
  const [issue, setIssue] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reqIdRef = useRef(0);

  const load = useCallback(async (issueId: string, typeId: string, p = 1, replace = true) => {
    if (!issueId) return; // typeId 空串 = 全部类型，是合法值
    const reqId = ++reqIdRef.current;
    setBusy(true);
    setError("");
    try {
      const result = await client.getWeekAlbums(issueId, typeId, p);
      if (reqIdRef.current !== reqId) return; // 换期/离开页面后丢弃过期回包
      const list = result.list || [];
      setItems((prev) => (replace ? list : [...prev, ...list]));
      setIssue(issueId);
      setType(typeId);
      setPage(p);
      setHasMore(list.length >= PAGE_SIZE);
    } catch (err) {
      if (reqIdRef.current === reqId) setError(String(err));
    } finally {
      if (reqIdRef.current === reqId) setBusy(false);
    }
  }, []);

  const open = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setBusy(true);
    setError("");
    try {
      const wk = await client.getWeek();
      if (reqIdRef.current !== reqId) return false;
      setPayload(wk);
      const latest = wk.categories && wk.categories[0];
      if (latest) {
        setIssue(String(latest.id));
        setType("");
        await load(String(latest.id), "", 1, true);
      }
      return true;
    } catch (err) {
      if (reqIdRef.current === reqId) setError(String(err));
      return false;
    } finally {
      if (reqIdRef.current === reqId) setBusy(false);
    }
  }, [load]);

  const loadMore = useCallback(() => {
    if (!issue || busy || !hasMore) return;
    void load(issue, type, page + 1, false);
  }, [issue, type, page, busy, hasMore, load]);

  const reset = useCallback(() => {
    reqIdRef.current++;
    setBusy(false);
    setError("");
  }, []);

  return { payload, items, issue, type, busy, error, hasMore, open, load, loadMore, setIssue, setType, reset };
}
