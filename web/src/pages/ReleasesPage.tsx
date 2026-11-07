/**
 * 工程动态页（t21）：GitHub Releases 独立于新闻页的专属视图。
 *
 * 卡片 = 仓库 + 版本 + 技术点分类标签 + 中文要点 bullets + 原文链接 + 发版时间；
 * KPI = 今日发版数 / 技术点总数 / 待抽取。抽取是懒触发：进页面发现有待抽取
 * 就后台跑一轮（LLM 优先、无 LLM 走规则兜底），跑完自动刷新列表。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { ExtractionStatus, Item, Source } from '../lib/types';
import { getExtractionStatus, listItems, listSources, runExtraction, type ApiError } from '../lib/api';
import { relTime } from '../lib/format';
import { useAppSettings } from '../lib/hooks';
import { Icon } from '../components/Icon';
import { Pill, SectionHead, Spinner } from '../components/primitives';
import { StatBar } from '../components/StatBar';
import { useToastFns } from '../components/Toast';

const PAGE_LIMIT = 60;
const CATEGORY_COLOR: Record<string, string> = {
  调度: 'var(--color-accent)',
  KV: '#38bdf8',
  投机: '#a78bfa',
  量化: '#f59e0b',
  算子: '#34d399',
  并行: '#f472b6',
  硬件: '#fb7185',
  其他: 'var(--color-ink-3)',
};

/** repo 名从 source label / item 标题推断（vLLM Releases → vLLM；版本从标题 [vX.Y.Z] 提取） */
function versionOf(title: string): string | null {
  const m = /\bv?\d+(?:\.\d+)+(?:[-.\w]*)?/.exec(title);
  return m ? m[0] : null;
}

