/**
 * chat 的四个工具实现。为什么这么设计：
 *
 * 1. 结果统一成 {items, note}：编排器不关心每个工具的内部形状，引用收集、
 *    序列化、sources 事件全部按同一形态处理；新增工具只需要在 runTool 加一行。
 * 2. 外部检索（arXiv / Google Patents）**降级不抛错**：搜索失败时返回空列表 + note，
 *    让模型在下一轮自己决定换词或改用库内检索——一次网络抖动不该杀掉整条对话。
 *    唯一例外是 generate_ideas：领域错误（no_items / all_invalid 等）按 errors.ts
 *    翻译后抛出，因为这些是「用户必须知道」的业务结论（如库里没有素材）。
 * 3. 复用 sources/arxiv.ts 的解析器而不是重写一份 Atom 解析：解析规则只存在一份，
 *    采集与实时检索看到的世界才一致。
 */

import type { GenerateIdeasRequest, Idea, Item, ItemKind, ItemQuery, NoveltyRecord, Paged, Source } from '../types.js';
import type { VerdictSummary } from '../ideas/verdict.js';
import { parseArxivAtom } from '../sources/arxiv.js';
import { stripTags } from '../sources/xml.js';
import { mapDomainError, badGateway } from '../http/errors.js';
import { extractJson, type LlmClient } from '../ideas/llm.js';
import { buildClaimsPrompt } from './prompt.js';
import type { ChatSourceItem, ChatToolName, ToolResult } from './types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 工具能拿到的全部能力；测试注入假实现即可离线跑。
 * B 组工具（export_disclosure / check_novelty / draft_claims）需要的选题与查新
 * 能力全部可选注入：缺什么，对应工具降级成「note 引导」，而不是整个 chat 不可用。
 */
export interface ToolContext {
  fetch: FetchLike;
  listItems(query: ItemQuery): Paged<Item>;
  generateIdeas(req: GenerateIdeasRequest): Promise<{ ideas: Idea[] }>;
  now(): Date;
  /** 选题读取（export_disclosure / check_novelty / draft_claims） */
  getIdea(ideaId: string): Idea | undefined;
  /** 权利要求草案落库（INSERT OR REPLACE，chat-store 的 idea_claims 表） */
  saveClaims(ideaId: string, content: string, at?: string): void;
  /** 查新闭环：配置了智慧芽 CLI 时跑真查新并落库（约 20-60 秒） */
  autoNovelty?(ideaId: string): Promise<Idea>;
  /** 判读摘要（verdict.ts 可缺失时降级） */
  summarizeVerdict?(records: NoveltyRecord[]): VerdictSummary;
  /** 智慧芽 CLI 是否真的可用（settings.novelty.hasCommand，非空且存在） */
  noveltyCommandAvailable?: boolean;
  /** 权利要求起草用的 LLM 通道；缺失时 draft_claims 降级为 note */
  llm?: Pick<LlmClient, 'complete'>;
}

export const TOOL_NAMES: readonly ChatToolName[] = [
  'search_local',
  'search_arxiv',
  'search_patents',
  'generate_ideas',
  'export_disclosure',
  'check_novelty',
  'draft_claims',
];

const USER_AGENT = 'trend-radar/0.1 (technical-intelligence-radar; +https://github.com/trend-radar)';

// ---------------------------------------------------------------- args 解析

const argString = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const argInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
};

const ITEM_KINDS: readonly ItemKind[] = ['paper', 'news', 'release'];

function argKinds(value: unknown): ItemKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kinds = value.filter((entry): entry is ItemKind => typeof entry === 'string' && (ITEM_KINDS as readonly string[]).includes(entry));
  return kinds.length > 0 ? [...new Set(kinds)] : undefined;
}

// ---------------------------------------------------------------- search_local

