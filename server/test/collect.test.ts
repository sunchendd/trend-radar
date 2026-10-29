import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { runCollect, runCollectDetailed } from '../src/collect.js';
import { fetchAllSources, type FetchLike } from '../src/sources/index.js';
import { probeSource } from '../src/sources/probe.js';
import { openDb } from '../src/store/db.js';
import { listItems, listRuns } from '../src/store/queries.js';
import type { Source } from '../src/types.js';

/**
 * 采集管线测试。
 *
 * 铁律：**一次真实网络请求都不许发**。所有请求走注入的假 fetcher，
 * 这样测试才能断言「某个源 500 时其余源照常入库」这类真实场景，
 * 否则跑一次测试就同时在压 arXiv 的接口。
 */

const NOW = new Date('2026-10-29T12:00:00.000Z');
const CREATED_AT = '2026-01-01T00:00:00.000Z';

function makeConfig(dataDir: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir,
    port: 0,
    host: '127.0.0.1',
    collectMinutes: 0,
    minKeepScore: 0,
    limitPerSource: 40,
    ttlDays: 180,
    llm: { baseUrl: '', apiKey: '', model: '', temperature: 0.7, maxTokens: 1000 },
    novelty: { command: '', agreeKick: false },
    ...over,
  };
}

function makeSource(over: Partial<Source> & Pick<Source, 'id' | 'kind' | 'url'>): Source {
  return {
    label: over.id,
    weight: 1,
    enabled: true,
    tags: [],
    note: `${over.id} 测试源`,
    createdAt: CREATED_AT,
    ...over,
  };
}

interface FakeRoute {
  body?: string;
  error?: Error;
  status?: number;
}

/** 假 fetcher：按精确 URL 路由；记录调用次数，用来验证「同 URL 只发一次」 */
function fakeFetch(routes: Record<string, FakeRoute | string>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    calls.push(input);
    const route = routes[input];
    if (route === undefined) return Promise.reject(new Error(`unexpected url: ${input}`));
    const normalized: FakeRoute = typeof route === 'string' ? { body: route } : route;
    if (normalized.error) throw normalized.error;
    return new Response(normalized.body ?? '', {
      status: normalized.status ?? 200,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
    });
  };
  return { fetch: fetchImpl, calls };
}

interface ArxivEntry {
  id: string;
  url?: string;
  title: string;
  summary?: string;
  published?: string;
  authors?: string[];
  doi?: string;
}

function arxivFeed(entries: ArxivEntry[]): string {
  const body = entries
    .map((entry) => {
      const authors = (entry.authors ?? []).map((name) => `<author><name>${name}</name></author>`).join('');
      const link = entry.url ?? entry.id.replace(/^http:/, 'https:');
      const doi = entry.doi ? `<arxiv:doi>${entry.doi}</arxiv:doi>` : '';
      return `<entry>
    <id>${entry.id}</id>
    <title>${entry.title}</title>
    <link href="${link}" rel="alternate" type="text/html"/>
    <summary>${entry.summary ?? ''}</summary>
    <published>${entry.published ?? '2026-10-28T00:00:00Z'}</published>
    ${authors}${doi}
  </entry>`;
    })
    .join('\n');

  return `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">${body}</feed>`;
}

const GITHUB_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/599547518/v1.2.3</id>
    <updated>2026-10-27T09:31:23Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/vllm-project/vllm/releases/tag/v1.2.3"/>
    <title>v1.2.3: KV cache offload benchmark</title>
    <content type="html">&lt;p&gt;Adds KV cache offload for long context serving&lt;/p&gt;</content>
    <author><name>grYe99</name></author>
  </entry>
</feed>`;

const RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>FlashInfer v0.7 发布</title>
    <link>https://flashinfer.ai/2026/09/22/flashinfer-v07.html</link>
    <description><![CDATA[<p>开放 kernel 与自动调优，覆盖 KV cache 场景</p>]]></description>
    <pubDate>Tue, 22 Sep 2026 01:00:00 +0000</pubDate>
    <dc:creator>FlashInfer Team</dc:creator>
  </item>
</channel></rss>`;

