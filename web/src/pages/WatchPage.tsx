/**
 * 检索式巡检页：盯住若干方向，命中数环比异动 → 选题触发器。
 *
 * 为什么单独一页而不是塞进「信源」：巡检的语义是**方向**（技术主题），
 * 和信源（抓取管道）是两件事；混在一起会让"这条为什么报警"看不出来。
 *
 * 判读口径全部来自后端 `ideas/trend.ts`（本页不自算阈值），前端只负责呈现与配色。
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  addWatch,
  friendlyError,
  generateIdeas,
  listWatches,
  removeWatch,
  runSweep,
  setWatchEnabled,
  toApiError,
  type ApiError,
} from '../lib/api';
import { relTime } from '../lib/format';
import type { RouteName } from '../lib/hooks';
import type { SweepResult, TrendLevel, Watch, WatchTrend } from '../lib/types';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState } from '../components/States';
import { ListRowSkeleton } from '../components/Skeleton';
import { useToastFns } from '../components/Toast';
import { Pill, Spinner } from '../components/primitives';

const LEVEL_META: Record<TrendLevel, { label: string; cls: string; hint: string }> = {
  surge: { label: '升温', cls: 'text-warn border-warn/40 bg-warn/10', hint: '有人在同一处布专利，值得据此出选题' },
  'new-front': { label: '新方向', cls: 'text-accent border-accent/40 bg-accent/10', hint: '从 0 变有命中：新方向冒头' },
  warm: { label: '微升', cls: 'text-ink-2 border-line bg-white/[0.03]', hint: '涨幅未过阈值，继续观察' },
  flat: { label: '平稳', cls: 'text-ink-3 border-line bg-white/[0.02]', hint: '无显著变化' },
  cool: { label: '降温', cls: 'text-ink-3 border-line bg-white/[0.02]', hint: '竞争减少，也可能方向过时' },
  baseline: { label: '基线', cls: 'text-ink-3 border-dashed border-line', hint: '首次巡检，下次才有环比' },
};

/** 命中数折线（手写 SVG，不引图表库）：解析失败的点断开，不连线 */
function Sparkline({ history }: { history: { at: string; hits: number | null }[] }): JSX.Element {
  const width = 168;
  const height = 34;
  const points = history.slice(-12);
  const values = points.map((p) => p.hits).filter((v): v is number => v !== null);
  const max = Math.max(1, ...values);
  const step = points.length > 1 ? width / (points.length - 1) : width;

  const coords = points.map((point, index) => ({
    x: index * step,
    y: point.hits === null ? null : height - 3 - (point.hits / max) * (height - 8),
  }));

  let path = '';
  let pen = false;
  for (const coord of coords) {
    if (coord.y === null) {
      pen = false;
      continue;
    }
    path += `${pen ? 'L' : 'M'}${coord.x.toFixed(1)},${coord.y.toFixed(1)} `;
    pen = true;
  }

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="shrink-0">
      <line x1="0" y1={height - 2} x2={width} y2={height - 2} stroke="currentColor" strokeWidth="0.5" className="text-line" />
      {path ? <path d={path} fill="none" stroke="currentColor" strokeWidth="1.4" className="text-accent" /> : null}
      {coords.map((coord, index) =>
        coord.y === null ? (
          // 解析失败画成空心小方块：和 0 命中（贴底实心点）在视觉上区分开
          <rect key={index} x={coord.x - 2} y={height / 2 - 2} width="4" height="4" fill="none" stroke="currentColor" strokeWidth="0.8" className="text-ink-3" />
        ) : (
          <circle key={index} cx={coord.x} cy={coord.y} r="1.6" fill="currentColor" className="text-accent" />
        ),
      )}
    </svg>
  );
}