export function searchLocal(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const q = argString(args['q'], 200);
  const kinds = argKinds(args['kinds']);
  const sinceDays = argInt(args['since_days'], 1, 365, 0);
  const minScore = argInt(args['min_score'], 0, 100, 0);
  const limit = argInt(args['limit'], 1, 20, 10);

  const query: ItemQuery = { sort: 'score', limit };
  if (q !== '') query.q = q;
  if (kinds) query.kinds = kinds;
  if (minScore > 0) query.minScore = minScore;
  if (sinceDays > 0) {
    query.since = new Date(ctx.now().getTime() - sinceDays * 86_400_000).toISOString();
  }

  const page = ctx.listItems(query);
  const items: ChatSourceItem[] = page.items.map((item) => ({
    title: item.title,
    url: item.url,
    kind: item.kind,
    meta: {
      score: item.score,
      publishedAt: item.publishedAt,
      sourceId: item.sourceId,
      summary: item.summary.slice(0, 160),
    },
  }));
  const note =
    page.total > items.length
      ? `库内共命中 ${page.total} 条，已按相关度返回前 ${items.length} 条`
      : `库内命中 ${page.total} 条`;
  return { items, note };
}

// ---------------------------------------------------------------- search_arxiv

/** 实时检索用的假源：parseArxivAtom 只需要 id/kind 两个字段参与构造 */
const CHAT_ARXIV_SOURCE: Source = {
  id: 'chat-arxiv-live',
  kind: 'arxiv',
  label: 'arXiv 实时检索',
  url: '',
  weight: 1,
  enabled: false,
  tags: [],
  note: 'chat 工具实时检索的临时载体，不落库',
  createdAt: '1970-01-01T00:00:00.000Z',
};

/**
 * 把自由文本/检索式转成 arXiv API 能吃的 search_query 值。
 *
 * 为什么不能用 encodeURIComponent 整体编码：`all:` 的冒号一被编码成 `%3A`，
 * arXiv 就解析不出字段前缀，查询退化成「按提交时间返回全部最新论文」——
 * 看起来"成功返回 10 条"，实际全是无关噪音（实测踩过）。
 *
 * 两种形态：
 *  - 已带字段语法（all:/ti:/abs:…）或布尔算符：按原始检索式对待，只做
 *    空格→+ 与引号→%22 的最小替换（: ( ) 在 query 部分是合法字符）；
 *  - 纯自然语言：拆词后每个词一个 all: 字段、AND 连接——arXiv 对裸短语
 *    解析脆弱，单词字段是最稳的口径。
 */
export function arxivSearchQuery(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  const hasFieldSyntax = /\b(all|ti|abs|co|jr|au|id|cat):/i.test(trimmed);
  const hasBoolean = /\s(AND|OR|ANDNOT)\s/i.test(trimmed);
  if (hasFieldSyntax || hasBoolean) {
    return trimmed.replace(/\s+/g, '+').replace(/"/g, '%22');
  }
  const terms = trimmed
    .split(/\s+/)
    .slice(0, 8)
    .filter((term) => /^[\w%.-]+$/.test(term))
    .map((term) => `all:${term}`);
  return terms.join('+AND+');
}

export async function searchArxiv(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const query = argString(args['query'], 200);
  if (query === '') return { items: [], note: '缺少检索词（args.query）' };
  const limit = argInt(args['limit'], 1, 15, 10);
  const searchQuery = arxivSearchQuery(query);
  if (searchQuery === '') return { items: [], note: '检索词没有可用的词元（只认字母数字/常见符号）' };
  const url =
    `https://export.arxiv.org/api/query?search_query=${searchQuery}` +
    `&sortBy=submittedDate&sortOrder=descending&max_results=${limit}`;

  let body: string;
  try {
    const response = await ctx.fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': USER_AGENT, accept: 'application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8' },
    });
    if (!response.ok) return { items: [], note: `arXiv 实时检索失败：HTTP ${response.status}` };
    body = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { items: [], note: `arXiv 实时检索失败：${message}` };
  }

  const raws = parseArxivAtom(body, CHAT_ARXIV_SOURCE, ctx.now()).slice(0, limit);
  const items: ChatSourceItem[] = raws.map((raw) => ({
    title: raw.title,
    url: raw.url,
    kind: 'paper',
    meta: {
      authors: raw.authors,
      publishedAt: raw.publishedAt,
      summary: raw.summary.slice(0, 160),
      ...(raw.externalId ? { externalId: raw.externalId } : {}),
    },
  }));
  return { items, note: `arXiv 实时返回 ${items.length} 条（search_query=${searchQuery}，近提交优先）` };
}

