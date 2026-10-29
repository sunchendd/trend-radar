/**
 * 信源与日志：源的启停/权重/备注，以及采集运行记录。
 * 所有写操作都做乐观更新 + 失败回滚，避免"点了没反应"。
 */
import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import {
  createSource,
  deleteSource,
  friendlyError,
  listRuns,
  listSources,
  patchSource,
  toApiError,
  type ApiError,
} from '../lib/api';
import { absTime, relTime, runDuration } from '../lib/format';
import type { RunRecord, Source, SourceKind } from '../lib/types';
import { Icon } from '../components/Icon';
import { Drawer } from '../components/Overlay';
import { ListRowSkeleton, Skeleton } from '../components/Skeleton';
import { EmptyState, ErrorState } from '../components/States';
import { useToastFns } from '../components/Toast';
import { Pill, Slider, Spinner, Toggle } from '../components/primitives';

const KIND_COLOR: Record<SourceKind, string> = {
  arxiv: '#7aa7f7',
  atom: '#f2b357',
  rss: '#9caeb4',
};

export function SystemPage({ liveNonce }: { liveNonce: number }): JSX.Element {
  const toast = useToastFns();

  const [sources, setSources] = useState<Source[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([listSources(), listRuns()])
      .then(([s, r]) => {
        if (cancelled) return;
        setSources(s);
        setRuns(r);
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
  }, [nonce]);

  useEffect(() => {
    if (liveNonce > 0) setNonce((n) => n + 1);
  }, [liveNonce]);

  const lastErrorBySource = useMemo(() => {
    const m = new Map<string, { message: string; at: string }>();
    for (const run of runs) {
      for (const e of run.errors) {
        if (!m.has(e.sourceId)) m.set(e.sourceId, { message: e.message, at: run.startedAt });
      }
    }
    return m;
  }, [runs]);

  const patch = useCallback(
    async (id: string, body: { enabled?: boolean; weight?: number; note?: string }) => {
      const before = sources;
      setSources((prev) => prev.map((s) => (s.id === id ? { ...s, ...body } : s)));
      setBusyId(id);
      try {
        const next = await patchSource(id, body);
        setSources((prev) => prev.map((s) => (s.id === id ? next : s)));
      } catch (err) {
        setSources(before);
        const f = friendlyError(err);
        toast.error(f.title, f.hint);
      } finally {
        setBusyId(null);
      }
    },
    [sources, toast],
  );

  const onDelete = useCallback(
    async (id: string) => {
      const before = sources;
      setSources((prev) => prev.filter((s) => s.id !== id));
      setConfirmDelete(null);
      try {
        await deleteSource(id);
        toast.ok('已删除信源', '该源的条目会保留并标记为 orphan。');
      } catch (err) {
        setSources(before);
        const f = friendlyError(err);
        toast.error(f.title, f.hint);
      }
    },
    [sources, toast],
  );

  const enabled = sources.filter((s) => s.enabled).length;
  const lastRun = runs[0];
  const failures = runs.filter((r) => r.errors.length > 0).length;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-3 py-3.5 md:px-5 md:py-4">
      {error && sources.length === 0 ? (
        <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} retrying={loading} />
      ) : null}

      {/* 概览 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MiniStat label="信源" value={`${enabled}/${sources.length}`} hint="启用 / 全部" loading={loading} />
        <MiniStat
          label="上次采集"
          value={lastRun ? relTime(lastRun.startedAt).replace(/前$/, '') : '—'}
          hint={lastRun ? `${lastRun.sourceCount} 源 · ${runDuration(lastRun)}` : '暂无记录'}
          loading={loading}
        />
        <MiniStat
          label="近 20 次失败"
          value={String(failures)}
          hint={failures === 0 ? '全部成功' : '存在源报错，见下表展开'}
          loading={loading}
          tone={failures > 0 ? 'warn' : 'ok'}
        />
        <MiniStat
          label="近 20 次新增"
          value={String(runs.reduce((s, r) => s + r.added, 0))}
          hint={`抓取 ${runs.reduce((s, r) => s + r.fetched, 0)} 条`}
          loading={loading}
        />
      </div>

      {/* 信源 */}
      <section className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-ink">信源</h2>
          <span className="text-[10.5px] text-ink-3">权重参与相关度打分（0.1–3）</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setNonce((n) => n + 1)}
              className="btn btn-ghost h-7 px-2 text-[11px]"
              disabled={loading}
            >
              <Icon name="refresh" size={12} />
              刷新
            </button>
            <button type="button" className="btn h-7 px-2 text-[11px]" onClick={() => setAddOpen(true)}>
              <Icon name="plus" size={12} />
              添加信源
            </button>
          </div>
        </div>

        {loading && sources.length === 0 ? (
          <div className="card divide-y divide-line overflow-hidden">
            <ListRowSkeleton />
            <ListRowSkeleton />
            <ListRowSkeleton />
          </div>
        ) : sources.length === 0 ? (
          <EmptyState
            icon="antenna"
            title="还没有信源"
            hint="添加一个 arXiv API 地址或 RSS 订阅；后端会先探活再入库，探活失败会直接报 422。"
            action={
              <button type="button" className="btn btn-accent" onClick={() => setAddOpen(true)}>
                <Icon name="plus" size={13} />
                添加信源
              </button>
            }
          />
        ) : (
          <div className="space-y-2">
            {sources.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                busy={busyId === s.id}
                lastError={lastErrorBySource.get(s.id)}
                confirming={confirmDelete === s.id}
                onToggle={() => void patch(s.id, { enabled: !s.enabled })}
                onWeight={(w) => void patch(s.id, { weight: w })}
                onNote={(note) => void patch(s.id, { note })}
                onAskDelete={() => setConfirmDelete(s.id)}
                onCancelDelete={() => setConfirmDelete(null)}
                onDelete={() => void onDelete(s.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* 运行记录 */}
      <section className="mt-5 pb-6">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-ink">采集运行记录</h2>
          <span className="text-[10.5px] text-ink-3">最近 {runs.length} 次 · 点行展开错误</span>
        </div>
        <RunsTable runs={runs} loading={loading} />
      </section>

      <AddSourceSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(s) => {
          setSources((prev) => [...prev, s]);
          toast.ok('信源已添加', `${s.label} · 探活通过。下一次采集会抓取它。`);
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ 信源行

function SourceRow({
  source,
  busy,
  lastError,
  confirming,
  onToggle,
  onWeight,
  onNote,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  source: Source;
  busy: boolean;
  lastError?: { message: string; at: string };
  confirming: boolean;
  onToggle: () => void;
  onWeight: (w: number) => void;
  onNote: (note: string) => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}): JSX.Element {
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState(source.note);
  const color = KIND_COLOR[source.kind];

  useEffect(() => {
    setNote(source.note);
  }, [source.note]);

  return (
    <div
      className={`card px-3.5 py-3 transition-colors ${source.enabled ? '' : 'opacity-[0.62]'}`}
      style={{ borderColor: lastError ? 'color-mix(in oklab, var(--color-warn) 24%, var(--color-line))' : undefined }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Pill color={color} bg={`color-mix(in oklab, ${color} 12%, transparent)`} border={`color-mix(in oklab, ${color} 30%, transparent)`} mono>
          {source.kind}
        </Pill>
        <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">{source.label}</span>
        <span className="num hidden text-[10px] text-ink-3 sm:inline">{source.id}</span>
        {(source.tags ?? []).map((t) => (
          <span key={t} className="chip">
            {t}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {busy ? <Spinner size={12} className="text-ink-3" /> : null}
          <span className="num text-[10.5px] text-ink-3">×{source.weight.toFixed(1)}</span>
          <Toggle checked={source.enabled} onChange={onToggle} disabled={busy} label={`${source.enabled ? '停用' : '启用'} ${source.label}`} />
          {confirming ? (
            <span className="flex items-center gap-1">
              <button type="button" className="btn btn-danger h-6 px-1.5 text-[10.5px]" onClick={onDelete}>
                确认删除
              </button>
              <button type="button" className="btn btn-ghost h-6 px-1.5 text-[10.5px]" onClick={onCancelDelete}>
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={onAskDelete}
              className="flex h-6 w-6 items-center justify-center rounded text-ink-3 transition-colors hover:bg-danger/10 hover:text-danger"
              title="删除信源（条目保留）"
              aria-label="删除信源"
            >
              <Icon name="trash" size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="num mt-1.5 truncate text-[10.5px] text-ink-3/90" title={source.url}>
        {source.url}
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_190px] sm:items-center">
        <div className="min-w-0">
          {editingNote ? (
            <div className="flex items-start gap-1.5">
              <textarea
                className="textarea text-[11.5px]"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="为什么加这个源？记住什么坑？"
                autoFocus
              />
              <div className="flex shrink-0 flex-col gap-1">
                <button
                  type="button"
                  className="btn h-6 px-1.5 text-[10.5px]"
                  onClick={() => {
                    onNote(note.trim());
                    setEditingNote(false);
                  }}
                >
                  保存
                </button>
                <button
                  type="button"
                  className="btn btn-ghost h-6 px-1.5 text-[10.5px]"
                  onClick={() => {
                    setNote(source.note);
                    setEditingNote(false);
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setEditingNote(true)}
              className="group flex w-full items-start gap-1.5 text-left"
              title="点击编辑说明"
            >
              <Icon name="info" size={11} className="mt-[3px] shrink-0 text-ink-3" />
              <span className="text-[11px] leading-relaxed text-ink-2">
                {source.note || <span className="text-ink-3">（无说明，点击补充）</span>}
              </span>
            </button>
          )}
        </div>
        <div className="min-w-0">
          <Slider
            label="权重"
            min={0.1}
            max={3}
            step={0.1}
            value={source.weight}
            onChange={() => {}}
            onCommit={(w) => onWeight(Math.round(w * 10) / 10)}
            format={(v) => `×${v.toFixed(1)}`}
          />
        </div>
      </div>

      {lastError ? (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-warn/25 bg-warn/[0.06] px-2 py-1.5">
          <Icon name="alert" size={11} className="mt-[2px] shrink-0 text-warn" />
          <span className="min-w-0 flex-1 text-[10.5px] leading-relaxed text-ink-2">
            最近错误（{relTime(lastError.at)}）：<span className="num break-all">{lastError.message}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ 运行表

function RunsTable({ runs, loading }: { runs: RunRecord[]; loading: boolean }): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);

  if (loading && runs.length === 0) {
    return (
      <div className="card divide-y divide-line overflow-hidden">
        {[0, 1, 2].map((i) => (
          <div key={i} className="px-3 py-2.5">
            <Skeleton w="60%" h={11} />
          </div>
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return <EmptyState icon="table" title="还没有采集记录" hint="点情报流右上角的「一键采集」跑一次。" />;
  }

  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-[1fr_46px_60px_46px_52px_28px] gap-2 border-b border-line px-3 py-1.5 text-[9.5px] tracking-wide text-ink-3 uppercase">
        <span>时间</span>
        <span className="text-right">源</span>
        <span className="text-right">抓取</span>
        <span className="text-right">新增</span>
        <span className="text-right">耗时</span>
        <span />
      </div>
      {runs.map((run) => {
        const open = openId === run.id;
        const hasErr = run.errors.length > 0;
        return (
          <div key={run.id} className="border-b border-line last:border-b-0">
            <button
              type="button"
              onClick={() => setOpenId(open ? null : run.id)}
              aria-expanded={open}
              className="grid w-full grid-cols-[1fr_46px_60px_46px_52px_28px] items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.025]"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="inline-block h-[5px] w-[5px] shrink-0 rounded-full"
                  style={{ background: hasErr ? 'var(--color-warn)' : 'var(--color-accent)' }}
                />
                <span className="truncate text-[11.5px] text-ink" title={absTime(run.startedAt)}>
                  {relTime(run.startedAt)}
                </span>
                <span className="num hidden shrink-0 text-[9.5px] text-ink-3 sm:inline">
                  {run.startedAt.slice(11, 19)}
                </span>
                {hasErr ? (
                  <span className="shrink-0 text-[9.5px] text-warn">{run.errors.length} 错误</span>
                ) : null}
              </span>
              <span className="num text-right text-[11px] text-ink-2">{run.sourceCount}</span>
              <span className="num text-right text-[11px] text-ink-2">{run.fetched}</span>
              <span className="num text-right text-[11px] font-medium text-ink">{run.added}</span>
              <span className="num text-right text-[11px] text-ink-3">{runDuration(run)}</span>
              <span className="flex justify-end text-ink-3">
                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
              </span>
            </button>
            {open ? (
              <div className="animate-fade border-t border-line bg-sunken px-3 py-2">
                <div className="mb-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-ink-3">
                  <span className="num">id {run.id}</span>
                  <span className="num">start {absTime(run.startedAt)}</span>
                  <span className="num">end {absTime(run.finishedAt)}</span>
                </div>
                {run.errors.length === 0 ? (
                  <div className="text-[11px] text-ink-2">没有错误。</div>
                ) : (
                  <ul className="space-y-1">
                    {run.errors.map((e, i) => (
                      <li key={`${e.sourceId}-${i}`} className="flex items-start gap-1.5">
                        <Icon name="alert" size={11} className="mt-[2px] shrink-0 text-warn" />
                        <span className="text-[10.5px] leading-relaxed text-ink-2">
                          <span className="num text-warn">{e.sourceId}</span> · {e.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ 新增信源

function AddSourceSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (s: Source) => void;
}): JSX.Element {
  const toast = useToastFns();
  const [id, setId] = useState('');
  const [kind, setKind] = useState<SourceKind>('rss');
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!id.trim() || !label.trim() || !url.trim()) {
      setErr('id / 名称 / 地址 都必填');
      return;
    }
    if (!/^https?:\/\//.test(url.trim())) {
      setErr('地址必须以 http(s):// 开头');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      const s = await createSource({
        id: id.trim(),
        kind,
        label: label.trim(),
        url: url.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onCreated(s);
      setId('');
      setLabel('');
      setUrl('');
      setNote('');
      onClose();
    } catch (e) {
      const f = friendlyError(e);
      setErr(`${f.title}${f.hint ? ` — ${f.hint}` : ''}`);
      toast.error(f.title, f.hint);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      label="添加信源"
      width={440}
      header={<span className="text-[12.5px] font-medium text-ink">添加信源</span>}
      footer={
        <div className="flex gap-2">
          <button type="button" className="btn btn-accent flex-1" onClick={() => void submit()} disabled={busy}>
            {busy ? <Spinner size={12} /> : <Icon name="plus" size={12} />}
            {busy ? '探活中…' : '探活并添加'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
        </div>
      }
    >
      <div className="space-y-2.5 px-4 py-4">
        <p className="text-[11px] leading-relaxed text-ink-3">
          后端会先请求该地址，HTTP 200 且能解析出条目才入库；否则返回 422 并保留原因。
        </p>
        <Field label="id（稳定 slug）">
          <input
            className="input num h-8 text-[12px]"
            placeholder="arxiv-kv-offload"
            value={id}
            onChange={(e) => setId(e.target.value.replace(/[^a-z0-9-]/g, ''))}
          />
        </Field>
        <Field label="类型">
          <select
            className="input h-8 text-[12px]"
            value={kind}
            onChange={(e) => setKind(e.target.value as SourceKind)}
          >
            <option value="rss">rss — 普通 RSS / RSSHub</option>
            <option value="atom">atom — Atom feed（GitHub Releases）</option>
            <option value="arxiv">arxiv — arXiv API 查询地址</option>
          </select>
        </Field>
        <Field label="展示名">
          <input className="input h-8 text-[12px]" placeholder="arXiv · KV Cache" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="抓取地址">
          <input
            className="input num h-8 text-[11px]"
            placeholder="https://…（arxiv 也要完整 API URL）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label="备注（可选）">
          <textarea className="textarea text-[12px]" rows={2} placeholder="为什么加它" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {err ? <div className="text-[10.5px] text-danger">{err}</div> : null}
      </div>
    </Drawer>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="eyebrow mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function MiniStat({
  label,
  value,
  hint,
  loading,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  loading: boolean;
  tone?: 'ok' | 'warn';
}): JSX.Element {
  return (
    <div className="card px-3 py-2.5">
      <div className="eyebrow">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        {loading ? (
          <div className="skeleton" style={{ width: 40, height: 20, borderRadius: 4 }} />
        ) : (
          <span
            className="num text-[19px] leading-none font-semibold"
            style={{ color: tone === 'warn' ? 'var(--color-warn)' : 'var(--color-ink)' }}
          >
            {value}
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-[9.5px] text-ink-3">{hint}</div>
    </div>
  );
}
