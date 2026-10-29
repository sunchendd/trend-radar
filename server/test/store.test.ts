import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_SOURCES } from '../src/sources/defaults.js';
import { openDb } from '../src/store/db.js';
import {
  addNoveltyRecord,
  deleteSource,
  exportItems,
  getIdea,
  getItem,
  getItemsByIds,
  getSource,
  insertItems,
  insertRun,
  insertSource,
  listIdeas,
  listItems,
  listRuns,
  listSources,
  pruneItems,
  seedSources,
  stats,
  updateIdea,
  updateSource,
  upsertIdea,
} from '../src/store/queries.js';
import type { Idea, Item, RunRecord } from '../src/types.js';
import { itemId, normalizeUrl } from '../src/url.js';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function makeItem(over: Partial<Item> & { sourceId?: string; url?: string } = {}): Item {
  const sourceId = over.sourceId ?? 'src-a';
  const url = over.url ?? 'https://example.com/a';
  return {
    sourceId,
    url,
    id: over.id ?? itemId(sourceId, url),
    kind: over.kind ?? 'paper',
    title: over.title ?? 'title',
    summary: over.summary ?? '',
    authors: over.authors ?? [],
    publishedAt: over.publishedAt ?? NOW_ISO,
    fetchedAt: over.fetchedAt ?? NOW_ISO,
    score: over.score ?? 50,
    scoreReasons: over.scoreReasons ?? [],
    keywords: over.keywords ?? [],
    ...(over.externalId ? { externalId: over.externalId } : {}),
  };
}

function makeIdea(over: Partial<Idea> = {}): Idea {
  return {
    id: over.id ?? 'idea-1',
    createdAt: over.createdAt ?? NOW_ISO,
    updatedAt: over.updatedAt ?? NOW_ISO,
    title: over.title ?? '异构 GPU-NPU 的 KV cache 分级卸载方法',
    problem: over.problem ?? '显存不足',
    solution: over.solution ?? '按 token 热度分级',
    effect: over.effect ?? '显存下降 40%',
    keywords: over.keywords ?? ['kv cache', '昇腾'],
    ipcHints: over.ipcHints ?? ['G06F12/02'],
    queries: over.queries ?? ['KV缓存 卸载 异构'],
    risks: over.risks ?? ['华为已有相近布局'],
    status: over.status ?? 'draft',
    cites: over.cites ?? ['item-1'],
    focus: over.focus ?? 'kv cache offload',
    novelty: over.novelty ?? [],
  };
}

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: over.id ?? 'run-1',
    startedAt: over.startedAt ?? NOW_ISO,
    finishedAt: over.finishedAt ?? NOW_ISO,
    sourceCount: over.sourceCount ?? 7,
    added: over.added ?? 12,
    fetched: over.fetched ?? 40,
    errors: over.errors ?? [],
  };
}

let db: DatabaseSync;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('URL 归一化与去重键', () => {
  it('丢掉 utm_*、末尾斜杠、协议与端口差异、fragment', () => {
    expect(normalizeUrl('https://example.com/post/?utm_source=x&utm_medium=y')).toBe('https://example.com/post');
    expect(normalizeUrl('http://example.com/post')).toBe('https://example.com/post');
    expect(normalizeUrl('https://example.com/post/#section-2')).toBe('https://example.com/post');
    expect(normalizeUrl('https://example.com:443/post')).toBe('https://example.com/post');
  });

  it('host 小写但 path 保持大小写（GitHub 仓库名大小写有意义）', () => {
    expect(normalizeUrl('https://GitHub.com/NVIDIA/TensorRT-LLM')).toBe('https://github.com/NVIDIA/TensorRT-LLM');
  });

  it('查询参数顺序不同视为同一条', () => {
    expect(normalizeUrl('https://a.com/x?b=2&a=1')).toBe(normalizeUrl('https://a.com/x?a=1&b=2'));
  });

  it('非法 URL 不抛异常，退化为小写串', () => {
    expect(normalizeUrl('  Not A Url ')).toBe('not a url');
    expect(normalizeUrl('')).toBe('');
  });

  it('去重键是 16 位 hex，且随源变化', () => {
    const a = itemId('src-a', 'https://example.com/post/?utm_source=x');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(itemId('src-a', 'http://example.com/post'));
    expect(a).not.toBe(itemId('src-b', 'https://example.com/post'));
  });
});

