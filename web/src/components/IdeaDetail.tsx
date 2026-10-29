/**
 * 选题详情：把一条选题按「专利口径」摆开，并把查新记录画成一眼能读的分布。
 *
 * 两条硬规则：
 * 1. 判读结论**只展示**服务端 `verdictSummary`（唯一出口），前端不重算；
 * 2. `hits === null`（解析失败）与 `hits === 0`（零命中）必须视觉可区分，
 *    且两者都**不是**技术空白——全零先怀疑检索式。
 */
import { useMemo, useState, type JSX } from 'react';
import type { IdeaStatus, IdeaWithVerdict, NoveltyRecord } from '../lib/types';
import {
  BAND_META,
  RED_OCEAN_HITS,
  SPARSE_HITS_MAX,
  STATUS_META,
  VERDICT_META,
  absTime,
  bandOf,
  fmtInt,
  ideaToMarkdown,
  relTime,
  summaryOf,
  type RecordBand,
} from '../lib/format';
import { useCopy } from '../lib/hooks';
import { HitsMeter, HitsValue, NoveltyBar } from './charts';
import { Icon } from './Icon';
import { NoticeBar } from './States';
import { useToastFns } from './Toast';
import { Pill, SectionHead, Spinner, StatusBadge } from './primitives';

const SITE_LABEL: Record<NoveltyRecord['site'], string> = {
  zhihuiya: '智慧芽',
  manual: '人工录入',
  other: '其他',
};

export interface NoveltyInput {
  query: string;
  hits: number | null;
  topAssignees: string;
  note: string;
}