const URL_ARXIV_A = 'https://export.arxiv.org/api/query?search_query=speculative+decoding';
const URL_ARXIV_B = 'https://export.arxiv.org/api/query?search_query=kv+cache';
const URL_GH = 'https://github.com/vllm-project/vllm/releases.atom';
const URL_RSS = 'https://flashinfer.ai/feed.xml';
const URL_BROKEN = 'https://broken.example.com/feed.xml';

const SOURCES: Source[] = [
  makeSource({ id: 'arxiv-a', kind: 'arxiv', url: URL_ARXIV_A, weight: 2.4, tags: ['paper'] }),
  makeSource({ id: 'arxiv-b', kind: 'arxiv', url: URL_ARXIV_B, weight: 1.2, tags: ['paper'] }),
  makeSource({ id: 'gh-vllm', kind: 'atom', url: URL_GH, weight: 2.8, tags: ['release'] }),
  makeSource({ id: 'rss-flashinfer', kind: 'rss', url: URL_RSS, weight: 1, tags: ['blog'] }),
  makeSource({ id: 'broken-feed', kind: 'rss', url: URL_BROKEN, weight: 1 }),
];

const ROUTES: Record<string, FakeRoute> = {
  [URL_ARXIV_A]: {
    body: arxivFeed([
      {
        id: 'http://arxiv.org/abs/2401.00001v1',
        title: 'Fast Speculative Decoding with KV cache Reuse',
        summary: 'We combine speculative decoding with kv cache reuse to cut decode latency.',
        authors: ['Alice', 'Bob'],
      },
      {
        id: 'http://arxiv.org/abs/2401.00002v1',
        title: 'PD 分离调度器实测',
        summary: 'prefill decode disaggregation 在异构集群上的吞吐',
        authors: ['Chen'],
      },
    ]),
  },
  [URL_ARXIV_B]: {
    // 同一篇 2401.00001，但换了 URL 写法（没有版本号）→ 只能靠 externalId 合并
    body: arxivFeed([
      {
        id: 'http://arxiv.org/abs/2401.00001v2',
        url: 'https://arxiv.org/abs/2401.00001',
        title: 'Fast Speculative Decoding with KV cache Reuse (v2)',
        summary: 'extended version',
        authors: ['Alice'],
      },
    ]),
  },
  [URL_GH]: { body: GITHUB_ATOM },
  [URL_RSS]: { body: RSS_FEED },
  [URL_BROKEN]: { error: new Error('connect ECONNREFUSED') },
};

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'trend-radar-collect-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('fetchAllSources：解析质量与调度', () => {
  it('解析 arXiv/Atom/RSS 三类源，字段落到位', async () => {
    const { fetch } = fakeFetch(ROUTES);
    const result = await fetchAllSources(makeConfig(dataDir), {
      fetch,
      sources: SOURCES.filter((source) => source.enabled && source.id !== 'broken-feed'),
      hostPacingMs: {},
      attempts: 1,
      now: () => NOW,
    });

    expect(result.errors).toEqual([]);
    expect(result.sourceCount).toBe(4);
    // arxiv-a 2 条 + arxiv-b 1 条 + gh 1 条 + rss 1 条
    expect(result.fetched).toBe(5);

    const paper = result.items.find((item) => item.externalId === '2401.00001');
    expect(paper?.kind).toBe('paper');
    expect(paper?.authors).toEqual(['Alice', 'Bob']);
    expect(paper?.summary).toContain('speculative decoding');
    expect(paper?.publishedAt).toBe('2026-10-28T00:00:00.000Z');
    // arXiv 的 https alternate 链接优先，id 里的 http 不能进库
    expect(paper?.url.startsWith('https://arxiv.org/abs/')).toBe(true);

    const release = result.items.find((item) => item.sourceId === 'gh-vllm');
    expect(release?.kind).toBe('release');
    // GitHub 的 content 是转义 HTML，必须剥干净
    expect(release?.summary).toBe('Adds KV cache offload for long context serving');
    expect(release?.externalId).toBe('gh:vllm-project/vllm@v1.2.3');
    expect(release?.authors).toEqual(['grYe99']);

    const news = result.items.find((item) => item.sourceId === 'rss-flashinfer');
    expect(news?.kind).toBe('news');
    expect(news?.summary).toContain('开放 kernel 与自动调优');
    expect(news?.summary).not.toContain('<p>');
    expect(news?.publishedAt).toBe('2026-09-22T01:00:00.000Z');
  });

  it('单源失败只进 errors，其它源照常返回', async () => {
    const { fetch } = fakeFetch(ROUTES);
    const result = await fetchAllSources(makeConfig(dataDir), {
      fetch,
      sources: SOURCES,
      hostPacingMs: {},
      attempts: 1,
      now: () => NOW,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.sourceId).toBe('broken-feed');
    expect(result.errors[0]?.message).toContain('ECONNREFUSED');
    // 4 个可用源全部产出，采集没有被一个坏源带崩
    expect(result.sourceCount).toBe(5);
    expect(result.fetched).toBe(5);
  });

  it('HTTP 4xx/5xx 记为错误而不是抛异常', async () => {
    const { fetch } = fakeFetch({
      [URL_ARXIV_A]: { body: '', status: 503 },
      [URL_GH]: { body: GITHUB_ATOM },
    });
    const result = await fetchAllSources(makeConfig(dataDir), {
      fetch,
      sources: SOURCES.filter((source) => source.id === 'arxiv-a' || source.id === 'gh-vllm'),
      hostPacingMs: {},
      attempts: 1,
      now: () => NOW,
    });
    expect(result.errors[0]?.sourceId).toBe('arxiv-a');
    expect(result.errors[0]?.message).toContain('503');
    expect(result.items).toHaveLength(1);
  });

  it('单个源可重试：第一次 500、第二次成功', async () => {
    let attempt = 0;
    const fetchImpl: FetchLike = async () => {
      attempt += 1;
      if (attempt === 1) return new Response('busy', { status: 500 });
      return new Response(GITHUB_ATOM, { status: 200 });
    };

    const result = await fetchAllSources(makeConfig(dataDir), {
      fetch: fetchImpl,
      sources: [makeSource({ id: 'gh-vllm', kind: 'atom', url: URL_GH, tags: ['release'] })],
      hostPacingMs: {},
      attempts: 2,
      now: () => NOW,
    });

    expect(attempt).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.items).toHaveLength(1);
  });

  it('同一 URL 只发一次请求（arXiv 并发打同一 URL 会 500）', async () => {
    const { fetch, calls } = fakeFetch({ [URL_RSS]: RSS_FEED });
    const shared: Source[] = [
      makeSource({ id: 'rss-1', kind: 'rss', url: URL_RSS }),
      makeSource({ id: 'rss-2', kind: 'rss', url: URL_RSS }),
    ];

    const result = await fetchAllSources(makeConfig(dataDir), {
      fetch,
      sources: shared,
      hostPacingMs: {},
      attempts: 1,
      now: () => NOW,
    });

    expect(calls.filter((url) => url === URL_RSS)).toHaveLength(1);
    // 请求只发一次，但两个源各自解析出自己的条目（sourceId 不同 → 不是同一条）
    expect(result.items.map((item) => item.sourceId).sort()).toEqual(['rss-1', 'rss-2']);
  });

  it('limitPerSource 生效，且不影响别的源', async () => {
    const { fetch } = fakeFetch(ROUTES);
    const result = await fetchAllSources(makeConfig(dataDir, { limitPerSource: 1 }), {
      fetch,
      sources: SOURCES.filter((source) => source.id === 'arxiv-a' || source.id === 'gh-vllm'),
      hostPacingMs: {},
      attempts: 1,
      now: () => NOW,
    });
    expect(result.items.filter((item) => item.sourceId === 'arxiv-a')).toHaveLength(1);
    expect(result.items.filter((item) => item.sourceId === 'gh-vllm')).toHaveLength(1);
  });

  it('抓不含 entry 的合法 feed 不算错误，只是 0 条', async () => {
    const { fetch } = fakeFetch({ [URL_RSS]: '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>' });
    const result = await fetchAllSources(makeConfig(dataDir), {
      fetch,
      sources: [makeSource({ id: 'rss-flashinfer', kind: 'rss', url: URL_RSS })],
      hostPacingMs: {},
      attempts: 1,
      now: () => NOW,
    });
    expect(result.errors).toEqual([]);
    expect(result.items).toEqual([]);
  });

  it('禁用源不参与抓取', async () => {
    const { fetch, calls } = fakeFetch(ROUTES);
    const result = await fetchAllSources(makeConfig(dataDir), {
      fetch,
      sources: [makeSource({ id: 'gh-vllm', kind: 'atom', url: URL_GH, tags: ['release'], enabled: false })],
      hostPacingMs: {},
      attempts: 1,
      now: () => NOW,
    });
    expect(result.sourceCount).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('runCollect：端到端（假网络 + 真 SQLite）', () => {
  const collect = async (config: AppConfig, sources = SOURCES, extra = {}) => {
    const { fetch, calls } = fakeFetch(ROUTES);
    const run = await runCollect(config, {
      fetch,
      sources,
      hostPacingMs: {},
      attempts: 1,
      scoreOptions: { now: NOW },
      ...extra,
    });
    return { run, calls };
  };

  it('写库、去重、记录 RunRecord', async () => {
    const config = makeConfig(dataDir);
    const { run } = await collect(config);

    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.sourceCount).toBe(5);
    // 原始条数：2 (arxiv-a) + 1 (arxiv-b) + 1 (gh) + 1 (rss) = 5
    expect(run.fetched).toBe(5);
    // 2401.00001 在两个 arXiv 源里都出现 → 只入库一次
    expect(run.added).toBe(4);
    expect(run.errors.map((error) => error.sourceId)).toEqual(['broken-feed']);
    expect(Date.parse(run.finishedAt)).toBeGreaterThanOrEqual(Date.parse(run.startedAt));

    const db = openDb(dataDir);
    try {
      const page = listItems(db, { limit: 100 });
      expect(page.total).toBe(4);
      const paper = page.items.filter((item) => item.externalId === '2401.00001');
      expect(paper).toHaveLength(1);
      expect(paper[0]?.title).toContain('Speculative Decoding');

      // 打分产物完整，前端「为什么值得看」有东西可展示
      for (const item of page.items) {
        expect(Number.isInteger(item.score)).toBe(true);
        expect(item.score).toBeGreaterThanOrEqual(0);
        expect(item.score).toBeLessThanOrEqual(100);
        expect(item.scoreReasons.length).toBeGreaterThan(0);
        expect(Array.isArray(item.keywords)).toBe(true);
        expect(item.fetchedAt).toBe(NOW.toISOString());
      }

      // release 有工程验证信号，同源权重下分数应高于普通 news
      const release = page.items.find((item) => item.kind === 'release');
      const news = page.items.find((item) => item.kind === 'news');
      expect(release?.scoreReasons.some((reason) => reason.rule === 'signal')).toBe(true);
      expect(release?.score).toBeGreaterThan(news?.score ?? 0);

      // 运行记录也进了库
      expect(listRuns(db)).toHaveLength(1);
      expect(listRuns(db)[0]?.id).toBe(run.id);
    } finally {
      db.close();
    }
  });

  it('坏源不影响整轮：仍返回 RunRecord 且好源条目入库', async () => {
    const config = makeConfig(dataDir);
    const { run } = await collect(config);

    expect(run.added).toBeGreaterThan(0);
    const db = openDb(dataDir);
    try {
      expect(listItems(db).total).toBe(4);
      // 坏源没有任何条目
      expect(listItems(db, { sourceId: 'broken-feed' }).total).toBe(0);
    } finally {
      db.close();
    }
  });

  it('minKeepScore 过滤掉低分条目（不入库但仍计入 fetched）', async () => {
    const config = makeConfig(dataDir, { minKeepScore: 99 });
    const { run } = await collect(config, SOURCES, {
      // 空词表把关键词分掐掉，确保所有条目都低分
      scoreOptions: { now: NOW, keywords: [] },
    });

    expect(run.fetched).toBe(5);
    expect(run.added).toBe(0);
    const db = openDb(dataDir);
    try {
      expect(listItems(db).total).toBe(0);
    } finally {
      db.close();
    }
  });

  it('默认取数据库里 enabled 的源，且 sourceIds 可过滤', async () => {
    const config = makeConfig(dataDir);
    // 先让数据库里有内置源（openDb 首次打开时灌入）
    openDb(dataDir).close();

    const { fetch, calls } = fakeFetch({ [URL_GH]: GITHUB_ATOM });
    const run = await runCollect(config, {
      fetch,
      hostPacingMs: {},
      attempts: 1,
      sourceIds: ['github-vllm-releases'],
      scoreOptions: { now: NOW },
    });

    expect(calls).toEqual([URL_GH]);
    expect(run.sourceCount).toBe(1);
    expect(run.added).toBe(1);
    expect(run.errors).toEqual([]);
  });

  it('同一进程内并发触发复用同一次采集（API 幂等）', async () => {
    const config = makeConfig(dataDir);
    const { fetch, calls } = fakeFetch(ROUTES);
    const deps = {
      fetch,
      sources: SOURCES.filter((source) => source.id !== 'broken-feed'),
      hostPacingMs: {},
      attempts: 1,
      scoreOptions: { now: NOW },
    };

    const [first, second] = await Promise.all([runCollect(config, deps), runCollect(config, deps)]);
    expect(first.id).toBe(second.id);
    // 每个 URL 只被请求一次，说明第二轮没有真的跑
    expect(calls.filter((url) => url === URL_GH)).toHaveLength(1);

    // 上一轮结束后可以再跑一轮
    const third = await runCollect(config, deps);
    expect(third.id).not.toBe(first.id);
  });

  it('runCollectDetailed 每源耗时同时进 RunRecord（v2 契约）', async () => {
    const config = makeConfig(dataDir);
    const { fetch } = fakeFetch(ROUTES);
    const detailed = await runCollectDetailed(config, {
      fetch,
      sources: SOURCES,
      hostPacingMs: {},
      attempts: 1,
      scoreOptions: { now: NOW },
    });

    // v2 起 perSource 也属于 RunRecord（运行日志页要展示"哪个源慢"）；
    // 其余字段仍是原契约，多一个少一个都要让这里失败。
    expect(Object.keys(detailed.run).sort()).toEqual(
      ['added', 'errors', 'fetched', 'finishedAt', 'id', 'perSource', 'sourceCount', 'startedAt'].sort(),
    );
    expect(detailed.run.perSource).toEqual(detailed.perSource);

    expect(detailed.perSource).toHaveLength(SOURCES.length);
    expect(detailed.perSource.map((entry) => entry.sourceId)).toEqual(
      [...detailed.perSource.map((entry) => entry.sourceId)].sort(),
    );
    for (const entry of detailed.perSource) {
      expect(entry.ms).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(entry.items)).toBe(true);
    }
    const broken = detailed.perSource.find((entry) => entry.sourceId === 'broken-feed');
    expect(broken?.items).toBe(0);
    expect(broken?.error).toContain('ECONNREFUSED');
    expect(detailed.perSource.find((entry) => entry.sourceId === 'arxiv-a')?.items).toBe(2);
    expect(detailed.perSource.reduce((sum, entry) => sum + entry.items, 0)).toBe(detailed.run.fetched);
  });

  it('空源清单也能正常返回 RunRecord（不抛错）', async () => {
    const config = makeConfig(dataDir);
    const { run } = await collect(config, []);
    expect(run.sourceCount).toBe(0);
    expect(run.fetched).toBe(0);
    expect(run.added).toBe(0);
    expect(run.errors).toEqual([]);
  });
});

