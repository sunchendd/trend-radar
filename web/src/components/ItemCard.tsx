/**
 * 情报卡片：一眼看出「值不值得读」。
 * 结构固定为 元信息行 → 标题 → 关键词 → 两条打分理由，右侧相关度环。
 */
import { useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import type { Item, Source } from '../lib/types';
import { KIND_META, TONE_COLOR, absTime, cleanReason, relTime, scoreTone, signed } from '../lib/format';
import { useToastFns } from './Toast';
import { ScoreRing } from './charts';
import { Icon } from './Icon';
import { Pill } from './primitives';
import { openExternal } from '../lib/hooks';
import { getListLang, subscribeListLang } from '../lib/lang';

/**
 * release 类条目的标题常常只是版本号（「v0.5.22」），单独显示毫无信息量。
 * 这种情况补上来源名，让卡片标题自解释。
 */
const VERSION_LIKE = /^v?\d+(\.\d+)+([-.+][\w.+]+)*$/i;

export function displayTitle(item: Item, source?: Source): string {
  const t = item.title.trim();
  if (VERSION_LIKE.test(t)) return `${source?.label ?? item.sourceId} · ${t}`;
  return item.title;
}

export function ItemCard({
  item,
  source,
  active,
  onOpen,
  onOpenReader,
}: {
  item: Item;
  source?: Source;
  active?: boolean;
  onOpen: (item: Item) => void;
  /** 论文条目提供时，卡片右上角多一个「阅读全文」入口（进 PDF 阅读器） */
  onOpenReader?: (item: Item) => void;
}): JSX.Element {
  const kind = KIND_META[item.kind];
  const tone = scoreTone(item.score);
  const reasons = item.scoreReasons.slice(0, 2);
  const keywords = item.keywords.slice(0, 5);
  const restKeywords = item.keywords.length - keywords.length;
  const toast = useToastFns();
  // 中文视图：有译文用译文，没有回落原文（不给空态）
  const lang = useSyncExternalStore(subscribeListLang, getListLang);
  const useZh = lang === 'zh' && item.titleZh !== undefined;
  const title = useZh && item.titleZh ? item.titleZh : displayTitle(item, source);
  const summaryText = useZh && item.summaryZh ? item.summaryZh : item.summary;

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`${title}，相关度 ${Math.round(item.score)}`}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(item);
        }
      }}
      className="card card-lift group relative cursor-pointer overflow-hidden px-4 py-3.5 outline-none focus-visible:border-accent/60"
      style={active ? { borderColor: 'color-mix(in oklab, var(--color-accent) 45%, transparent)' } : undefined}
    >
      {/* 左侧相关度色条 */}
      <span
        aria-hidden="true"
        className="absolute top-4 bottom-4 left-0 w-[2px] rounded-r-full transition-opacity"
        style={{ background: TONE_COLOR[tone], opacity: active ? 1 : 0.6 }}
      />

      <div className="flex gap-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Pill
              color={kind.color}
              bg={`color-mix(in oklab, ${kind.color} 12%, transparent)`}
              border={`color-mix(in oklab, ${kind.color} 32%, transparent)`}
            >
              {kind.label}
            </Pill>
            <span className="inline-flex min-w-0 items-center gap-1 text-[10.5px] text-ink-3">
              <Icon name="antenna" size={10.5} className="shrink-0 opacity-70" />
              <span className="truncate">{source?.label ?? item.sourceId}</span>
            </span>
            <span className="text-[10.5px] text-ink-3" title={absTime(item.publishedAt)}>
              · {relTime(item.publishedAt)}
            </span>
            {item.externalId ? (
              <span className="num hidden text-[10px] text-ink-3/80 sm:inline">{item.externalId}</span>
            ) : null}
          </div>

          <h3 className="clamp-2 mt-1.5 text-[13.5px] leading-[1.5] font-medium tracking-[-0.005em] text-ink transition-colors group-hover:text-ink">
            {title}
            {useZh ? <span className="ml-1 align-middle text-[9px] font-normal text-ink-3/70">译</span> : null}
          </h3>

          {reasons.length > 0 ? (
            <ul className="mt-2 space-y-[3px]">
              {reasons.map((r) => (
                <li key={`${r.rule}-${r.detail}`} className="flex items-baseline gap-1.5 text-[10.5px] leading-[1.5]">
                  <span
                    className="num shrink-0 tabular-nums"
                    style={{ color: r.delta >= 0 ? 'var(--color-accent)' : 'var(--color-danger)' }}
                  >
                    {signed(r.delta)}
                  </span>
                  <span className="truncate text-ink-2">{cleanReason(r.detail)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="clamp-2 mt-2 text-[11px] leading-relaxed text-ink-3">{summaryText}</p>
          )}

          {keywords.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-1">
              {keywords.map((k) => (
                <span key={k} className="chip">
                  {k}
                </span>
              ))}
              {restKeywords > 0 ? <span className="text-[10px] text-ink-3">+{restKeywords}</span> : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end justify-between gap-2">
          <ScoreRing score={item.score} size={42} />
          <div className="flex items-center gap-0.5">
            {item.kind === 'paper' && onOpenReader !== undefined ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenReader(item);
                }}
                title="阅读全文（PDF 阅读器）"
                aria-label="阅读全文"
                className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-fill-2 hover:text-accent"
              >
                <Icon name="book" size={13} />
              </button>
            ) : null}
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => {
                // 侧边栏 sandbox 无 allow-popups：默认跳转会被静默拦截。
                // 交给 openExternal 处理（能开则开，不能开降级复制链接）。
                e.preventDefault();
                e.stopPropagation();
                openExternal(item.url, toast);
              }}
              title="打开原文（新标签）"
              aria-label="打开原文"
              className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-fill-2 hover:text-accent"
            >
              <Icon name="external" size={13} />
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}
