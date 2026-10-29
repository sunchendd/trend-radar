/**
 * 所有 /api 路由。这里只做三件事：zod 校验入参 → 调下层 → 广播 SSE。
 * 参数边界、字段名、状态码都以 docs/api.md 为准；业务规则（打分/去重/查新）
 * 全部留在 store / collect / ideas 里，路由函数保持短小。
 */
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { VerdictSummary } from '../ideas/verdict.js';
import type { Idea, Item, ItemQuery, NoveltyRecord, RunRecord } from '../types.js';
import type { HttpDeps } from './deps.js';
import { notFound, parse, serviceUnavailable } from './errors.js';
import type { SseHub } from './sse.js';
import { disclosureFilename, toDisclosureMarkdown } from '../ideas/disclosure.js';

const DEFAULT_LIMIT = 30;
const EXPORT_LIMIT = 5000;
const RUNS_PAGE = 20;

/** 空字符串按「没传」处理，否则 `?limit=` 会被 coerce 成 0 而不是默认值 */
const emptyToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

const optionalInt = (min: number, max: number): z.ZodType<number | undefined> =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).optional()) as z.ZodType<number | undefined>;

const optionalNumber = (min: number, max: number): z.ZodType<number | undefined> =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(min).max(max).optional()) as z.ZodType<number | undefined>;

/** preprocess 会把输出类型放宽成 unknown，这里按需显式收回，避免污染 ItemQuery */
const optionalString = (schema: z.ZodType<string>): z.ZodType<string | undefined> =>
  z.preprocess(emptyToUndefined, schema.optional()) as z.ZodType<string | undefined>;

const idParams = z.object({ id: z.string().trim().min(1).max(128) });

const itemsQuerySchema = z.object({
  q: optionalString(z.string().trim().min(1).max(200)),
  sourceId: optionalString(z.string().trim().min(1).max(128)),
  kind: z
    .enum(['paper', 'news', 'release'], { errorMap: () => ({ message: '只能是 paper|news|release' }) })
    .optional(),
  minScore: optionalNumber(0, 100),
  since: optionalString(z.string().refine((value) => !Number.isNaN(Date.parse(value)), '必须是 ISO 8601 日期')),
  sort: z.enum(['score', 'time'], { errorMap: () => ({ message: '只能是 score 或 time' }) }).optional().default('score'),
  limit: optionalInt(1, 200),
  offset: optionalInt(0, Number.MAX_SAFE_INTEGER),
});

const ideasQuerySchema = z.object({
  status: z
    .enum(['draft', 'verified', 'red-ocean', 'archived'], {
      errorMap: () => ({ message: '只能是 draft|verified|red-ocean|archived' }),
    })
    .optional(),
});

const exportQuerySchema = z.object({
  format: z.enum(['csv', 'json'], { errorMap: () => ({ message: '只能是 csv 或 json' }) }).optional().default('csv'),
});

const collectBodySchema = z.object({
  sourceIds: z.array(z.string().trim().min(1).max(128)).min(1).max(50).optional(),
});

const sourceInputSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, '只能是小写字母/数字/-/_/. 且以字母数字开头'),
  kind: z.enum(['arxiv', 'atom', 'rss'], { errorMap: () => ({ message: '只能是 arxiv|atom|rss' }) }),
  label: z.string().trim().min(1).max(120),
  url: z
    .string()
    .trim()
    .max(2000)
    .refine((value) => /^https?:\/\//i.test(value), '必须是 http(s) 地址'),
  weight: z.number().min(0.1).max(3).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  note: z.string().trim().max(500).optional(),
});

const sourcePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    weight: z.number().min(0.1).max(3).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: '至少提供 enabled/weight/note 之一' });

const ideaPatchSchema = z
  .object({
    status: z
      .enum(['draft', 'verified', 'red-ocean', 'archived'], {
        errorMap: () => ({ message: '只能是 draft|verified|red-ocean|archived' }),
      })
      .optional(),
    title: z.string().trim().min(1).max(300).optional(),
    problem: z.string().trim().min(1).max(4000).optional(),
    solution: z.string().trim().min(1).max(8000).optional(),
    effect: z.string().trim().min(1).max(4000).optional(),
    queries: z.array(z.string().trim().min(1).max(200)).min(1).max(8).optional(),
    risks: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: '至少提供一个可修订字段' });

const generateBodySchema = z.object({
  focus: z.string().trim().min(1).max(200),
  count: z.number().int().min(1).max(20),
  itemIds: z.array(z.string().trim().min(1).max(128)).min(1).max(200).optional(),
});

