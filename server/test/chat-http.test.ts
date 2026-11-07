import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { HttpDeps } from '../src/http/deps.js';
import type { LlmClient, ChatMessage } from '../src/ideas/llm.js';
import type { ApiError, AppSettings, Idea, Item, RunRecord, Source, Stats } from '../src/types.js';

/**
 * /api/chat 的 HTTP 契约测试。
 * 校验失败 / 503 / 429 是 hijack 之前的普通 JSON，走 app.inject；
 * SSE 帧序列必须走真实 listen + fetch（inject 拿不到流，与 http.test.ts 同约定）。
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
  bark: { url: '', enabled: true },
  ...over,
});

const makeItem = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  sourceId: 'arxiv-spec',
  kind: 'paper',
  title: 'Fast Speculative Decoding',
  url: `https://example.com/${id}`,
  summary: '摘要',
  authors: ['张三'],
  publishedAt: '2026-10-20T00:00:00.000Z',
  fetchedAt: '2026-10-21T00:00:00.000Z',
  score: 88,
  scoreReasons: [],
  keywords: ['speculative'],
  ...over,
});

const makeSettings = (): AppSettings => ({
  dailyRefreshAt: '08:00',
  dailyRefreshEnabled: false,
  collectMinutes: 0,
  limitPerSource: 40,
  minKeepScore: 0,
  ttlDays: 180,
  highScore: 80,
  midScore: 60,
  llm: { baseUrl: '', model: 'fake-model', hasApiKey: true },
  novelty: { command: '', hasCommand: false },
  bark: { url: '', enabled: true },
  updatedAt: null,
  nextRefreshAt: null,
  refreshMode: 'off',
});

const RUN: RunRecord = { id: 'run-1', startedAt: '', finishedAt: '', sourceCount: 1, added: 1, fetched: 1, errors: [] };
const STATS: Stats = { items: 1, ideas: 0, sources: 1, enabledSources: 1, lastRunAt: null, dailyAdded: [], scoreHistogram: [] };
const IDEA: Idea = {
  id: 'idea-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  title: '一条选题',
  problem: '问题',
  solution: '方案；方案；方案',
  effect: '提升 30%',
  keywords: [],
  ipcHints: [],
  queries: [],
  risks: [],
  status: 'draft',
  cites: [],
  focus: '',
  novelty: [],
};
const SOURCE: Source = {
  id: 'arxiv-spec',
  kind: 'arxiv',
  label: 'arXiv · 投机解码',
  url: 'https://export.arxiv.org/api/query?search_query=x',
  weight: 2,
  enabled: true,
  tags: [],
  note: '',
  createdAt: '2026-01-01T00:00:00.000Z',
};

interface LlmScript {
  /** 依序返回的决策 JSON；用尽后一律 final */
  decisions?: string[];
  /** 合成阶段逐个吐出的增量 */
  tokens?: string[];
  /** 提供时：决策 complete 会先等它（占住并发闸用） */
  blockDecision?: Promise<void>;
}

