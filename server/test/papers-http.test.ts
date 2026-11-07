import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { HttpDeps } from '../src/http/deps.js';
import type { ChatMessage, LlmClient } from '../src/ideas/llm.js';
import type { PaperAnnotation, PaperInfo } from '../src/store/papers.js';
import type { ApiError, Item } from '../src/types.js';

/**
 * 论文阅读器 HTTP 契约测试：
 * JSON 端点走 app.inject；ask 的 SSE 帧契约走真实 listen + fetch（inject 拿不到流）。
 * LLM 全部脚本化假实现，全程不出网。
 */

const makeConfig = (over: Partial<AppConfig> = {}): AppConfig => ({
  dataDir: ':memory:',
  port: 0,
  host: '127.0.0.1',
  collectMinutes: 0,
  minKeepScore: 0,
  limitPerSource: 40,
  ttlDays: 180,
  llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-key', model: 'fake-model', temperature: 0, maxTokens: 256 },
  novelty: { command: '', agreeKick: false },
  ...over,
});

const ITEM: Item = {
  id: 'aaaaaaaaaaaaaaaa',
  sourceId: 'arxiv-spec',
  kind: 'paper',
  title: 'Fast Speculative Decoding',
  url: 'https://arxiv.org/abs/2401.12345v2',
  summary: '摘要： KV cache',
  authors: [],
  publishedAt: '2026-10-20T00:00:00.000Z',
  fetchedAt: '2026-10-21T00:00:00.000Z',
  score: 90,
  scoreReasons: [],
  keywords: [],
};

const NONE: PaperInfo = {
  itemId: ITEM.id,
  status: 'none',
  originUrl: '',
  bytes: null,
  error: '',
  downloadedAt: null,
  updatedAt: '',
};

interface Depot {
  paper: PaperInfo;
  annotations: Map<string, PaperAnnotation>;
  downloads: number;
}