export function IdeaDetail({
  idea,
  statusBusy,
  noveltyBusy,
  autoBusy,
  onStatus,
  onSubmitNovelty,
  onAutoNovelty,
  onCite,
  onBack,
}: {
  idea: IdeaWithVerdict;
  statusBusy: boolean;
  noveltyBusy: boolean;
  autoBusy: boolean;
  onStatus: (s: IdeaStatus) => void;
  onSubmitNovelty: (input: NoveltyInput) => Promise<boolean>;
  onAutoNovelty: () => void;
  onCite: (itemId: string) => void;
  onBack?: () => void;
}): JSX.Element {
  const { copy, copied } = useCopy();
  const toast = useToastFns();
  const meta = STATUS_META[idea.status];
  const summary = summaryOf(idea);
  const verdictMeta = VERDICT_META[summary.verdict];

  /** 逐条检索式的档位计数：解释「为什么是这个判读」 */
  const bandCounts = useMemo(() => {
    const counts: Record<RecordBand, number> = { unparsed: 0, zero: 0, sparse: 0, mid: 0, red: 0 };
    for (const r of idea.novelty) counts[bandOf(r.hits)] += 1;
    return counts;
  }, [idea.novelty]);

  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          {onBack ? (
            <button type="button" onClick={onBack} className="btn btn-ghost h-7 px-1.5 lg:hidden" aria-label="返回列表">
              <Icon name="chevron-left" size={14} />
              列表
            </button>
          ) : null}
          <StatusBadge status={idea.status} />
          <span className="text-[10.5px] text-ink-3">{meta.desc}</span>
          <span className="num ml-auto hidden text-[10px] text-ink-3 sm:inline">更新 {relTime(idea.updatedAt)}</span>
        </div>

        <h2 className="mt-2 text-[16.5px] leading-[1.45] font-semibold tracking-[-0.012em] text-ink">
          {idea.title}
        </h2>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-ink-3">
          <span>
            focus：<span className="text-ink-2">{idea.focus || '—'}</span>
          </span>
          <span className="num">创建 {absTime(idea.createdAt)}</span>
          {idea.promptVersion ? <span className="num">prompt {idea.promptVersion}</span> : null}
          <span className="num">id {idea.id}</span>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="btn h-7 px-2 text-[11.5px]"
            onClick={() => void copy(ideaToMarkdown(idea))}
            title="复制整条选题为 Markdown（可直接粘进交底书）"
          >
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            {copied ? '已复制 Markdown' : '复制 Markdown'}
          </button>
          <a
            className="btn h-7 px-2 text-[11.5px]"
            href={`/api/ideas/${idea.id}/disclosure`}
            download
            title="下载符合国内实务章节结构的专利交底书（Markdown）"
          >
            <Icon name="doc" size={12} />
            导出交底书
          </a>
          {idea.status !== 'archived' ? (
            <>
              <button
                type="button"
                className="btn h-7 px-2 text-[11.5px]"
                disabled={statusBusy || idea.status === 'verified'}
                onClick={() => onStatus('verified')}
                title="已人工确认交叉带有空位 → 标记为已验证"
              >
                <Icon name="shield" size={12} />
                标记已验证
              </button>
              <button
                type="button"
                className="btn h-7 px-2 text-[11.5px]"
                disabled={statusBusy || idea.status === 'red-ocean'}
                onClick={() => onStatus('red-ocean')}
                title="命中密集 → 标记为红海"
              >
                <Icon name="flame" size={12} />
                标记红海
              </button>
              <button
                type="button"
                className="btn btn-ghost h-7 px-2 text-[11.5px]"
                disabled={statusBusy}
                onClick={() => onStatus('archived')}
                title="归档（软删，不进入 KPI，可恢复）"
              >
                <Icon name="trash" size={12} />
                归档
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn h-7 px-2 text-[11.5px]"
              disabled={statusBusy}
              onClick={() => onStatus('draft')}
            >
              <Icon name="refresh" size={12} />
              取消归档
            </button>
          )}
          {statusBusy ? <Spinner size={12} className="text-ink-3" /> : null}
        </div>
      </div>

      <div className="scroll-area min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {/* 三段式正文 */}
        <div className="space-y-4">
          <Field index="01" title="要解决的技术问题" text={idea.problem} />
          <Field index="02" title="技术方案" text={idea.solution} />
          <Field index="03" title="有益效果" text={idea.effect} />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <SectionHead title="关键词" />
            <div className="flex flex-wrap gap-1.5">
              {idea.keywords.length === 0 ? (
                <span className="text-[11px] text-ink-3">—</span>
              ) : (
                idea.keywords.map((k) => (
                  <span key={k} className="chip">
                    {k}
                  </span>
                ))
              )}
            </div>
          </div>
          <div>
            <SectionHead title="IPC 提示" hint="撰写时确认主分类" />
            <div className="flex flex-wrap gap-1.5">
              {idea.ipcHints.length === 0 ? (
                <span className="text-[11px] text-ink-3">—</span>
              ) : (
                idea.ipcHints.map((h) => (
                  <span key={h} className="chip" style={{ color: 'var(--color-info)' }}>
                    {h}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>

        {/* 查新 */}
        <section className="mt-5">
          <SectionHead
            title="查新记录"
            hint={`${idea.novelty.length} 条 · 阈值 1–${SPARSE_HITS_MAX} 稀疏 / ≥${RED_OCEAN_HITS} 红海`}
          />

          {/* 判读结论（服务端唯一出口）+ 可执行建议 */}
          <div className="rounded-tile border px-3 py-2.5" style={{ borderColor: verdictMeta.border, background: verdictMeta.bg }}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-[1px] text-[10.5px] font-medium"
                style={{ color: verdictMeta.color, background: 'rgb(0 0 0 / 0.22)' }}
              >
                <Icon
                  name={summary.verdict === 'red-ocean' ? 'flame' : summary.verdict === 'inconclusive' ? 'info' : 'shield'}
                  size={11}
                />
                {verdictMeta.label}
              </span>
              <span className="text-[12.5px] font-medium" style={{ color: verdictMeta.color }}>
                {summary.headline}
              </span>
              <span className="ml-auto flex items-center gap-1.5 text-[9.5px] text-ink-3">
                {(['unparsed', 'zero', 'sparse', 'mid', 'red'] as RecordBand[])
                  .filter((b) => bandCounts[b] > 0)
                  .map((b) => (
                    <span key={b} className="num" style={{ color: BAND_META[b].color }}>
                      {BAND_META[b].label}
                      {bandCounts[b]}
                    </span>
                  ))}
              </span>
            </div>

            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-2">{verdictMeta.hint}</p>

            {summary.verdict === 'inconclusive' && idea.novelty.length > 0 ? (
              <div className="mt-2">
                <NoticeBar tone="warn">
                  全零 / 解析失败都<strong>不等于技术空白</strong>。简单搜索是 AND 语义，词多即空——
                  先把检索式改短再跑一遍，别把「查不到」当成「没人做」。
                </NoticeBar>
              </div>
            ) : null}

            {summary.suggestions.length > 0 ? (
              <div className="mt-2.5">
                <div className="eyebrow mb-1">建议这样改检索式</div>
                <ul className="space-y-1">
                  {summary.suggestions.map((s, i) => (
                    <li key={`${i}-${s.slice(0, 8)}`}>
                      <button
                        type="button"
                        onClick={() => {
                          void copy(s).then((ok) => {
                            if (ok) toast.ok('已复制建议', s);
                          });
                        }}
                        title="点击复制这条建议"
                        className="group flex w-full items-start gap-1.5 rounded-md px-1 py-[3px] text-left transition-colors hover:bg-white/[0.04]"
                      >
                        <span className="num mt-[1px] shrink-0 text-[9.5px] text-ink-3">{i + 1}</span>
                        <span className="text-[11.5px] leading-relaxed text-ink">{s}</span>
                        <Icon
                          name="copy"
                          size={10}
                          className="mt-[3px] shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100"
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {idea.novelty.length > 0 ? (
            <div className="mt-2 rounded-tile border border-line bg-sunken px-3 pt-2 pb-2.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="eyebrow">命中数分布（0–100 对数刻度）</span>
                <span className="text-[9.5px] text-ink-3">青绿带 = 稀疏交叉带 · 红带 = 红海</span>
              </div>
              <NoveltyBar records={idea.novelty} />
            </div>
          ) : null}

          <div className="mt-2.5 space-y-1.5">
            {idea.novelty.map((r, i) => {
              const band = BAND_META[bandOf(r.hits)];
              return (
                <div
                  key={`${r.at}-${i}`}
                  className="rounded-tile border border-line px-2.5 py-2 transition-colors hover:border-line-strong"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <code className="num text-[11.5px] text-ink">{r.query}</code>
                    <Pill color={band.color} bg={band.bg} border={band.border} title={band.hint} className="shrink-0">
                      {band.label}
                    </Pill>
                    <span className="ml-auto flex items-center gap-2">
                      <HitsValue hits={r.hits} />
                      <span className="text-[9.5px] text-ink-3">
                        {SITE_LABEL[r.site]} · {relTime(r.at)}
                      </span>
                    </span>
                  </div>
                  {r.hits !== null ? (
                    <div className="mt-1.5">
                      <HitsMeter hits={r.hits} />
                    </div>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-ink-3">
                    {r.topAssignees ? (
                      <span className="truncate">
                        头部申请人：<span className="text-ink-2">{r.topAssignees}</span>
                      </span>
                    ) : (
                      <span className="text-ink-3/80">无头部申请人</span>
                    )}
                    {r.note ? <span className="text-ink-3">· {r.note}</span> : null}
                  </div>
                </div>
              );
            })}
          </div>

          <NoveltyForm busy={noveltyBusy} onSubmit={onSubmitNovelty} />

          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[10px] text-ink-3">
              建议检索式：
              {idea.queries.length === 0
                ? '—'
                : idea.queries.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => void copy(q)}
                      className="num ml-1 rounded border border-line px-1 py-[1px] text-[10px] text-ink-2 transition-colors hover:border-accent/40 hover:text-accent"
                      title="点击复制检索式"
                    >
                      {q}
                    </button>
                  ))}
            </span>
            <button
              type="button"
              className="btn h-7 shrink-0 px-2 text-[11px]"
              onClick={onAutoNovelty}
              disabled={autoBusy}
              title="调用智慧芽 CLI 批量查新并回填（需要后端配置凭据）"
            >
              {autoBusy ? <Spinner size={11} /> : <Icon name="bolt" size={11} />}
              {autoBusy ? '查新中…' : '自动查新'}
            </button>
          </div>
        </section>

        {/* 风险 */}
        <section className="mt-5 pb-4">
          <SectionHead title="撞车风险点" hint={`${idea.risks.length} 条`} />
          {idea.risks.length === 0 ? (
            <p className="text-[11.5px] text-ink-3">暂无记录的风险点。</p>
          ) : (
            <ul className="space-y-1.5">
              {idea.risks.map((r, i) => (
                <li
                  key={`${i}-${r.slice(0, 12)}`}
                  className="flex items-start gap-2 rounded-tile border border-line px-2.5 py-1.5"
                >
                  <span className="mt-[2px] shrink-0" style={{ color: 'var(--color-warn)' }}>
                    <Icon name="alert" size={12} />
                  </span>
                  <span className="text-[11.5px] leading-relaxed text-ink-2">{r}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 依据情报 */}
        {idea.cites.length > 0 ? (
          <section className="mb-4">
            <SectionHead title="依据情报" hint="点击跳到情报流详情" />
            <div className="flex flex-wrap gap-1.5">
              {idea.cites.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onCite(id)}
                  className="num inline-flex items-center gap-1 rounded-md border border-line bg-white/[0.02] px-1.5 py-[3px] text-[10.5px] text-ink-2 transition-colors hover:border-accent/40 hover:text-accent"
                  title={`打开情报 ${id}`}
                >
                  <Icon name="link" size={10} />
                  {id.slice(0, 10)}
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Field({ index, title, text }: { index: string; title: string; text: string }): JSX.Element {
  return (
    <div className="flex gap-3">
      <div className="num mt-[2px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border border-line bg-white/[0.02] text-[9px] text-ink-3">
        {index}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11.5px] font-medium text-ink-2">{title}</div>
        <p className="mt-1 text-[12.5px] leading-[1.75] whitespace-pre-wrap text-ink">{text || '（待补）'}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 手工登记表单

function NoveltyForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (input: NoveltyInput) => Promise<boolean>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState('');
  const [unparsed, setUnparsed] = useState(false);
  const [assignees, setAssignees] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!query.trim()) {
      setErr('检索式不能为空');
      return;
    }
    let hitsValue: number | null = null;
    if (!unparsed) {
      if (hits.trim() === '') {
        setErr('填命中数；如果页面没解析出来，勾选上面的“解析失败”');
        return;
      }
      const n = Number(hits.trim());
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        setErr('命中数必须是 ≥0 的整数');
        return;
      }
      hitsValue = n;
    }
    setErr('');
    const ok = await onSubmit({
      query: query.trim(),
      hits: hitsValue,
      topAssignees: assignees.trim(),
      note: note.trim(),
    });
    if (ok) {
      setQuery('');
      setHits('');
      setUnparsed(false);
      setAssignees('');
      setNote('');
      setOpen(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-tile border border-dashed border-line-strong py-1.5 text-[11.5px] text-ink-3 transition-colors hover:border-accent/40 hover:text-accent"
      >
        <Icon name="plus" size={12} />
        手工登记一条查新记录
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-tile border border-line-strong bg-sunken p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <Icon name="flask" size={13} className="text-accent" />
        <span className="text-[11.5px] font-medium text-ink">登记查新结果</span>
        <span className="text-[10px] text-ink-3">命中数决定判读与状态</span>
        <button type="button" onClick={() => setOpen(false)} className="ml-auto text-ink-3 hover:text-ink" aria-label="收起">
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_92px]">
        <input
          className="input h-8 text-[12px]"
          placeholder="检索式原文，例如「投机解码 草稿树 剪枝」"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="检索式"
        />
        <input
          className="input num h-8 text-[12px]"
          placeholder="命中数"
          inputMode="numeric"
          value={hits}
          disabled={unparsed}
          onChange={(e) => setHits(e.target.value.replace(/[^\d]/g, ''))}
          aria-label="命中数"
        />
      </div>

      <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-[10.5px] text-ink-2">
        <input
          type="checkbox"
          checked={unparsed}
          onChange={(e) => setUnparsed(e.target.checked)}
          className="h-3 w-3 accent-[var(--color-warn)]"
        />
        页面解析失败（命中数未知，登记为 <span className="num text-warn">null</span>，与「零命中」区分）
      </label>

      <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
        <input
          className="input h-8 text-[12px]"
          placeholder="头部申请人，如「华为:7、中兴:3」"
          value={assignees}
          onChange={(e) => setAssignees(e.target.value)}
          aria-label="头部申请人"
        />
        <input
          className="input h-8 text-[12px]"
          placeholder="判读备注（可选）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          aria-label="备注"
        />
      </div>

      {err ? <div className="mt-1.5 text-[10.5px] text-danger">{err}</div> : null}

      <div className="mt-2 flex items-center gap-2">
        <button type="button" className="btn btn-accent h-7 px-2.5 text-[11.5px]" onClick={() => void submit()} disabled={busy}>
          {busy ? <Spinner size={11} /> : <Icon name="check" size={12} />}
          登记
        </button>
        <span className="text-[10px] text-ink-3">
          {unparsed ? '将登记为「解析失败」' : hits ? `将登记 ${fmtInt(Number(hits) || 0)} 命中` : '尚未填命中数'}
        </span>
      </div>
    </div>
  );
}