export function WatchPage({
  liveNonce,
  navigate,
}: {
  liveNonce: number;
  navigate: (n: RouteName, params?: Record<string, string>) => void;
}): JSX.Element {
  const toast = useToastFns();
  const [watches, setWatches] = useState<Watch[]>([]);
  const [trends, setTrends] = useState<WatchTrend[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [lastSweep, setLastSweep] = useState<SweepResult | null>(null);
  /** 正在为该巡检方向生成选题（记 query，避免整页按钮一起转圈） */
  const [generatingFor, setGeneratingFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await listWatches(true);
      setWatches(rows);
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, liveNonce]);

  const onAdd = useCallback(async () => {
    const query = draft.trim();
    if (query.length < 4) {
      toast.warn('检索式太短', '至少 4 个字符，建议 3–5 个中文关键词');
      return;
    }
    setBusy(true);
    try {
      await addWatch(query);
      setDraft('');
      await load();
      toast.ok('已加入巡检', '跑一轮巡检后才有命中数基线');
    } catch (err) {
      toast.error('添加失败', friendlyError(err).title);
    } finally {
      setBusy(false);
    }
  }, [draft, load, toast]);

  const onSweep = useCallback(async () => {
    setSweeping(true);
    try {
      const result = await runSweep();
      setLastSweep(result);
      setTrends(result.trends);
      await load();
      if (result.alerts.length > 0) {
        toast.warn(`${result.alerts.length} 个方向有异动`, result.alerts.map((a) => a.watch.query).join(' / '));
      } else if (result.errors.length > 0) {
        toast.warn('部分方向失败', result.errors[0]?.message ?? '');
      } else {
        toast.ok(`巡检完成 · ${result.checked} 个方向`, '命中数已记录，下次巡检可算环比');
      }
    } catch (err) {
      const api = toApiError(err);
      // 503 = 查新没配：这是产品最该说清的状态，不能糊成"未知错误"
      toast.error(api.code === 'novelty_not_configured' ? '查新未配置' : '巡检失败', api.message);
    } finally {
      setSweeping(false);
    }
  }, [load, toast]);

  /**
   * 巡检 → 选题闭环：把巡检检索式直接当 focus 交给 LLM。
   * 不在这里"顺手"改状态或存稿，生成完就跳到工作台让用户自己看/查新——
   * 自动流转会让人分不清哪条是机器塞进来的。
   */
  const onGenerateFromWatch = useCallback(
    async (watch: Watch) => {
      setGeneratingFor(watch.id);
      try {
        const res = await generateIdeas({ focus: watch.query, count: 1 });
        const first = res.ideas[0];
        toast.ok(
          `已按「${watch.query}」生成选题`,
          first ? first.title.slice(0, 28) + '…' : '已写入工作台',
        );
        navigate('ideas', first ? { idea: first.id } : undefined);
        void navigate;
      } catch (err) {
        const api = toApiError(err);
        toast.error(
          api.code === 'llm_not_configured' ? 'LLM 未配置' : '生成失败',
          api.code === 'llm_not_configured' ? '填 TREND_RADAR_LLM_BASE_URL / MODEL 后可用；也可在工作台手工新建' : api.message,
        );
      } finally {
        setGeneratingFor(null);
      }
    },
    [navigate, toast],
  );

  const trendOf = (id: string): WatchTrend | undefined => trends.find((t) => t.watch.id === id);

  return (
    <div className="mx-auto w-full max-w-[1200px] px-3 py-3.5 md:px-5 md:py-4">
      <div className="card px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Icon name="flame" size={14} className="text-accent" />
          <span className="text-[12.5px] font-medium text-ink">巡检方向</span>
          <span className="text-[10.5px] text-ink-3">
            命中数环比涨 ≥30% 且 ≥5 命中 → 升温；从 0 变有 → 新方向。判读口径由后端统一，前端不自己算
          </span>
        </div>
        <form
          className="mt-2.5 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void onAdd();
          }}
        >
          <input
            className="input h-9 min-w-0 flex-1 px-3 text-[12.5px]"
            placeholder="要盯住的检索式，例如：投机解码 草稿 重建"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={80}
            aria-label="巡检检索式"
          />
          <div className="flex items-center gap-2">
            <button type="submit" className="btn h-9 px-3" disabled={busy}>
              {busy ? <Spinner size={13} /> : <Icon name="plus" size={13} />}
              新增
            </button>
            <button
              type="button"
              className="btn btn-accent h-9 px-3.5"
              disabled={sweeping || watches.length === 0}
              onClick={() => void onSweep()}
              title="对全部启用方向跑一次查新，通常 20–60 秒"
            >
              {sweeping ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}
              {sweeping ? '巡检中…' : '跑一轮巡检'}
            </button>
          </div>
        </form>
        {lastSweep ? (
          <p className="mt-2 text-[10.5px] text-ink-3">
            {relTime(lastSweep.at)} · 检查 {lastSweep.checked} 个 · 失败 {lastSweep.skipped} 个 · 异动{' '}
            {lastSweep.alerts.length} 个
          </p>
        ) : null}
      </div>

      <div className="mt-3">
        {loading ? (
          <div className="card divide-y divide-line/60">
            {[0, 1, 2].map((i) => (
              <div key={i} className="px-3.5 py-3">
                <ListRowSkeleton />
              </div>
            ))}
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={() => void load()} />
        ) : watches.length === 0 ? (
          <EmptyState
            icon="flame"
            title="还没有巡检方向"
            hint="加 3–5 个你最关心的检索式，每周跑一次，命中数异动就是选题信号"
          />
        ) : (
          <div className="card divide-y divide-line/60">
            {watches.map((watch) => {
              const trend = trendOf(watch.id);
              const meta = trend ? LEVEL_META[trend.trend.level] : null;
              return (
                <div key={watch.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12.5px] text-ink">{watch.query}</span>
                      {meta ? (
                        <span
                          className={`rounded border px-1.5 py-[1px] text-[10px] ${meta.cls}`}
                          title={meta.hint}
                        >
                          {meta.label}
                        </span>
                      ) : null}
                      {trend?.trend.actionable ? (
                        <span className="rounded border border-warn/50 bg-warn/10 px-1.5 py-[1px] text-[10px] text-warn">
                          选题信号
                        </span>
                      ) : null}
                      {!watch.enabled ? <Pill mono>已停用</Pill> : null}
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-ink-3">
                      {trend ? trend.trend.headline : `最近命中 ${watch.lastHits ?? '—'} · 巡检 ${watch.checks} 次`}
                      {watch.lastCheckedAt ? ` · ${relTime(watch.lastCheckedAt)}` : ''}
                    </div>
                  </div>

                  {trend && trend.history.length > 1 ? <Sparkline history={trend.history} /> : null}

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="btn h-7 px-2 text-[11px]"
                      disabled={generatingFor !== null}
                      onClick={() => void onGenerateFromWatch(watch)}
                      title="以该检索式为 focus 生成一条选题（需要配置 LLM）"
                    >
                      {generatingFor === watch.id ? <Spinner size={11} /> : <Icon name="bulb" size={11} />}
                      出选题
                    </button>
                    <button
                      type="button"
                      className="btn h-7 px-2 text-[11px]"
                      onClick={async () => {
                        await setWatchEnabled(watch.id, !watch.enabled);
                        await load();
                      }}
                    >
                      {watch.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className="btn h-7 px-2 text-[11px] text-warn"
                      onClick={async () => {
                        await removeWatch(watch.id);
                        await load();
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {lastSweep && lastSweep.errors.length > 0 ? (
        <div className="card mt-3 px-3.5 py-2.5">
          <div className="text-[11px] text-warn">本轮失败的方向（单方向失败不会中断整轮）</div>
          <ul className="mt-1 space-y-0.5">
            {lastSweep.errors.map((e) => (
              <li key={e.watchId} className="text-[10.5px] text-ink-3">
                <span className="text-ink-2">{e.query}</span> · {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