function makeDeps(llm: LlmClient | null, over: Partial<HttpDeps> = {}): { deps: HttpDeps; depot: Depot } {
  const depot: Depot = { paper: { ...NONE }, annotations: new Map(), downloads: 0 };
  let seq = 0;
  const deps: HttpDeps = {
    listItems: () => ({ items: [ITEM], total: 1, limit: 30, offset: 0 }),
    getItem: (id) => (id === ITEM.id ? ITEM : undefined),
    exportItems: () => [ITEM],
    listSources: () => [],
    createSource: async () => {
      throw new Error('not used');
    },
    updateSource: () => undefined,
    deleteSource: () => true,
    listIdeas: () => [],
    getIdea: () => undefined,
    updateIdea: () => undefined,
    archiveIdea: () => undefined,
    saveIdea: (idea) => idea,
    recordNovelty: () => undefined,
    autoNovelty: async () => {
      throw new Error('not used');
    },
    listRuns: () => [],
    clusterIdeas: () => [],
    listWatches: () => [],
    addWatch: () => ({
      id: 'w',
      query: 'q',
      note: '',
      enabled: true,
      createdAt: '',
      lastHits: null,
      lastCheckedAt: null,
      checks: 0,
    }),
    removeWatch: () => true,
    setWatchEnabled: () => true,
    sweepWatches: async () => ({ at: '', checked: 0, skipped: 0, alerts: [], trends: [], errors: [] }),
    stats: () => ({
      items: 1,
      ideas: 0,
      sources: 0,
      enabledSources: 0,
      lastRunAt: null,
      dailyAdded: [],
      scoreHistogram: [],
    }),
    runCollect: async () => ({
      id: 'run',
      startedAt: '',
      finishedAt: '',
      sourceCount: 0,
      added: 0,
      fetched: 0,
      errors: [],
    }),
    generateIdeas: async () => ({ ideas: [], usedItems: [] }),
    isLlmConfigured: () => llm !== null,
    ...(llm ? { createLlmClient: () => llm } : {}),
    getSettings: () => ({
      dailyRefreshAt: '08:00',
      dailyRefreshEnabled: false,
      collectMinutes: 0,
      limitPerSource: 40,
      minKeepScore: 0,
      ttlDays: 180,
      highScore: 80,
      midScore: 60,
      llm: { baseUrl: '', model: 'fake', hasApiKey: llm !== null },
      novelty: { command: '', hasCommand: false },
      updatedAt: null,
      nextRefreshAt: null,
      refreshMode: 'off',
    }),
    updateSettings: (patch) => ({
      dailyRefreshAt: '08:00',
      dailyRefreshEnabled: false,
      collectMinutes: 0,
      limitPerSource: 40,
      minKeepScore: 0,
      ttlDays: 180,
      highScore: 80,
      midScore: 60,
      llm: { baseUrl: '', model: 'fake', hasApiKey: llm !== null },
      novelty: { command: '', hasCommand: false },
      updatedAt: null,
      nextRefreshAt: null,
      refreshMode: 'off',
      ...(patch as Record<string, never>),
    }),

    // ---- 论文阅读器 ----
    getPaperStatus: (id) => ({ ...depot.paper, itemId: id }),
    downloadPaper: async (id) => {
      depot.downloads += 1;
      depot.paper = { ...depot.paper, itemId: id, status: 'ready', bytes: 42, downloadedAt: new Date().toISOString() };
      return { ...depot.paper };
    },
    getPaperFile: (id) =>
      depot.paper.status === 'ready' ? { itemId: id, path: '/tmp/x.pdf', bytes: 42 } : undefined,
    listPaperAnnotations: (itemId) => [...depot.annotations.values()].filter((a) => a.itemId === itemId),
    addPaperAnnotation: (itemId, input) => {
      seq += 1;
      const annotation: PaperAnnotation = {
        id: `anno-${seq}`,
        itemId,
        page: input.page,
        rects: input.rects,
        text: input.text ?? '',
        note: input.note ?? '',
        color: input.color ?? '#f2b357',
        createdAt: '2026-11-06T00:00:00.000Z',
        updatedAt: '2026-11-06T00:00:00.000Z',
      };
      depot.annotations.set(annotation.id, annotation);
      return annotation;
    },
    updatePaperAnnotation: (itemId, annotationId, patch) => {
      const current = depot.annotations.get(annotationId);
      if (!current || current.itemId !== itemId) return undefined;
      const next = { ...current, ...patch, updatedAt: '2026-11-06T01:00:00.000Z' };
      depot.annotations.set(annotationId, next);
      return next;
    },
    removePaperAnnotation: (itemId, annotationId) => {
      const current = depot.annotations.get(annotationId);
      if (!current || current.itemId !== itemId) return false;
      depot.annotations.delete(annotationId);
      return true;
    },
    close: () => {},
    ...over,
  };
  return { deps, depot };
}

const openApps: FastifyInstance[] = [];

async function makeApp(llm: LlmClient | null, over: Partial<HttpDeps> = {}): Promise<FastifyInstance> {
  const app = await buildApp(makeConfig(), { deps: makeDeps(llm, over).deps, logger: false, distDir: null });
  openApps.push(app);
  return app;
}

