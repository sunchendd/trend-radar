/**
 * 自定义 hook 集合。全部基于 React 自带能力，不引入状态库。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  getSettings,
  getStats,
  isDemo,
  listItems,
  subscribeDemo,
  toApiError,
  type ApiError,
} from './api';
import { fetchFeed, type FeedFilters, type FeedPage, type SortKey } from './feed';
import { HIGH_SCORE, MID_SCORE, todayIso } from './format';
import type { AppSettings, Item, ItemKind, ItemQuery, Stats } from './types';

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

/**
 * 路由名。
 *
 * 情报流已拆成 `papers` / `news` 两页；旧链接 `#/feed` 由 `parseHash` 重写成 `#/papers`，
 * 所以这里不再保留 `'feed'` 别名——留一个"永远不被返回的名字"只会让人误用。
 */
export type RouteName = 'papers' | 'news' | 'ideas' | 'watch' | 'system' | 'settings';

/** 兼容旧代码的别名（等价于 RouteName） */
export type PageRoute = RouteName;

export interface Route {
  name: RouteName;
  params: URLSearchParams;
}

const ROUTE_NAMES: PageRoute[] = ['papers', 'news', 'ideas', 'watch', 'system', 'settings'];

/** 旧 hash 别名：`#/feed` 是历史书签（情报流拆成论文/资讯两页之前），不能白屏 */
const LEGACY_ROUTES: Record<string, PageRoute> = { feed: 'papers' };