function scriptedLlm(script: LlmScript = {}): { client: LlmClient; state: { completeCalls: number; streamCalls: number } } {
  const decisions = [...(script.decisions ?? [])];
  const state = { completeCalls: 0, streamCalls: 0, completeMessages: [] as ChatMessage[][] };
  const client: LlmClient = {
    model: 'fake-chat-model',
    complete: async (messages: ChatMessage[]) => {
      state.completeCalls += 1;
      state.completeMessages.push(messages);
      if (script.blockDecision) await script.blockDecision;
      return decisions.shift() ?? '{"thought":"无需工具","action":"final","args":{}}';
    },
    completeStream: async (_messages, options, onToken) => {
      state.streamCalls += 1;
      const tokens = script.tokens ?? ['结论'];
      for (const token of tokens) {
        if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        onToken(token);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return tokens.join('');
    },
  };
  return { client, state };
}

function makeDeps(llm: LlmClient, over: Partial<HttpDeps> = {}): HttpDeps {
  const items = [makeItem('item-1', { score: 90 }), makeItem('item-2', { score: 40 })];
  return {
    listItems: (query) => {
      const limit = query.limit ?? 30;
      const offset = query.offset ?? 0;
      return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
    },
    getItem: (id) => items.find((item) => item.id === id),
    exportItems: () => items,
    listSources: () => [SOURCE],
    createSource: async (input) => ({ ...SOURCE, ...input, weight: input.weight ?? 1 }),
    updateSource: () => SOURCE,
    deleteSource: () => true,
    listIdeas: () => [IDEA],
    getIdea: () => IDEA,
    updateIdea: () => IDEA,
    archiveIdea: () => IDEA,
    saveIdea: (idea) => idea,
    recordNovelty: () => IDEA,
    autoNovelty: async () => IDEA,
    listRuns: () => [RUN],
    // 论文阅读器：这些测试不碰论文端点，给最小桩实现即可
    getPaperStatus: () => ({ itemId: '', status: 'none', originUrl: '', bytes: null, error: '', downloadedAt: null, updatedAt: '' }),
    downloadPaper: async () => ({ itemId: '', status: 'none', originUrl: '', bytes: null, error: '', downloadedAt: null, updatedAt: '' }),
    getPaperFile: () => undefined,
    listPaperAnnotations: () => [],
    addPaperAnnotation: (itemId, input) => ({
      id: 'anno-stub',
      itemId,
      page: input.page,
      rects: input.rects,
      text: input.text ?? '',
      note: input.note ?? '',
      color: input.color ?? '#f2b357',
      createdAt: '',
      updatedAt: '',
    }),
    updatePaperAnnotation: () => undefined,
    removePaperAnnotation: () => false,
    clusterIdeas: () => [],
    listWatches: () => [],
    addWatch: () => ({ id: 'w', query: 'q', note: '', enabled: true, createdAt: '', lastHits: null, lastCheckedAt: null, checks: 0 }),
    removeWatch: () => true,
    setWatchEnabled: () => true,
    sweepWatches: async () => ({ results: [], startedAt: '', finishedAt: '' }),
    stats: () => STATS,
    runCollect: async () => RUN,
    generateIdeas: async () => ({ ideas: [IDEA], usedItems: ['item-1'] }),
    isLlmConfigured: () => true,
    createLlmClient: () => llm,
    getSettings: () => makeSettings(),
    updateSettings: (patch) => ({ ...makeSettings(), ...patch }),
    close: () => {},
    ...over,
  };
}

const openApps: FastifyInstance[] = [];

async function makeApp(llm: LlmClient, over: Partial<HttpDeps> = {}): Promise<FastifyInstance> {
  const app = await buildApp(makeConfig(), { deps: makeDeps(llm, over), logger: false, distDir: null });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

// ---------------------------------------------------------------- 校验与前置错误（inject，普通 JSON）

describe('POST /api/chat：hijack 之前的 JSON 错误', () => {
  it('message 缺失/为空/超长 → 400 validation_error', async () => {
    const app = await makeApp(scriptedLlm().client);

    const missing = await app.inject({ method: 'POST', url: '/api/chat', payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<ApiError>().error.code).toBe('validation_error');
    expect(missing.json<ApiError>().error.message).toContain('message');

    const empty = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: '   ' } });
    expect(empty.statusCode).toBe(400);

    const tooLong = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: '长'.repeat(2001) } });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json<ApiError>().error.message).toContain('message');

    const edgeOk = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: '长'.repeat(2000) } });
    expect(edgeOk.statusCode).toBe(200);
  });

  it('history 超 12 条 / role 非法 / content 超长 → 400', async () => {
    const app = await makeApp(scriptedLlm().client);

    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: {
        message: 'hi',
        history: Array.from({ length: 13 }, (_, i) => ({ role: 'user', content: `m${i}` })),
      },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json<ApiError>().error.message).toContain('history');

    const badRole = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'hi', history: [{ role: 'system', content: 'x' }] },
    });
    expect(badRole.statusCode).toBe(400);
    expect(badRole.json<ApiError>().error.message).toContain('role');

    const longContent = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'hi', history: [{ role: 'assistant', content: 'x'.repeat(4001) }] },
    });
    expect(longContent.statusCode).toBe(400);
    expect(longContent.json<ApiError>().error.message).toContain('content');
  });

  it('LLM 未配置 → 503 llm_not_configured（普通 JSON）', async () => {
    const app = await makeApp(scriptedLlm().client, { isLlmConfigured: () => false });
    const res = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: '你好' } });

    expect(res.statusCode).toBe(503);
    expect(res.json<ApiError>().error.code).toBe('llm_not_configured');
  });
});

