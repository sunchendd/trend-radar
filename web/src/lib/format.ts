/**
 * 纯函数格式化 / 判读 / 刻度工具。全部无副作用，可安全内联进渲染。
 */
import type {
  Idea,
  IdeaStatus,
  IdeaWithVerdict,
  ItemKind,
  NoveltyRecord,
  NoveltyVerdict,
  RunRecord,
  Stats,
  VerdictSummary,
} from './types';

// ------------------------------------------------------------------ 时间

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期 */
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = now - t;
  if (d < 0) return '刚刚';
  if (d < MIN) return '刚刚';
  if (d < HOUR) return `${Math.floor(d / MIN)} 分钟前`;
  if (d < DAY) return `${Math.floor(d / HOUR)} 小时前`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} 天前`;
  return absDate(iso);
}

/** 2026-10-29 20:31（本地时区） */
export function absDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function absTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  return `${absDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function durationSec(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 1000);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 近 N 天（含今天）的 ISO 日期下界，用于 since 过滤 */
export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

export function todayIso(): string {
  return absDate(new Date().toISOString());
}

// ------------------------------------------------------------------ 数字

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

/** 1234 → 1.2k */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** 服务端的打分理由 detail 末尾常自带「+70」，与左侧 delta 重复，展示前去掉 */
export function cleanReason(detail: string): string {
  return detail.replace(/\s*[+＋]\d+(?:\.\d+)?\s*$/u, '').trim();
}

export function signed(n: number): string {
  const v = Math.round(n * 10) / 10;
  return v > 0 ? `+${v}` : String(v);
}

// ------------------------------------------------------------------ 状态文案

export type Tone = 'high' | 'mid' | 'low';

/**
 * 相关度的产品阈值（后端已改成分档打分刻度）：
 *   ≥70 → 高分（今天值得读的那一小撮）
 *   50–70 → 待判（数字不低不高，要读摘要才知道）
 *   <50  → 低
 * 统计卡、色环、左侧色条共用这一套口径，避免同一条数据在不同位置显示不同结论。
 */
export const HIGH_SCORE = 70;
export const MID_SCORE = 50;

export function scoreTone(score: number): Tone {
  if (score >= HIGH_SCORE) return 'high';
  if (score >= MID_SCORE) return 'mid';
  return 'low';
}

export const TONE_COLOR: Record<Tone, string> = {
  high: 'var(--color-accent)',
  mid: 'var(--color-warn)',
  low: 'var(--color-ink-3)',
};

export interface StatusMeta {
  label: string;
  color: string;
  desc: string;
}

export const STATUS_META: Record<IdeaStatus, StatusMeta> = {
  draft: { label: '草稿', color: 'var(--color-st-draft)', desc: '未查新，随时可改' },
  verified: {
    label: '已验证',
    color: 'var(--color-st-verified)',
    desc: '查新交叉带存在空位，可撰写交底书',
  },
  'red-ocean': {
    label: '红海',
    color: 'var(--color-st-red)',
    desc: '命中密集，撞车风险高，建议换角度',
  },
  archived: {
    label: '已归档',
    color: 'var(--color-st-archived)',
    desc: '暂不跟进',
  },
};

export const KIND_META: Record<ItemKind, { label: string; color: string }> = {
  paper: { label: '论文', color: '#7aa7f7' },
  news: { label: '资讯', color: '#9caeb4' },
  release: { label: '发布', color: '#f2b357' },
};

/**
 * 查新判读。
 *
 * **结论只信 `verdictSummary.verdict`（服务端唯一出口）**，这里只提供两件事：
 *   1. 单条检索式的「档位」——用于给每行记录上色和说话（0 命中 ≠ 空白）；
 *   2. 服务端没给摘要时的兜底摘要（老响应 / 演示数据）。
 *
 * 阈值与 server/src/ideas/verdict.ts 一致：1–5 稀疏交叉带、≥50 红海、
 * 全零与全解析失败都是「无效」而不是「空白」——gap 只能由人读完权利要求后手工确认。
 */
export const SPARSE_HITS_MAX = 5;
export const RED_OCEAN_HITS = 50;

export type RecordBand = 'unparsed' | 'zero' | 'sparse' | 'mid' | 'red';

export function bandOf(hits: number | null): RecordBand {
  if (hits === null) return 'unparsed';
  if (hits === 0) return 'zero';
  if (hits <= SPARSE_HITS_MAX) return 'sparse';
  if (hits < RED_OCEAN_HITS) return 'mid';
  return 'red';
}

export interface BandMeta {
  label: string;
  color: string;
  bg: string;
  border: string;
  hint: string;
}

export const BAND_META: Record<RecordBand, BandMeta> = {
  unparsed: {
    label: '解析失败',
    color: '#f2b357',
    bg: 'rgb(242 179 87 / 0.10)',
    border: 'rgb(242 179 87 / 0.34)',
    hint: '页面没取到命中数：本次检索无效，需确认登录态后重跑',
  },
  zero: {
    label: '零命中',
    color: '#8fa3ad',
    bg: 'rgb(143 163 173 / 0.10)',
    border: 'rgb(143 163 173 / 0.28)',
    hint: '先怀疑检索式（AND 语义，词多即空），不能当作技术空白',
  },
  sparse: {
    label: '稀疏',
    color: '#35e7c5',
    bg: 'rgb(53 231 197 / 0.12)',
    border: 'rgb(53 231 197 / 0.36)',
    hint: '1–5 命中的交叉带：最值得读权利要求的位置',
  },
  mid: {
    label: '中间',
    color: '#7aa7f7',
    bg: 'rgb(122 167 247 / 0.10)',
    border: 'rgb(122 167 247 / 0.30)',
    hint: '6–49 命中：数字判不了，要读最近邻权利要求',
  },
  red: {
    label: '红海',
    color: '#ff6b7a',
    bg: 'rgb(255 107 122 / 0.10)',
    border: 'rgb(255 107 122 / 0.32)',
    hint: '≥50 命中：已成建制布防，规避成本高',
  },
};

export const VERDICT_META: Record<NoveltyVerdict, { label: string; color: string; bg: string; border: string; hint: string }> = {
  gap: {
    label: '已验证',
    color: '#35e7c5',
    bg: 'rgb(53 231 197 / 0.12)',
    border: 'rgb(53 231 197 / 0.38)',
    hint: '人工读完权利要求后确认的技术空白（机器不会自动判 gap）',
  },
  opportunity: {
    label: '机会',
    color: '#a9e34b',
    bg: 'rgb(169 227 75 / 0.10)',
    border: 'rgb(169 227 75 / 0.32)',
    hint: '有占位但密度有限，可绕开',
  },
  'red-ocean': {
    label: '红海',
    color: '#ff6b7a',
    bg: 'rgb(255 107 122 / 0.10)',
    border: 'rgb(255 107 122 / 0.32)',
    hint: '命中密集：撞车风险高',
  },
  inconclusive: {
    label: '待判',
    color: '#f2b357',
    bg: 'rgb(242 179 87 / 0.10)',
    border: 'rgb(242 179 87 / 0.34)',
    hint: '没有有效证据：解析失败或全部零命中，都要先改检索式',
  },
};

/** 单条查新记录的命中数文案 */
export function hitsLabel(rec: NoveltyRecord): string {
  if (rec.hits === null) return '解析失败';
  if (rec.hits === 0) return '零命中';
  return `${fmtInt(rec.hits)} 命中`;
}

/**
 * 兜底摘要：只有服务端没给 verdictSummary 时才用（老响应 / 演示数据）。
 * 规则照抄 server/src/ideas/verdict.ts，**不引入任何新阈值**。
 */
export function fallbackSummary(idea: Idea): VerdictSummary {
  const evidence = idea.novelty.map((r) => ({
    query: r.query,
    hits: r.hits,
    topAssignees: r.topAssignees,
  }));
  const parsed = evidence.filter((e): e is { query: string; hits: number; topAssignees: string } => e.hits !== null);
  const suggestions: string[] = [];

  if (evidence.length === 0) {
    return {
      verdict: 'inconclusive',
      headline: '未查新：无记录',
      evidence,
      suggestions: ['先跑一次智慧芽查新，或手工登记命中数后再判读'],
    };
  }
  if (parsed.length === 0) {
    return {
      verdict: 'inconclusive',
      headline: '无法判断：解析失败',
      evidence,
      suggestions: ['确认智慧芽登录态与页面渲染时间后重跑', '换一条更短的检索式，验证能否取到命中数'],
    };
  }
  const counts = parsed.map((e) => e.hits);
  if (counts.every((n) => n === 0)) {
    suggestions.push('先怀疑检索式：简单搜索是 AND 语义，词多即空');
    const firstWords = parsed[0]?.query.trim().split(/\s+/u) ?? [];
    const last = firstWords[firstWords.length - 1];
    if (firstWords.length > 3 && last) suggestions.push(`去掉尾词「${last}」后重试`);
    suggestions.push('减到 3 个词再跑');
    return { verdict: 'inconclusive', headline: '无法判断：全部零命中', evidence, suggestions };
  }
  const red = parsed.find((e) => e.hits >= RED_OCEAN_HITS);
  if (red) {
    suggestions.push('避开头部申请人已覆盖的子问题', '给检索式加限定词细分（按场景/模块）');
    return { verdict: 'red-ocean', headline: `红海：${red.hits} 命中`, evidence, suggestions };
  }
  const sparse = parsed.find((e) => e.hits >= 1 && e.hits <= SPARSE_HITS_MAX);
  if (sparse) {
    suggestions.push('读这几篇最近邻的独立权利要求，确认区别技术特征');
    return { verdict: 'opportunity', headline: `稀疏交叉带：${sparse.hits} 命中`, evidence, suggestions };
  }
  const nonZero = counts.filter((n) => n > 0);
  const min = Math.min(...nonZero);
  const max = Math.max(...nonZero);
  suggestions.push('读最近邻权利要求定边界');
  return {
    verdict: 'opportunity',
    headline: min === max ? `中间地带：${max} 命中` : `中间地带：${min}–${max} 命中`,
    evidence,
    suggestions,
  };
}

/** 服务端给了就用服务端的（唯一出口），没给才兜底 */
export function summaryOf(idea: Idea | IdeaWithVerdict): VerdictSummary {
  const maybe = (idea as Partial<IdeaWithVerdict>).verdictSummary;
  return maybe && typeof maybe.headline === 'string' ? maybe : fallbackSummary(idea);
}

// ------------------------------------------------------------------ 分布条刻度

/**
 * 对数刻度位置 0–1（0–100 对数刻度，0 单独放在最左且视觉加粗）。
 * log10(hits + 1) / log10(101)
 */
export function logPos(hits: number, max = 100): number {
  const v = clamp(hits, 0, max);
  return Math.log10(v + 1) / Math.log10(max + 1);
}

/** 刻度取服务端阈值：0（无效）/ 5（稀疏带上界）/ 50（红海线）/ 100 */
export const LOG_TICKS = [0, 5, 50, 100] as const;

// ------------------------------------------------------------------ Stats 派生

/** 从 "[0,20)" / "20-40" / "80+" 这类桶名里取数值下界 */
export function bucketLower(bucket: string): number | null {
  const m = bucket.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** 今日新增：dailyAdded 的最后一项（若最后一项不是今天则回退 0） */
export function todayAdded(stats: Stats | null): number {
  if (!stats || stats.dailyAdded.length === 0) return 0;
  const last = stats.dailyAdded[stats.dailyAdded.length - 1];
  if (!last) return 0;
  if (last.date === todayIso()) return last.count;
  // 服务端日期口径可能带时区差异，取最后一项的日期与今天比较失败时仍展示它
  return last.count;
}

/** 高相关条目数：相关度 >= 75 的桶求和（与 scoreTone 的 high 阈值一致） */
export function highRelevance(stats: Stats | null): number {
  if (!stats || stats.scoreHistogram.length === 0) return 0;
  const bins = stats.scoreHistogram;
  const parsed = bins.map((b) => ({ lo: bucketLower(b.bucket), count: b.count }));
  const usable = parsed.filter((p): p is { lo: number; count: number } => p.lo !== null);
  if (usable.length === 0) {
    // 桶名解析不出来时退化为「最后两个桶」——比返回 0 更不容易误导
    return bins.slice(-2).reduce((s, b) => s + b.count, 0);
  }
  return usable.filter((p) => p.lo >= HIGH_SCORE).reduce((s, p) => s + p.count, 0);
}

/**
 * 分数最高的**非空**分桶的桶名（按桶下界比较，不是按计数），
 * 用于「当前没有高分条目」时说明数据实际落在哪一档。
 */
export function highestBucketLabel(stats: Stats | null): string | null {
  if (!stats) return null;
  let best: { bucket: string; lo: number } | null = null;
  for (const b of stats.scoreHistogram) {
    if (b.count <= 0) continue;
    const lo = bucketLower(b.bucket);
    if (lo === null) continue;
    if (best === null || lo > best.lo) best = { bucket: b.bucket, lo };
  }
  return best ? best.bucket : null;
}

/** 近 7 天新增合计 */
export function weekAdded(stats: Stats | null): number {
  if (!stats) return 0;
  return stats.dailyAdded.reduce((s, d) => s + d.count, 0);
}

// ------------------------------------------------------------------ 采集耗时

export function runDuration(run: RunRecord): string {
  const s = durationSec(run.startedAt, run.finishedAt);
  if (s === null) return '—';
  if (s < 1) return '<1s';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// ------------------------------------------------------------------ Markdown 导出

const SITE_LABEL: Record<NoveltyRecord['site'], string> = {
  zhihuiya: '智慧芽',
  manual: '人工录入',
  other: '其他',
};

export function ideaToMarkdown(idea: Idea): string {
  const st = STATUS_META[idea.status];
  const lines: string[] = [];
  lines.push(`# ${idea.title}`, '');
  lines.push(
    `> 状态：**${st.label}** · focus：\`${idea.focus || '—'}\` · 更新时间：${absTime(idea.updatedAt)}`,
    '',
  );
  if (idea.keywords.length > 0) lines.push(`**关键词**：${idea.keywords.join('、')}  `);
  if (idea.ipcHints.length > 0) lines.push(`**IPC 提示**：${idea.ipcHints.join('、')}  `);
  lines.push('', '## 一、要解决的技术问题', '', idea.problem || '（待补）', '');
  lines.push('## 二、技术方案', '', idea.solution || '（待补）', '');
  lines.push('## 三、有益效果', '', idea.effect || '（待补）', '');

  if (idea.queries.length > 0) {
    lines.push('## 四、查新检索式', '');
    idea.queries.forEach((q, i) => lines.push(`${i + 1}. \`${q}\``));
    lines.push('');
  }

  if (idea.novelty.length > 0) {
    lines.push('## 五、查新记录', '', '| 时间 | 检索式 | 命中 | 判读 | 头部申请人 |', '|---|---|---|---|---|');
    for (const r of idea.novelty) {
      const hits = r.hits === null ? '解析失败' : String(r.hits);
      const verdict = BAND_META[bandOf(r.hits)].label;
      lines.push(
        `| ${absDate(r.at)} | \`${r.query}\` | ${hits} | ${verdict} | ${r.topAssignees || '—'} |`,
      );
    }
    lines.push('');
  }

  if (idea.risks.length > 0) {
    lines.push('## 六、撞车风险点', '');
    for (const r of idea.risks) lines.push(`- ${r}`);
    lines.push('');
  }

  if (idea.cites.length > 0) {
    lines.push('---', '', `依据情报：${idea.cites.map((c) => `\`${c}\``).join(' ')}`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ misc

export function shortId(id: string, n = 8): string {
  return id.slice(0, n);
}

export function plural(n: number, unit: string): string {
  return `${fmtInt(n)} ${unit}`;
}
