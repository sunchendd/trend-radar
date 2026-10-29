/**
 * 自定义 hook 集合。全部基于 React 自带能力，不引入状态库。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getStats, isDemo, listItems, subscribeDemo, toApiError, type ApiError } from './api';
import { HIGH_SCORE, MID_SCORE } from './format';
import type { Stats } from './types';

// ------------------------------------------------------------------ 基础

/** 防抖值（搜索框 300ms） */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return v;
}

/** 媒体查询（SSR / 首帧安全） */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    [query],
  );
  const get = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, get, () => false);
}

/** 演示模式状态：全局、订阅式，徽标与各处提示共用一份真相 */
export function useDemoMode(): boolean {
  return useSyncExternalStore(subscribeDemo, isDemo, () => false);
}

// ------------------------------------------------------------------ 路由（hash）

export type RouteName = 'feed' | 'ideas' | 'system';

export interface Route {
  name: RouteName;
  params: URLSearchParams;
}

const ROUTE_NAMES: RouteName[] = ['feed', 'ideas', 'system'];

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const name = ROUTE_NAMES.find((n) => n === pathPart) ?? 'feed';
  return { name, params: new URLSearchParams(queryPart) };
}

export function useHashRoute(): {
  route: Route;
  navigate: (name: RouteName, params?: Record<string, string | undefined>) => void;
} {
  const [hash, setHash] = useState<string>(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const route = useMemo(() => parseHash(hash), [hash]);

  const navigate = useCallback((name: RouteName, params?: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    }
    const s = sp.toString();
    const next = `#/${name}${s ? `?${s}` : ''}`;
    if (window.location.hash === next) {
      // 相同 hash 也要让外部（页面）重新读取参数
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    window.location.hash = next;
  }, []);

  return { route, navigate };
}

/**
 * 就地替换 hash 里的 query 参数，且**不新增历史记录**
 * （关闭抽屉时不希望浏览器「后退」又把它打开）。
 */
export function replaceHashParam(name: string, value: string | null): void {
  const hash = window.location.hash || '#/feed';
  const [path = 'feed', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const sp = new URLSearchParams(query);
  if (value === null) sp.delete(name);
  else sp.set(name, value);
  const q = sp.toString();
  const next = `#/${path}${q ? `?${q}` : ''}`;
  const url = `${window.location.pathname}${window.location.search}${next}`;
  if (`#/${path}${q ? `?${q}` : ''}` === hash) return;
  window.location.replace(url);
}

// ------------------------------------------------------------------ 快捷键

export interface Binding {
  /** 单个键，例如 '/'、'g'、'Escape'、'?' */
  key: string;
  run: (e: KeyboardEvent) => void;
  /** 输入框聚焦时是否仍然触发（默认 false） */
  allowInInput?: boolean;
  /** 是否要求没有 meta/ctrl/alt */
  plain?: boolean;
}

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable;
}

export function useHotkeys(bindings: Binding[], enabled = true): void {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const editable = isEditableTarget(e.target);
      for (const b of ref.current) {
        if (e.key.toLowerCase() !== b.key.toLowerCase()) continue;
        if (editable && !b.allowInInput) continue;
        if (b.plain !== false && (e.metaKey || e.ctrlKey || e.altKey)) continue;
        e.preventDefault();
        b.run(e);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

// ------------------------------------------------------------------ 复制

export function useCopy(resetMs = 1800): { copy: (text: string) => Promise<boolean>; copied: boolean } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetMs);
        return true;
      } catch {
        setCopied(false);
        return false;
      }
    },
    [resetMs],
  );

  return { copy, copied };
}

// ------------------------------------------------------------------ 统计轮询

export interface StatsState {
  stats: Stats | null;
  error: ApiError | null;
  /** 首次加载中 */
  loading: boolean;
  /** 后台刷新中（不清空旧数据） */
  refreshing: boolean;
  refresh: () => void;
  lastUpdated: number | null;
}

/** 30s 轮询 /api/stats；提供手动 refresh 供 SSE 事件与采集后调用 */
export function useStats(intervalMs = 30_000): StatsState {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setRefreshing(true);
      try {
        const next = await getStats();
        if (cancelled) return;
        setStats(next);
        setError(null);
        setLastUpdated(Date.now());
      } catch (err) {
        if (cancelled) return;
        setError(toApiError(err));
      } finally {
        if (!cancelled) {
          setRefreshing(false);
          setLoading(false);
        }
      }
    };
    void load();
    const t = setInterval(() => void load(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [intervalMs, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { stats, error, loading, refreshing, refresh, lastUpdated };
}

// ------------------------------------------------------------------ 分数档位计数

export interface ScoreBands {
  /** ≥70 高分 */
  high: number;
  /** 50–70 待判 */
  mid: number;
  loading: boolean;
}

/**
 * 「高分 / 待判」两个精确计数。
 * /api/stats 的直方图桶太粗（20 分一档），算不出 ≥70 这种边界，
 * 所以直接问 /api/items 的 total（limit=1 只取计数，很便宜）。
 */
export function useScoreBands(intervalMs = 30_000, refreshKey = 0): ScoreBands {
  const [state, setState] = useState<ScoreBands>({ high: 0, mid: 0, loading: true });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [hi, mid] = await Promise.all([
          listItems({ minScore: HIGH_SCORE, limit: 1, offset: 0 }),
          listItems({ minScore: MID_SCORE, limit: 1, offset: 0 }),
        ]);
        if (cancelled) return;
        setState({ high: hi.total, mid: Math.max(0, mid.total - hi.total), loading: false });
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false }));
      }
    };
    void load();
    const t = setInterval(() => void load(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [intervalMs, refreshKey]);

  return state;
}

// ------------------------------------------------------------------ 很久没更新的提示

export function useTicker(intervalMs = 30_000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return tick;
}
