/**
 * HTTP 契约测试：全部走 `buildApp()` + `app.inject()`，不监听端口、不打真网络。
 * 唯一例外是 SSE（inject 拿不到流），用 `listen(0)` + fetch，并在 finally 里收尾。
 *
 * 下层实现用内存假体注入（HttpDeps 的全部方法都是纯函数式签名），
 * 所以这里测的是「路由 + 校验 + 错误映射 + SSE/CSV 契约」，不测 sqlite/抓取。
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { buildApp, startServer } from '../src/http/app.js';
import { SseHub } from '../src/http/sse.js';
import { loadDeps, type HttpDeps } from '../src/http/deps.js';
import { openDb } from '../src/store/db.js';
import { insertItems, upsertIdea } from '../src/store/queries.js';
import type { VerdictSummary } from '../src/ideas/verdict.js';
import { unprocessable } from '../src/http/errors.js';
import type { ApiError, AppSettings, Idea, Item, RunRecord, Source, Stats } from '../src/types.js';

// ---------------------------------------------------------------- fixtures

const makeConfig = (over: Partial<AppConfig> = {}): AppConfig => ({
  dataDir: ':memory:',
  port: 0,
  host: '127.0.0.1',
  collectMinutes: 0,
  minKeepScore: 0,
  limitPerSource: 40,
  ttlDays: 180,
  llm: { baseUrl: '', apiKey: '', model: 'test-model', temperature: 0, maxTokens: 256 },
  novelty: { command: '', agreeKick: false },
  ...over,
});

const makeItem = (over: Partial<Item> & Pick<Item, 'id'>): Item => ({
  sourceId: 'arxiv-spec',
  kind: 'paper',
  title: 'Speculative decoding with dynamic draft length',
  url: `https://example.com/${over.id}`,
  summary: '减少投机解码的验证开销',
  authors: ['张三'],
  publishedAt: '2026-10-20T00:00:00.000Z',
  fetchedAt: '2026-10-21T00:00:00.000Z',
  score: 88,
  scoreReasons: [{ rule: 'keyword', delta: 8, detail: '命中 speculative' }],
  keywords: ['speculative', 'decoding'],
  ...over,
});

const makeIdea = (over: Partial<Idea> & Pick<Idea, 'id'>): Idea => ({
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  title: '一种基于动态草稿长度的投机解码方法',
  problem: '草稿模型固定长度导致验证浪费',
  solution: '按置信度动态截断草稿序列',
  effect: '验证开销降低 30%',
  keywords: ['speculative'],
  ipcHints: ['G06F'],
  queries: ['投机解码 草稿 长度'],
  risks: ['与华为 CN11xxxx 撞车'],
  status: 'draft',
  cites: ['item-1'],
  focus: 'speculative decoding',
  novelty: [],
  ...over,
});

const makeSource = (over: Partial<Source> & Pick<Source, 'id'>): Source => ({
  kind: 'arxiv',
  label: 'arXiv 投机解码',
  url: 'https://export.arxiv.org/api/query?search_query=all:speculative+decoding',
  weight: 1.5,
  enabled: true,
  tags: ['paper'],
  note: '领域最核心的源',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const RUN: RunRecord = {
  id: 'run-1',
  startedAt: '2026-10-29T00:00:00.000Z',
  finishedAt: '2026-10-29T00:00:08.000Z',
  sourceCount: 7,
  added: 12,
  fetched: 40,
  errors: [],
};

const STATS: Stats = {
  items: 2,
  ideas: 1,
  sources: 1,
  enabledSources: 1,
  lastRunAt: RUN.finishedAt,
  dailyAdded: [{ date: '2026-10-29', count: 12 }],
  scoreHistogram: [{ bucket: '80-100', count: 2 }],
};

const makeSettings = (over: Partial<AppSettings> = {}): AppSettings => ({
  dailyRefreshAt: '08:00',
  dailyRefreshEnabled: false,
  collectMinutes: 0,
  limitPerSource: 40,
  minKeepScore: 0,
  ttlDays: 180,
  highScore: 80,
  midScore: 60,
  llm: { baseUrl: '', model: 'test-model', hasApiKey: false },
  novelty: { command: '', hasCommand: false },
  updatedAt: null,
  nextRefreshAt: null,
  refreshMode: 'off',
  ...over,
});

interface FakeDeps {
  deps: HttpDeps;
  calls: { runCollect: number; createSource: number };
}

function makeDeps(over: Partial<HttpDeps> = {}): FakeDeps {
  const items = [
    makeItem({ id: 'item-1', score: 90 }),
    makeItem({ id: 'item-2', score: 40, title: 'RSS: 降本增效的推理引擎, "实测"' }),
  ];
  const ideas = new Map<string, Idea>([['idea-1', makeIdea({ id: 'idea-1' })]]);
  const sources = [makeSource({ id: 'arxiv-spec' })];
  const calls = { runCollect: 0, createSource: 0 };

  const deps: HttpDeps = {
    listItems: (query) => {
      const limit = query.limit ?? 30;
      const offset = query.offset ?? 0;
      return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
    },
    getItem: (id) => items.find((item) => item.id === id),
    exportItems: () => items,
    listSources: () => sources,
    createSource: async (input) => {
      calls.createSource += 1;
      return makeSource({ ...input, weight: input.weight ?? 1 });
    },
    updateSource: (id, patch) => {
      const index = sources.findIndex((source) => source.id === id);
      const current = index >= 0 ? sources[index] : undefined;
      if (!current) return undefined;
      const next = { ...current, ...patch };
      sources[index] = next;
      return next;
    },
    deleteSource: (id) => sources.some((source) => source.id === id),
    listIdeas: (status) => [...ideas.values()].filter((idea) => !status || idea.status === status),
    getIdea: (id) => ideas.get(id),
    updateIdea: (id, patch) => {
      const current = ideas.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch, updatedAt: '2026-10-29T01:00:00.000Z' };
      ideas.set(id, next);
      return next;
    },
    archiveIdea: (id) => deps.updateIdea(id, { status: 'archived' }),
    recordNovelty: (id, record) => {
      const current = ideas.get(id);
      if (!current) return undefined;
      const next = { ...current, novelty: [...current.novelty, record] };
      ideas.set(id, next);
      return next;
    },
    autoNovelty: async (id) => {
      const current = ideas.get(id);
      if (!current) throw new Error(`idea ${id} missing`);
      return deps.recordNovelty(id, {
        at: '2026-10-29T01:00:00.000Z',
        query: '投机解码 草稿',
        hits: 3,
        topAssignees: '华为:2',
        note: 'auto',
        site: 'zhihuiya',
      })!;
    },
    listRuns: () => [RUN],
    stats: () => STATS,
    runCollect: async () => {
      calls.runCollect += 1;
      // 让两个并发请求都能撞上同一个 in-flight Promise
      await new Promise((resolve) => setTimeout(resolve, 30));
      return RUN;
    },
    isLlmConfigured: () => true,
    getSettings: () => makeSettings(),
    updateSettings: (patch) => makeSettings(patch as Partial<AppSettings>),
    generateIdeas: async () => ({
      ideas: [makeIdea({ id: 'idea-new' })],
      usedItems: ['item-1'],
      dropped: [{ index: 2, title: '重复的候选', reasons: ['与库中选题标题相似度过高'] }],
    }),
    close: () => {},
    ...over,
  };

  return { deps, calls };
}

const openApps: FastifyInstance[] = [];

async function makeApp(options: { config?: AppConfig; deps?: Partial<HttpDeps> } = {}): Promise<{
  app: FastifyInstance;
  calls: FakeDeps['calls'];
}> {
  const fake = makeDeps(options.deps);
  const app = await buildApp(options.config ?? makeConfig(), {
    deps: fake.deps,
    logger: false,
    distDir: null,
  });
  openApps.push(app);
  return { app, calls: fake.calls };
}

afterEach(async () => {
  // 无论如何都要关：SSE/定时器/句柄泄漏会直接把 vitest 挂住
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** 统一断言 ApiError 形状，并顺手检查没有把堆栈塞进响应 */
function expectApiError(payload: unknown, status: number, expectStatus: number, code?: string): ApiError {
  expect(status).toBe(expectStatus);
  const body = payload as ApiError;
  expect(body).toHaveProperty('error.code');
  expect(typeof body.error.code).toBe('string');
  expect(typeof body.error.message).toBe('string');
  expect(body.error.message.length).toBeGreaterThan(0);
  if (code) expect(body.error.code).toBe(code);
  // 形如 "    at foo (/x/y.ts:12:3)" 的堆栈行不能出现在响应里
  expect(JSON.stringify(body)).not.toMatch(/at \S+ \(\S+:\d+:\d+\)/);
  return body;
}

