/**
 * 选题工作台：左侧选题列表 + 右侧详情。
 * 生成走 /api/ideas/generate（LLM 未配置会明确报 503，不会假装成功）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  addNovelty,
  archiveIdea,
  autoNovelty,
  createIdea,
  friendlyError,
  generateIdeas,
  listClusters,
  listIdeas,
  patchIdea,
  toApiError,
  type ApiError,
} from '../lib/api';
import { STATUS_META, VERDICT_META, bandOf, relTime, summaryOf } from '../lib/format';
import { useHotkeys, useMediaQuery, type Route, type RouteName } from '../lib/hooks';
import type { IdeaClusterSummary, IdeaStatus, IdeaWithVerdict } from '../lib/types';
import { IdeaDetail, type NoveltyInput } from '../components/IdeaDetail';
import { Icon } from '../components/Icon';
import { IdeaDetailSkeleton, GeneratingSkeleton, ListRowSkeleton } from '../components/Skeleton';
import { EmptyState, ErrorState } from '../components/States';
import { useToastFns } from '../components/Toast';
import { Modal } from '../components/Overlay';
import { Pill, Segmented, Spinner, StatusBadge } from '../components/primitives';

const STATUS_ORDER: IdeaStatus[] = ['draft', 'verified', 'red-ocean', 'archived'];

export function IdeasPage({
  route,
  navigate,
  liveNonce,
  liveIdea,
}: {
  /** 当前路由：支持 /#/ideas?idea=<id> 直接选中某条（巡检页「出选题」跳过来时用） */
  route: Route;
  navigate: (n: RouteName, params?: Record<string, string>) => void;
  liveNonce: number;
  /** SSE idea 帧：就地更新那一条，不整表重取 */
  liveIdea: IdeaWithVerdict | null;
}): JSX.Element {
  const toast = useToastFns();
  const wide = useMediaQuery('(min-width: 1024px)');
  // 窄屏默认停在列表：只有点了某一条（或刚生成）才进详情
  const wideRef = useRef(wide);
  wideRef.current = wide;

  const [ideas, setIdeas] = useState<IdeaWithVerdict[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => route.params.get('idea'));
  const [statusFilter, setStatusFilter] = useState<IdeaStatus | 'all'>('all');
  const [nonce, setNonce] = useState(0);
  /** 同方向选题的聚类摘要：ideaId → 所属簇（只有 size>1 才展示徽标） */
  const [clusterOf, setClusterOf] = useState<Record<string, { label: string; size: number; titles: string[] }>>({});

  const [focus, setFocus] = useState('');
  const [count, setCount] = useState<'1' | '2' | '3'>('2');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<ApiError | null>(null);

  // 手工新建：LLM 不可用（未配 key）或想自己写一条时的唯一入口
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ title: '', problem: '', solution: '', effect: '' });
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const [statusBusy, setStatusBusy] = useState(false);
  const [noveltyBusy, setNoveltyBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listIdeas()
      .then((list) => {
        if (cancelled) return;
        setIdeas(list);
        setError(null);
        setSelectedId((prev) => {
          if (prev && list.some((i) => i.id === prev)) return prev;
          if (!wideRef.current) return null;
          const first = list.find((i) => i.status !== 'archived') ?? list[0];
          return first ? first.id : null;
        });
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
  }, [nonce]);

  // 聚类是"辅助信息"：拿不到就不显示徽标，绝不能让它把工作台整体拖垮
  useEffect(() => {
    let cancelled = false;
    listClusters()
      .then((clusters: IdeaClusterSummary[]) => {
        if (cancelled) return;
        const map: Record<string, { label: string; size: number; titles: string[] }> = {};
        for (const cluster of clusters) {
          if (cluster.size <= 1) continue;
          for (const id of cluster.ideaIds) {
            map[id] = { label: cluster.label, size: cluster.size, titles: cluster.titles };
          }
        }
        setClusterOf(map);
      })
      .catch(() => {
        if (!cancelled) setClusterOf({});
      });
    return () => {
      cancelled = true;
    };
  }, [nonce, ideas.length]);

  const selected = useMemo(() => ideas.find((i) => i.id === selectedId) ?? null, [ideas, selectedId]);

  const counts = useMemo(() => {
    const c: Record<IdeaStatus, number> = { draft: 0, verified: 0, 'red-ocean': 0, archived: 0 };
    for (const i of ideas) c[i.status] += 1;
    return c;
  }, [ideas]);

  /** 与 /api/stats 口径一致：KPI 不含归档（软删） */
  const activeCount = ideas.length - counts.archived;

  const visible = useMemo(
    () => (statusFilter === 'all' ? ideas : ideas.filter((i) => i.status === statusFilter)),
    [ideas, statusFilter],
  );

  // SSE idea 帧：就地更新（含 verdictSummary），列表位置与选中项都不跳
  useEffect(() => {
    if (!liveIdea) return;
    setIdeas((prev) => {
      const exists = prev.some((i) => i.id === liveIdea.id);
      if (!exists) return [liveIdea, ...prev];
      return prev.map((i) => (i.id === liveIdea.id ? liveIdea : i));
    });
  }, [liveIdea]);

  const focusSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const i of ideas) if (i.focus) set.add(i.focus);
    return [...set].slice(0, 4);
  }, [ideas]);

  const replaceIdea = useCallback((next: IdeaWithVerdict) => {
    setIdeas((prev) => prev.map((i) => (i.id === next.id ? next : i)));
  }, []);

  // ---------------------------------------------------------------- 生成

  const onManualCreate = useCallback(async () => {
    setManualBusy(true);
    setManualError(null);
    try {
      const idea = await createIdea({
        title: manual.title,
        problem: manual.problem,
        solution: manual.solution,
        effect: manual.effect,
        focus: focus.trim() || undefined,
      });
      setIdeas((prev) => [idea, ...prev]);
      setSelectedId(idea.id);
      setManualOpen(false);
      setManual({ title: '', problem: '', solution: '', effect: '' });
      toast.ok('已创建手工选题', '记得先查新再改状态');
    } catch (err) {
      const api = toApiError(err);
      setManualError(api.message || '创建失败');
    } finally {
      setManualBusy(false);
    }
  }, [focus, manual, toast]);

  const onGenerate = useCallback(async () => {
    const f = focus.trim();
    if (!f) {
      toast.warn('先写一个聚焦方向', '例如「投机解码 接受率」「KV Cache 卸载」。');
      return;
    }
    setGenerating(true);
    setGenError(null);
    try {
      const res = await generateIdeas({ focus: f, count: Number(count) });
      setIdeas((prev) => [...res.ideas, ...prev]);
      const first = res.ideas[0];
      if (first) setSelectedId(first.id);
      setStatusFilter('all');
      toast.ok(
        `生成 ${res.ideas.length} 条选题`,
        `依据 ${res.usedItems.length} 条情报 · focus「${f}」— 记得逐条查新后再改状态。`,
      );
    } catch (err) {
      const apiErr = toApiError(err);
      setGenError(apiErr);
      const fr = friendlyError(apiErr);
      toast.error(fr.title, fr.hint);
    } finally {
      setGenerating(false);
    }
  }, [count, focus, toast]);

  useHotkeys([
    {
      key: 'escape',
      allowInInput: true,
      run: () => {
        if (!wide) setSelectedId(null);
      },
    },
  ]);

  // ---------------------------------------------------------------- 状态变更

  const changeStatus = useCallback(
    async (status: IdeaStatus) => {
      if (!selected || statusBusy) return;
      setStatusBusy(true);
      try {
        if (status === 'archived') {
          await archiveIdea(selected.id);
          replaceIdea({ ...selected, status: 'archived', updatedAt: new Date().toISOString() });
          toast.ok('已归档', '可以随时「取消归档」回到草稿。');
        } else {
          const next = await patchIdea(selected.id, { status });
          replaceIdea(next);
          toast.ok(`状态已改为「${STATUS_META[status].label}」`, STATUS_META[status].desc);
        }
      } catch (err) {
        const f = friendlyError(err);
        toast.error(f.title, f.hint);
      } finally {
        setStatusBusy(false);
      }
    },
    [replaceIdea, selected, statusBusy, toast],
  );

  // ---------------------------------------------------------------- 查新

  const submitNovelty = useCallback(
    async (input: NoveltyInput): Promise<boolean> => {
      if (!selected || noveltyBusy) return false;
      setNoveltyBusy(true);
      try {
        const next = await addNovelty(selected.id, {
          query: input.query,
          hits: input.hits,
          ...(input.topAssignees ? { topAssignees: input.topAssignees } : {}),
          ...(input.note ? { note: input.note } : {}),
          site: 'manual',
        });
        replaceIdea(next);
        const s = next.verdictSummary;
        toast.ok(
          input.hits === null ? '已登记（解析失败）' : `已登记：${input.hits} 命中`,
          `判读：${s.headline}${s.suggestions[0] ? ` · ${s.suggestions[0]}` : ''}`,
        );
        return true;
      } catch (err) {
        const f = friendlyError(err);
        toast.error(f.title, f.hint);
        return false;
      } finally {
        setNoveltyBusy(false);
      }
    },
    [noveltyBusy, replaceIdea, selected, toast],
  );

  const onAutoNovelty = useCallback(async () => {
    if (!selected || autoBusy) return;
    setAutoBusy(true);
    try {
      const next = await autoNovelty(selected.id, selected.queries);
      replaceIdea(next);
      toast.ok('自动查新完成', `已回填 ${next.novelty.length} 条记录。`);
    } catch (err) {
      const f = friendlyError(err);
      toast.error(f.title, f.hint);
    } finally {
      setAutoBusy(false);
    }
  }, [autoBusy, replaceIdea, selected, toast]);

  // ---------------------------------------------------------------- 渲染

  const listPanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Icon name="bulb" size={14} className="text-ink-3" />
        <span className="text-[12.5px] font-medium text-ink">选题</span>
        <span className="num text-[10.5px] text-ink-3" title="选题（不含归档）：归档是软删，不进 KPI">
          {activeCount}
        </span>
        <span className="text-[9.5px] text-ink-3/80">不含归档</span>
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-ink-3 transition-colors hover:bg-white/5 hover:text-ink"
          title="刷新列表"
          aria-label="刷新列表"
        >
          <Icon name="refresh" size={12} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-line px-2.5 py-1.5">
        <FilterChip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} label="全部" count={ideas.length} />
        {STATUS_ORDER.map((s) => (
          <FilterChip
            key={s}
            active={statusFilter === s}
            onClick={() => setStatusFilter(s)}
            label={STATUS_META[s].label}
            count={counts[s]}
            color={STATUS_META[s].color}
          />
        ))}
      </div>

      <div className="scroll-area min-h-0 flex-1 overflow-y-auto">
        {loading && ideas.length === 0 ? (
          <>
            <ListRowSkeleton />
            <ListRowSkeleton />
            <ListRowSkeleton />
            <ListRowSkeleton />
          </>
        ) : visible.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11.5px] text-ink-3">
            {ideas.length === 0 ? '还没有选题 —— 用上面的表单生成第一批。' : '这个状态下没有选题。'}
          </div>
        ) : (
          visible.map((idea) => (
            <IdeaRow
              key={idea.id}
              idea={idea}
              active={idea.id === selectedId}
              {...(clusterOf[idea.id] ? { cluster: clusterOf[idea.id] } : {})}
              onClick={() => setSelectedId(idea.id)}
            />
          ))
        )}
      </div>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-[1440px] px-3 py-3.5 md:px-5 md:py-4">
      {/* 生成表单 */}
      <form
        className="card px-3.5 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void onGenerate();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Icon name="bolt" size={14} className="text-accent" />
          <span className="text-[12.5px] font-medium text-ink">生成选题</span>
          <span className="text-[10.5px] text-ink-3">从近期高相关情报提炼一条可查新的中国发明专利选题</span>
          {genError ? (
            <span className="ml-auto text-[10.5px] text-warn">
              {friendlyError(genError).title}
            </span>
          ) : null}
        </div>

        <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <input
              className="input h-9 pr-3 pl-3 text-[12.5px]"
              placeholder="聚焦方向，例如：投机解码 接受率 / KV Cache 卸载"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              aria-label="聚焦方向"
              maxLength={80}
            />
          </div>
          <div className="flex items-center gap-2">
            <Segmented
              size="sm"
              options={[
                { value: '1' as const, label: '1 条' },
                { value: '2' as const, label: '2 条' },
                { value: '3' as const, label: '3 条' },
              ]}
              value={count}
              onChange={(v) => setCount(v ?? '1')}
            />
            <button
              type="button"
              className="btn h-9 px-3"
              onClick={() => setManualOpen(true)}
              title="不依赖 LLM，自己写一条选题进工作台（同样要查新）"
            >
              <Icon name="plus" size={13} />
              手工新建
            </button>
            <button type="submit" className="btn btn-accent h-9 px-3.5" disabled={generating}>
              {generating ? <Spinner size={13} /> : <Icon name="flask" size={13} />}
              {generating ? '生成中…' : '生成'}
            </button>
          </div>
        </div>

        {focusSuggestions.length > 0 && !focus ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-ink-3">用过：</span>
            {focusSuggestions.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFocus(f)}
                className="chip transition-colors hover:border-accent/40 hover:text-accent"
              >
                {f}
              </button>
            ))}
          </div>
        ) : null}
      </form>

      <Modal open={manualOpen} onClose={() => setManualOpen(false)} label="手工新建选题">
        <div className="px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Icon name="doc" size={14} className="text-accent" />
            <span className="text-[13px] font-medium text-ink">手工新建选题</span>
            <span className="text-[10.5px] text-ink-3">不经过 LLM；字段要求与生成结果一致，保存后同样要查新</span>
          </div>
          <div className="mt-3 grid gap-2">
            {([
              ['title', '发明名称', '最少 6 字，例如：一种 KV 缓存分级传输方法'],
              ['problem', '技术问题', '现有技术的缺陷，最少 10 字'],
              ['solution', '技术方案', '多条相互配合的技术手段，最少 20 字'],
              ['effect', '有益效果', '量化口径，例如：传输字节数降低 50%'],
            ] as const).map(([key, label, placeholder]) => (
              <label key={key} className="grid gap-1">
                <span className="text-[10.5px] text-ink-3">{label}</span>
                <textarea
                  className="input min-h-[62px] resize-y px-2.5 py-1.5 text-[12px]"
                  placeholder={placeholder}
                  value={manual[key]}
                  onChange={(e) => setManual((prev) => ({ ...prev, [key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          {manualError ? <p className="mt-2 text-[11px] text-warn">{manualError}</p> : null}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button type="button" className="btn h-8 px-3 text-[11.5px]" onClick={() => setManualOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-accent h-8 px-3 text-[11.5px]"
              disabled={manualBusy}
              onClick={() => void onManualCreate()}
            >
              {manualBusy ? <Spinner size={12} /> : <Icon name="check" size={12} />}
              保存
            </button>
          </div>
        </div>
      </Modal>

      {/* 列表 + 详情 */}
      <div className="mt-3 flex gap-3 lg:gap-4">
        <aside
          className={`shrink-0 ${wide ? 'block w-[318px]' : selected ? 'hidden' : 'block w-full'}`}
        >
          <div className="card h-[calc(100dvh-232px)] max-h-[860px] min-h-[320px] overflow-hidden">
            {listPanel}
          </div>
        </aside>

        <main className={`min-w-0 flex-1 ${wide ? 'block' : selected ? 'block' : 'hidden'}`}>
          <div className="card h-[calc(100dvh-232px)] max-h-[860px] min-h-[320px] overflow-hidden">
            {generating && !selected ? (
              <div className="p-4">
                <GeneratingSkeleton />
              </div>
            ) : loading && !selected ? (
              <IdeaDetailSkeleton />
            ) : error && ideas.length === 0 ? (
              <div className="p-4">
                <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} retrying={loading} />
              </div>
            ) : selected ? (
              <IdeaDetail
                idea={selected}
                statusBusy={statusBusy}
                noveltyBusy={noveltyBusy}
                autoBusy={autoBusy}
                onStatus={(s) => void changeStatus(s)}
                onSubmitNovelty={submitNovelty}
                onAutoNovelty={() => void onAutoNovelty()}
                onCite={(id) => navigate('feed', { item: id })}
                {...(wide ? {} : { onBack: () => setSelectedId(null) })}
              />
            ) : (
              <div className="p-4">
                <EmptyState
                  icon="bulb"
                  title="选一条选题看详情"
                  hint="左侧列表里点任意一条；或者在上面的表单里填一个方向，让 LLM 先起个草稿。"
                />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 小组件

function FilterChip({
  active,
  onClick,
  label,
  count,
  color,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  color?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[10.5px] transition-colors ${
        active ? 'bg-raised text-ink' : 'text-ink-3 hover:bg-white/[0.03] hover:text-ink-2'
      }`}
      style={active ? { boxShadow: 'inset 0 0 0 1px var(--color-line-strong)' } : undefined}
    >
      {color ? <span className="inline-block h-[5px] w-[5px] rounded-full" style={{ background: color }} /> : null}
      {label}
      <span className="num opacity-60">{count}</span>
    </button>
  );
}

function IdeaRow({
  idea,
  active,
  cluster,
  onClick,
}: {
  idea: IdeaWithVerdict;
  active: boolean;
  /** 同方向聚类摘要；只有簇内 ≥2 条时才有值 */
  cluster?: { label: string; size: number; titles: string[] };
  onClick: () => void;
}): JSX.Element {
  const summary = summaryOf(idea);
  const vm = VERDICT_META[summary.verdict];
  const sparse = idea.novelty.filter((r) => bandOf(r.hits) === 'sparse').length;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`relative block w-full border-b border-line px-3 py-2.5 text-left transition-colors ${
        active ? 'bg-white/[0.045]' : 'hover:bg-white/[0.025]'
      }`}
    >
      <span
        className="absolute top-2.5 bottom-2.5 left-0 w-[2px] rounded-r-full"
        style={{ background: active ? STATUS_META[idea.status].color : 'transparent' }}
      />
      <div className="flex items-center gap-1.5">
        <StatusBadge status={idea.status} size="sm" />
        <span className="num ml-auto text-[9.5px] text-ink-3">{relTime(idea.updatedAt)}</span>
      </div>
      <div className="clamp-2 mt-1 text-[12px] leading-[1.5] text-ink">{idea.title}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9.5px] text-ink-3">
        <Pill color={vm.color} bg={vm.bg} border={vm.border} title={vm.hint} className="max-w-full">
          <span className="truncate">{summary.headline}</span>
        </Pill>
        {cluster ? (
          <span
            className="rounded border border-accent/35 bg-accent/[0.08] px-1.5 py-[1px] text-[9.5px] text-accent"
            title={`同方向 ${cluster.size} 条：\n${cluster.titles.join('\n')}`}
          >
            同方向 ×{cluster.size}
            {cluster.label ? ` · ${cluster.label}` : ''}
          </span>
        ) : null}
        <span className="num">{idea.novelty.length} 查新</span>
        {sparse > 0 ? <span className="num text-accent/80">{sparse} 稀疏</span> : null}
        {idea.cites.length > 0 ? <span className="num">引 {idea.cites.length}</span> : null}
      </div>
    </button>
  );
}