// ---------------------------------------------------------------- SSE 帧契约（listen + fetch）

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

const SEARCH_LOCAL_DECISION = '{"thought":"先查库","action":"search_local","args":{"q":"投机解码"}}';

describe('POST /api/chat：SSE 帧契约', () => {
  it('完整流：status/sources/token/done 帧格式与顺序精确匹配，done 恰好一帧收尾', async () => {
    const { client } = scriptedLlm({
      decisions: [SEARCH_LOCAL_DECISION, '{"thought":"够了","action":"final","args":{}}'],
      tokens: ['结', '论'],
    });
    const app = await makeApp(client);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const response = await fetch(`${address}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '投机解码有什么新进展？', history: [{ role: 'user', content: '昨天问过 KV cache' }] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const raw = await response.text();
    // 帧格式逐字节：第一帧就是 status plan
    expect(raw.startsWith('event: status\ndata: {"step":"plan","label":"正在分析问题…"}\n\n')).toBe(true);
    // 每个 data 都是单行 JSON（SSE 契约）
    for (const frame of parseFrames(raw)) {
      expect(frame.data).not.toContain('\n');
      expect(() => JSON.parse(frame.data)).not.toThrow();
    }

    const frames = parseFrames(raw);
    const steps = frames
      .filter((frame) => frame.event === 'status')
      .map((frame) => (JSON.parse(frame.data) as { step: string }).step);
    expect(steps).toEqual(['plan', 'search_local', 'compose']);

    const sourcesFrames = frames.filter((frame) => frame.event === 'sources');
    expect(sourcesFrames).toHaveLength(1);
    const sources = JSON.parse(sourcesFrames[0]?.data ?? '{}') as { items: { title: string; url: string; kind: string; meta: object }[] };
    // 假 listItems 返回 2 条，全部进入覆盖式 sources 帧
    expect(sources.items).toHaveLength(2);
    expect(sources.items[0]).toMatchObject({ title: 'Fast Speculative Decoding', url: 'https://example.com/item-1', kind: 'paper' });

    const tokens = frames
      .filter((frame) => frame.event === 'token')
      .map((frame) => (JSON.parse(frame.data) as { text: string }).text);
    expect(tokens).toEqual(['结', '论']);

    // done 恰好一帧、是最后一帧
    const doneFrames = frames.filter((frame) => frame.event === 'done');
    expect(doneFrames).toHaveLength(1);
    expect(frames.at(-1)?.event).toBe('done');
    const done = JSON.parse(doneFrames[0]?.data ?? '{}') as { messageId: string; toolsUsed: string[] };
    expect(done.messageId).toMatch(/^chat-/);
    expect(done.toolsUsed).toEqual(['search_local']);
    expect(frames.some((frame) => frame.event === 'error')).toBe(false);
  });

  it('决策输出坏 JSON → error 帧恰好一帧收尾，code=llm_bad_output', async () => {
    const { client } = scriptedLlm({ decisions: ['这不是 JSON'], tokens: ['不该出现'] });
    const app = await makeApp(client);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const response = await fetch(`${address}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '你好' }),
    });
    const raw = await response.text();
    const frames = parseFrames(raw);

    const errorFrames = frames.filter((frame) => frame.event === 'error');
    expect(errorFrames).toHaveLength(1);
    expect(frames.at(-1)?.event).toBe('error');
    const payload = JSON.parse(errorFrames[0]?.data ?? '{}') as { code: string; message: string };
    expect(payload.code).toBe('llm_bad_output');
    expect(payload.message).toContain('JSON');
    expect(frames.some((frame) => frame.event === 'token')).toBe(false);
  });

  it('工具领域错误翻译成 error 帧（如 generate_ideas 库内无素材 → all_invalid）', async () => {
    const { client } = scriptedLlm({
      decisions: [
        '{"thought":"生成选题","action":"generate_ideas","args":{"focus":"投机解码"}}',
        '{"thought":"x","action":"final","args":{}}',
      ],
    });
    const app = await makeApp(client, {
      generateIdeas: async () => {
        const error = new Error('模型返回的 3 条选题全部不合格');
        (error as Error & { code?: string }).code = 'all_invalid';
        throw error;
      },
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const response = await fetch(`${address}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '帮我生成选题' }),
    });
    const frames = parseFrames(await response.text());
    const errorFrame = frames.find((frame) => frame.event === 'error');
    expect(errorFrame).toBeDefined();
    expect(JSON.parse(errorFrame?.data ?? '{}')).toMatchObject({ code: 'all_invalid' });
    expect(frames.at(-1)?.event).toBe('error');
    // 选题生成的 status 提示帧在 error 之前
    const steps = frames
      .filter((frame) => frame.event === 'status')
      .map((frame) => (JSON.parse(frame.data) as { step: string }).step);
    expect(steps).toContain('generate_ideas');
  });
});

// ---------------------------------------------------------------- 并发闸门与断开

describe('POST /api/chat：并发闸门与客户端断开', () => {
  it('在飞 2 个上限：第 3 个请求 429 chat_busy（普通 JSON），结束后闸门释放', async () => {
    let releaseDecision!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const { client } = scriptedLlm({
      decisions: ['{"thought":"x","action":"final","args":{}}'],
      tokens: ['完'],
      blockDecision: blocker,
    });
    const app = await makeApp(client);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const post = (): Promise<Response> =>
      fetch(`${address}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '你好' }),
      });

    // 两个在飞：决策阶段被阻塞，SSE 挂着
    const busy1 = await post();
    expect(busy1.status).toBe(200);
    const busy2 = await post();
    expect(busy2.status).toBe(200);

    // 第三个被闸门挡下，且是 hijack 之前的普通 JSON 错误
    const rejected = await post();
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('content-type')).toContain('application/json');
    expect(await rejected.json()).toMatchObject({ error: { code: 'chat_busy' } });

    // 放行两个在飞 → done 收尾 → 闸门腾出 → 新请求恢复 200
    releaseDecision();
    const raw1 = await busy1.text();
    const raw2 = await busy2.text();
    expect(parseFrames(raw1).at(-1)?.event).toBe('done');
    expect(parseFrames(raw2).at(-1)?.event).toBe('done');

    const after = await post();
    expect(after.status).toBe(200);
    expect(parseFrames(await after.text()).at(-1)?.event).toBe('done');
  });

  it('客户端断开 → 合成流被取消、不吐 error 帧、闸门释放', async () => {
    const { client, state } = scriptedLlm({
      decisions: ['{"thought":"x","action":"final","args":{}}'],
      tokens: ['开头'],
    });
    // 让合成流真正响应外部取消（模拟真实 LLM 流被掐断）；只有第一次调用挂起，
    // 后续调用（断开后的验证请求）正常完成
    let hangUsed = false;
    const cancellable: LlmClient = {
      ...client,
      completeStream: async (_messages, options, onToken) => {
        state.streamCalls += 1;
        onToken('开头');
        if (!hangUsed) {
          hangUsed = true;
          await new Promise<void>((_resolve, reject) => {
            const fail = (): void => reject(new DOMException('aborted', 'AbortError'));
            if (options?.signal?.aborted) return fail();
            options?.signal?.addEventListener('abort', fail);
          });
        }
        return '开头';
      },
    };
    const app = await makeApp(cancellable);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const controller = new AbortController();
    const response = await fetch(`${address}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '讲讲投机解码' }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);

    // 等到合成阶段已经开始（token 已吐），再掐断客户端
    const deadline = Date.now() + 3000;
    while (state.streamCalls === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(state.streamCalls).toBe(1);
    controller.abort();

    // 闸门释放后新请求立即 200（不是 429）
    const retry = await fetch(`${address}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '再来一次' }),
    });
    expect(retry.status).toBe(200);
    expect(parseFrames(await retry.text()).at(-1)?.event).toBe('done');
  });
});