// ---------------------------------------------------------------- search_patents

/**
 * Google Patents 免鉴权 XHR 接口（Lead 已实测 200）。
 * 响应形状：results.cluster[].result[]，条目字段在 result[].patent 里；
 * 兼容把字段直接放在 result[] 上的写法（取 entry.patent ?? entry）。
 */
interface RawPatentEntry {
  title?: unknown;
  snippet?: unknown;
  publication_number?: unknown;
  assignee?: unknown;
  filing_date?: unknown;
}

/**
 * Google Patents 检索的可复用适配器：URL/UA/超时/解析收口在这一个函数。
 *
 * 为什么单独抽出来：巡检引擎（sweep.ts 的 engine=google_patents）与 chat 工具
 * 共用同一条解析路径——解析规则只存在一份，两边看到的世界才一致。
 * 返回 {items, error}：chat 侧把 error 降级成 note，sweep 侧把它当真实错误抛出
 * （巡检必须区分「0 命中」和「请求失败」，否则快照会把失败记成 0 命中污染趋势）。
 */
export async function queryGooglePatents(
  fetchLike: FetchLike,
  query: string,
  limit = 10,
): Promise<{ items: ChatSourceItem[]; error?: string }> {
  // 内层查询串的空格必须是 + 而不是 %20：GP 的 xhr/query?url= 是「查询串再编码一次」的
  // 双层结构，%20 会让它的解析归零——实测同一查询 + 形态 886 命中、%20 形态 0 命中。
  // 所以先空格→+，再整体 encodeURIComponent（+ 传输为 %2B，GP 解码后当词分隔符）。
  const url = `https://patents.google.com/xhr/query?url=${encodeURIComponent(`q=${query.replace(/ /g, '+')}`)}`;

  let payload: unknown;
  try {
    // 必须带 UA：无 UA 请求会被 Google 拒绝
    const response = await fetchLike(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    });
    if (!response.ok) return { items: [], error: `HTTP ${response.status}` };
    payload = await response.json();
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : String(error) };
  }

  const clusters = (payload as { results?: { cluster?: unknown } })?.results?.cluster;
  const entries: RawPatentEntry[] = [];
  if (Array.isArray(clusters)) {
    for (const cluster of clusters) {
      const results = (cluster as { result?: unknown })?.result;
      if (Array.isArray(results)) entries.push(...(results as RawPatentEntry[]));
    }
  }

  const items: ChatSourceItem[] = [];
  for (const entry of entries) {
    const patent = (entry as { patent?: RawPatentEntry }).patent ?? entry;
    const pubNumber = typeof patent.publication_number === 'string' ? patent.publication_number : '';
    const title = typeof patent.title === 'string' ? stripTags(patent.title) : '';
    if (pubNumber === '' && title === '') continue;
    const assignee = Array.isArray(patent.assignee)
      ? patent.assignee.filter((a): a is string => typeof a === 'string').join('、')
      : typeof patent.assignee === 'string'
        ? patent.assignee
        : '';
    items.push({
      title: title || pubNumber,
      url: pubNumber === '' ? '' : `https://patents.google.com/patent/${pubNumber}/en`,
      kind: 'patent',
      meta: {
        publication_number: pubNumber,
        assignee,
        filing_date: typeof patent.filing_date === 'string' ? patent.filing_date : '',
        snippet: typeof patent.snippet === 'string' ? stripTags(patent.snippet).slice(0, 160) : '',
      },
    });
    if (items.length >= limit) break;
  }
  return { items };
}

export async function searchPatents(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const query = argString(args['query'], 200);
  if (query === '') return { items: [], note: '缺少检索词（args.query）' };
  const limit = argInt(args['limit'], 1, 10, 10);

  const { items, error } = await queryGooglePatents(ctx.fetch, query, limit);
  if (error) return { items: [], note: `Google Patents 检索失败：${error}` };
  if (items.length === 0) return { items, note: 'Google Patents 未解析到条目（接口结构可能变化或无命中）' };
  return { items, note: `Google Patents 返回 ${items.length} 条` };
}

// ---------------------------------------------------------------- generate_ideas