function scriptedLlm(tokens = ['答', '案']): LlmClient {
  return {
    model: 'fake-model',
    complete: async () => 'unused',
    completeStream: async (_messages, options, onToken) => {
      for (const token of tokens) {
        if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        onToken(token);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      return tokens.join('');
    },
  };
}

beforeEach(() => {});
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('论文 PDF：下载状态与文件', () => {
  it('POST /paper 触发下载并返回 ready；GET /paper 查询同一状态', async () => {
    const app = await makeApp(null);
    const post = await app.inject({ method: 'POST', url: `/api/items/${ITEM.id}/paper` });
    expect(post.statusCode).toBe(200);
    expect(post.json<PaperInfo>()).toMatchObject({ itemId: ITEM.id, status: 'ready', bytes: 42 });

    const get = await app.inject({ method: 'GET', url: `/api/items/${ITEM.id}/paper` });
    expect(get.statusCode).toBe(200);
    expect(get.json<PaperInfo>().status).toBe('ready');
  });

  it('未知条目 → 404；未下载时 GET /paper/file → 404', async () => {
    const app = await makeApp(null);
    const missing = await app.inject({ method: 'GET', url: '/api/items/zzzzzzzzzzzzzzzz/paper' });
    expect(missing.statusCode).toBe(404);

    const noFile = await app.inject({ method: 'GET', url: `/api/items/${ITEM.id}/paper/file` });
    expect(noFile.statusCode).toBe(404);
    expect(noFile.json<ApiError>().error.code).toBe('not_found');
  });

  it('ready 后 GET /paper/file 回 application/pdf（真实文件流）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-paper-http-'));
    try {
      const pdfPath = join(dir, 'sample.pdf');
      writeFileSync(pdfPath, Buffer.from('%PDF-1.4 test', 'latin1'));
      const app = await makeApp(null, {
        getPaperFile: (id) => ({ itemId: id, path: pdfPath, bytes: 12 }),
      });
      const res = await app.inject({ method: 'GET', url: `/api/items/${ITEM.id}/paper/file` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.body).toContain('%PDF-1.4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('论文标注 CRUD', () => {
  it('POST 201 → GET 列表 → PATCH 笔记 → DELETE', async () => {
    const app = await makeApp(null);

    const created = await app.inject({
      method: 'POST',
      url: `/api/items/${ITEM.id}/annotations`,
      payload: {
        page: 2,
        rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
        text: '选中文本',
        color: '#7aa7f7',
      },
    });
    expect(created.statusCode).toBe(201);
    const annotation = created.json<PaperAnnotation>();
    expect(annotation.id).toMatch(/^anno-/);

    const list = await app.inject({ method: 'GET', url: `/api/items/${ITEM.id}/annotations` });
    expect(list.json<PaperAnnotation[]>()).toHaveLength(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/items/${ITEM.id}/annotations/${annotation.id}`,
      payload: { note: '这是笔记' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<PaperAnnotation>().note).toBe('这是笔记');

    const del = await app.inject({ method: 'DELETE', url: `/api/items/${ITEM.id}/annotations/${annotation.id}` });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/items/${ITEM.id}/annotations` })).json()).toHaveLength(0);
  });

  it('非法 rect / 非法颜色 → 400；删别人的标注 → 404', async () => {
    const app = await makeApp(null);
    const badRect = await app.inject({
      method: 'POST',
      url: `/api/items/${ITEM.id}/annotations`,
      payload: { page: 1, rects: [] },
    });
    expect(badRect.statusCode).toBe(400);

    const badColor = await app.inject({
      method: 'POST',
      url: `/api/items/${ITEM.id}/annotations`,
      payload: { page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }], color: '#123456' },
    });
    expect(badColor.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/items/${ITEM.id}/annotations/anno-nope`,
    });
    expect(missing.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- ask SSE

interface Frame {
  event: string;
  data: string;
}

function parseFrames(raw: string): Frame[] {
  return raw
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '';
      return { event, data };
    });
}

describe('POST /api/items/:id/paper/ask：SSE 帧契约', () => {
  it('完整流：status/token/done 帧格式正确，token 内容与 LLM 输出一致', async () => {
    const app = await makeApp(scriptedLlm(['结', '论']));
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const response = await fetch(`${address}/api/items/${ITEM.id}/paper/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question: '这段在讲什么？',
        page: 3,
        pageText: 'We propose ...',
        selection: 'KV cache compression',
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const frames = parseFrames(await response.text());
    const events = frames.map((f) => f.event);
    expect(events[0]).toBe('status');
    expect(events.filter((e) => e === 'token')).toHaveLength(2);
    expect(events[events.length - 1]).toBe('done');
    const joined = frames
      .filter((f) => f.event === 'token')
      .map((f) => (JSON.parse(f.data) as { text: string }).text)
      .join('');
    expect(joined).toBe('结论');

    await app.close();
  });

  it('LLM 未配置 → 503（普通 JSON）；校验失败 → 400', async () => {
    const app = await makeApp(null);
    const res = await app.inject({ method: 'POST', url: `/api/items/${ITEM.id}/paper/ask`, payload: { question: '为什么' } });
    expect(res.statusCode).toBe(503);
    expect(res.json<ApiError>().error.code).toBe('llm_not_configured');

    const bad = await app.inject({ method: 'POST', url: `/api/items/${ITEM.id}/paper/ask`, payload: { question: '' } });
    expect(bad.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/items/zzzzzzzzzzzzzzzz/paper/ask',
      payload: { question: '为什么' },
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });
});