function ReleaseCard({ item, source }: { item: Item; source?: Source }): JSX.Element {
  const version = versionOf(item.title);
  const repo = source?.label ?? item.sourceId.replace(/^github-|-releases$/g, '');
  const points = item.pointsZh ?? [];
  return (
    <article className="card card-lift px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-2">
          <Icon name="bolt" size={11} className="shrink-0 opacity-70" />
          <span className="truncate">{repo}</span>
        </span>
        {version ? (
          <span className="num rounded-md border border-line bg-sunken px-1.5 py-0.5 text-[10px] text-ink-2">{version}</span>
        ) : null}
        <span className="text-[10.5px] text-ink-3">· {relTime(item.publishedAt)}</span>
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-ink-3 transition-colors hover:text-accent"
          title="在浏览器打开 release（新窗口）"
          onClick={(e) => e.stopPropagation()}
        >
          <Icon name="external" size={12} />
          原文
        </a>
      </div>

      <h3 className="mt-1.5 text-[13.5px] leading-[1.5] font-medium tracking-[-0.005em] text-ink">{item.titleZh ?? item.title}</h3>

      {points.length > 0 ? (
        <>
          <div className="mt-2 flex flex-wrap gap-1">
            {[...new Set(points.map((p) => p.category))].map((category) => (
              <Pill
                key={category}
                color={CATEGORY_COLOR[category] ?? 'var(--color-ink-3)'}
                bg={`color-mix(in oklab, ${CATEGORY_COLOR[category] ?? 'var(--color-ink-3)'} 10%, transparent)`}
                border={`color-mix(in oklab, ${CATEGORY_COLOR[category] ?? 'var(--color-ink-3)'} 30%, transparent)`}
              >
                {category}
              </Pill>
            ))}
          </div>
          <ul className="mt-2 space-y-[3px]">
            {points.slice(0, 5).map((point, index) => (
              <li key={`${point.category}-${index}`} className="flex items-baseline gap-1.5 text-[11px] leading-[1.6]">
                <span className="num shrink-0 text-[9.5px]" style={{ color: CATEGORY_COLOR[point.category] ?? 'var(--color-ink-3)' }}>
                  {point.category}
                </span>
                <span className="text-ink-2">{point.zh}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 clamp-2 text-[11px] leading-relaxed text-ink-3">
          {item.summaryZh ?? (item.summary || '（无正文）')}
        </p>
      )}
    </article>
  );
}

export function ReleasesPage({ demo, liveNonce }: { demo: boolean; liveNonce: number }): JSX.Element {
  const toast = useToastFns();
  const settings = useAppSettings();
  const [items, setItems] = useState<Item[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [status, setStatus] = useState<ExtractionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [nonce, setNonce] = useState(0);
  const triggeredRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [paged, sourceList] = await Promise.all([
        listItems({ kinds: ['release'], sort: 'time', limit: PAGE_LIMIT, offset: 0 }),
        listSources(),
      ]);
      setItems(paged.items);
      setSources(sourceList);
      setError(null);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await getExtractionStatus());
    } catch {
      // 状态拿不到不打断页面
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load();
    void refreshStatus();
  }, [load, refreshStatus, nonce, liveNonce]);

  // 懒触发：进页面发现有待抽取 → 后台跑一轮（幂等，抽过的跳过），轮询到完成
  useEffect(() => {
    if (demo || triggeredRef.current || status === null) return;
    if (status.pending <= 0 || !status.enabled) return;
    triggeredRef.current = true;
    setExtracting(true);
    void (async () => {
      try {
        const result = await runExtraction();
        if (result.extracted > 0) {
          toast.ok(`已抽取 ${result.extracted} 个 release 的技术点`, `LLM ${result.viaLlm} · 规则 ${result.viaRules}${result.failed > 0 ? ` · 失败 ${result.failed}` : ''}`);
        }
      } catch {
        // 静默：状态行会显示 lastError
      } finally {
        setExtracting(false);
        setNonce((v) => v + 1);
      }
    })();
  }, [demo, status, toast]);

  // 抽取轮询：进行中每 5s 刷新状态（完成后上面的 nonce 变化会重拉列表）
  useEffect(() => {
    if (!extracting) return;
    const timer = setInterval(() => void refreshStatus(), 5_000);
    return () => clearInterval(timer);
  }, [extracting, refreshStatus]);

  const kpiCards = useMemo(
    () => [
      { label: '今日发版', value: status?.todayReleases ?? 0 },
      { label: '技术点总数', value: status?.pointsTotal ?? 0 },
      { label: '待抽取', value: status?.pending ?? 0 },
      { label: '今日额度已用', value: `${status?.usedToday ?? 0}/${status?.dailyLimit ?? '—'}` },
    ],
    [status],
  );

  const onManualExtract = useCallback(async () => {
    setExtracting(true);
    try {
      const result = await runExtraction();
      toast.ok(`抽取完成 ${result.extracted} 条`, `LLM ${result.viaLlm} · 规则 ${result.viaRules}${result.failed > 0 ? ` · 失败 ${result.failed}` : ''}`);
    } catch (err) {
      const f = (err as ApiError)?.message ?? String(err);
      toast.error('触发失败', f);
    } finally {
      setExtracting(false);
      setNonce((v) => v + 1);
      void refreshStatus();
    }
  }, [refreshStatus, toast]);

  const sourceMap = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  return (
    <div className="mx-auto flex w-full max-w-[1240px] gap-4 px-3 py-3.5 md:px-5 md:py-4">
      <div className="min-w-0 flex-1">
        <SectionHead
          title="工程动态"
          hint="GitHub Releases 的技术要点：LLM 抽取优先，无 LLM 走规则兜底；与翻译共用每日配额"
          right={
            <div className="flex items-center gap-2">
              {extracting ? <Spinner size={12} /> : null}
              <button type="button" className="btn h-7 text-[11px]" onClick={() => void onManualExtract()} disabled={extracting}>
                {extracting ? '抽取中…' : '抽取最新'}
              </button>
            </div>
          }
        />
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {kpiCards.map((card) => (
            <div key={card.label} className="rounded-tile border border-line bg-sunken px-3 py-2">
              <p className="text-[10px] text-ink-3">{card.label}</p>
              <p className="num mt-0.5 text-[16px] font-medium text-ink">{card.value}</p>
            </div>
          ))}
        </div>
        {status?.lastError ? (
          <p className="mt-1.5 text-[10px] text-warn">上次抽取错误：{status.lastError.slice(0, 120)}</p>
        ) : null}
        {!settings.data?.translation.enabled ? (
          <p className="mt-1.5 text-[10px] text-ink-3">自动处理已在设置页关闭：列表仍可浏览，但不会新增抽取。</p>
        ) : null}

        <div className="mt-3 space-y-2.5">
          {loading ? (
            <div className="card flex items-center gap-2 p-4 text-[12px] text-ink-3">
              <Spinner size={13} /> 正在加载发版…
            </div>
          ) : error !== null ? (
            <div className="card p-4 text-[12px] text-warn">加载失败：{error.message}</div>
          ) : items.length === 0 ? (
            <div className="card p-4 text-[12px] text-ink-3">还没有 release 数据：点右上角「抽取最新」或在信源页跑一轮采集。</div>
          ) : (
            items.map((item) => <ReleaseCard key={item.id} item={item} source={sourceMap.get(item.sourceId)} />)
          )}
        </div>
      </div>
    </div>
  );
}
