/**
 * 情报详情抽屉：摘要全文 + 打分明细（为什么这条值得读，一分一分摆出来）。
 */
import { useMemo, type JSX } from 'react';
import type { Item, Source } from '../lib/types';
import { KIND_META, absTime, cleanReason, relTime, signed } from '../lib/format';
import { displayTitle } from './ItemCard';
import { useCopy } from '../lib/hooks';
import { ScoreRing } from './charts';
import { Icon } from './Icon';
import { Drawer } from './Overlay';
import { Pill, SectionHead } from './primitives';

export function ItemDrawer({
  item,
  source,
  onClose,
}: {
  item: Item | null;
  source?: Source;
  onClose: () => void;
}): JSX.Element | null {
  const { copy, copied } = useCopy();

  const maxAbs = useMemo(() => {
    if (!item) return 1;
    return Math.max(1, ...item.scoreReasons.map((r) => Math.abs(r.delta)));
  }, [item]);

  if (!item) return null;

  const kind = KIND_META[item.kind];
  const sum = item.scoreReasons.reduce((s, r) => s + r.delta, 0);

  return (
    <Drawer
      open={item !== null}
      onClose={onClose}
      label="情报详情"
      width={600}
      header={
        <div className="flex min-w-0 items-center gap-2">
          <Pill
            color={kind.color}
            bg={`color-mix(in oklab, ${kind.color} 12%, transparent)`}
            border={`color-mix(in oklab, ${kind.color} 32%, transparent)`}
          >
            {kind.label}
          </Pill>
          <span className="truncate text-[11px] text-ink-3">{source?.label ?? item.sourceId}</span>
          <span className="shrink-0 text-[11px] text-ink-3">· {relTime(item.publishedAt)}</span>
        </div>
      }
      footer={
        <div className="flex items-center gap-2">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            className="btn btn-accent flex-1"
            title="在新标签页打开原文"
          >
            <Icon name="external" size={13} />
            打开原文
          </a>
          <button
            type="button"
            className="btn"
            onClick={() => void copy(item.url)}
            title="复制链接"
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} />
            {copied ? '已复制' : '复制链接'}
          </button>
        </div>
      }
    >
      <div className="px-4 pt-4 pb-5">
        <div className="flex items-start gap-4">
          <h2 className="min-w-0 flex-1 text-[16px] leading-[1.45] font-semibold tracking-[-0.01em] text-ink">
            {displayTitle(item, source)}
          </h2>
          <ScoreRing score={item.score} size={52} />
        </div>

        {item.authors.length > 0 ? (
          <p className="mt-1.5 text-[11.5px] text-ink-3">{item.authors.join(' · ')}</p>
        ) : null}

        <div className="mt-3.5 grid grid-cols-2 gap-x-3 gap-y-2 rounded-tile border border-line bg-sunken px-3 py-2.5 sm:grid-cols-5">
          <Meta label="发布" value={absTime(item.publishedAt)} />
          <Meta label="抓取" value={absTime(item.fetchedAt)} />
          {/* 源权重是打分里唯一"人为设定"的输入，单独露出来才解释得清为什么同主题分数不同 */}
          <Meta label="源权重" value={source ? `×${source.weight.toFixed(1)}` : '—'} mono />
          <Meta label="外部 ID" value={item.externalId ?? '—'} mono />
          <Meta label="条目 ID" value={item.id.slice(0, 12)} mono />
        </div>

        <section className="mt-5">
          <SectionHead title="摘要" hint={item.summary.includes('。') ? '中文原文' : '原文'} />
          <p className="text-[12.5px] leading-[1.75] whitespace-pre-wrap text-ink-2">{item.summary}</p>
        </section>

        <section className="mt-5">
          <SectionHead
            title="打分明细"
            hint={`合计 ${signed(sum)} → 归一化 ${Math.round(item.score)}`}
            right={
              <span className="text-[10px] text-ink-3">
                {item.scoreReasons.length} 条规则命中
              </span>
            }
          />
          <div className="divide-y divide-line rounded-tile border border-line">
            {item.scoreReasons.map((r) => (
              <div key={`${r.rule}-${r.detail}`} className="flex items-start gap-2.5 px-3 py-2">
                <span className="num mt-[2px] w-8 shrink-0 text-right text-[11px] tabular-nums" style={{ color: r.delta >= 0 ? 'var(--color-accent)' : 'var(--color-danger)' }}>
                  {signed(r.delta)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="num text-[10.5px] text-ink-3">{r.rule}</span>
                    <span className="text-[11.5px] leading-snug text-ink-2">{cleanReason(r.detail)}</span>
                  </div>
                  <div className="mt-1.5 h-[2px] w-full overflow-hidden rounded-full bg-track">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (Math.abs(r.delta) / maxAbs) * 100)}%`,
                        background: r.delta >= 0 ? 'var(--color-accent)' : 'var(--color-danger)',
                        opacity: 0.75,
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
            {item.scoreReasons.length === 0 ? (
              <div className="px-3 py-3 text-[11.5px] text-ink-3">这条没有留下打分理由（可能是旧数据）。</div>
            ) : null}
          </div>
        </section>

        {item.keywords.length > 0 ? (
          <section className="mt-5">
            <SectionHead title="关键词" />
            <div className="flex flex-wrap gap-1.5">
              {item.keywords.map((k) => (
                <span key={k} className="chip">
                  {k}
                </span>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </Drawer>
  );
}

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className={`mt-0.5 truncate text-[11.5px] text-ink-2 ${mono ? 'num' : ''}`} title={value}>
        {value}
      </div>
    </div>
  );
}
