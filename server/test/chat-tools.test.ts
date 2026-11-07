import { describe, expect, it } from 'vitest';

import { ApiException } from '../src/http/errors.js';
import { arxivSearchQuery, runTool, searchArxiv, searchLocal, searchPatents, type ToolContext } from '../src/chat/tools.js';
import type { FetchLike } from '../src/chat/tools.js';
import type { Idea, Item, ItemQuery, Paged } from '../src/types.js';

/**
 * chat 工具测试：全程离线，fetch / listItems / generateIdeas 全部注入假实现。
 * 重点断言参数映射、外部检索的降级路径（非 200 / 解析失败 → 空列表 + note）。
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');

const ITEM: Item = {
  id: 'item-1',
  sourceId: 'arxiv-spec',
  kind: 'paper',
  title: 'Fast Speculative Decoding',
  url: 'https://arxiv.org/abs/2401.00001',
  summary: '投机解码与 KV 复用',
  authors: ['Alice'],
  publishedAt: '2026-10-28T00:00:00.000Z',
  fetchedAt: '2026-11-01T00:00:00.000Z',
  score: 88,
  scoreReasons: [],
  keywords: ['speculative'],
};

const PAGE: Paged<Item> = { items: [ITEM], total: 2, limit: 10, offset: 0 };

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  const IDEA: Idea = {
    id: 'idea-1',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    title: '一种基于动态草稿长度的投机解码方法',
    problem: '草稿固定长度导致验证浪费',
    solution: '①按置信度动态截断草稿序列；②用验证通过率反馈调整截断阈值；③把截断长度写入缓存复用',
    effect: '验证开销降低 30%',
    keywords: ['投机解码'],
    ipcHints: ['G06F9/50'],
    queries: ['投机解码 草稿 截断', '草稿 长度 动态 调整'],
    risks: ['既有固定草稿长度方案'],
    status: 'draft',
    cites: [],
    focus: '投机解码',
    novelty: [],
  };
  const claims = new Map<string, string>();
  return {
    fetch: (async () => {
      throw new Error('unexpected fetch');
    }) as FetchLike,
    listItems: () => PAGE,
    generateIdeas: async () => ({ ideas: [IDEA] }),
    now: () => NOW,
    getIdea: (ideaId) => (ideaId === 'idea-1' ? IDEA : undefined),
    saveClaims: (ideaId, content) => claims.set(ideaId, content),
    ...over,
  };
}

describe('search_local', () => {
  it('args 映射成 ItemQuery：q/kinds/since_days/min_score/limit 全部生效', () => {
    const queries: ItemQuery[] = [];
    const ctx = makeCtx({
      listItems: (query) => {
        queries.push(query);
        return PAGE;
      },
    });
    const result = searchLocal(ctx, { q: '投机', kinds: ['paper'], since_days: 7, min_score: 60, limit: 5 });

    expect(queries[0]).toEqual({
      q: '投机',
      kinds: ['paper'],
      since: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
      minScore: 60,
      limit: 5,
      sort: 'score',
    });
    expect(result.items[0]).toMatchObject({ title: ITEM.title, url: ITEM.url, kind: 'paper' });
    expect(result.items[0]?.meta).toMatchObject({ score: 88, sourceId: 'arxiv-spec' });
    expect(result.note).toContain('2 条');
  });

  it('缺省值：limit≤20 默认 10、min_score=0 不下推、非法 kinds 被过滤', () => {
    const queries: ItemQuery[] = [];
    searchLocal(makeCtx({ listItems: (q) => (queries.push(q), PAGE) }), {
      kinds: ['paper', 'patent', 'bogus'],
      limit: 99,
    });
    expect(queries[0]).toEqual({ sort: 'score', limit: 20, kinds: ['paper'] });
  });
});

const ARXIV_ATOM = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>Fast Speculative Decoding</title>
    <link href="https://arxiv.org/abs/2401.00001" rel="alternate" type="text/html"/>
    <summary>We speed up decoding.</summary>
    <published>2026-10-28T00:00:00Z</published>
    <author><name>Alice</name></author>
  </entry>
</feed>`;

describe('search_arxiv', () => {
  it('实时查 arXiv API：sortBy=submittedDate，limit 夹到 15，复用采集的 Atom 解析', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const ctx = makeCtx({
      fetch: (async (input: string | URL, init?: RequestInit) => {
        seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response(ARXIV_ATOM, { status: 200, headers: { 'content-type': 'application/atom+xml' } });
      }) as FetchLike,
    });

    const result = await searchArxiv(ctx, { query: 'speculative decoding', limit: 99 });

    const url = new URL(seen[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://export.arxiv.org/api/query');
    // 自然语言拆词成 all: 字段 AND 连接（arxivSearchQuery 契约，裸短语在 arXiv 解析脆弱）
    expect(url.searchParams.get('search_query')).toBe('all:speculative AND all:decoding');
    expect(url.searchParams.get('sortBy')).toBe('submittedDate');
    expect(url.searchParams.get('sortOrder')).toBe('descending');
    expect(url.searchParams.get('max_results')).toBe('15');
    expect(seen[0]?.headers['user-agent']).toContain('trend-radar');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ title: 'Fast Speculative Decoding', url: 'https://arxiv.org/abs/2401.00001', kind: 'paper' });
    expect(result.items[0]?.meta).toMatchObject({ authors: ['Alice'] });
  });

  it('非 200 / 网络失败 → 空列表 + note，不抛死请求', async () => {
    const failed = await searchArxiv(
      makeCtx({ fetch: (async () => new Response('busy', { status: 429 })) as FetchLike }),
      { query: 'kv cache' },
    );
    expect(failed.items).toEqual([]);
    expect(failed.note).toContain('429');

    const thrown = await searchArxiv(
      makeCtx({
        fetch: (async () => {
          throw new Error('connect ECONNREFUSED');
        }) as FetchLike,
      }),
      { query: 'kv cache' },
    );
    expect(thrown.items).toEqual([]);
    expect(thrown.note).toContain('ECONNREFUSED');
  });

  it('缺检索词 → 空列表 + note', async () => {
    const result = await searchArxiv(makeCtx(), {});
    expect(result.items).toEqual([]);
    expect(result.note).toContain('query');
  });
});

const PATENTS_JSON = JSON.stringify({
  results: {
    cluster: [
      {
        result: [
          {
            patent: {
              title: '<b>投机解码</b>加速方法',
              snippet: '一种利用草稿模型的 &lt;i&gt;验证机制&lt;/i&gt;',
              publication_number: 'CN110000001A',
              assignee: '华为技术有限公司',
              filing_date: '20240101',
            },
          },
          {
            title: '直接字段的条目',
            publication_number: 'US11111111B2',
            assignee: ['OpenAI', '微软'],
            filing_date: '20230202',
          },
        ],
      },
    ],
  },
});

describe('search_patents', () => {
  it('XHR URL 编码正确、带 UA header，解析 cluster[].result[] 并拼专利链接', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const ctx = makeCtx({
      fetch: (async (input: string | URL, init?: RequestInit) => {
        seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response(PATENTS_JSON, { status: 200, headers: { 'content-type': 'application/json' } });
      }) as FetchLike,
    });

    const result = await searchPatents(ctx, { query: '投机解码' });

    expect(seen[0]?.url).toBe(
      `https://patents.google.com/xhr/query?url=${encodeURIComponent('q=投机解码')}`,
    );
    expect(seen[0]?.headers['user-agent']).toContain('trend-radar');

    // 空格必须转成 + 而不是 %20：GP 的 xhr/query?url= 是「查询串再编码一次」的双层结构，
    // %20 会让 GP 解析归零（实测同一查询 + 形态 886 命中、%20 形态 0 命中）
    await searchPatents(ctx, { query: 'KV cache 压缩' });
    expect(seen[1]?.url).toBe(
      `https://patents.google.com/xhr/query?url=${encodeURIComponent('q=KV+cache+压缩')}`,
    );

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      title: '投机解码加速方法', // <b> 标签被剥掉
      url: 'https://patents.google.com/patent/CN110000001A/en',
      kind: 'patent',
    });
    expect(result.items[0]?.meta).toMatchObject({ publication_number: 'CN110000001A', assignee: '华为技术有限公司', filing_date: '20240101' });
    expect(result.items[0]?.meta.snippet).not.toContain('<i>');
    // 字段直接在 result[] 上的写法、assignee 为数组时 join
    expect(result.items[1]).toMatchObject({ url: 'https://patents.google.com/patent/US11111111B2/en' });
    expect(result.items[1]?.meta.assignee).toBe('OpenAI、微软');
  });

  it('非 200 / 坏 JSON / 结构变化 → 空列表 + note，不抛死请求', async () => {
    const forbidden = await searchPatents(
      makeCtx({ fetch: (async () => new Response('forbidden', { status: 403 })) as FetchLike }),
      { query: 'kv cache' },
    );
    expect(forbidden.items).toEqual([]);
    expect(forbidden.note).toContain('403');

    const badJson = await searchPatents(
      makeCtx({ fetch: (async () => new Response('<html>not json</html>', { status: 200 })) as FetchLike }),
      { query: 'kv cache' },
    );
    expect(badJson.items).toEqual([]);
    expect(badJson.note).toBeTruthy();

    const weirdShape = await searchPatents(
      makeCtx({ fetch: (async () => new Response('{"unexpected":true}', { status: 200 })) as FetchLike }),
      { query: 'kv cache' },
    );
    expect(weirdShape.items).toEqual([]);
    expect(weirdShape.note).toContain('未解析到条目');
  });
});

describe('generate_ideas', () => {
  it('count 夹到 1-5 默认 3，选题映射为 kind=idea 的条目', async () => {
    const requests: { focus: string; count: number }[] = [];
    const ctx = makeCtx({
      generateIdeas: async (req) => {
        requests.push(req);
        return { ideas: (await makeCtx().generateIdeas(req)).ideas };
      },
    });
    const result = await runTool(ctx, 'generate_ideas', { focus: '投机解码', count: 99 });

    expect(requests[0]).toEqual({ focus: '投机解码', count: 5 });
    expect(result.items[0]).toMatchObject({ title: '一种基于动态草稿长度的投机解码方法', kind: 'idea' });
    expect(result.items[0]?.meta).toMatchObject({ id: 'idea-1', status: 'draft' });
    expect(result.note).toContain('入库');
  });

  it('领域错误按 errors.ts 翻译（no_items → 422 ApiException）', async () => {
    const ctx = makeCtx({
      generateIdeas: async () => {
        const error = new Error('没有可用的情报条目');
        (error as Error & { code?: string }).code = 'no_items';
        throw error;
      },
    });
    await expect(runTool(ctx, 'generate_ideas', { focus: '投机解码' })).rejects.toMatchObject({
      name: 'ApiException',
      statusCode: 422,
      code: 'no_items',
    });
    await expect(runTool(ctx, 'generate_ideas', { focus: '投机解码' })).rejects.toBeInstanceOf(ApiException);
  });

  describe('arxivSearchQuery：自然语言与字段语法分道', () => {
    it('自然语言 → 拆词 all: 字段 AND 连接（裸短语在 arXiv 解析脆弱）', () => {
      expect(arxivSearchQuery('prefill decode disaggregation')).toBe(
        'all:prefill+AND+all:decode+AND+all:disaggregation',
      );
    });

    it('字段语法检索式按原样保留，仅空格→+ 与引号→%22（冒号绝不能编码成 %3A）', () => {
      expect(arxivSearchQuery('all:"prefill decode disaggregation"')).toBe(
        'all:%22prefill+decode+disaggregation%22',
      );
      expect(arxivSearchQuery('ti:DistServe OR ti:Mooncake')).toBe('ti:DistServe+OR+ti:Mooncake');
    });

    it('非词元字符被过滤，防止构造出坏 URL；空白输入返回空串', () => {
      expect(arxivSearchQuery('KV cache 压缩，注意 stability!')).toBe('all:KV+AND+all:cache');
      expect(arxivSearchQuery('   ')).toBe('');
    });
  });

  it('缺 focus → 空列表 + note，不触发生成', async () => {
    let called = 0;
    const ctx = makeCtx({
      generateIdeas: async () => {
        called += 1;
        return { ideas: [] };
      },
    });
    const result = await runTool(ctx, 'generate_ideas', {});
    expect(called).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.note).toContain('focus');
  });
});

// ---------------------------------------------------------------- B 组：export_disclosure / check_novelty / draft_claims

import { runTool as runToolDispatch } from '../src/chat/tools.js';
import { serializeToolResult } from '../src/chat/prompt.js';
import { summarizeVerdict } from '../src/ideas/verdict.js';
import type { NoveltyRecord } from '../src/types.js';
import type { ToolResult } from '../src/chat/types.js';

const NOVELTY_RECORDS: NoveltyRecord[] = [
  { at: '2026-11-01T00:00:00.000Z', query: '投机解码 草稿 截断', hits: 2, topAssignees: '华为:2', note: '', site: 'manual' },
];

const IDEA_WITH_NOVELTY = {
  novelty: NOVELTY_RECORDS,
} as Partial<Parameters<ToolContext['getIdea']>[0]>;

void IDEA_WITH_NOVELTY;

describe('export_disclosure', () => {
  it('默认 docx，链接指向披露端点；format=md 同理', async () => {
    const docx = await runToolDispatch(makeCtx(), 'export_disclosure', { ideaId: 'idea-1' });
    expect(docx.items).toHaveLength(1);
    expect(docx.items[0]).toMatchObject({
      title: expect.stringContaining('投机解码'),
      url: '/api/ideas/idea-1/disclosure?format=docx',
      kind: 'idea',
    });
    expect(docx.items[0]?.meta).toMatchObject({ format: 'docx' });
    expect(docx.note).toContain('下载');

    const md = await runToolDispatch(makeCtx(), 'export_disclosure', { ideaId: 'idea-1', format: 'md' });
    expect(md.items[0]?.url).toBe('/api/ideas/idea-1/disclosure?format=md');
  });

  it('选题不存在 / 缺 ideaId → 空列表 + note', async () => {
    const missing = await runToolDispatch(makeCtx(), 'export_disclosure', { ideaId: 'idea-nope' });
    expect(missing.items).toEqual([]);
    expect(missing.note).toContain('idea-nope');

    const noArg = await runToolDispatch(makeCtx(), 'export_disclosure', {});
    expect(noArg.items).toEqual([]);
    expect(noArg.note).toContain('ideaId');
  });
});

describe('check_novelty', () => {
  it('CLI 可用 → 跑自动查新并返回四档判读摘要', async () => {
    let autoCalled: string | undefined;
    const updatedIdea = {
      id: 'idea-1',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      title: '一种基于动态草稿长度的投机解码方法',
      problem: '草稿固定长度导致验证浪费',
      solution: '按置信度动态截断草稿序列',
      effect: '验证开销降低 30%',
      keywords: ['投机解码'],
      ipcHints: ['G06F9/50'],
      queries: ['投机解码 草稿 截断'],
      risks: ['撞车'],
      status: 'draft' as const,
      cites: [],
      focus: 'x',
      novelty: NOVELTY_RECORDS,
    };
    const ctx = makeCtx({
      noveltyCommandAvailable: true,
      autoNovelty: async (ideaId) => {
        autoCalled = ideaId;
        return updatedIdea;
      },
      summarizeVerdict,
    });

    const result = await runToolDispatch(ctx, 'check_novelty', { ideaId: 'idea-1' });
    expect(autoCalled).toBe('idea-1');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.meta).toMatchObject({ verdict: expect.any(String), headline: expect.any(String) });
    expect(result.items[0]?.meta.evidence).toEqual(expect.any(Array));
    expect(result.note).toContain('自动查新');
  });

  it('CLI 未配置但已有记录 → 只做摘要判读，note 说明', async () => {
    const base = makeCtx().getIdea('idea-1')!;
    const ctx = makeCtx({ summarizeVerdict, getIdea: (id) => (id === 'idea-1' ? { ...base, novelty: NOVELTY_RECORDS } : undefined) });

    const result = await runToolDispatch(ctx, 'check_novelty', { ideaId: 'idea-1' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.meta).toHaveProperty('headline');
    expect(result.note).toContain('未配置');
  });

  it('没有记录也无法自动查新 → 引导 note；自动查新失败 → 回退已有记录', async () => {
    const empty = await runToolDispatch(makeCtx(), 'check_novelty', { ideaId: 'idea-1' });
    expect(empty.items).toEqual([]);
    expect(empty.note).toContain('还没有查新记录');

    const base = makeCtx().getIdea('idea-1')!;
    const ctx = makeCtx({
      noveltyCommandAvailable: true,
      autoNovelty: async () => {
        throw new Error('登录已失效');
      },
      summarizeVerdict,
      getIdea: (id) => (id === 'idea-1' ? { ...base, novelty: NOVELTY_RECORDS } : undefined),
    });
    const fallback = await runToolDispatch(ctx, 'check_novelty', { ideaId: 'idea-1' });
    expect(fallback.items).toHaveLength(1);
    expect(fallback.note).toContain('自动查新失败');
  });
});

describe('draft_claims', () => {
  const CLAIMS_JSON = JSON.stringify({
    claims: [
      '1. 一种投机解码加速方法，其特征在于，包括：按置信度动态截断草稿序列。',
      '2. 根据权利要求1所述的方法，其特征在于，所述截断阈值由验证通过率反馈调整。',
      '3. 根据权利要求1所述的方法，其特征在于，截断长度写入缓存以供复用。',
      '4. 根据权利要求1所述的方法，其特征在于，所述置信度按 token 级别计算。',
    ],
  });

  it('生成草案并落库：items.meta.claims 为主载荷，note 提示人工修订', async () => {
    const saved = new Map<string, string>();
    const ctx = makeCtx({
      llm: { complete: async () => CLAIMS_JSON } as ToolContext['llm'],
      saveClaims: (ideaId, content) => saved.set(ideaId, content),
    });

    const result = await runToolDispatch(ctx, 'draft_claims', { ideaId: 'idea-1' });
    expect(result.items[0]).toMatchObject({ title: '权利要求草案（4 条）', kind: 'idea' });
    expect((result.items[0]?.meta.claims as string).startsWith('1. 一种投机解码加速方法')).toBe(true);
    expect(saved.get('idea-1')).toBe((result.items[0]?.meta.claims as string) ?? 'x');
    expect(result.note).toContain('人工修订');
    expect(result.note).toContain('/api/ideas/idea-1/claims');
  });

  it('容忍裸数组输出；缺 LLM / 选题不存在 → 降级 note；坏 JSON → 502', async () => {
    const bare = await runToolDispatch(
      makeCtx({ llm: { complete: async () => '["1. 方法A","2. 根据权利要求1所述的方法B"]' } as ToolContext['llm'] }),
      'draft_claims',
      { ideaId: 'idea-1' },
    );
    expect(bare.items[0]?.title).toContain('2 条');

    const noLlm = await runToolDispatch(makeCtx(), 'draft_claims', { ideaId: 'idea-1' });
    expect(noLlm.items).toEqual([]);
    expect(noLlm.note).toContain('LLM');

    const missing = await runToolDispatch(makeCtx({ llm: { complete: async () => '{}' } as ToolContext['llm'] }), 'draft_claims', {
      ideaId: 'idea-nope',
    });
    expect(missing.items).toEqual([]);

    const bad = runToolDispatch(makeCtx({ llm: { complete: async () => '不是JSON' } as ToolContext['llm'] }), 'draft_claims', {
      ideaId: 'idea-1',
    });
    await expect(bad).rejects.toMatchObject({ name: 'ApiException', code: 'llm_bad_output' });
  });

  it('claims 走序列化白名单：超 160 字符的主载荷不被截断（上限 2500）', () => {
    const longClaim = '1. 一种方法，其特征在于，'.repeat(120); // ~2000+ 字符
    const result: ToolResult = {
      items: [{ title: '权利要求草案', url: '', kind: 'idea', meta: { ideaId: 'idea-1', claims: longClaim } }],
    };
    const text = serializeToolResult('draft_claims', result);
    expect(text).toContain(longClaim.slice(0, 2500));
    // 普通键仍按 160 截断
    const normal = serializeToolResult('search_local', {
      items: [{ title: 't', url: 'u', kind: 'paper', meta: { summary: '长'.repeat(400) } }],
    });
    expect(normal).toContain('长'.repeat(160));
    expect(normal).not.toContain('长'.repeat(161));
  });
});