// ---------------------------------------------------------------- 只读

describe('GET 只读端点', () => {
  it('健康检查返回 ok/version/uptimeSec', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; version: string; uptimeSec: number }>();
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.uptimeSec).toBeTypeOf('number');
  });

  it('items 默认 limit=30 且返回 Paged 形状', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/items' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Item[]; total: number; limit: number; offset: number }>();
    expect(body.limit).toBe(30);
    expect(body.offset).toBe(0);
    expect(body.total).toBe(2);
    expect(body.items.map((item) => item.id)).toEqual(['item-1', 'item-2']);
  });

  it('limit=200 通过，limit=201 返回 400 且 message 指明 limit', async () => {
    const { app } = await makeApp();

    const ok = await app.inject({ method: 'GET', url: '/api/items?limit=200' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ limit: number }>().limit).toBe(200);

    const bad = await app.inject({ method: 'GET', url: '/api/items?limit=201' });
    const body = expectApiError(bad.json(), bad.statusCode, 400, 'validation_error');
    expect(body.error.message).toContain('limit');
    expect(body.error.detail).toMatchObject({ fields: [{ field: 'limit' }] });
  });

  it('非法 sort 返回 400，字段名进 message', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/items?sort=hot' });

    const body = expectApiError(res.json(), res.statusCode, 400, 'validation_error');
    expect(body.error.message).toContain('sort');
  });

  it('非法 kind 与 minScore 越界都返回 400', async () => {
    const { app } = await makeApp();

    const kind = await app.inject({ method: 'GET', url: '/api/items?kind=blog' });
    expectApiError(kind.json(), kind.statusCode, 400);
    expect(kind.json<ApiError>().error.message).toContain('kind');

    const score = await app.inject({ method: 'GET', url: '/api/items?minScore=101' });
    expectApiError(score.json(), score.statusCode, 400);
    expect(score.json<ApiError>().error.message).toContain('minScore');
  });

  it('单个条目 / 选题能取到，缺失时 404', async () => {
    const { app } = await makeApp();

    const item = await app.inject({ method: 'GET', url: '/api/items/item-1' });
    expect(item.statusCode).toBe(200);
    expect(item.json<Item>().id).toBe('item-1');

    const missing = await app.inject({ method: 'GET', url: '/api/items/nope' });
    const body = expectApiError(missing.json(), missing.statusCode, 404, 'not_found');
    expect(body.error.message).toContain('nope');

    const idea = await app.inject({ method: 'GET', url: '/api/ideas/idea-1' });
    expect(idea.statusCode).toBe(200);
    expect(idea.json<Idea>().status).toBe('draft');

    const missingIdea = await app.inject({ method: 'GET', url: '/api/ideas/nope' });
    expectApiError(missingIdea.json(), missingIdea.statusCode, 404, 'not_found');
  });

  it('未知路由 404 且仍是 ApiError 形状', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/nope' });

    const body = expectApiError(res.json(), res.statusCode, 404, 'not_found');
    expect(body.error.message).toContain('/api/nope');
  });

  it('runs / sources / stats 走同一份契约', async () => {
    const { app } = await makeApp();

    const runs = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(runs.statusCode).toBe(200);
    expect(runs.json<RunRecord[]>()[0]?.id).toBe('run-1');

    const sources = await app.inject({ method: 'GET', url: '/api/sources' });
    expect(sources.statusCode).toBe(200);
    expect(sources.json<Source[]>()[0]).toMatchObject({ id: 'arxiv-spec', enabled: true, weight: 1.5 });

    const stats = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(stats.statusCode).toBe(200);
    expect(stats.json<Stats>().items).toBe(2);

    const filtered = await app.inject({ method: 'GET', url: '/api/ideas?status=verified' });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json<Idea[]>()).toEqual([]);
  });

  it('CORS 反射 origin（vite dev 与生产同源都能用）', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://127.0.0.1:5273' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5273');
  });

  it('坏 JSON body → 400 而不是 500', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/sources/arxiv-spec',
      headers: { 'content-type': 'application/json' },
      payload: '{"weight": ',
    });

    expectApiError(res.json(), res.statusCode, 400);
  });

  it('未预期异常 → 500 internal_error，且不含堆栈', async () => {
    const { app } = await makeApp({
      deps: {
        stats: () => {
          throw new Error('sqlite exploded at /secret/path/db.ts:42:7');
        },
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/stats' });

    expectApiError(res.json(), res.statusCode, 500, 'internal_error');
    expect(res.body).not.toContain('sqlite exploded');
  });
});

// ---------------------------------------------------------------- 写操作

describe('写操作与错误语义', () => {
  it('PATCH source 的 weight 超出 0.1–3 → 400', async () => {
    const { app } = await makeApp();

    const ok = await app.inject({ method: 'PATCH', url: '/api/sources/arxiv-spec', payload: { weight: 2.5 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<Source>().weight).toBe(2.5);

    const high = await app.inject({ method: 'PATCH', url: '/api/sources/arxiv-spec', payload: { weight: 3.5 } });
    const body = expectApiError(high.json(), high.statusCode, 400, 'validation_error');
    expect(body.error.message).toContain('weight');

    const low = await app.inject({ method: 'PATCH', url: '/api/sources/arxiv-spec', payload: { weight: 0.05 } });
    expectApiError(low.json(), low.statusCode, 400);

    const empty = await app.inject({ method: 'PATCH', url: '/api/sources/arxiv-spec', payload: {} });
    expectApiError(empty.json(), empty.statusCode, 400);
  });

  it('PATCH 不存在的 source → 404', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'PATCH', url: '/api/sources/ghost', payload: { enabled: false } });
    expectApiError(res.json(), res.statusCode, 404, 'not_found');
  });

  it('POST /api/sources 校验 kind/url/id，成功返回 201', async () => {
    const { app, calls } = await makeApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: { id: 'rss-x', kind: 'rss', label: '某 RSS', url: 'https://example.com/feed.xml', weight: 1 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<Source>().id).toBe('rss-x');
    expect(calls.createSource).toBe(1);

    const badKind = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: { id: 'rss-y', kind: 'podcast', label: 'x', url: 'https://example.com/feed.xml' },
    });
    expectApiError(badKind.json(), badKind.statusCode, 400);
    expect(badKind.json<ApiError>().error.message).toContain('kind');

    const badUrl = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: { id: 'rss-y', kind: 'rss', label: 'x', url: 'ftp://example.com/feed.xml' },
    });
    expectApiError(badUrl.json(), badUrl.statusCode, 400);
    expect(badUrl.json<ApiError>().error.message).toContain('url');

    const badId = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: { id: 'Bad ID', kind: 'rss', label: 'x', url: 'https://example.com/feed.xml' },
    });
    expectApiError(badId.json(), badId.statusCode, 400);
    expect(badId.json<ApiError>().error.message).toContain('id');
  });

  it('探活失败 → 422 且 code=source_probe_failed', async () => {
    const { app } = await makeApp({
      deps: {
        createSource: async () => {
          throw unprocessable('source_probe_failed', '源探活失败：HTTP 404', { sourceId: 'rss-dead' });
        },
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/sources',
      payload: { id: 'rss-dead', kind: 'rss', label: '死链', url: 'https://example.com/404.xml' },
    });

    const body = expectApiError(res.json(), res.statusCode, 422, 'source_probe_failed');
    expect(body.error.detail).toMatchObject({ sourceId: 'rss-dead' });
  });

  it('LLM 未配置 → 503 llm_not_configured', async () => {
    const { app } = await makeApp({ deps: { isLlmConfigured: () => false } });
    const res = await app.inject({ method: 'POST', url: '/api/ideas/generate', payload: { focus: 'x', count: 3 } });

    expectApiError(res.json(), res.statusCode, 503, 'llm_not_configured');
  });

  it('LLM 已配置 → 200 返回 ideas/usedItems/dropped', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/ideas/generate', payload: { focus: 'x', count: 3 } });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ideas: Idea[]; usedItems: string[]; dropped: { index: number }[] }>();
    expect(body.usedItems).toEqual(['item-1']);
    // 「要 3 条只回来 2 条」的原因必须透传给前端
    expect(body.dropped).toEqual([{ index: 2, title: '重复的候选', reasons: ['与库中选题标题相似度过高'] }]);
  });

  it('查新 CLI 未配置 → 503 novelty_not_configured', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/ideas/idea-1/novelty/auto', payload: {} });

    expectApiError(res.json(), res.statusCode, 503, 'novelty_not_configured');
  });

  it('手工登记查新：hits 允许 null，且 null 与 0 分别入库', async () => {
    const { app } = await makeApp();

    const parsed = await app.inject({
      method: 'POST',
      url: '/api/ideas/idea-1/novelty',
      payload: { query: '投机解码 草稿', hits: 0 },
    });
    expect(parsed.statusCode).toBe(200);
    expect(parsed.json<Idea>().novelty.at(-1)).toMatchObject({ hits: 0, site: 'manual' });

    const failed = await app.inject({
      method: 'POST',
      url: '/api/ideas/idea-1/novelty',
      payload: { query: '投机解码 草稿', hits: null, note: '页面没渲染' },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json<Idea>().novelty.at(-1)).toMatchObject({ hits: null });

    const negative = await app.inject({
      method: 'POST',
      url: '/api/ideas/idea-1/novelty',
      payload: { query: 'x', hits: -1 },
    });
    expectApiError(negative.json(), negative.statusCode, 400);
  });

  it('DELETE idea 归档（软删）而不是真删', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'DELETE', url: '/api/ideas/idea-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json<Idea>().status).toBe('archived');
  });

  it('PATCH idea 空 body → 400', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'PATCH', url: '/api/ideas/idea-1', payload: {} });
    expectApiError(res.json(), res.statusCode, 400, 'validation_error');
  });
});

