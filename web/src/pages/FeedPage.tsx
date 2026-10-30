/**
 * 情报流（论文 / 新闻共用）：统计 → 搜索/筛选 → 卡片流 → 详情抽屉。
 *
 * `scope` 决定这一页**只看哪一类条目**：
 *   papers → kind=paper；news → kinds=news,release（Releases 与博客都属于工程信号）。
 * 页面的 KPI 也按同一口径统计，避免把两类混在一起看（那样「今天新增」永远对不上）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  collect as collectApi,
  exportUrl,
  friendlyError,
  getItem,
  listRuns,
  listSources,
  toApiError,
  type ApiError,
} from '../lib/api';
import { DEFAULT_FILTERS, activeFilterCount, type FeedFilters } from '../lib/feed';
import { runDuration, todayIso } from '../lib/format';
import {
  SCOPE_KINDS,
  SCOPE_LABEL,
  fetchScopedFeed,
  replaceHashParam,
  useAppSettings,
  useDebouncedValue,
  useHotkeys,
  useMediaQuery,
  useScopedKpi,
  useStats,
  type Route,
  type ScopeMode,
} from '../lib/hooks';
import { HIGH_SCORE, MID_SCORE } from '../lib/format';
import type { Item, RunRecord, Source, Stats } from '../lib/types';
import { FilterPanel } from '../components/FilterPanel';
import { Icon } from '../components/Icon';
import { ItemCard } from '../components/ItemCard';
import { ItemDrawer } from '../components/ItemDrawer';
import { Drawer } from '../components/Overlay';
import { ItemCardSkeleton } from '../components/Skeleton';
import { StatBar } from '../components/StatBar';
import { EmptyState, ErrorState } from '../components/States';
import { useToastFns } from '../components/Toast';
import { Kbd, Spinner } from '../components/primitives';

const LIMIT = 20;

export function FeedPage({
  route,
  scope,
  demo,
  liveNonce,
  onHelp,
}: {
  route: Route;
  /** 本页的类型口径：论文 / 新闻 */
  scope: ScopeMode;
  demo: boolean;
  liveNonce: number;
  onHelp: () => void;
}): JSX.Element {
  const toast = useToastFns();
  const wide = useMediaQuery('(min-width: 1280px)');
  const statsState = useStats(30_000);
  const scopeKinds = SCOPE_KINDS[scope];
  const label = SCOPE_LABEL[scope];

  const [filters, setFilters] = useState<FeedFilters>(() => ({
    ...DEFAULT_FILTERS,
    q: route.params.get('q') ?? '',
  }));
  const rawQ = filters.q;
  const debouncedQ = useDebouncedValue(rawQ, 300);
  // 注意：identity 必须只随「真实值」变化，否则每敲一个字都会重新取数
  const effective = useMemo<FeedFilters>(
    () => ({
      q: debouncedQ,
      sourceIds: filters.sourceIds,
      kind: filters.kind,
      minScore: filters.minScore,
      range: filters.range,
      sort: filters.sort,
    }),
    [debouncedQ, filters.sourceIds, filters.kind, filters.minScore, filters.range, filters.sort],
  );

  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [merged, setMerged] = useState(false);
  const [mode, setMode] = useState<'more' | 'pages'>('more');
  const [page, setPage] = useState(0);
  const [nonce, setNonce] = useState(0);

  const [sources, setSources] = useState<Source[]>([]);
  const [lastRun, setLastRun] = useState<RunRecord | null>(null);
  const [collecting, setCollecting] = useState(false);

  const [selected, setSelected] = useState<Item | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listTopRef = useRef<HTMLDivElement | null>(null);
  const reqId = useRef(0);

  // 本页口径的 KPI（论文页 / 新闻页各自统计，不混全库口径）
  const settingsState = useAppSettings();
  const thresholds = useMemo(
    () => ({
      high: settingsState.data?.highScore ?? HIGH_SCORE,
      mid: settingsState.data?.midScore ?? MID_SCORE,
    }),
    [settingsState.data?.highScore, settingsState.data?.midScore],
  );
  const kpi = useScopedKpi(scopeKinds, thresholds, 30_000, nonce);
  const bands = useMemo(() => ({ high: kpi.high, mid: kpi.mid, loading: kpi.loading }), [kpi.high, kpi.mid, kpi.loading]);
  /**
   * StatBar 拿的是 Stats 对象，这里把「本页口径」的条目数塞进去：
   * items / 今日新增 / 近 7 天 都换成当前 kind 口径，信源数与直方图仍是全库事实
   * （它们本来就是系统级信息，跟 kind 无关）。
   */
  const scopedStats: Stats | null = useMemo(() => {
    const base = statsState.stats;
    if (!base) return null;
    const rest = Math.max(0, kpi.week - kpi.today);
    return {
      ...base,
      items: kpi.items,
      // todayAdded 取最后一项、weekAdded 求和 → 用「过去几天」垫一行再放今天
      dailyAdded: [
        { date: '更早', count: rest },
        { date: todayIso(), count: kpi.today },
      ],
    };
  }, [statsState.stats, kpi.items, kpi.week, kpi.today]);

  const filterKey = useMemo(
    () =>
      JSON.stringify({
        q: effective.q,
        s: effective.sourceIds.slice().sort(),
        k: effective.kind,
        m: effective.minScore,
        r: effective.range,
        o: effective.sort,
      }),
    [effective],
  );

  // ---------------------------------------------------------------- 取数

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const offset = mode === 'pages' ? page * LIMIT : 0;
    const id = ++reqId.current;
    fetchScopedFeed(effective, scopeKinds, LIMIT, offset)
      .then((res) => {
        if (cancelled || id !== reqId.current) return;
        setItems(res.items);
        setTotal(res.total);
        setMerged(res.merged);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled || id !== reqId.current) return;
        setError(toApiError(err));
        setItems([]);
        setTotal(null);
      })
      .finally(() => {
        if (!cancelled && id === reqId.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, page, nonce, effective, scopeKinds]);

  // 筛选条件变化 → 回到第一页
  useEffect(() => {
    setPage(0);
  }, [filterKey]);

  // 30s 轮询兜底（SSE 未连接时也不会错过新条目）
  useEffect(() => {
    const t = setInterval(() => setNonce((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // SSE 事件（run / items）→ 立即刷新，不等 30s
  const refreshStats = statsState.refresh;
  useEffect(() => {
    if (liveNonce <= 0) return;
    setNonce((n) => n + 1);
    refreshStats();
  }, [liveNonce, refreshStats]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    const id = ++reqId.current;
    try {
      const res = await fetchScopedFeed(effective, scopeKinds, LIMIT, items.length);
      if (id !== reqId.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...res.items.filter((r) => !seen.has(r.id))];
      });
      setTotal(res.total);
      setMerged(res.merged);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      if (id === reqId.current) setLoadingMore(false);
    }
  }, [effective, items.length, scopeKinds]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    listSources()
      .then(setSources)
      .catch(() => setSources([]));
  }, []);

  useEffect(() => {
    listRuns()
      .then((runs) => setLastRun(runs[0] ?? null))
      .catch(() => setLastRun(null));
  }, [nonce]);

  // URL ?item= 打开抽屉（从选题工作台的「依据情报」跳过来）
  const itemParam = route.params.get('item');
  useEffect(() => {
    if (!itemParam) return;
    const local = items.find((i) => i.id === itemParam);
    if (local) {
      setSelected(local);
      return;
    }
    let cancelled = false;
    getItem(itemParam)
      .then((it) => {
        if (!cancelled) setSelected(it);
      })
      .catch(() => {
        if (!cancelled) toast.warn('找不到这条情报', `id=${itemParam} 可能已过期或未入库`);
      });
    return () => {
      cancelled = true;
    };
  }, [itemParam, items, toast]);

  const closeDrawer = useCallback(() => {
    setSelected(null);
    if (itemParam) replaceHashParam('item', null);
  }, [itemParam]);

  // ---------------------------------------------------------------- 动作

  const sourceMap = useMemo(() => {
    const m = new Map<string, Source>();
    for (const s of sources) m.set(s.id, s);
    return m;
  }, [sources]);

  const onCollect = useCallback(async () => {
    if (collecting) return;
    setCollecting(true);
    try {
      const run = await collectApi();
      toast.ok(
        `采集完成 · 新增 ${run.added} 条`,
        `${run.sourceCount} 个源 · 抓取 ${run.fetched} 条 · 用时 ${runDuration(run)}${
          run.errors.length > 0 ? ` · ${run.errors.length} 个源报错（详见信源与日志）` : ''
        }`,
      );
      statsState.refresh();
      reload();
    } catch (err) {
      const f = friendlyError(err);
      toast.error(f.title, f.hint);
    } finally {
      setCollecting(false);
    }
  }, [collecting, reload, statsState, toast]);

  const onExport = useCallback(() => {
    if (demo) {
      toast.warn('演示模式下不导出', '演示数据在内存里，/api/export 需要真实后端。');
      return;
    }
    window.open(exportUrl('csv'), '_blank', 'noopener');
  }, [demo, toast]);

  const resetFilters = useCallback(() => {
    setFilters({ ...DEFAULT_FILTERS, q: '' });
  }, []);

  const patchFilters = useCallback(
    (patch: Partial<FeedFilters>) => {
      // 本页已经固定在某一类条目上，类型筛选在这里没有意义（会被页面口径覆盖）
      if (patch.kind !== undefined) {
        toast.info(`本页只看${label.title}`, `类型已锁定为${label.kinds}；想看另一类请切到对应的页面。`);
        return;
      }
      setFilters((prev) => ({ ...prev, ...patch }));
    },
    [label.kinds, label.title, toast],
  );

  const toggleMode = useCallback(() => {
    setMode((m) => {
      const next = m === 'more' ? 'pages' : 'more';
      setPage(0);
      toast.info(next === 'pages' ? '已切换为分页模式' : '已切换为流式加载', '按 g 随时切换');
      return next;
    });
  }, [toast]);

  // ---------------------------------------------------------------- 快捷键

  useHotkeys([
    { key: '/', run: () => searchRef.current?.focus() },
    { key: 'g', run: toggleMode },
    {
      key: 'f',
      run: () => {
        if (wide) {
          toast.info('筛选器已常驻', '窗口宽度 ≥1280 时筛选器固定在右侧。');
          return;
        }
        setFilterOpen((v) => !v);
      },
    },
    {
      key: 'c',
      run: () => {
        void onCollect();
      },
    },
    {
      key: 'escape',
      run: () => {
        setFilterOpen(false);
        searchRef.current?.blur();
      },
    },
  ]);

  // ---------------------------------------------------------------- 渲染

  const activeCount = activeFilterCount({ ...filters, q: debouncedQ });
  const totalPages = total === null ? 1 : Math.max(1, Math.ceil(total / LIMIT));

  const filterProps = {
    filters,
    onChange: patchFilters,
    onReset: resetFilters,
    sources,
    stats: statsState.stats,
    total,
    loading,
  };

  return (
    <div className="mx-auto flex w-full max-w-[1240px] gap-4 px-3 py-3.5 md:px-5 md:py-4">
      <div className="min-w-0 flex-1">
        <StatBar
          stats={scopedStats}
          bands={bands}
          highScore={thresholds.high}
          midScore={thresholds.mid}
          loading={statsState.loading}
          lastRun={lastRun}
          collecting={collecting}
          onCollect={() => void onCollect()}
          onExport={onExport}
        />

        {/* 口径说明：把这一页的统计边界写清楚，避免和全库口径混淆 */}
        <p className="mt-1.5 text-[10px] leading-relaxed text-ink-3/85">
          本页口径：<span className="text-ink-2">{label.kinds}</span> · 高分 ≥
          <span className="num text-ink-2">{thresholds.high}</span> · 待判{' '}
          <span className="num text-ink-2">
            {thresholds.mid}–{thresholds.high}
          </span>{' '}
          · 「今日新增 / 近 7 天」只数本页口径下今天 / 近 7 天<strong className="font-medium text-ink-2">发布</strong>
          的条目，不与全库混合
        </p>

        {/* 搜索 + 工具条 */}
        <div className="mt-3 flex items-center gap-2">
          <div className="relative min-w-0 flex-1 md:max-w-[420px]">
            <Icon
              name="search"
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3"
            />
            <input
              ref={searchRef}
              value={rawQ}
              onChange={(e) => patchFilters({ q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.currentTarget.blur();
                }
              }}
              className="input h-9 pr-[52px] pl-8 text-[12.5px]"
              placeholder={`在${label.empty}里搜索标题 / 摘要 / 关键词…`}
              aria-label={`搜索${label.title}`}
              spellCheck={false}
            />
            {rawQ ? (
              <button
                type="button"
                onClick={() => {
                  patchFilters({ q: '' });
                  searchRef.current?.focus();
                }}
                aria-label="清空搜索"
                className="absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-3 hover:bg-fill-2 hover:text-ink"
              >
                <Icon name="x" size={12} />
              </button>
            ) : (
              <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
                <Kbd>/</Kbd>
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => setFilterOpen(true)}
            className="btn h-9 shrink-0 xl:hidden"
            aria-label="打开筛选器"
          >
            <Icon name="filter" size={13} />
            <span className="hidden sm:inline">筛选</span>
            {activeCount > 0 ? (
              <span className="num rounded bg-accent/15 px-1 text-[10px] text-accent">{activeCount}</span>
            ) : null}
          </button>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="hidden items-center gap-1 text-[10.5px] text-ink-3 sm:flex">
              <span className="num">{total === null ? '—' : total}</span> 条
              {merged ? <span className="text-ink-3/70">（多源合并）</span> : null}
            </span>
            <div
              className="hidden items-center gap-0.5 rounded-lg border border-line bg-sunken p-0.5 sm:flex"
              role="group"
              aria-label="浏览方式"
            >
              <button
                type="button"
                onClick={() => setMode('more')}
                aria-pressed={mode === 'more'}
                title="流式加载：滚到底点「加载更多」（快捷键 g）"
                className={`inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[10.5px] transition-colors ${
                  mode === 'more' ? 'bg-raised text-ink' : 'text-ink-3 hover:text-ink-2'
                }`}
              >
                <Icon name="feed" size={12} />
                <span className="hidden sm:inline">流式</span>
              </button>
              <button
                type="button"
                onClick={() => setMode('pages')}
                aria-pressed={mode === 'pages'}
                title="分页浏览：上一页 / 下一页（快捷键 g）"
                className={`inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[10.5px] transition-colors ${
                  mode === 'pages' ? 'bg-raised text-ink' : 'text-ink-3 hover:text-ink-2'
                }`}
              >
                <Icon name="table" size={12} />
                <span className="hidden sm:inline">分页</span>
              </button>
            </div>
            <button
              type="button"
              onClick={onHelp}
              className="btn btn-ghost h-9 w-9 px-0 xl:hidden"
              aria-label="快捷键"
              title="快捷键（?）"
            >
              <Icon name="keyboard" size={14} />
            </button>
          </div>
        </div>

        {/* 列表 */}
        <div ref={listTopRef} className="mt-3 space-y-2.5">
          {error && items.length === 0 ? (
            <ErrorState error={error} onRetry={reload} retrying={loading} />
          ) : loading && items.length === 0 ? (
            <>
              <ItemCardSkeleton />
              <ItemCardSkeleton />
              <ItemCardSkeleton />
            </>
          ) : items.length === 0 ? (
            activeCount > 0 ? (
              <EmptyState
                icon="filter"
                title={`没有符合条件的${label.title}`}
                hint="试着放宽相关度阈值或时间范围；也可以清除全部筛选看看全库。"
                action={
                  <button type="button" className="btn" onClick={resetFilters}>
                    <Icon name="refresh" size={13} />
                    清除筛选
                  </button>
                }
              />
            ) : (
              <EmptyState
                icon="antenna"
                title={`${label.empty}里还没有条目`}
                hint={`点上方「一键采集」抓一次；或在「信源」里添加${label.kinds}源。`}
                action={
                  <button type="button" className="btn btn-accent" onClick={() => void onCollect()} disabled={collecting}>
                    {collecting ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}
                    一键采集
                  </button>
                }
              />
            )
          ) : (
            <>
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  source={sourceMap.get(item.sourceId)}
                  active={selected?.id === item.id}
                  onOpen={setSelected}
                />
              ))}

              {mode === 'more' ? (
                <div className="flex flex-col items-center gap-2 pt-1 pb-6">
                  {items.length < (total ?? 0) ? (
                    <button type="button" className="btn" onClick={() => void loadMore()} disabled={loadingMore}>
                      {loadingMore ? <Spinner size={13} /> : <Icon name="chevron-down" size={13} />}
                      {loadingMore ? '加载中…' : `加载更多（还剩 ${Math.max(0, (total ?? 0) - items.length)} 条）`}
                    </button>
                  ) : (
                    <span className="text-[10.5px] text-ink-3">已经到底了 · 共 {total ?? items.length} 条</span>
                  )}
                  <span className="text-[10px] text-ink-3/80">
                    按 <Kbd>g</Kbd> 切换分页 · <Kbd>?</Kbd> 查看全部快捷键
                  </span>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-3 py-4 pb-6">
                  <button
                    type="button"
                    className="btn"
                    disabled={page === 0 || loading}
                    onClick={() => {
                      setPage((p) => Math.max(0, p - 1));
                      listTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  >
                    <Icon name="chevron-left" size={13} />
                    上一页
                  </button>
                  <span className="num text-[11.5px] text-ink-2">
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    disabled={page + 1 >= totalPages || loading}
                    onClick={() => {
                      setPage((p) => p + 1);
                      listTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  >
                    下一页
                    <Icon name="chevron-right" size={13} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 右侧筛选器（≥1280 常驻） */}
      <aside className="hidden w-[286px] shrink-0 xl:block">
        <div className="sticky top-[64px] max-h-[calc(100dvh-80px)] overflow-hidden rounded-card border border-line bg-surface">
          <FilterPanel {...filterProps} />
        </div>
      </aside>

      {/* <1280 的筛选抽屉 */}
      <Drawer
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        label="筛选器"
        width={330}
        header={
          <div className="flex items-center gap-2">
            <Icon name="filter" size={13} className="text-ink-3" />
            <span className="text-[12.5px] font-medium text-ink">筛选条件</span>
            <span className="num text-[10.5px] text-ink-3">{total ?? 0} 条</span>
            <button
              type="button"
              onClick={resetFilters}
              disabled={activeCount === 0}
              className="ml-auto rounded-md px-1.5 py-0.5 text-[10.5px] text-ink-3 transition-colors hover:bg-fill-2 hover:text-ink disabled:opacity-35"
            >
              清除
            </button>
          </div>
        }
        footer={
          <button type="button" className="btn btn-accent w-full" onClick={() => setFilterOpen(false)}>
            查看 {total ?? 0} 条结果
          </button>
        }
      >
        <FilterPanel {...filterProps} showHeader={false} />
      </Drawer>

      <ItemDrawer item={selected} source={sourceMap.get(selected?.sourceId ?? '')} onClose={closeDrawer} />
    </div>
  );
}
