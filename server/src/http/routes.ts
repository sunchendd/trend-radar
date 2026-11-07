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
import type { AppSettings, AppSettingsPatch, Idea, Item, ItemQuery, NoveltyRecord, RunRecord } from '../types.js';
import { nextRunAt, refreshModeOf, type Scheduler } from '../scheduler.js';
import type { HttpDeps } from './deps.js';
import { ApiException, badGateway, mapDomainError, notFound, parse, serviceUnavailable, unprocessable } from './errors.js';
import type { SseHub } from './sse.js';
import { disclosureFilename, toDisclosureMarkdown } from '../ideas/disclosure.js';
import { buildDocx } from '../ideas/docx.js';
import { createLlm, type LlmClient } from '../ideas/llm.js';
import { runChat } from '../chat/orchestrator.js';
import { CHAT_SSE_HEADERS, createChatSseWriter } from '../chat/sse.js';
import { chatGate } from '../chat/gate.js';
import { runPaperAsk } from '../papers/ask.js';
import { ANNOTATION_COLORS } from '../store/papers.js';
import { createReadStream } from 'node:fs';
import { openChatStore, type ChatStore, type ChatStoredSource } from '../store/chat-store.js';
import type { WatchEngine } from '../store/watches.js';
import { pushBark } from '../push/bark.js';

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

const ITEM_KINDS = ['paper', 'news', 'release'] as const;
type ItemKindName = (typeof ITEM_KINDS)[number];

/** `kinds=news,release`：多选筛选，空串/空数组都表示不过滤；非法值点名报错 */
const kindsQuerySchema = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .max(200)
    .transform((raw, ctx) => {
      const parts = raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
      const invalid = parts.filter((part) => !(ITEM_KINDS as readonly string[]).includes(part));
      if (invalid.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `非法值 ${invalid.join(',')}，只能是 ${ITEM_KINDS.join('|')}`,
        });
        return z.NEVER;
      }
      return [...new Set(parts)] as ItemKindName[];
    })
    .optional(),
) as z.ZodType<ItemKindName[] | undefined>;