describe('probeSource：新增源探活', () => {
  it('能解析出条目时返回样本', async () => {
    const { fetch } = fakeFetch({ [URL_RSS]: RSS_FEED });
    const result = await probeSource(
      { id: 'probe', kind: 'rss', label: 'probe', url: URL_RSS },
      { fetch, hostPacingMs: {}, attempts: 1 },
    );
    expect(result.sampleCount).toBe(1);
    expect(result.sample[0]?.title).toContain('FlashInfer');
  });

  it('请求失败时抛可读错误（HTTP 层映射 422）', async () => {
    const { fetch } = fakeFetch({ [URL_BROKEN]: { error: new Error('ENOTFOUND') } });
    await expect(
      probeSource({ id: 'probe', kind: 'rss', label: 'probe', url: URL_BROKEN }, { fetch, hostPacingMs: {}, attempts: 1 }),
    ).rejects.toThrow(/源探活失败.*ENOTFOUND/);
  });

  it('200 但解析不出条目同样判失败', async () => {
    const { fetch } = fakeFetch({ [URL_RSS]: '<html><body>not a feed</body></html>' });
    await expect(
      probeSource({ id: 'probe', kind: 'rss', label: 'probe', url: URL_RSS }, { fetch, hostPacingMs: {}, attempts: 1 }),
    ).rejects.toThrow(/解析不出任何条目/);
  });
});