export async function generateIdeasTool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const focus = argString(args['focus'], 200);
  if (focus === '') return { items: [], note: '缺少 focus（技术方向），无法生成选题' };
  const count = argInt(args['count'], 1, 5, 3);

  let ideas: Idea[];
  try {
    ({ ideas } = await ctx.generateIdeas({ focus, count }));
  } catch (error) {
    // 领域错误按 errors.ts 统一翻译（no_items→422、llm_bad_output→502 等），照常抛出；
    // 超时/网络类错误降级为工具 note：对话不该因为一次生成慢就整个 500，
    // 编排层拿到 note 后还能向用户解释「生成失败，可重试」。
    const mapped = mapDomainError(error);
    if (mapped) throw mapped;
    const message = error instanceof Error ? error.message : String(error);
    if (/超时|TimeoutError|AbortError|fetch failed|ECONN|ENOTFOUND/i.test(message)) {
      return { items: [], note: `生成选题失败：${message}。可减少 count 或稍后重试。` };
    }
    throw error;
  }

  const items: ChatSourceItem[] = ideas.map((idea) => ({
    title: idea.title,
    url: '',
    kind: 'idea',
    meta: {
      id: idea.id,
      status: idea.status,
      problem: idea.problem.slice(0, 120),
      queries: idea.queries,
    },
  }));
  return { items, note: `已生成 ${items.length} 条专利选题并入库，可在选题工作台查看` };
}

// ---------------------------------------------------------------- export_disclosure

/** 导出专利交底书：不生成内容（导出端点实时渲染），只给可点击的下载链接 */
export function exportDisclosure(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const ideaId = argString(args['ideaId'], 128);
  // 只认 md/docx，其它值静默落回默认 docx（Word 是代理人实际要的格式）
  const format = args['format'] === 'md' ? 'md' : 'docx';
  const idea = ideaId === '' ? undefined : ctx.getIdea(ideaId);
  if (!idea) return { items: [], note: ideaId === '' ? '缺少 ideaId（args.ideaId）' : `选题 ${ideaId} 不存在` };

  return {
    items: [
      {
        title: `${idea.title}（交底书 ${format.toUpperCase()}）`,
        url: `/api/ideas/${ideaId}/disclosure?format=${format}`,
        kind: 'idea',
        meta: { ideaId, format },
      },
    ],
    note: '交底书已就绪，点击条目链接即可下载；内容为技术问题/方案/效果的结构化章节 + 查新记录如实转录',
  };
}

// ---------------------------------------------------------------- check_novelty

/** 查新记录的一行式摘要（给 draft_claims 的提示与 check_novelty 的 meta 用） */
function noveltyDigest(records: NoveltyRecord[], max = 5): string {
  return records
    .slice(-max)
    .map((record) => `[${record.at.slice(0, 10)}] ${record.query} → 命中 ${record.hits ?? '未知'}（${record.topAssignees || '无申请人'}）`)
    .join('\n');
}

/**
 * 查新闭环：配置了智慧芽 CLI → 跑真查新（结果落库）；
 * 没配置 → 摘要已有查新记录；两者皆无 → note 引导配置/手工登记。
 * 自动查新失败（登录掉了/页面改版）不抛死：回退为已有记录判读，note 里说明。
 */
export async function checkNovelty(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const ideaId = argString(args['ideaId'], 128);
  const idea = ideaId === '' ? undefined : ctx.getIdea(ideaId);
  if (!idea) return { items: [], note: ideaId === '' ? '缺少 ideaId（args.ideaId）' : `选题 ${ideaId} 不存在` };

  let current = idea;
  let sourceNote: string;
  if (ctx.noveltyCommandAvailable && ctx.autoNovelty) {
    try {
      current = await ctx.autoNovelty(ideaId);
      sourceNote = '已跑自动查新（智慧芽 CLI），结果已落库';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sourceNote = `自动查新失败（${message.slice(0, 120)}），以下基于已有查新记录判读`;
    }
  } else if (idea.novelty.length > 0) {
    sourceNote = '未配置智慧芽 CLI，基于已有查新记录判读';
  } else {
    return {
      items: [],
      note: '该选题还没有查新记录，也无法自动查新：可配置智慧芽 CLI（settings 或 ZHY_COMMAND）后再试，或在选题工作台手动登记查新（检索式 + 命中数）',
    };
  }

  if (current.novelty.length === 0) {
    return { items: [], note: `${sourceNote}；但记录为空，请先手动登记或重试自动查新` };
  }
  if (!ctx.summarizeVerdict) {
    return { items: [], note: `${sourceNote}；判读模块未就绪（verdict.ts 需导出 summarizeVerdict），暂无法给出四档判读` };
  }

  const summary = ctx.summarizeVerdict(current.novelty);
  return {
    items: [
      {
        title: `${current.title}｜${summary.headline}`,
        url: `/api/ideas/${ideaId}`,
        kind: 'idea',
        meta: {
          verdict: summary.verdict,
          headline: summary.headline,
          evidence: summary.evidence,
          suggestions: summary.suggestions,
          recordCount: current.novelty.length,
        },
      },
    ],
    note: `${sourceNote}。判读口径：命中数 0=存疑、低位=机会、高位=红海；建议(suggestions)可直接采纳为改词方向`,
  };
}