function hashPath(hash: string): string {
  return hash.replace(/^#\/?/, '').split('?')[0] ?? '';
}

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const name = ROUTE_NAMES.find((n) => n === pathPart) ?? LEGACY_ROUTES[pathPart] ?? 'papers';
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

  // 旧书签 #/feed → 就地改写成 #/papers（location.replace，不新增历史记录）
  useEffect(() => {
    const path = hashPath(window.location.hash);
    const target = LEGACY_ROUTES[path];
    if (!target) return;
    const query = window.location.hash.includes('?') ? window.location.hash.slice(window.location.hash.indexOf('?')) : '';
    const url = `${window.location.pathname}${window.location.search}#/${target}${query}`;
    window.location.replace(url);
    setHash(`#/${target}${query}`);
  }, [hash]);

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

// ------------------------------------------------------------------ 论文 / 新闻：按类型分区的取数

export type ScopeMode = 'papers' | 'news';

/**
 * 两个页面各自的类型口径。
 * 论文页只查 `kind=paper`；资讯页查 `kinds=news,release`（GitHub Releases 与博客
 * 在库里是两种 kind，但对用户是同一件事：工程信号）。
 */
export const SCOPE_KINDS: Record<ScopeMode, ItemKind[]> = {
  papers: ['paper'],
  news: ['news', 'release'],
};

export const SCOPE_LABEL: Record<ScopeMode, { title: string; kinds: string; empty: string }> = {
  papers: { title: '论文', kinds: '论文源（arXiv）', empty: '论文库' },
  news: { title: '新闻', kinds: 'Releases + 博客', empty: '资讯库' },
};

function sortItems(sort: SortKey, a: Item, b: Item): number {
  if (sort === 'time') return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  return b.score - a.score || Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
}

/**
 * 按类型分区取数。
 *
 * `kind` 与 `kinds` 是**互斥的两类分区**：paper / news / release 彼此不重叠，
 * 所以「每个 kind 各取一段、合并后排序、切出第 offset..offset+limit 段」的
 * total 就是各分区之和，分页语义与单 kind 完全一致（不需要跨分区去重）。
 *
 * TODO(下一轮)：`ItemQuery.kinds` 已能一路发到后端（api.ts 已拼 `kinds=a,b`），
 * 等 feed.ts 的 toItemQuery 支持 kinds 后，这里可以塌缩成一次请求。
 */
export async function fetchScopedFeed(
  filters: FeedFilters,
  kinds: ItemKind[],
  limit: number,
  offset: number,
): Promise<FeedPage> {
  const first = kinds[0];
  if (kinds.length <= 1) {
    return fetchFeed({ ...filters, kind: first ?? null }, limit, offset);
  }
  const need = offset + limit;
  const pages = await Promise.all(kinds.map((k) => fetchFeed({ ...filters, kind: k }, need, 0)));
  const all: Item[] = [];
  for (const p of pages) all.push(...p.items);
  all.sort((a, b) => sortItems(filters.sort, a, b));
  return {
    items: all.slice(offset, offset + limit),
    total: pages.reduce((sum, p) => sum + p.total, 0),
    limit,
    offset,
    merged: pages.some((p) => p.merged),
  };
}

// ------------------------------------------------------------------ 分页面的 KPI

export interface ScoreThresholds {
  high: number;
  mid: number;
}

export interface ScopedKpi {
  /** 该页口径下的条目总数 */
  items: number;
  /** 今天新增（同口径） */
  today: number;
  /** 近 7 天新增（同口径） */
  week: number;
  /** ≥ high 分 */
  high: number;
  /** [mid, high) 待判 */
  mid: number;
  loading: boolean;
}

/**
 * 论文页 / 新闻页各自的 KPI。
 *
 * 不能直接拿 `/api/stats`：它是全库口径，两页混着看会得出错误结论
 * （「今天新增 90」里大部分是另一类）。这里全部用同一条 `kinds` 过滤去要 total
 * （limit=1，只取计数），四个数才自洽。
 */
export function useScopedKpi(
  kinds: ItemKind[],
  thresholds: ScoreThresholds,
  intervalMs = 30_000,
  refreshKey = 0,
): ScopedKpi {
  const [state, setState] = useState<ScopedKpi>({ items: 0, today: 0, week: 0, high: 0, mid: 0, loading: true });
  const key = kinds.join(',');
  const { high, mid } = thresholds;

  useEffect(() => {
    let cancelled = false;
    const scopeKinds = key.split(',').filter((k) => k !== '') as ItemKind[];

    /**
     * 只取计数（limit=1）。多个 kind 时**按 kind 分别数再相加**——
     * 三种 kind 互不重叠，求和就是精确总量；等后端 `kinds` 参数上线后
     * 这里可以退化成单次带 `kinds` 的请求。
     */
    const countFor = async (extra: ItemQuery): Promise<number> => {
      if (scopeKinds.length <= 1) {
        return (await listItems({ ...extra, kind: scopeKinds[0], limit: 1, offset: 0 })).total;
      }
      const parts = await Promise.all(
        scopeKinds.map((k) => listItems({ ...extra, kind: k, limit: 1, offset: 0 })),
      );
      return parts.reduce((sum, p) => sum + p.total, 0);
    };

    const load = async () => {
      try {
        const [all, today, week, hi, midAll] = await Promise.all([
          countFor({}),
          countFor({ since: todayIso() }),
          countFor({ since: new Date(Date.now() - 7 * 86_400_000).toISOString() }),
          countFor({ minScore: high }),
          countFor({ minScore: mid }),
        ]);
        if (cancelled) return;
        setState({
          items: all,
          today,
          week,
          high: hi,
          mid: Math.max(0, midAll - hi),
          loading: false,
        });
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
  }, [key, high, mid, intervalMs, refreshKey]);

  return state;
}

// ------------------------------------------------------------------ 运行时设置（/api/settings）

export interface SettingsState {
  data: AppSettings | null;
  error: ApiError | null;
  loading: boolean;
  refresh: () => void;
}

/** 进程内缓存：同一会话里切页不必重复拉设置（保存后由 SettingsPage 回写） */
let settingsMemo: { data: AppSettings | null; at: number } = { data: null, at: 0 };

export function primeSettings(next: AppSettings): void {
  settingsMemo = { data: next, at: Date.now() };
}

export function useAppSettings(refreshKey = 0): SettingsState {
  const [data, setData] = useState<AppSettings | null>(settingsMemo.data);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(settingsMemo.data === null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(settingsMemo.data === null);
    getSettings()
      .then((next) => {
        if (cancelled) return;
        primeSettings(next);
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toApiError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, refresh };
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
