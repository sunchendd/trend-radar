/**
 * 右侧筛选器（≥1280 常驻；768–1280 变成抽屉）。
 * 所有条件即时生效，没有「应用」按钮——除了相关度滑杆，它防抖 450ms 才请求。
 */
import type { JSX } from 'react';
import type { ItemKind, Source, Stats } from '../lib/types';
import type { FeedFilters, TimeRange } from '../lib/feed';
import { activeFilterCount } from '../lib/feed';
import { fmtInt } from '../lib/format';
import { ScoreHistogram } from './charts';
import { Icon } from './Icon';
import { Segmented, Slider, SectionHead, Pill } from './primitives';

export function FilterPanel({
  filters,
  onChange,
  onReset,
  sources,
  stats,
  total,
  loading,
  showHeader = true,
}: {
  filters: FeedFilters;
  onChange: (patch: Partial<FeedFilters>) => void;
  onReset: () => void;
  sources: Source[];
  stats: Stats | null;
  total: number | null;
  loading: boolean;
  /** 放进抽屉时由抽屉自己提供标题栏，这里就不再重复一遍 */
  showHeader?: boolean;
}): JSX.Element {
  const active = activeFilterCount(filters);

  const toggleSource = (id: string) => {
    const has = filters.sourceIds.includes(id);
    onChange({
      sourceIds: has ? filters.sourceIds.filter((x) => x !== id) : [...filters.sourceIds, id],
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className={`flex items-center gap-2 border-b border-line px-3.5 py-2.5 ${showHeader ? '' : 'hidden'}`}>
        <Icon name="filter" size={14} className="text-ink-3" />
        <span className="text-[12.5px] font-medium text-ink">筛选</span>
        {active > 0 ? (
          <Pill
            color="var(--color-accent)"
            bg="color-mix(in oklab, var(--color-accent) 12%, transparent)"
            border="color-mix(in oklab, var(--color-accent) 30%, transparent)"
            mono
          >
            {active}
          </Pill>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <span className="num text-[10.5px] text-ink-3">
            {loading ? '…' : total === null ? '—' : `${fmtInt(total)} 条`}
          </span>
          <button
            type="button"
            onClick={onReset}
            disabled={active === 0}
            className="rounded-md px-1.5 py-0.5 text-[10.5px] text-ink-3 transition-colors hover:bg-white/5 hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
            title="清除全部筛选"
          >
            清除
          </button>
        </div>
      </div>

      <div className="scroll-area min-h-0 flex-1 space-y-5 overflow-y-auto px-3.5 py-3.5">
        <section>
          <SectionHead title="信源" hint="可多选" />
          <div className="-mx-1 space-y-0.5">
            {sources.length === 0 ? (
              <div className="px-1 py-1 text-[11px] text-ink-3">还没有信源，去「信源与日志」添加。</div>
            ) : (
              sources.map((s) => {
                const checked = filters.sourceIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggleSource(s.id)}
                    aria-pressed={checked}
                    title={s.note || s.url}
                    className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-[5px] text-left transition-colors ${
                      checked ? 'bg-white/[0.045]' : 'hover:bg-white/[0.025]'
                    }`}
                  >
                    <span
                      className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[4px] border transition-colors"
                      style={{
                        borderColor: checked ? 'var(--color-accent)' : 'var(--color-line-strong)',
                        background: checked ? 'var(--color-accent)' : 'transparent',
                        color: 'var(--color-accent-ink)',
                      }}
                    >
                      {checked ? <Icon name="check" size={9} strokeWidth={3} /> : null}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate text-[11.5px] ${
                        s.enabled ? 'text-ink-2' : 'text-ink-3 line-through decoration-line-strong'
                      } ${checked ? 'text-ink' : ''}`}
                    >
                      {s.label}
                    </span>
                    {!s.enabled ? (
                      <span className="shrink-0 text-[9.5px] text-ink-3">停用</span>
                    ) : (
                      <span className="num shrink-0 text-[9.5px] text-ink-3">×{s.weight.toFixed(1)}</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </section>

        <section>
          <SectionHead title="类型" />
          <Segmented<ItemKind>
            size="sm"
            options={[
              { value: 'paper', label: '论文' },
              { value: 'news', label: '资讯' },
              { value: 'release', label: '发布' },
            ]}
            value={filters.kind}
            onChange={(v) => onChange({ kind: v })}
          />
        </section>

        <section>
          <SectionHead title="相关度" hint="≥ 阈值" />
          <Slider
            label="最低相关度"
            min={0}
            max={95}
            step={5}
            value={filters.minScore}
            onChange={(v) => onChange({ minScore: v })}
            format={(v) => (v === 0 ? '不限' : `≥ ${v}`)}
          />
          {stats ? (
            <div className="mt-2.5">
              <ScoreHistogram bins={stats.scoreHistogram} minScore={filters.minScore} height={38} />
              <div className="mt-0.5 text-[9.5px] text-ink-3">库内相关度分布（高亮 = 当前阈值以上）</div>
            </div>
          ) : null}
        </section>

        <section>
          <SectionHead title="时间范围" hint="按发布" />
          <Segmented<TimeRange>
            size="sm"
            options={[
              { value: '24h', label: '24h' },
              { value: '7d', label: '7d' },
              { value: '30d', label: '30d' },
              { value: 'all', label: '不限' },
            ]}
            value={filters.range}
            onChange={(v) => onChange({ range: v ?? 'all' })}
          />
        </section>

        <section>
          <SectionHead title="排序" />
          <Segmented
            size="sm"
            options={[
              { value: 'score' as const, label: '相关度', icon: 'sort-desc' },
              { value: 'time' as const, label: '最新', icon: 'clock' },
            ]}
            value={filters.sort}
            onChange={(v) => onChange({ sort: v ?? 'score' })}
          />
        </section>
      </div>
    </div>
  );
}