// ---------------------------------------------------------------- draft_claims

/** 从模型输出里取 claims 数组：认 {claims:[...]}，也容忍裸数组 */
function parseClaims(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { claims?: unknown } | null)?.claims)
      ? ((raw as { claims: unknown[] }).claims)
      : [];
  return list
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.trim());
}

/**
 * 权利要求草案：基于 idea 的 problem/solution/effect + 查新记录（如有），
 * 生成独立 1 条 + 从属 3-5 条。草稿 INSERT OR REPLACE 进 idea_claims
 * （GET /api/ideas/:id/claims 读取），items 里带全文 claims——这是主载荷，
 * 序列化截断上限单独放宽到 ~2500 字符（见 prompt.ts META_VALUE_CAPS）。
 */
export async function draftClaims(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const ideaId = argString(args['ideaId'], 128);
  const idea = ideaId === '' ? undefined : ctx.getIdea(ideaId);
  if (!idea) return { items: [], note: ideaId === '' ? '缺少 ideaId（args.ideaId）' : `选题 ${ideaId} 不存在` };
  if (!ctx.llm) return { items: [], note: 'LLM 未配置，无法起草权利要求（需 LLM_BASE_URL / LLM_API_KEY）' };

  const { system, user } = buildClaimsPrompt({
    title: idea.title,
    problem: idea.problem,
    solution: idea.solution,
    effect: idea.effect,
    queries: idea.queries,
    noveltyDigest: idea.novelty.length > 0 ? noveltyDigest(idea.novelty) : '',
  });

  let raw: unknown;
  try {
    const answer = await ctx.llm.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.3 },
    );
    raw = extractJson(answer);
  } catch (error) {
    if (mapDomainError(error)) throw mapDomainError(error);
    const reason = error instanceof Error ? error.message : String(error);
    throw badGateway('llm_bad_output', `权利要求输出无法解析为 JSON：${reason}`);
  }

  const claims = parseClaims(raw);
  if (claims.length === 0) {
    throw badGateway('llm_bad_output', '权利要求输出里没有可用的 claims 数组');
  }

  const content = claims.join('\n');
  ctx.saveClaims(ideaId, content);

  return {
    items: [
      {
        title: `权利要求草案（${claims.length} 条）`,
        url: '',
        kind: 'idea',
        meta: { ideaId, claims: content },
      },
    ],
    note: `草案已存档，可经 GET /api/ideas/${ideaId}/claims 取回；草案由模型生成，仅供人工修订，不构成法律意见`,
  };
}

// ---------------------------------------------------------------- 分发

export async function runTool(ctx: ToolContext, action: ChatToolName, args: Record<string, unknown>): Promise<ToolResult> {
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  switch (action) {
    case 'search_local':
      return searchLocal(ctx, safeArgs);
    case 'search_arxiv':
      return searchArxiv(ctx, safeArgs);
    case 'search_patents':
      return searchPatents(ctx, safeArgs);
    case 'generate_ideas':
      return generateIdeasTool(ctx, safeArgs);
    case 'export_disclosure':
      return exportDisclosure(ctx, safeArgs);
    case 'check_novelty':
      return checkNovelty(ctx, safeArgs);
    case 'draft_claims':
      return draftClaims(ctx, safeArgs);
  }
}