const noveltyBodySchema = z.object({
  query: z.string().trim().min(1).max(500),
  // null 与 0 语义不同：null = 页面解析失败，0 = 确实没有命中，所以这里必须允许 null
  hits: z.number().int().min(0).nullable(),
  topAssignees: z.string().trim().max(500).optional(),
  note: z.string().trim().max(1000).optional(),
  site: z.enum(['zhihuiya', 'manual', 'other']).optional(),
});

const noveltyAutoBodySchema = z.object({
  queries: z.array(z.string().trim().min(1).max(200)).min(1).max(8).optional(),
});

// ---------------------------------------------------------------- 采集幂等

export type CollectorFn = (opts?: { sourceIds?: string[] }) => Promise<RunRecord>;

/**
 * 幂等采集：同一时刻只允许一次 runCollect 在飞，后到者复用同一个 Promise。
 * 定时采集与 POST /api/collect 共用同一个实例，所以两者也不会互相叠加。
 */
export function createCollector(config: AppConfig, deps: HttpDeps, hub: SseHub): CollectorFn {
  let inFlight: Promise<RunRecord> | null = null;

  return (opts) => {
    if (inFlight) return inFlight;
    inFlight = deps
      .runCollect(config, opts)
      .then((run) => {
        hub.broadcast('run', run);
        hub.broadcast('items', { runId: run.id, added: run.added });
        return run;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

// ---------------------------------------------------------------- 判读摘要

/**
 * 所有返回选题的端点都统一挂 `verdictSummary`：判读规则只在 ideas/verdict.ts 里存在一份，
 * 前端只做展示，不再自己算阈值。verdict.ts 缺失时优雅降级成原始 Idea。
 */
const withVerdict = <T extends Idea>(idea: T, deps: HttpDeps): T | (T & { verdictSummary: VerdictSummary }) => {
  const summary = deps.summarizeVerdict?.(idea.novelty);
  return summary ? { ...idea, verdictSummary: summary } : idea;
};

// ---------------------------------------------------------------- CSV

/** Excel 会把以 = + - @ 开头的单元格当公式执行，导出时前置单引号 */
const csvCell = (value: unknown): string => {
  const raw = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
};

export const CSV_COLUMNS = ['score', 'kind', 'title', 'url', 'sourceId', 'publishedAt'] as const;

export function toCsv(rows: readonly Item[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  // BOM：不加的话 Excel 会按 GBK 解读 UTF-8 中文标题
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- 注册

export interface RouteContext {
  config: AppConfig;
  deps: HttpDeps;
  hub: SseHub;
  collect: CollectorFn;
  version: string;
  startedAt: number;
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { config, deps, hub, collect } = ctx;

  app.get('/api/health', async () => ({
    ok: true as const,
    version: ctx.version,
    uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
  }));

  app.get('/api/stats', async () => deps.stats());

  app.get('/api/items', async (req) => {
    const query = parse(itemsQuerySchema, req.query);
    const itemQuery: ItemQuery = {
      ...query,
      limit: query.limit ?? DEFAULT_LIMIT,
      offset: query.offset ?? 0,
    };
    return deps.listItems(itemQuery);
  });

  app.get('/api/items/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const item = deps.getItem(id);
    if (!item) throw notFound(`条目 ${id} 不存在`);
    return item;
  });

  app.get('/api/sources', async () => deps.listSources());

  app.get('/api/ideas', async (req) => {
    const { status } = parse(ideasQuerySchema, req.query);
    return deps.listIdeas(status).map((idea) => withVerdict(idea, deps));
  });

  app.get('/api/ideas/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const idea = deps.getIdea(id);
    if (!idea) throw notFound(`选题 ${id} 不存在`);
    return withVerdict(idea, deps);
  });

  // 导出专利交底书：结构化章节 + 如实转录查新记录（不编造实验数据与附图）
  app.get('/api/ideas/:id/disclosure', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const idea = deps.getIdea(id);
    if (!idea) throw notFound(`选题 ${id} 不存在`);
    const summary = deps.summarizeVerdict?.(idea.novelty);
    // cites 里存的是条目 id，导出时要换成可点开的标题与链接
    const cites = idea.cites
      .map((citeId) => deps.getItem(citeId))
      .filter((item): item is Item => item !== undefined)
      .map((item) => ({ title: item.title, url: item.url, score: item.score }));
    const markdown = toDisclosureMarkdown(idea, {
      ...(summary ? { verdictHeadline: summary.headline } : {}),
      cites,
    });
    const filename = disclosureFilename(idea);
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="disclosure.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      )
      .send(markdown);
  });

  app.get('/api/runs', async () => deps.listRuns(RUNS_PAGE));

  app.get('/api/export', async (req, reply) => {
    const { format } = parse(exportQuerySchema, req.query);
    // 导出不分页：走 store 的 exportItems（内部有硬上限），不能拿 listItems 的 200 上限凑
    const items = deps.exportItems({ sort: 'score' }, EXPORT_LIMIT);
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      return reply
        .header('content-disposition', `attachment; filename="trend-radar-items-${stamp}.json"`)
        .send(items);
    }

    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="trend-radar-items-${stamp}.csv"`)
      .send(toCsv(items));
  });

  // ---------------------------------------------------------------- 写操作

  app.post('/api/collect', async (req) => {
    const body = parse(collectBodySchema, req.body ?? {});
    return collect(body.sourceIds ? { sourceIds: body.sourceIds } : undefined);
  });

  app.post('/api/sources', async (req, reply) => {
    const input = parse(sourceInputSchema, req.body ?? {});
    const source = await deps.createSource(input);
    return reply.code(201).send(source);
  });

  app.patch('/api/sources/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(sourcePatchSchema, req.body ?? {});
    const source = deps.updateSource(id, patch);
    if (!source) throw notFound(`源 ${id} 不存在`);
    return source;
  });

  app.delete('/api/sources/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    if (!deps.deleteSource(id)) throw notFound(`源 ${id} 不存在`);
    return { ok: true as const, id };
  });

  app.post('/api/ideas/generate', async (req) => {
    const body = parse(generateBodySchema, req.body ?? {});
    // 判定规则只保留一份（ideas/llm.ts 的 isLlmConfigured），这里只负责把它翻成 503
    if (!deps.isLlmConfigured()) {
      throw serviceUnavailable(
        'llm_not_configured',
        'LLM 未配置（LLM_BASE_URL / LLM_API_KEY），请先在环境变量里填好再生成选题',
      );
    }
    const result = await deps.generateIdeas(body);
    const ideas = result.ideas.map((idea) => withVerdict(idea, deps));
    for (const idea of ideas) hub.broadcast('idea', idea);
    return { ...result, ideas };
  });

  app.patch('/api/ideas/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(ideaPatchSchema, req.body ?? {});
    const updated = deps.updateIdea(id, patch);
    if (!updated) throw notFound(`选题 ${id} 不存在`);
    const idea = withVerdict(updated, deps);
    hub.broadcast('idea', idea);
    return idea;
  });

  app.delete('/api/ideas/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const archived = deps.archiveIdea(id);
    if (!archived) throw notFound(`选题 ${id} 不存在`);
    const idea = withVerdict(archived, deps);
    hub.broadcast('idea', idea);
    return idea;
  });

  app.post('/api/ideas/:id/novelty', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(noveltyBodySchema, req.body ?? {});
    const record: NoveltyRecord = {
      at: new Date().toISOString(),
      query: body.query,
      hits: body.hits,
      topAssignees: body.topAssignees ?? '',
      note: body.note ?? '',
      site: body.site ?? 'manual',
    };
    const written = deps.recordNovelty(id, record);
    if (!written) throw notFound(`选题 ${id} 不存在`);
    // 写回后立即重算：前端不用再发一次 GET 才能看到新结论
    const idea = withVerdict(written, deps);
    hub.broadcast('idea', idea);
    return idea;
  });

  app.post('/api/ideas/:id/novelty/auto', async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(noveltyAutoBodySchema, req.body ?? {});
    if (!deps.getIdea(id)) throw notFound(`选题 ${id} 不存在`);
    if (!config.novelty.command.trim() || !existsSync(config.novelty.command)) {
      throw serviceUnavailable(
        'novelty_not_configured',
        `智慧芽查新 CLI 未配置或不存在（${config.novelty.command || '空'}），请手工登记查新记录`,
      );
    }
    const written = await deps.autoNovelty(id, body.queries);
    const idea = withVerdict(written, deps);
    hub.broadcast('idea', idea);
    return idea;
  });

  // ---------------------------------------------------------------- SSE
  app.get('/api/events', (_req, reply) => {
    // 长连接由 hub 完全接管；handler 立即返回，fastify 不再管这个 reply
    reply.hijack();
    hub.add(reply.raw);
  });
}