describe('数据库初始化', () => {
  it('首次打开灌入内置源，且每个源都有可读备注', () => {
    const sources = listSources(db);
    expect(sources.length).toBeGreaterThanOrEqual(6);
    expect(sources.filter((source) => source.kind === 'arxiv').length).toBeGreaterThanOrEqual(3);
    expect(sources.filter((source) => source.url.includes('releases.atom')).length).toBeGreaterThanOrEqual(3);
    expect(sources.some((source) => source.kind === 'rss')).toBe(true);

    for (const source of sources) {
      expect(source.note.length, `${source.id} 缺少 note`).toBeGreaterThan(10);
      expect(source.url.startsWith('https://'), `${source.id} 必须用 https`).toBe(true);
      expect(source.weight).toBeGreaterThanOrEqual(0.1);
      expect(source.weight).toBeLessThanOrEqual(3);
      expect(source.enabled).toBe(true);
      expect(source.tags.length).toBeGreaterThan(0);
      expect(source.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('arXiv 源都走 https（http 会 301，并发查同一 URL 会 500）', () => {
    const arxiv = listSources(db).filter((source) => source.kind === 'arxiv');
    expect(arxiv.every((source) => source.url.startsWith('https://export.arxiv.org/api/query'))).toBe(true);
  });

  it('重复灌入内置源是幂等的', () => {
    const before = listSources(db).length;
    expect(seedSources(db, DEFAULT_SOURCES)).toBe(0);
    expect(listSources(db).length).toBe(before);
  });
});

describe('条目去重', () => {
  it('同源同 url 的 utm/末尾斜杠/http 变体只留一条', () => {
    const result = insertItems(db, [
      makeItem({ url: 'https://example.com/post/?utm_source=twitter' }),
      makeItem({ url: 'http://example.com/post' }),
      makeItem({ url: 'https://example.com/post/' }),
    ]);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(2);
    expect(listItems(db).total).toBe(1);
  });

  it('跨源同一篇 arXiv 论文按 externalId 合并，并保留更高分', () => {
    const result = insertItems(db, [
      makeItem({ sourceId: 'arxiv-a', url: 'https://arxiv.org/abs/2401.00001v1', externalId: '2401.00001', score: 40 }),
      makeItem({ sourceId: 'arxiv-b', url: 'https://arxiv.org/abs/2401.00001', externalId: '2401.00001', score: 72 }),
    ]);
    expect(result.added).toBe(1);
    expect(result.merged).toBe(1);
    expect(listItems(db).total).toBe(1);

    const stored = listItems(db).items[0];
    expect(stored?.score).toBe(72);
    // 归属仍是先入库的源：来源可追溯，但分数不被低权重源拖住
    expect(stored?.sourceId).toBe('arxiv-a');
    expect(stored?.externalId).toBe('2401.00001');
  });

  it('低分版本后到不会把已有高分覆盖掉', () => {
    insertItems(db, [
      makeItem({ sourceId: 'arxiv-a', url: 'https://arxiv.org/abs/2401.00002', externalId: '2401.00002', score: 80 }),
    ]);
    const second = insertItems(db, [
      makeItem({ sourceId: 'arxiv-b', url: 'https://arxiv.org/abs/2401.00002v2', externalId: '2401.00002', score: 30 }),
    ]);
    expect(second.added).toBe(0);
    expect(second.merged).toBe(0);
    expect(listItems(db).items[0]?.score).toBe(80);
  });

  it('没有 externalId 的不同条目不会被误合并', () => {
    const result = insertItems(db, [
      makeItem({ url: 'https://example.com/a' }),
      makeItem({ url: 'https://example.com/b' }),
    ]);
    expect(result.added).toBe(2);
    expect(listItems(db).total).toBe(2);
  });

  it('空数组不写库也不报错', () => {
    expect(insertItems(db, [])).toEqual({ added: 0, skipped: 0, merged: 0 });
  });
});

describe('条目查询', () => {
  beforeEach(() => {
    insertItems(db, [
      makeItem({
        url: 'https://example.com/1',
        title: 'Speculative Decoding for MoE Serving',
        summary: 'draft model + verification',
        kind: 'paper',
        score: 88,
        publishedAt: daysAgo(1),
        keywords: ['speculative decoding', 'moe'],
      }),
      makeItem({
        url: 'https://example.com/2',
        title: 'vLLM v0.9 发布',
        summary: 'KV cache offload 支持',
        kind: 'release',
        score: 76,
        publishedAt: daysAgo(3),
        keywords: ['kv cache offload'],
      }),
      makeItem({
        url: 'https://example.com/3',
        title: 'FlashInfer attention kernel',
        summary: 'benchmark results',
        kind: 'news',
        score: 52,
        publishedAt: daysAgo(10),
      }),
      makeItem({
        url: 'https://example.com/4',
        title: 'A gardening note',
        summary: 'nothing to do with inference',
        kind: 'news',
        score: 8,
        publishedAt: daysAgo(40),
      }),
      makeItem({
        url: 'https://example.com/5',
        title: 'PD 分离调度器实测',
        summary: 'prefill decode disaggregation',
        kind: 'paper',
        score: 64,
        publishedAt: daysAgo(120),
      }),
    ]);
  });

  it('默认按相关度倒序并返回 total/limit/offset', () => {
    const page = listItems(db);
    expect(page.total).toBe(5);
    expect(page.limit).toBe(30);
    expect(page.offset).toBe(0);
    expect(page.items.map((item) => item.score)).toEqual([88, 76, 64, 52, 8]);
  });

  it('按时间排序', () => {
    const page = listItems(db, { sort: 'time' });
    expect(page.items[0]?.score).toBe(88);
    expect(page.items.at(-1)?.score).toBe(64);
  });

  it('关键词搜索命中 title/summary/keywords，且大小写不敏感', () => {
    expect(listItems(db, { q: 'SPECULATIVE' }).total).toBe(1);
    expect(listItems(db, { q: 'kv cache' }).items[0]?.title).toBe('vLLM v0.9 发布');
    expect(listItems(db, { q: 'prefill decode' }).total).toBe(1);
    expect(listItems(db, { q: 'gardening' }).total).toBe(1);
  });

  it('LIKE 通配符被转义，搜 % 不会匹配全部', () => {
    expect(listItems(db, { q: '%' }).total).toBe(0);
    expect(listItems(db, { q: '_' }).total).toBe(0);
  });

  it('kind / minScore / since / sourceId 过滤', () => {
    expect(listItems(db, { kind: 'paper' }).total).toBe(2);
    expect(listItems(db, { kind: 'release' }).total).toBe(1);
    expect(listItems(db, { minScore: 60 }).total).toBe(3);
    expect(listItems(db, { since: daysAgo(7) }).total).toBe(2);
    expect(listItems(db, { sourceId: 'src-a' }).total).toBe(5);
    expect(listItems(db, { sourceId: 'src-x' }).total).toBe(0);
  });

  it('分页与 limit 上限', () => {
    expect(listItems(db, { limit: 2 }).items).toHaveLength(2);
    expect(listItems(db, { limit: 2, offset: 4 }).items).toHaveLength(1);
    expect(listItems(db, { limit: 2, offset: 4 }).total).toBe(5);
    expect(listItems(db, { limit: 9999 }).limit).toBe(200);
  });

  it('getItem / getItemsByIds / exportItems', () => {
    const all = listItems(db).items;
    const first = all[0];
    expect(first).toBeDefined();
    expect(getItem(db, first!.id)?.title).toBe(first!.title);
    expect(getItem(db, 'does-not-exist')).toBeUndefined();

    // getItemsByIds 保持调用方顺序，选题生成依赖这个语义来安排引用顺序
    const ids = [all[2]!.id, all[0]!.id];
    expect(getItemsByIds(db, ids).map((item) => item.id)).toEqual(ids);
    expect(getItemsByIds(db, [all[0]!.id, 'missing']).map((item) => item.id)).toEqual([all[0]!.id]);
    expect(getItemsByIds(db, [])).toEqual([]);

    // 导出不分页，但受 max 限制
    expect(exportItems(db, {})).toHaveLength(5);
    expect(exportItems(db, {}, 2)).toHaveLength(2);
    expect(exportItems(db, { minScore: 60 })).toHaveLength(3);
  });

  it('JSON 列（authors/keywords/scoreReasons）能原样读回', () => {
    insertItems(db, [
      makeItem({
        url: 'https://example.com/json',
        authors: ['Alice', 'Bob'],
        keywords: ['kv cache', '昇腾'],
        scoreReasons: [{ rule: 'keyword', delta: 9, detail: '命中关键词' }],
      }),
    ]);
    const target = listItems(db, { limit: 200 }).items.find((item) => item.url.includes('/json'));
    expect(target?.authors).toEqual(['Alice', 'Bob']);
    expect(target?.keywords).toEqual(['kv cache', '昇腾']);
    expect(target?.scoreReasons[0]?.rule).toBe('keyword');
  });
});

describe('过期清理', () => {
  it('按 ttlDays 删掉过老条目，保留新条目', () => {
    insertItems(db, [
      makeItem({ url: 'https://example.com/old', publishedAt: daysAgo(200) }),
      makeItem({ url: 'https://example.com/new', publishedAt: daysAgo(10) }),
    ]);
    expect(pruneItems(db, 180, NOW)).toBe(1);
    expect(listItems(db).items.map((item) => item.url)).toEqual(['https://example.com/new']);
  });

  it('ttlDays <= 0 表示不清理', () => {
    insertItems(db, [makeItem({ url: 'https://example.com/old', publishedAt: daysAgo(999) })]);
    expect(pruneItems(db, 0, NOW)).toBe(0);
  });
});

describe('源管理', () => {
  it('新增/改权重（夹到 0.1–3）/停用/删除', () => {
    const created = insertSource(db, {
      id: 'custom-feed',
      kind: 'rss',
      label: '自定义 RSS',
      url: 'https://example.com/feed.xml',
      tags: ['blog'],
    });
    expect(created.weight).toBe(1);
    expect(created.enabled).toBe(true);

    expect(updateSource(db, 'custom-feed', { weight: 99 })?.weight).toBe(3);
    expect(updateSource(db, 'custom-feed', { weight: 0 })?.weight).toBe(0.1);
    expect(updateSource(db, 'custom-feed', { enabled: false })?.enabled).toBe(false);
    expect(getSource(db, 'custom-feed')?.enabled).toBe(false);
    expect(updateSource(db, 'missing', { enabled: false })).toBeUndefined();

    expect(deleteSource(db, 'custom-feed')).toBe(true);
    expect(getSource(db, 'custom-feed')).toBeUndefined();
    expect(deleteSource(db, 'custom-feed')).toBe(false);
  });

  it('删除源后条目保留（孤儿条目仍可被查询）', () => {
    const sources = listSources(db);
    const target = sources[0]!;
    insertItems(db, [makeItem({ sourceId: target.id, url: 'https://example.com/keep' })]);
    deleteSource(db, target.id);

    const remaining = listItems(db).items;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.sourceId).toBe(target.id);
    expect(getSource(db, target.id)).toBeUndefined();
  });
});

describe('采集记录与统计', () => {
  it('RunRecord 进库后按结束时间倒序返回', () => {
    insertRun(db, makeRun({ id: 'run-old', finishedAt: daysAgo(2) }));
    insertRun(db, makeRun({ id: 'run-new', finishedAt: NOW_ISO, errors: [{ sourceId: 'x', message: 'boom' }] }));

    const runs = listRuns(db);
    expect(runs.map((run) => run.id)).toEqual(['run-new', 'run-old']);
    expect(runs[0]?.errors).toEqual([{ sourceId: 'x', message: 'boom' }]);
  });

  it('stats 汇总条目/源/最近采集', () => {
    const empty = stats(db, NOW);
    expect(empty.items).toBe(0);
    expect(empty.ideas).toBe(0);
    expect(empty.lastRunAt).toBeNull();
    expect(empty.sources).toBeGreaterThanOrEqual(6);
    expect(empty.enabledSources).toBe(empty.sources);

    insertItems(db, [
      makeItem({ url: 'https://example.com/1', score: 10, publishedAt: daysAgo(1) }),
      makeItem({ url: 'https://example.com/2', score: 30, publishedAt: daysAgo(2) }),
      makeItem({ url: 'https://example.com/3', score: 95, publishedAt: daysAgo(3) }),
    ]);
    upsertIdea(db, makeIdea({ id: 'idea-live' }));
    upsertIdea(db, makeIdea({ id: 'idea-gone', status: 'archived' }));
    insertRun(db, makeRun({ id: 'run-1', finishedAt: NOW_ISO }));

    const filled = stats(db, NOW);
    expect(filled.items).toBe(3);
    // archived 是软删，不计入有效选题
    expect(filled.ideas).toBe(1);
    expect(filled.lastRunAt).toBe(NOW_ISO);

    // 近 7 天补 0，固定 7 项，今天在最右
    expect(filled.dailyAdded).toHaveLength(7);
    expect(filled.dailyAdded.at(-1)).toEqual({ date: '2026-10-29', count: 3 });
    expect(filled.dailyAdded.reduce((sum, day) => sum + day.count, 0)).toBe(3);

    // 直方图 5 桶，求和等于条目数
    expect(filled.scoreHistogram.map((bucket) => bucket.bucket)).toEqual(['0-20', '20-40', '40-60', '60-80', '80-100']);
    expect(filled.scoreHistogram.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
    expect(filled.scoreHistogram.at(-1)?.count).toBe(1);

    const disabled = listSources(db)[0]!;
    updateSource(db, disabled.id, { enabled: false });
    expect(stats(db, NOW).enabledSources).toBe(filled.sources - 1);
  });
});

describe('选题读写（供 ideas 模块使用）', () => {
  it('upsert/get 保留数组字段与 novelty 记录', () => {
    upsertIdea(db, makeIdea({ id: 'idea-a' }));
    const loaded = getIdea(db, 'idea-a');
    expect(loaded?.keywords).toEqual(['kv cache', '昇腾']);
    expect(loaded?.queries).toEqual(['KV缓存 卸载 异构']);
    expect(loaded?.status).toBe('draft');

    addNoveltyRecord(db, 'idea-a', {
      at: NOW_ISO,
      query: 'KV缓存 卸载 异构',
      hits: 12,
      topAssignees: '华为技术有限公司:7',
      note: '',
      site: 'manual',
    });
    expect(getIdea(db, 'idea-a')?.novelty).toHaveLength(1);
    expect(getIdea(db, 'idea-a')?.novelty[0]?.hits).toBe(12);
    expect(getIdea(db, 'idea-a')?.novelty[0]?.site).toBe('manual');
  });

  it('updateIdea 只改传入字段并刷新 updatedAt', () => {
    upsertIdea(db, makeIdea({ id: 'idea-b', updatedAt: '2020-01-01T00:00:00.000Z' }));
    const updated = updateIdea(db, 'idea-b', { status: 'verified', title: '新标题' });
    expect(updated?.title).toBe('新标题');
    expect(updated?.status).toBe('verified');
    expect(updated?.problem).toBe('显存不足');
    expect(updated?.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(updateIdea(db, 'missing', { status: 'draft' })).toBeUndefined();
  });

  it('listIdeas 按 status 过滤且按 updatedAt 倒序', () => {
    upsertIdea(db, makeIdea({ id: 'i1', updatedAt: '2026-10-01T00:00:00.000Z', status: 'draft' }));
    upsertIdea(db, makeIdea({ id: 'i2', updatedAt: '2026-10-05T00:00:00.000Z', status: 'verified' }));
    expect(listIdeas(db).map((idea) => idea.id)).toEqual(['i2', 'i1']);
    expect(listIdeas(db, 'draft').map((idea) => idea.id)).toEqual(['i1']);
  });

  it('未知 status 落库时降级为 draft（防止 dirty data 打崩前端）', () => {
    upsertIdea(db, { ...makeIdea({ id: 'i3' }), status: 'opportunity' as Idea['status'] });
    expect(getIdea(db, 'i3')?.status).toBe('draft');
  });
});