const itemsQuerySchema = z.object({
  q: optionalString(z.string().trim().min(1).max(200)),
  sourceId: optionalString(z.string().trim().min(1).max(128)),
  // 单值 kind 保留（老前端/curl 习惯），与 kinds 合并成一份去重数组
  kind: z
    .enum(['paper', 'news', 'release'], { errorMap: () => ({ message: '只能是 paper|news|release' }) })
    .optional(),
  kinds: kindsQuerySchema,
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

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const settingsPatchSchema = z
  .object({
    dailyRefreshAt: z.string().trim().regex(HHMM_PATTERN, '必须是 HH:mm（00:00–23:59）').optional(),
    dailyRefreshEnabled: z.boolean().optional(),
    collectMinutes: z.number().int().min(0).max(10_080, '最多 10080 分钟（7 天）').optional(),
    limitPerSource: z.number().int().min(1).max(200).optional(),
    minKeepScore: z.number().min(0).max(100).optional(),
    ttlDays: z.number().int().min(1).max(3650).optional(),
    highScore: z.number().min(0).max(100).optional(),
    midScore: z.number().min(0).max(100).optional(),
    llm: z
      .object({
        baseUrl: z.string().trim().max(500).optional(),
        model: z.string().trim().max(120).optional(),
        // 空串 = 不改（设置页拿不到明文 key，用户没重填时提交的就是空串）
        apiKey: z.string().trim().max(500).optional(),
      })
      .optional(),
    novelty: z.object({ command: z.string().trim().max(500).optional() }).optional(),
    translation: z
      .object({
        enabled: z.boolean().optional(),
        dailyLimit: z.number().int().min(0).max(100_000, '最多 100000 条/日').optional(),
      })
      .optional(),
    bark: z
      .object({
        // 空串 = 清除 URL（推送随之静默）
        url: z
          .string()
          .trim()
          .max(500)
          .refine((value) => value === '' || /^https?:\/\//i.test(value), '必须是 http(s) 地址')
          .optional(),
        enabled: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: '至少提供一个可修改字段' })
  .refine((body) => body.midScore === undefined || body.highScore === undefined || body.midScore <= body.highScore, {
    message: 'midScore 不能大于 highScore',
    path: ['midScore'],
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

const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant'], { errorMap: () => ({ message: '只能是 user 或 assistant' }) }),
  content: z.string().trim().min(1).max(4000),
});

const chatBodySchema = z.object({
  message: z.string().trim().min(1, 'message 不能为空').max(2000),
  history: z.array(chatMessageSchema).max(12).optional(),
  // 带 sessionId = 持久化会话模式（服务端取历史、双向落库）；不带的旧模式完全兼容
  sessionId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, '只能是字母/数字/下划线/连字符，长度 8-64')
    .optional(),
});


// ---------------------------------------------------------------- 论文阅读器

const colorEnum = z.enum(ANNOTATION_COLORS, {
  errorMap: () => ({ message: `高亮色只能是 ${ANNOTATION_COLORS.join(' / ')}` }),
});

/** 高亮矩形归一化到页面（0–1），随缩放/窗口不变 */
const rectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

const annotationCreateSchema = z.object({
  page: z.number().int().min(1).max(100_000),
  rects: z.array(rectSchema).min(1, '至少一个选区矩形').max(200),
  text: z.string().max(16_000).optional(),
  note: z.string().max(16_000).optional(),
  color: colorEnum.optional(),
});

const annotationPatchSchema = z
  .object({
    note: z.string().max(16_000).optional(),
    color: colorEnum.optional(),
  })
  .refine((body) => body.note !== undefined || body.color !== undefined, {
    message: '至少提供 note/color 之一',
  });

const paperAskBodySchema = z.object({
  question: z.string().trim().min(1, 'question 不能为空').max(2000),
  page: z.number().int().min(1).max(100_000).optional(),
  pageText: z.string().max(30_000).optional(),
  selection: z.string().max(10_000).optional(),
  history: z.array(chatMessageSchema).max(8).optional(),
});

/** 会话模式下回灌给模型的 history 条数（与旧模式 history 上限一致） */
const CHAT_HISTORY_LIMIT = 12;
/** 单会话明细返回的消息上限 */
const CHAT_SESSION_MESSAGES = 200;
/** 会话列表返回条数 */
const CHAT_SESSIONS_LIMIT = 20;

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
  /** 采集调度器；buildApp（测试/无定时场景）下为 undefined */
  scheduler?: Scheduler;
  version: string;
  startedAt: number;
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { config, deps, hub, collect } = ctx;

  /**
   * chat 会话存储：懒打开（第一次用到会话/草案才连库），onClose 统一释放。
   * 与主库同一个 dataDir 文件、独立连接 + WAL，绝不碰 db.ts 的迁移链。
   */
  let chatStoreInstance: ChatStore | undefined;
  const getChatStore = (): ChatStore => (chatStoreInstance ??= openChatStore(config.dataDir));
  app.addHook('onClose', async () => {
    chatStoreInstance?.close();
    chatStoreInstance = undefined;
  });

  app.get('/api/health', async () => ({
    ok: true as const,
    version: ctx.version,
    uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
  }));

  app.get('/api/stats', async () => deps.stats());

  /**
   * 下一次刷新时刻是「设置 + 当前时间」的纯函数结果，所以即使没有调度器
   * （buildApp 不装定时器）也能如实算给前端看。
   */
  const withNextRefresh = (settings: AppSettings): AppSettings => ({
    ...settings,
    nextRefreshAt: nextRunAt(settings, new Date())?.toISOString() ?? null,
    // 模式和时间必须同源推导，别信调用方传进来的旧值
    refreshMode: refreshModeOf(settings),
  });

  app.get('/api/settings', async () => withNextRefresh(deps.getSettings()));

  app.put('/api/settings', async (req) => {
    const patch = parse(settingsPatchSchema, req.body ?? {}) as AppSettingsPatch;
    const current = deps.getSettings();
    const midScore = patch.midScore ?? current.midScore;
    const highScore = patch.highScore ?? current.highScore;
    // 只改一半时 zod 的交叉校验看不到另一半，这里按「合并后」再校一次
    if (midScore > highScore) {
      throw new ApiException(400, 'validation_error', `midScore: 不能大于 highScore（${midScore} > ${highScore}）`, {
        fields: [{ field: 'midScore', message: '不能大于 highScore' }],
      });
    }

    const saved = withNextRefresh(deps.updateSettings(patch));
    // 立即重排：改完不用重启，也不用等下个周期
    ctx.scheduler?.reschedule(saved);
    app.log.info(
      { dailyRefreshEnabled: saved.dailyRefreshEnabled, dailyRefreshAt: saved.dailyRefreshAt, nextRefreshAt: saved.nextRefreshAt },
      '采集计划已更新',
    );
    return saved;
  });

  app.get('/api/items', async (req) => {
    const { kind, kinds, ...query } = parse(itemsQuerySchema, req.query);
    // 两个参数可能同时出现：合并去重后只按 kinds 过滤，避免出现 `kind=? AND kind IN (...)` 的矛盾条件
    const mergedKinds = [...new Set<ItemKindName>([...(kinds ?? []), ...(kind ? [kind] : [])])];
    const itemQuery: ItemQuery = {
      ...query,
      kinds: mergedKinds,
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

  const disclosureQuerySchema = z.object({
    format: z.enum(['md', 'docx']).optional(),
  });

  const watchesQuerySchema = z.object({
    all: z.enum(['true', 'false']).optional(),
  });

  const watchBodySchema = z.object({
    query: z.string().trim().min(4, '检索式至少 4 个字符').max(80),
    note: z.string().trim().max(200).optional(),
    // 规范值是 google_patents（下划线）；同时接受前端在发的连字符写法，入口统一规范化。
    // transform 的 Input≠Output，与 kindsQuerySchema 同款：显式收回输出类型
    engine: z
      .enum(['zhihuiya', 'google_patents', 'google-patents'])
      .transform((value): WatchEngine => (value === 'google-patents' ? 'google_patents' : value))
      .optional(),
  }) as unknown as z.ZodType<{ query: string; note?: string; engine?: WatchEngine }>;

  const watchPatchSchema = z.object({ enabled: z.boolean() });

  // 手工创建选题：LLM 不可用时用户仍能把想法结构化进工作台（与生成结果同一张表、同一套判读）
  const manualIdeaSchema = z.object({
    title: z.string().trim().min(6).max(200),
    problem: z.string().trim().min(10).max(4000),
    solution: z.string().trim().min(20).max(8000),
    effect: z.string().trim().min(6).max(2000),
    keywords: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    ipcHints: z
      .array(z.string().trim().regex(/^[A-H]\d{2}[A-Z]\s?\d+\/\d+$/i, 'IPC 号格式非法，例：G06F12/0871'))
      .max(8)
      .optional(),
    queries: z.array(z.string().trim().min(3).max(60)).max(6).optional(),
    risks: z.array(z.string().trim().min(4).max(300)).max(6).optional(),
    focus: z.string().trim().max(200).optional(),
  });

  app.post('/api/ideas', async (req, reply) => {
    const body = parse(manualIdeaSchema, req.body ?? {});
    const now = new Date().toISOString();
    const id = `idea-manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const idea: Idea = {
      id,
      createdAt: now,
      updatedAt: now,
      title: body.title,
      problem: body.problem,
      solution: body.solution,
      effect: body.effect,
      keywords: body.keywords ?? [],
      ipcHints: body.ipcHints ?? [],
      queries: body.queries ?? [],
      risks: body.risks ?? [],
      status: 'draft',
      cites: [],
      focus: body.focus ?? '',
      novelty: [],
      promptVersion: 'manual',
    };
    const saved = deps.saveIdea(idea);
    hub.broadcast('idea', withVerdict(saved, deps));
    return reply.code(201).send(withVerdict(saved, deps));
  });

  app.get('/api/ideas', async (req) => {
    const { status } = parse(ideasQuerySchema, req.query);
    return deps.listIdeas(status).map((idea) => withVerdict(idea, deps));
  });

  // 选题按方向聚类：工作台用它标「同方向 ×N」，避免同一方向被当成新选题重复做
  app.get('/api/ideas/clusters', async (req) => {
    const { status } = parse(ideasQuerySchema, req.query);
    return deps.clusterIdeas(status).map((cluster) => ({
      id: cluster.id,
      label: cluster.label,
      sharedTerms: cluster.sharedTerms,
      size: cluster.ideas.length,
      ideaIds: cluster.ideas.map((idea) => idea.id),
      titles: cluster.ideas.map((idea) => idea.title),
    }));
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
    const { format } = parse(disclosureQuerySchema, req.query);
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

    if (format === 'docx') {
      // Word 是专利代理人实际要的格式；docx 由零依赖的 OOXML 写入器生成
      const buffer = buildDocx(markdown);
      return reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        .header(
          'content-disposition',
          `attachment; filename="disclosure.docx"; filename*=UTF-8''${encodeURIComponent(filename.replace(/\.md$/, '.docx'))}`,
        )
        .send(buffer);
    }

    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="disclosure.md"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      )
      .send(markdown);
  });

  // ---- 检索式巡检：盯住方向，命中数异动就是选题触发器 ----
  app.get('/api/watches', async (req) => {
    const { all } = parse(watchesQuerySchema, req.query);
    return deps.listWatches(all === 'true');
  });

  app.post('/api/watches', async (req, reply) => {
    const body = parse(watchBodySchema, req.body ?? {});
    const watch = deps.addWatch(body);
    return reply.code(201).send(watch);
  });

  app.delete('/api/watches/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    if (!deps.removeWatch(id)) throw notFound(`巡检项 ${id} 不存在`);
    return { ok: true };
  });

  app.patch('/api/watches/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { enabled } = parse(watchPatchSchema, req.body ?? {});
    if (!deps.setWatchEnabled(id, enabled)) throw notFound(`巡检项 ${id} 不存在`);
    const watch = deps.listWatches(true).find((item) => item.id === id);
    return watch ?? { ok: true };
  });

  // 同步跑一轮巡检：会调外部查新 CLI，正常 20–60s；单方向失败不影响其余
  app.post('/api/watches/sweep', async () => deps.sweepWatches());

  app.get('/api/runs', async () => deps.listRuns(RUNS_PAGE));

  // ---- 自动中文翻译（t18）：设置页给开关/上限/手动触发，列表页给状态角标 ----
  app.get('/api/translation/status', async () => deps.translationStatus());

  app.post('/api/translation/run', async () => {
    try {
      return await deps.runTranslation();
    } catch (cause) {
      // ApiException（如 translation_disabled 422）照原样冒泡；其余按统一规则翻译
      throw mapDomainError(cause) ?? cause;
    }
  });

  // ---- 工程动态（t21）：release 技术点抽取（LLM 优先/规则兜底） ----
  app.get('/api/extraction/status', async () => deps.extractionStatus());

  app.post('/api/extraction/run', async () => {
    try {
      return await deps.runExtraction();
    } catch (cause) {
      throw mapDomainError(cause) ?? cause;
    }
  });

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


  // ---------------------------------------------------------------- 论文阅读器

  /**
   * 触发论文 PDF 下载（幂等）：阅读器打开时自动调用，也可手动重试。
   * 返回最终 PaperInfo（status=ready/failed），failed 时 error 是可读原因。
   */
  app.post('/api/items/:id/paper', async (req) => {
    const { id } = parse(idParams, req.params);
    return deps.downloadPaper(id);
  });

  /** 下载状态查询：阅读器用它做进度轮询，也用于恢复「已下载」标记 */
  app.get('/api/items/:id/paper', async (req) => {
    const { id } = parse(idParams, req.params);
    if (!deps.getItem(id)) throw notFound(`条目 ${id} 不存在`);
    return deps.getPaperStatus(id);
  });

  /** PDF 原文流：阅读器 canvas 渲染的数据源（inline，浏览器可直接预览/另存） */
  app.get('/api/items/:id/paper/file', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const file = deps.getPaperFile(id);
    if (!file) throw notFound(`该条目的 PDF 尚未下载或已失效，请先触发下载`);
    reply
      .header('content-type', 'application/pdf')
      .header('content-length', file.bytes)
      .header('content-disposition', `inline; filename="${file.itemId}.pdf"`)
      // 下载后文件不可变：短缓存能让翻回上一页时秒开，又不会憋住「重新下载」
      .header('cache-control', 'private, max-age=600');
    return reply.send(createReadStream(file.path));
  });

  // ---- 高亮 / 笔记标注：按条目隔离，annotation id 全局唯一 ----

  app.get('/api/items/:id/annotations', async (req) => {
    const { id } = parse(idParams, req.params);
    if (!deps.getItem(id)) throw notFound(`条目 ${id} 不存在`);
    return deps.listPaperAnnotations(id);
  });

  app.post('/api/items/:id/annotations', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(annotationCreateSchema, req.body ?? {});
    const annotation = deps.addPaperAnnotation(id, body);
    return reply.code(201).send(annotation);
  });

  app.patch('/api/items/:id/annotations/:aid', async (req) => {
    const { id, aid } = parse(z.object({ id: idParams.shape.id, aid: idParams.shape.id }), req.params);
    const patch = parse(annotationPatchSchema, req.body ?? {});
    const updated = deps.updatePaperAnnotation(id, aid, patch);
    if (!updated) throw notFound(`标注 ${aid} 不存在`);
    return updated;
  });

  app.delete('/api/items/:id/annotations/:aid', async (req) => {
    const { id, aid } = parse(z.object({ id: idParams.shape.id, aid: idParams.shape.id }), req.params);
    if (!deps.removePaperAnnotation(id, aid)) throw notFound(`标注 ${aid} 不存在`);
    return { ok: true as const, id: aid };
  });

  /**
   * 选中文本提问（SSE）：帧契约与 /api/chat 相同（status/token/done/error），
   * 上下文 = 当前页文本 + 选中文本，不落库、不进全局会话。
   */
  app.post('/api/items/:id/paper/ask', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(paperAskBodySchema, req.body ?? {});
    const item = deps.getItem(id);
    if (!item) throw notFound(`条目 ${id} 不存在`);
    if (!deps.isLlmConfigured()) {
      throw serviceUnavailable('llm_not_configured', 'LLM 未配置（LLM_BASE_URL / LLM_API_KEY），论文提问不可用');
    }
    // 与 chat 共用并发闸：一条 LLM 流很贵，论文提问没有理由绕开限额
    if (!chatGate.tryAcquire()) {
      throw new ApiException(429, 'chat_busy', '当前对话并发已达上限（2），请等已有对话结束后再试');
    }

    let llm: LlmClient;
    try {
      llm = deps.createLlmClient
        ? deps.createLlmClient()
        : createLlm(config);
    } catch (cause) {
      chatGate.release();
      throw mapDomainError(cause) ?? serviceUnavailable('llm_not_configured', 'LLM 客户端创建失败，请检查 LLM 配置');
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, CHAT_SSE_HEADERS);
    const writer = createChatSseWriter((chunk) => {
      if (res.writableEnded || res.destroyed) throw new Error('paper ask SSE 连接已关闭');
      res.write(chunk);
    });
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.on('close', onClose);

    try {
      // status 帧给前端一个「正在思考」的指示；step 语义复用 chat 契约里的 plan
      writer.status('plan', '正在结合当前页内容思考…');
      await runPaperAsk(
        llm,
        {
          title: item.title,
          abstract: item.summary,
          page: body.page ?? 1,
          pageText: body.pageText ?? '',
          selection: body.selection ?? '',
        },
        body.history ?? [],
        { token: (text) => writer.token(text) },
        { signal: abort.signal },
      );
      writer.done({ messageId: `paper-ask-${Date.now().toString(36)}`, toolsUsed: ['paper_ask'] });
    } catch (error) {
      if (!abort.signal.aborted) {
        const mapped = error instanceof ApiException ? error : mapDomainError(error);
        if (mapped) writer.error(mapped.code, mapped.message);
        else {
          app.log.error({ err: error }, '论文提问失败');
          writer.error('internal_error', 'internal server error');
        }
      }
    } finally {
      res.off('close', onClose);
      abort.abort();
      chatGate.release();
      if (!res.writableEnded) res.end();
    }
  });

  // ---------------------------------------------------------------- chat（SSE 流式对话）

  /**
   * POST /api/chat：决策循环 + 流式合成，全程经 SSE 帧推给前端。
   * 帧契约（顺序不保证，除 done/error 恰好一帧收尾）：
   *   status  {"step","label"}   —— 阶段进度，多次
   *   sources {"items":[…]}      —— 证据全量（覆盖式），工具每次产出后发
   *   token   {"text"}           —— 回答增量，多次
   *   done    {"messageId","toolsUsed","sessionId"?} —— 恰好一帧，随后关闭；
   *             带 sessionId 持久化模式才回带 sessionId
   *   error   {"code","message"} —— 中途失败恰好一帧，随后关闭
   * 校验失败 / 503 / 429 发生在 hijack 之前，仍是普通 JSON 错误响应。
   *
   * 持久化语义：body 带 sessionId 时忽略请求里的 history（服务端取该会话最近
   * CHAT_HISTORY_LIMIT 条），user 消息立即落库，回答完成后 assistant 消息
   * （含 toolsUsed 与覆盖式最后一份 sources）落库；不带 sessionId 完全不落库。
   */
  app.post('/api/chat', async (req, reply) => {
    const body = parse(chatBodySchema, req.body ?? {});
    if (!deps.isLlmConfigured()) {
      throw serviceUnavailable('llm_not_configured', 'LLM 未配置（LLM_BASE_URL / LLM_API_KEY），对话功能不可用');
    }
    // 并发闸必须在 hijack 之前占：429 chat_busy 是普通 JSON 错误
    if (!chatGate.tryAcquire()) {
      throw new ApiException(429, 'chat_busy', '当前对话并发已达上限（2），请等已有对话结束后再试');
    }

    let llm: LlmClient;
    try {
      // 工厂走 deps（settings 覆盖后的生效配置）；deps 未提供时退回 env 基线配置
      llm = deps.createLlmClient ? deps.createLlmClient() : createLlm(config);
    } catch (cause) {
      chatGate.release();
      throw mapDomainError(cause) ?? serviceUnavailable('llm_not_configured', 'LLM 客户端创建失败，请检查 LLM 配置');
    }

    // 会话持久化：带 sessionId 才激活；user 消息先落库（后续对话能续上）
    const store = body.sessionId ? getChatStore() : undefined;
    const sessionId = body.sessionId;
    const history = store ? store.history(sessionId!, CHAT_HISTORY_LIMIT) : body.history ?? [];
    if (store) store.appendMessage({ sessionId: sessionId!, role: 'user', content: body.message });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, CHAT_SSE_HEADERS);
    // 写入兜底：连接已坏时抛错，让 writer 进入 closed 状态静默丢弃后续帧
    const writer = createChatSseWriter((chunk) => {
      if (res.writableEnded || res.destroyed) throw new Error('chat SSE 连接已关闭');
      res.write(chunk);
    });
    const abort = new AbortController();
    // 客户端断开必须挂在 reply.raw（连接级）：req.raw 的 'close' 在请求体读完时
    // 就会触发（Node ≥15 的 IncomingMessage 语义），会把正常请求当成断开掐死。
    // reply.raw 的 'close' 只在「连接断开」或「我们 end()」时发生，后者无害。
    const onClose = (): void => abort.abort();
    res.on('close', onClose);

    // 覆盖式 sources 的最后一份：assistant 消息落库时随存
    let lastSources: ChatStoredSource[] = [];

    try {
      const outcome = await runChat(
        {
          llm,
          listItems: deps.listItems,
          listSources: deps.listSources,
          stats: deps.stats,
          listWatches: deps.listWatches,
          generateIdeas: deps.generateIdeas,
          getIdea: deps.getIdea,
          // HttpDeps.autoNovelty 带 queries 参数，chat 工具固定跑全部检索式
          autoNovelty: (ideaId: string) => deps.autoNovelty(ideaId, undefined),
          summarizeVerdict: deps.summarizeVerdict,
          noveltyCommandAvailable: deps.getSettings().novelty.hasCommand,
          saveClaims: (ideaId, content) => getChatStore().saveClaims(ideaId, content),
        },
        { message: body.message, history },
        {
          status: (step, label) => writer.status(step, label),
          sources: (items) => {
            lastSources = items;
            writer.sources(items);
          },
          token: (text) => writer.token(text),
        },
        { signal: abort.signal },
      );
      if (store) {
        store.appendMessage({
          sessionId: sessionId!,
          role: 'assistant',
          content: outcome.answer,
          toolsUsed: outcome.toolsUsed,
          sources: lastSources,
        });
      }
      writer.done({
        messageId: outcome.messageId,
        toolsUsed: outcome.toolsUsed,
        ...(sessionId ? { sessionId } : {}),
      });
    } catch (error) {
      if (!abort.signal.aborted) {
        // 客户端已断开时不再补错误帧；领域错误按统一规则翻译，未知错误固定安全文案
        const mapped = error instanceof ApiException ? error : mapDomainError(error);
        if (mapped) writer.error(mapped.code, mapped.message);
        else {
          app.log.error({ err: error }, 'chat 处理失败');
          writer.error('internal_error', 'internal server error');
        }
      }
    } finally {
      res.off('close', onClose);
      abort.abort();
      chatGate.release();
      if (!res.writableEnded) res.end();
    }
  });

  // ---- chat 会话：列表 / 明细 / 删除（持久化模式的数据出口） ----
  app.get('/api/chat/sessions', async () => getChatStore().sessions(CHAT_SESSIONS_LIMIT));

  app.get('/api/chat/sessions/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const session = getChatStore().session(id, CHAT_SESSION_MESSAGES);
    if (!session) throw notFound(`会话 ${id} 不存在`);
    return session;
  });

  app.delete('/api/chat/sessions/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    if (!getChatStore().removeSession(id)) throw notFound(`会话 ${id} 不存在`);
    return { ok: true as const };
  });

  // ---- 权利要求草案读取（draft_claims 工具落库的出口） ----
  app.get('/api/ideas/:id/claims', async (req) => {
    const { id } = parse(idParams, req.params);
    const claims = getChatStore().getClaims(id);
    if (!claims) throw notFound(`选题 ${id} 还没有权利要求草案`);
    return claims;
  });

  // ---- Bark 测试推送：设置页「测试推送」按钮；带 url = 先测后存 ----
  const pushTestSchema = z.object({
    url: z
      .string()
      .trim()
      .max(500)
      .refine((value) => value === '' || /^https?:\/\//i.test(value), '必须是 http(s) 地址')
      .optional(),
  });

  app.post('/api/push/test', async (req) => {
    const body = parse(pushTestSchema, req.body ?? {});
    const requestedUrl = body.url?.trim() ?? '';
    if (requestedUrl === '') {
      const settings = deps.getSettings();
      if (!settings.bark.enabled || settings.bark.url.trim() === '') {
        throw unprocessable('bark_not_configured', 'Bark 推送未启用或未配置 URL（设置页 bark.url / env BARK_URL）');
      }
    }
    const targetUrl = requestedUrl !== '' ? requestedUrl : deps.getSettings().bark.url;
    const fetchLike = deps.fetchLike ?? ((input: string, init?: RequestInit) => fetch(input, init));
    try {
      await pushBark(fetchLike, targetUrl, '情报雷达测试推送', `推送链路正常（${new Date().toISOString()}）`);
    } catch (error) {
      throw badGateway('bark_push_failed', error instanceof Error ? error.message : String(error));
    }
    return { ok: true as const };
  });

  // ---------------------------------------------------------------- SSE
  app.get('/api/events', (_req, reply) => {
    // 长连接由 hub 完全接管；handler 立即返回，fastify 不再管这个 reply
    reply.hijack();
    hub.add(reply.raw);
  });
}