// ---------------------------------------------------------------- 采集幂等

describe('POST /api/collect', () => {
  it('并发两次只跑一次 runCollect，且返回同一个 RunRecord', async () => {
    const { app, calls } = await makeApp();

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/collect', payload: {} }),
      app.inject({ method: 'POST', url: '/api/collect', payload: {} }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(calls.runCollect).toBe(1);
    expect(first.json<RunRecord>()).toEqual(second.json<RunRecord>());
    expect(first.json<RunRecord>()).toEqual(RUN);
  });

  it('跑完后再触发会重新采集（幂等只覆盖 in-flight 窗口）', async () => {
    const { app, calls } = await makeApp();

    await app.inject({ method: 'POST', url: '/api/collect', payload: {} });
    await app.inject({ method: 'POST', url: '/api/collect', payload: {} });

    expect(calls.runCollect).toBe(2);
  });

  it('sourceIds 非法类型 → 400', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/collect', payload: { sourceIds: 'arxiv-spec' } });
    expectApiError(res.json(), res.statusCode, 400);
  });
});

// ---------------------------------------------------------------- 导出

describe('GET /api/export', () => {
  it('CSV 带 BOM、首行表头正确、字段按 RFC 4180 转义', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/export?format=csv' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename="trend-radar-items-');

    const body = res.body;
    // Excel 只有看到 BOM 才会按 UTF-8 解析中文
    expect(body.charCodeAt(0)).toBe(0xfeff);
    const lines = body.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('score,kind,title,url,sourceId,publishedAt');
    expect(lines).toHaveLength(3);
    // 含逗号与引号的标题必须被整体引起来，且内部引号翻倍
    expect(lines[2]).toContain('"RSS: 降本增效的推理引擎, ""实测"""');
  });

  it('format=json 返回条目数组', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/export?format=json' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('.json');
    expect(res.json<Item[]>()).toHaveLength(2);
  });

  it('format 只接受 csv|json', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/export?format=xml' });
    expectApiError(res.json(), res.statusCode, 400);
    expect(res.json<ApiError>().error.message).toContain('format');
  });
});

