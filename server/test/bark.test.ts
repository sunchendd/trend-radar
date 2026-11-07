import { describe, expect, it } from 'vitest';

import {
  BARK_TITLE,
  barkUrl,
  buildDailyDigest,
  pushBark,
  pushDailyDigest,
  type DigestSource,
} from '../src/push/bark.js';
import type { AppSettings, Idea, Item, Paged } from '../src/types.js';

/**
 * Bark 推送模块测试（假 fetch，全程离线）。
 * 重点：可选能力的静默契约（未配置/关闭 → 不发请求不报错）、URL 编码、
 * 日报正文形状、失败语义（非 2xx 抛错，由调用方记日志）。
 */

const makeSettings = (bark: { url: string; enabled: boolean }): AppSettings => ({
  dailyRefreshAt: '08:00',
  dailyRefreshEnabled: false,
  collectMinutes: 0,
  limitPerSource: 40,
  minKeepScore: 0,
  ttlDays: 180,
  highScore: 80,
  midScore: 60,
  llm: { baseUrl: '', model: 'm', hasApiKey: false },
  novelty: { command: '', hasCommand: false },
  translation: { enabled: true, dailyLimit: 100 },
  bark,
  updatedAt: null,
  nextRefreshAt: null,
  refreshMode: 'off',
});

describe('barkUrl / pushBark', () => {
  it('base 末尾斜杠剥离，标题/正文 URL 编码', () => {
    const url = barkUrl('https://api.day.app/key/', '情报雷达日报', '第1行\n第2行');
    expect(url).toBe(`https://api.day.app/key/${encodeURIComponent('情报雷达日报')}/${encodeURIComponent('第1行\n第2行')}`);
  });

  it('base 带 Bark 参数（?group=…）时路径段插在 ? 之前，参数原样保留', () => {
    const url = barkUrl('https://api.day.app/key?group=example&ttl=600', 'T', 'B');
    expect(url).toBe(`https://api.day.app/key/${encodeURIComponent('T')}/${encodeURIComponent('B')}?group=example&ttl=600`);
  });

  it('2xx 成功；非 2xx 抛错（错误信息带状态码）；超时由 AbortSignal 控制', async () => {
    const seen: { url: string; signal: AbortSignal | undefined }[] = [];
    const ok = await pushBark(async (input, init) => {
      seen.push({ url: String(input), signal: init?.signal });
      return new Response('{"code":200}', { status: 200 });
    }, 'https://api.day.app/key', 'T', 'B');
    expect(ok).toBeUndefined();
    expect(seen[0]?.url).toContain('/T/B');
    expect(seen[0]?.signal).toBeDefined();

    const failing = pushBark(async () => new Response('no', { status: 403 }), 'https://api.day.app/key', 'T', 'B');
    await expect(failing).rejects.toThrow('403');

    const network = pushBark(
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
      'https://api.day.app/key',
      'T',
      'B',
    );
    await expect(network).rejects.toThrow('ECONNREFUSED');
  });
});

describe('buildDailyDigest', () => {
  it('Top5 带分数与短标题；无命中时明确说明；末行是新选题数', () => {
    const body = buildDailyDigest(
      [
        { score: 92, title: ' speculation: a very long title that should be truncated gracefully'.repeat(2) },
        { score: 74, title: 'KV cache 卸载' },
      ],
      3,
    );
    const lines = body.split('\n');
    expect(lines[0]).toBe('近24h 高分情报 Top5：');
    expect(lines[1]).toMatch(/^1\. \[92\] .{1,40}$/);
    expect(lines[2]).toBe('2. [74] KV cache 卸载');
    expect(lines.at(-1)).toBe('新增选题：3 条');
    expect(body).not.toContain('undefined');

    const empty = buildDailyDigest([], 0);
    expect(empty.split('\n')[0]).toContain('没有新高分情报');
    expect(empty).toContain('新增选题：0 条');
    void BARK_TITLE;
  });
});

describe('pushDailyDigest', () => {
  const ITEMS: Item[] = [
    { id: 'i1', sourceId: 's', kind: 'paper', title: '高分论文', url: 'u', summary: '', authors: [], publishedAt: '', fetchedAt: '', score: 95, scoreReasons: [], keywords: [] },
  ];
  const IDEAS: Idea[] = [
    { id: 'idea-1', createdAt: new Date().toISOString(), updatedAt: '', title: '新选题', problem: '', solution: '', effect: '', keywords: [], ipcHints: [], queries: [], risks: [], status: 'draft', cites: [], focus: '', novelty: [] },
    { id: 'idea-2', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '', title: '旧选题', problem: '', solution: '', effect: '', keywords: [], ipcHints: [], queries: [], risks: [], status: 'draft', cites: [], focus: '', novelty: [] },
  ];

  const makeSource = (bark: { url: string; enabled: boolean }, calls: { listItems?: unknown[] }): DigestSource => ({
    listItems: (query) => {
      calls.listItems?.push(query);
      return { items: ITEMS, total: 1, limit: 5, offset: 0 } as Paged<Item>;
    },
    listIdeas: () => IDEAS,
    getSettings: () => makeSettings(bark),
  });

  it('未配置/关闭 → 静默返回 false，一次请求都不发', async () => {
    let fetched = 0;
    const off = await pushDailyDigest(makeSource({ url: 'https://api.day.app/k', enabled: false }, {}), async () => {
      fetched += 1;
      return new Response('{}', { status: 200 });
    });
    expect(off).toBe(false);
    const noUrl = await pushDailyDigest(makeSource({ url: '', enabled: true }, {}), async () => {
      fetched += 1;
      return new Response('{}', { status: 200 });
    });
    expect(noUrl).toBe(false);
    expect(fetched).toBe(0);
  });

  it('已配置 → 推送日报；listItems 带 24h since + sort=score；新选题只数近 24h', async () => {
    const calls: { listItems: unknown[] } = { listItems: [] };
    const pushed: string[] = [];
    const pushedOk = await pushDailyDigest(makeSource({ url: 'https://api.day.app/k', enabled: true }, calls), async (input) => {
      pushed.push(String(input));
      return new Response('{}', { status: 200 });
    });
    expect(pushedOk).toBe(true);
    expect(pushed).toHaveLength(1);
    expect(decodeURIComponent(pushed[0] ?? '')).toContain('情报雷达日报');
    expect(decodeURIComponent(pushed[0] ?? '')).toContain('新增选题：1 条');
    expect(decodeURIComponent(pushed[0] ?? '')).toContain('[95] 高分论文');

    const query = calls.listItems[0] as { since?: string; sort?: string; limit?: number };
    const since = Date.parse(query.since ?? '');
    expect(Number.isFinite(since)).toBe(true);
    expect(Date.now() - since).toBeGreaterThan(23.9 * 3_600_000);
    expect(Date.now() - since).toBeLessThan(24.1 * 3_600_000);
    expect(query.sort).toBe('score');
    expect(query.limit).toBe(5);
  });

  it('推送失败（非 2xx / 网络错误）→ 抛错给调用方记日志，不影响采集', async () => {
    const failing = pushDailyDigest(makeSource({ url: 'https://api.day.app/k', enabled: true }, {}), async () => new Response('x', { status: 500 }));
    await expect(failing).rejects.toThrow('500');
  });
});
