/**
 * 顶部统计行：今日新增 / 高相关 / 上次采集 + 一键采集。
 * 数字全部等宽（tabular-nums），避免刷新时数字抖动。
 */
import type { JSX, ReactNode } from 'react';
import type { RunRecord, Stats } from '../lib/types';
import type { ScoreBands } from '../lib/hooks';
import { HIGH_SCORE, MID_SCORE, absTime, fmtInt, relTime, runDuration, todayAdded, weekAdded } from '../lib/format';
import { Sparkbars } from './charts';
import { Icon, type IconName } from './Icon';
import { Eyebrow, Spinner } from './primitives';

function Tile({
  label,
  icon,
  value,
  unit,
  foot,
  chart,
  loading,
}: {
  label: string;
  icon: IconName;
  value: string;
  unit?: string;
  foot: ReactNode;
  chart?: ReactNode;
  loading: boolean;
}): JSX.Element {
  return (
    <div className="card flex flex-col justify-between px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-ink-3">
        <Icon name={icon} size={12} />
        <Eyebrow>{label}</Eyebrow>
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        {loading ? (
          <div className="skeleton" style={{ width: 46, height: 24, borderRadius: 5 }} />
        ) : (
          <div className="flex items-baseline gap-1 whitespace-nowrap">
            <span className="num text-[25px] leading-none font-semibold tracking-tight text-ink">{value}</span>
            {unit ? <span className="text-[10.5px] text-ink-3">{unit}</span> : null}
          </div>
        )}
        {chart}
      </div>
      <div className="mt-1.5 truncate text-[10px] text-ink-3">{foot}</div>
    </div>
  );
}

export function StatBar({
  stats,
  bands,
  loading,
  lastRun,
  collecting,
  onCollect,
  onExport,
}: {
  stats: Stats | null;
  bands: ScoreBands;
  loading: boolean;
  lastRun: RunRecord | null;
  collecting: boolean;
  onCollect: () => void;
  onExport: () => void;
}): JSX.Element {
  // stats 还没到（或彻底失败）时显示 —，不要用 0 假装"今天确实没有"
  const today = stats ? todayAdded(stats) : null;
  const high = bands.loading && !stats ? null : bands.high;
  const week = stats ? weekAdded(stats) : null;

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <Tile
        label="今日新增"
        icon="bolt"
        value={today === null ? '—' : fmtInt(today)}
        unit="条"
        loading={loading}
        chart={stats ? <Sparkbars data={stats.dailyAdded} width={80} height={24} /> : null}
        foot={
          <>
            近 7 天 <span className="num text-ink-2">+{week === null ? '—' : fmtInt(week)}</span> · 库内{' '}
            {stats ? fmtInt(stats.items) : '—'}
          </>
        }
      />
      <Tile
        label={`高分 ≥${HIGH_SCORE}`}
        icon="flame"
        value={high === null ? '—' : fmtInt(high)}
        unit="条"
        loading={loading}
        foot={
          <>
            待判 <span className="num text-ink-2">{bands.loading ? '…' : fmtInt(bands.mid)}</span>
            <span className="text-ink-3/80">（{MID_SCORE}–{HIGH_SCORE}）</span>
          </>
        }
      />
      <Tile
        label="上次采集"
        icon="clock"
        value={stats?.lastRunAt ? relTime(stats.lastRunAt).replace(/前$/, '') : '—'}
        unit={stats?.lastRunAt ? '前' : undefined}
        loading={loading}
        foot={
          <span title={absTime(stats?.lastRunAt ?? null)}>
            {lastRun
              ? `${lastRun.sourceCount} 源 · 抓 ${lastRun.fetched} / 新增 ${lastRun.added} · ${runDuration(lastRun)}`
              : absTime(stats?.lastRunAt ?? null)}
          </span>
        }
      />

      <div className="card flex flex-col justify-between px-3 py-3">
        <button
          type="button"
          onClick={onCollect}
          disabled={collecting}
          className="btn btn-accent h-[34px] w-full"
          title="抓取所有启用信源（同步返回本次运行记录，通常 ≤15s）"
        >
          {collecting ? <Spinner size={13} /> : <Icon name="refresh" size={14} />}
          {collecting ? '采集中…' : '一键采集'}
        </button>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-ink-3">
            {stats ? `${stats.enabledSources}/${stats.sources} 源启用` : '信源加载中'}
          </span>
          <button
            type="button"
            onClick={onExport}
            className="inline-flex items-center gap-1 text-[10px] text-ink-3 transition-colors hover:text-ink"
            title="导出全部条目（CSV）"
          >
            <Icon name="doc" size={11} />
            导出
          </button>
        </div>
      </div>
    </div>
  );
}