// ---------------------------------------------------------------- SSE

interface SseFrame {
  event: string;
  data: string;
}

/** 读到出现指定事件名为止；超时由 AbortController 掐断，避免测试永久挂住 */
async function readFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (frames: SseFrame[]) => boolean,
  timeoutMs = 4000,
): Promise<SseFrame[]> {
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: SseFrame[] = [];

  const timer = setTimeout(() => {
    void reader.cancel().catch(() => {});
  }, timeoutMs);

  try {
    while (!until(frames)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? 'message';
        const data = /^data: (.+)$/m.exec(chunk)?.[1] ?? '';
        frames.push({ event, data });
      }
    }
    return frames;
  } finally {
    clearTimeout(timer);
  }
}

describe('GET /api/events (SSE)', () => {
  it('连上就收到 hello，采集完成能收到 run/items 广播，断开后清理订阅', async () => {
    const { app } = await makeApp();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();

    try {
      const response = await fetch(`${address}/api/events`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      // 同一个 body 只能有一个 reader：两次读取复用同一个
      const reader = response.body!.getReader();
      const hello = await readFrames(reader, (frames) => frames.some((frame) => frame.event === 'hello'));
      const helloFrame = hello.find((frame) => frame.event === 'hello');
      expect(helloFrame).toBeDefined();
      expect(JSON.parse(helloFrame!.data)).toMatchObject({ ok: true });

      // 广播链路：HTTP inject 触发采集 → hub 把 run/items 推给这个连接
      await app.inject({ method: 'POST', url: '/api/collect', payload: {} });

      const events = await readFrames(reader, (frames) =>
        frames.some((frame) => frame.event === 'run') && frames.some((frame) => frame.event === 'items'),
      );
      expect(events.map((frame) => frame.event)).toContain('run');
      expect(JSON.parse(events.find((frame) => frame.event === 'run')!.data)).toMatchObject({ id: 'run-1' });
      expect(JSON.parse(events.find((frame) => frame.event === 'items')!.data)).toMatchObject({ added: 12 });

      // 选题变更同样要即时推给前端
      await app.inject({ method: 'PATCH', url: '/api/ideas/idea-1', payload: { title: '改过的标题' } });
      const ideaFrames = await readFrames(reader, (frames) => frames.some((frame) => frame.event === 'idea'));
      expect(JSON.parse(ideaFrames.find((frame) => frame.event === 'idea')!.data)).toMatchObject({
        id: 'idea-1',
        title: '改过的标题',
      });
    } finally {
      // 必须先断开客户端，否则 app.close() 会等这条长连接
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
});

// ---------------------------------------------------------------- 静态托管

describe('静态托管与 SPA fallback', () => {
  it('dist 存在时托管资源，深链回落 index.html，/api 仍返回 JSON 404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trend-radar-dist-'));
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<!doctype html><div id="root">spa</div>');
    await writeFile(join(dir, 'assets', 'app.js'), 'console.log("ok")');

    const app = await buildApp(makeConfig(), { deps: makeDeps().deps, logger: false, distDir: dir });
    openApps.push(app);
    try {
      const root = await app.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain('spa');

      const deepLink = await app.inject({ method: 'GET', url: '/ideas/idea-1' });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.body).toContain('spa');

      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain('console.log');

      const apiMiss = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(apiMiss.statusCode).toBe(404);
      expect(apiMiss.json<ApiError>().error.code).toBe('not_found');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dist 不存在时跳过注册而不是崩', async () => {
    const app = await buildApp(makeConfig(), {
      deps: makeDeps().deps,
      logger: false,
      distDir: join(tmpdir(), 'trend-radar-dist-missing'),
    });
    openApps.push(app);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(404);
    expect(root.json<ApiError>().error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------- 进程生命周期

describe('startServer', () => {
  it('listen + 定时采集 + close() 停表，且 close 可重复调用', async () => {
    // 0.001 分钟 = 60ms，让定时器在测试里快速可见
    const config = makeConfig({ port: 0, collectMinutes: 0.001 });
    const { deps, calls } = makeDeps();
    // 定时节奏由生效设置决定（每日定时关、间隔 0.001 分钟 = 60ms）
    const handle = await startServer(config, {
      deps: { ...deps, getSettings: () => makeSettings({ collectMinutes: 0.001 }) },
      logger: false,
      distDir: null,
    });

    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      // 真监听后 curl 一次，确认网线这头也通
      const res = await fetch(`${handle.url}/api/health`);
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });

      const deadline = Date.now() + 3000;
      while (calls.runCollect === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(calls.runCollect).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }

    // 停表之后不能再有采集：否则 vitest 会被后台定时器拖着不退出
    const afterClose = calls.runCollect;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls.runCollect).toBe(afterClose);
    await expect(handle.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------- 真实模块集成

/**
 * 这条用例把 deps.ts 的「假定签名」换成真实模块跑一遍：
 * 内存库 + 本地探活失败，全程不出网。它能立刻暴露 store/pipeline/probe 的签名漂移。
 */
describe('真实模块集成（:memory: 库，不出网）', () => {
  it('loadDeps 接线正确：只读端点、CSV、LLM 未配置 503、探活失败 422', async () => {
    const config = makeConfig({ dataDir: ':memory:' });
    const deps = await loadDeps(config);
    const app = await buildApp(config, { deps, logger: false, distDir: null });

    try {
      const items = await app.inject({ method: 'GET', url: '/api/items' });
      expect(items.statusCode).toBe(200);
      expect(items.json<{ items: Item[]; total: number; limit: number; offset: number }>()).toMatchObject({
        total: 0,
        limit: 30,
        offset: 0,
        items: [],
      });

      // 首次打开会灌内置源，所以这里必然非空
      const sources = await app.inject({ method: 'GET', url: '/api/sources' });
      expect(sources.statusCode).toBe(200);
      expect(sources.json<Source[]>().length).toBeGreaterThan(0);

      const stats = await app.inject({ method: 'GET', url: '/api/stats' });
      expect(stats.statusCode).toBe(200);
      const statsBody = stats.json<Stats>();
      expect(statsBody.dailyAdded).toHaveLength(7);
      expect(statsBody.scoreHistogram).toHaveLength(5);

      const runs = await app.inject({ method: 'GET', url: '/api/runs' });
      expect(runs.statusCode).toBe(200);
      expect(runs.json()).toEqual([]);

      const csv = await app.inject({ method: 'GET', url: '/api/export?format=csv' });
      expect(csv.statusCode).toBe(200);
      expect(csv.body.slice(0, 1)).toBe('\uFEFF');
      expect(csv.body.slice(1).split('\r\n')[0]).toBe('score,kind,title,url,sourceId,publishedAt');

      const generate = await app.inject({
        method: 'POST',
        url: '/api/ideas/generate',
        payload: { focus: '投机解码', count: 2 },
      });
      expectApiError(generate.json(), generate.statusCode, 503, 'llm_not_configured');

      // 127.0.0.1:1 立刻 ECONNREFUSED → 真实探活失败路径 → 422
      const dead = await app.inject({
        method: 'POST',
        url: '/api/sources',
        payload: { id: 'dead-source', kind: 'rss', label: '死链', url: 'http://127.0.0.1:1/feed.xml' },
      });
      expectApiError(dead.json(), dead.statusCode, 422, 'source_probe_failed');

      const missing = await app.inject({ method: 'DELETE', url: '/api/sources/not-there' });
      expectApiError(missing.json(), missing.statusCode, 404, 'not_found');
    } finally {
      await app.close();
      deps.close();
    }
  });
});

// ---------------------------------------------------------------- 生成落库

/**
 * 落库回归测试：真实 pipeline + 真实 sqlite + 假 LLM（不出网）。
 * 断言的是「生成完之后库里真的有了」，这是 GET /api/ideas 与 novelty/auto 的前提。
 */
describe('POST /api/ideas/generate 落库', () => {
  const draft = (over: Record<string, unknown>) => ({
    problem: '现有投机解码用固定草稿长度，验证阶段大量无效计算被浪费，吞吐上不去',
    solution: '①按置信度动态截断草稿序列；②用验证通过率反馈调整截断阈值；③把截断长度写入缓存以复用',
    effect: '验证算力开销降低 32%，端到端吞吐提升 1.8 倍',
    keywords: ['投机解码', '草稿长度', '动态截断'],
    ipcHints: ['G06F9/50'],
    queries: ['投机解码 草稿 截断', '草稿 长度 动态 调整'],
    risks: ['华某公司以固定草稿长度做验证的既有方案'],
    cites: [1],
    ...over,
  });

  it('生成的选题落库后 GET /api/ideas 能查到，重复生成命中库内去重', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trend-radar-gen-'));
    const config = makeConfig({
      dataDir: dir,
      llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-key', model: 'fake', temperature: 0, maxTokens: 4000 },
    });

    // 用同一条 sqlite 文件先塞两条情报，pipeline 才有素材（不连网）
    const seed = openDb(dir);
    insertItems(seed, [
      makeItem({ id: 'seed-item-1', score: 92 }),
      makeItem({ id: 'seed-item-2', score: 61, title: 'Prefill-decode disaggregation latency study' }),
    ]);
    seed.close();

    const prompts: string[] = [];
    const deps = await loadDeps(config, {
      llm: {
        complete: async (messages) => {
          const last = messages.at(-1) as { content?: string } | undefined;
          prompts.push(last?.content ?? '');
          return JSON.stringify([
            draft({ title: '一种基于动态草稿长度截断的投机解码加速方法' }),
            draft({ title: '一种按验证通过率反馈调整草稿窗口的推理调度方法', queries: ['草稿 窗口 反馈 调整', '推理 调度 草稿 窗口'] }),
          ]);
        },
      },
    });
    const app = await buildApp(config, { deps, logger: false, distDir: null });

    try {
      const first = await app.inject({
        method: 'POST',
        url: '/api/ideas/generate',
        payload: { focus: '投机解码', count: 2 },
      });
      expect(first.statusCode).toBe(200);
      const created = first.json<{ ideas: Idea[]; usedItems: string[] }>();
      expect(created.ideas).toHaveLength(2);
      expect(prompts[0]).toContain('投机解码');

      // 关键回归断言：生成结果必须已落库
      const listed = await app.inject({ method: 'GET', url: '/api/ideas' });
      const stored = listed.json<Idea[]>();
      expect(stored.map((idea) => idea.title)).toEqual(expect.arrayContaining(created.ideas.map((i) => i.title)));
      expect(stored.every((idea) => idea.status === 'draft')).toBe(true);

      // 每条都能单独取到——novelty/auto 靠这个 404 检查
      for (const idea of created.ideas) {
        const one = await app.inject({ method: 'GET', url: `/api/ideas/${idea.id}` });
        expect(one.statusCode).toBe(200);
      }

      // 第二次用同一批草稿生成：existing 传的若是库内真实标题，两条都该被判重复，
      // pipeline 会把「全被丢弃」抛成 all_invalid → 422，原因在 detail.dropped 里
      const second = await app.inject({
        method: 'POST',
        url: '/api/ideas/generate',
        payload: { focus: '投机解码', count: 2 },
      });
      const body = expectApiError(second.json(), second.statusCode, 422, 'all_invalid');
      const dropped = (body.error.detail as { dropped: { reasons: string[] }[] }).dropped;
      expect(dropped).toHaveLength(2);
      expect(dropped[0]?.reasons.join('')).toContain('高度相似');

      // 库没被弄脏：还是最初那 2 条
      const afterRetry = await app.inject({ method: 'GET', url: '/api/ideas' });
      expect(afterRetry.json<Idea[]>()).toHaveLength(2);
    } finally {
      await app.close();
      deps.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- SSE hub 单元

describe('SseHub', () => {
  /** 够用就行的假响应：只实现 hub 会用到的四个成员 */
  const fakeRes = () => {
    const emitter = new EventEmitter();
    const written: string[] = [];
    const res = {
      writableEnded: false,
      destroyed: false,
      headers: {} as Record<string, string>,
      writeHead(_status: number, headers: Record<string, string>) {
        res.headers = headers;
      },
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
      end() {
        res.writableEnded = true;
      },
      on(event: string, listener: () => void) {
        emitter.on(event, listener);
        return res;
      },
      emit(event: string) {
        emitter.emit(event);
      },
      written,
    };
    return res;
  };

  it('hello 帧、广播、客户端断开清理、close 结束全部连接', () => {
    const hub = new SseHub();
    const a = fakeRes();
    const b = fakeRes();
    hub.add(a as never);
    hub.add(b as never);

    expect(hub.size).toBe(2);
    expect(a.headers['content-type']).toContain('text/event-stream');
    expect(a.written.join('')).toContain('event: hello');

    expect(hub.broadcast('run', { id: 'run-1' })).toBe(2);
    expect(b.written.join('')).toContain('"id":"run-1"');

    // 客户端断开：只清掉它自己
    a.emit('close');
    expect(hub.size).toBe(1);
    expect(hub.broadcast('items', { added: 1 })).toBe(1);

    hub.close();
    expect(hub.size).toBe(0);
    expect(b.writableEnded).toBe(true);
    expect(b.written.join('')).toContain('event: bye');
    expect(() => hub.close()).not.toThrow();
  });

  it('hub 关闭后新连接立即被拒（不再挂一个收不到消息的订阅）', () => {
    const hub = new SseHub();
    hub.close();
    const late = fakeRes();
    hub.add(late as never);
    expect(hub.size).toBe(0);
    expect(late.writableEnded).toBe(true);
  });
});

// ---------------------------------------------------------------- 判读摘要

/** 判读结论必须由 API 统一给出（前端不再复制阈值逻辑） */
describe('verdictSummary', () => {
  it('三条 [0,0,0] 判 inconclusive 并给改词建议；128 命中判 red-ocean 且 headline 点名华为', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trend-radar-verdict-'));
    const config = makeConfig({ dataDir: dir });

    const seed = openDb(dir);
    upsertIdea(seed, makeIdea({ id: 'idea-zero', title: '零命中的选题' }));
    upsertIdea(seed, makeIdea({ id: 'idea-red', title: '红海选题' }));
    seed.close();

    const deps = await loadDeps(config);
    const app = await buildApp(config, { deps, logger: false, distDir: null });

    try {
      // 全零：最容易被误读成「技术空白」的情形，必须给出可执行建议
      for (const query of ['投机解码 草稿 截断', '草稿 窗口 反馈', '推测执行 上下文 复用']) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/ideas/idea-zero/novelty',
          payload: { query, hits: 0 },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json<Idea & { verdictSummary: VerdictSummary }>().verdictSummary.verdict).toBe('inconclusive');
      }

      const zero = await app.inject({ method: 'GET', url: '/api/ideas/idea-zero' });
      const zeroIdea = zero.json<Idea & { verdictSummary: VerdictSummary }>();
      expect(zeroIdea.novelty).toHaveLength(3);
      expect(zeroIdea.verdictSummary.verdict).toBe('inconclusive');
      expect(zeroIdea.verdictSummary.suggestions.length).toBeGreaterThan(0);
      expect(zeroIdea.verdictSummary.evidence).toHaveLength(3);
      expect(zeroIdea.verdictSummary.headline).toContain('零命中');

      // 红海：写回即生效，status 也要同步重算
      const red = await app.inject({
        method: 'POST',
        url: '/api/ideas/idea-red/novelty',
        payload: { query: '投机解码 草稿 截断', hits: 128, topAssignees: '华为技术有限公司:128、腾讯:7' },
      });
      const redIdea = red.json<Idea & { verdictSummary: VerdictSummary }>();
      expect(redIdea.verdictSummary.verdict).toBe('red-ocean');
      expect(redIdea.verdictSummary.headline).toContain('华为');
      expect(redIdea.status).toBe('red-ocean');

      // 列表接口同样带摘要，前端不用逐条再请求
      const list = await app.inject({ method: 'GET', url: '/api/ideas' });
      const all = list.json<(Idea & { verdictSummary?: VerdictSummary })[]>();
      expect(all).toHaveLength(2);
      expect(all.every((idea) => idea.verdictSummary !== undefined)).toBe(true);
    } finally {
      await app.close();
      deps.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