// ---------------------------------------------------------------- 会话持久化（R2）

const VALID_SESSION = 'session-test-01';

describe('POST /api/chat：会话持久化', () => {
  it('带 sessionId：忽略请求 history、服务端取库内最近 12 条；双向落库；done 帧带 sessionId', async () => {
    const { client, state } = scriptedLlm({
      decisions: ['{"thought":"x","action":"final","args":{}}'],
      tokens: ['第一', '次回答'],
    });
    const app = await makeApp(client);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const post = (payload: object): Promise<Response> =>
      fetch(`${address}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

    // 第一轮：请求里带的 history 应被忽略（库里还没有历史）
    const first = await post({
      message: '第一问',
      history: [{ role: 'user', content: '请求里的旧历史，不该被采用' }],
      sessionId: VALID_SESSION,
    });
    expect(first.status).toBe(200);
    const done1 = parseFrames(await first.text()).find((frame) => frame.event === 'done');
    expect(JSON.parse(done1?.data ?? '{}')).toMatchObject({ sessionId: VALID_SESSION });
    // 决策消息里没有请求里的旧历史
    expect(JSON.stringify(state.completeMessages[0])).not.toContain('请求里的旧历史');

    // 第二轮：服务端历史 = 第一轮的 user+assistant（读完响应体等 assistant 落库完成）
    const second = await post({ message: '第二问', sessionId: VALID_SESSION });
    expect(parseFrames(await second.text()).at(-1)?.event).toBe('done');
    const round2 = JSON.stringify(state.completeMessages[1]);
    expect(round2).toContain('第一问');
    expect(round2).toContain('第一次回答');

    // 落库断言：会话列表 + 明细
    const list = await app.inject({ method: 'GET', url: '/api/chat/sessions' });
    expect(list.statusCode).toBe(200);
    const sessions = list.json<{ sessionId: string; title: string; messageCount: number }[]>();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: VALID_SESSION, title: '第一问', messageCount: 4 });

    const detail = await app.inject({ method: 'GET', url: `/api/chat/sessions/${VALID_SESSION}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json<{ sessionId: string; messages: { role: string; content: string }[] }>();
    expect(body.sessionId).toBe(VALID_SESSION);
    expect(body.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // 首轮没调工具 → assistant 不带空元数据（见下一个测试的带元数据场景）
    expect(body.messages[1]).toEqual({ role: 'assistant', content: '第一次回答', at: expect.any(String) });

    // 删除会话 → 404
    const removed = await app.inject({ method: 'DELETE', url: `/api/chat/sessions/${VALID_SESSION}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
    const after = await app.inject({ method: 'GET', url: `/api/chat/sessions/${VALID_SESSION}` });
    expect(after.statusCode).toBe(404);
  });

  it('assistant 落库带最后一份 sources 与 toolsUsed（覆盖式）', async () => {
    const { client } = scriptedLlm({
      decisions: [SEARCH_LOCAL_DECISION, '{"thought":"x","action":"final","args":{}}'],
      tokens: ['答'],
    });
    const app = await makeApp(client);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const response = await fetch(`${address}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '查一下', sessionId: VALID_SESSION }),
    });
    const done = parseFrames(await response.text()).find((frame) => frame.event === 'done');
    expect(JSON.parse(done?.data ?? '{}').toolsUsed).toEqual(['search_local']);

    const detail = await app.inject({ method: 'GET', url: `/api/chat/sessions/${VALID_SESSION}` });
    const assistant = detail.json<{ messages: { toolsUsed?: string[]; sources?: { url: string }[] }[] }>().messages[1];
    expect(assistant?.toolsUsed).toEqual(['search_local']);
    expect(assistant?.sources?.map((source) => source.url)).toContain('https://example.com/item-1');
  });

  it('不带 sessionId：旧模式完全不落库', async () => {
    const { client } = scriptedLlm({ tokens: ['答'] });
    const app = await makeApp(client);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const response = await fetch(`${address}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '闲聊' }),
    });
    // done 帧不回带 sessionId，且会话列表为空（不落库）
    const done = parseFrames(await response.text()).find((frame) => frame.event === 'done');
    expect(done?.data).not.toContain('sessionId');

    const list = await app.inject({ method: 'GET', url: '/api/chat/sessions' });
    expect(list.json<unknown[]>()).toEqual([]);
  });

  it('sessionId 非法（过短/含非法字符）→ 400 validation_error', async () => {
    const app = await makeApp(scriptedLlm().client);
    const short = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'hi', sessionId: 'abc' },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json<ApiError>().error.message).toContain('sessionId');

    const badChar = await app.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { message: 'hi', sessionId: `${VALID_SESSION}!` },
    });
    expect(badChar.statusCode).toBe(400);
  });
});

describe('GET /api/ideas/:id/claims', () => {
  it('draft_claims 工具落库后可读取；无草案 404', async () => {
    const { client } = scriptedLlm({
      decisions: [
        '{"thought":"起草","action":"draft_claims","args":{"ideaId":"idea-1"}}',
        JSON.stringify({ claims: ['1. 一种方法，其特征在于A。', '2. 根据权利要求1所述的方法，其特征在于B。'] }),
        '{"thought":"x","action":"final","args":{}}',
      ],
      tokens: ['答'],
    });
    const app = await makeApp(client);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    const none = await app.inject({ method: 'GET', url: '/api/ideas/idea-1/claims' });
    expect(none.statusCode).toBe(404);

    const response = await fetch(`${address}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '帮我起草权利要求' }),
    });
    const frames = parseFrames(await response.text());
    expect(JSON.parse(frames.find((frame) => frame.event === 'done')?.data ?? '{}').toolsUsed).toEqual(['draft_claims']);

    const claims = await app.inject({ method: 'GET', url: '/api/ideas/idea-1/claims' });
    expect(claims.statusCode).toBe(200);
    const body = claims.json<{ content: string; at: string }>();
    expect(body.content).toContain('其特征在于A');
    expect(body.at).toBeTruthy();
  });
});

describe('POST /api/push/test', () => {
  const makeSettingsWith = (bark: { url: string; enabled: boolean }): Partial<HttpDeps> => ({
    getSettings: () => ({ ...makeSettings(), bark }),
  });

  it('未配置 → 422 bark_not_configured', async () => {
    const app = await makeApp(scriptedLlm().client);
    const res = await app.inject({ method: 'POST', url: '/api/push/test', payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json<ApiError>().error.code).toBe('bark_not_configured');
  });

  it('用已保存配置推送（enabled+url）→ 200；请求带 url 时优先用请求里的（先测后存）', async () => {
    const pushed: string[] = [];
    const app = await makeApp(scriptedLlm().client, {
      ...makeSettingsWith({ url: 'https://api.day.app/savedkey', enabled: true }),
      fetchLike: async (input) => {
        pushed.push(String(input));
        return new Response('{"code":200}', { status: 200 });
      },
    });

    const saved = await app.inject({ method: 'POST', url: '/api/push/test', payload: {} });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ok: true });
    expect(pushed[0]).toContain('api.day.app/savedkey');

    const custom = await app.inject({
      method: 'POST',
      url: '/api/push/test',
      payload: { url: 'https://api.day.app/trial-key' },
    });
    expect(custom.statusCode).toBe(200);
    expect(pushed[1]).toContain('api.day.app/trial-key');
    // 标题/正文均被 URL 编码且为中文文案
    expect(pushed[0]).toContain(encodeURIComponent('情报雷达测试推送'));
  });

  it('已保存配置但被关闭 → 422；推送失败（非 2xx）→ 502 bark_push_failed', async () => {
    const disabled = await makeApp(scriptedLlm().client, {
      ...makeSettingsWith({ url: 'https://api.day.app/savedkey', enabled: false }),
    });
    const off = await disabled.inject({ method: 'POST', url: '/api/push/test', payload: {} });
    expect(off.statusCode).toBe(422);

    const app = await makeApp(scriptedLlm().client, {
      ...makeSettingsWith({ url: 'https://api.day.app/savedkey', enabled: true }),
      fetchLike: async () => new Response('forbidden', { status: 403 }),
    });
    const failed = await app.inject({ method: 'POST', url: '/api/push/test', payload: {} });
    expect(failed.statusCode).toBe(502);
    expect(failed.json<ApiError>().error.code).toBe('bark_push_failed');
    expect(failed.json<ApiError>().error.message).toContain('403');
  });
});
