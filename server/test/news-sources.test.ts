import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { defaultSources, DEFAULT_SOURCES } from '../src/sources/defaults.js';
import { parseFeed } from '../src/sources/feed.js';
import { scoreItem } from '../src/score.js';
import { openDb } from '../src/store/db.js';
import { insertItems, listSources, mergeDefaultSources, updateSource } from '../src/store/queries.js';
import type { Item, Source } from '../src/types.js';
import { itemId } from '../src/url.js';

/** t18 时点的 7 个内置源（t19 之前的基线）——验证「现有源零改动」 */
const LEGACY_IDS = [
  'arxiv-speculative-decoding',
  'arxiv-kv-cache-inference',
  'arxiv-pd-disaggregation',
  'github-vllm-releases',
  'github-sglang-releases',
  'github-tensorrt-llm-releases',
  'blog-flashinfer',
] as const;

/** t19 基线形态（升级后必须逐字段一致） */
const LEGACY_SHAPE: Record<string, { kind: string; weight: number; tags: string[] }> = {
  'arxiv-speculative-decoding': { kind: 'arxiv', weight: 2.4, tags: ['paper', 'speculative-decoding'] },
  'arxiv-kv-cache-inference': { kind: 'arxiv', weight: 2.4, tags: ['paper', 'kv-cache'] },
  'arxiv-pd-disaggregation': { kind: 'arxiv', weight: 2.0, tags: ['paper', 'pd-disaggregation'] },
  'github-vllm-releases': { kind: 'atom', weight: 2.8, tags: ['release', 'engine', 'vllm'] },
  'github-sglang-releases': { kind: 'atom', weight: 2.6, tags: ['release', 'engine', 'sglang'] },
  'github-tensorrt-llm-releases': { kind: 'atom', weight: 2.4, tags: ['release', 'engine', 'tensorrt-llm'] },
  'blog-flashinfer': { kind: 'rss', weight: 1.8, tags: ['blog', 'kernel'] },
};

const NEWS_BY_TAG = (tag: string): Source[] =>
  DEFAULT_SOURCES.filter((s) => s.tags.includes('news') && s.tags.includes(tag) && s.enabled);

/** 制造一个「t19 之前的已装库」：当前 schema + 老源清单，把 user_version 拨回 v3，
 *  下次 openDb 会走 v3→v4 的种子合并迁移——正好模拟升级路径。 */
function makeLegacyDb(): DatabaseSync {
  const db = openDb(':memory:');
  const del = db.prepare('DELETE FROM sources WHERE id = ?');
  for (const s of DEFAULT_SOURCES.filter((x) => x.id.startsWith('rss-') && x.tags.includes('news'))) {
    del.run(s.id);
  }
  db.exec('PRAGMA user_version = 3');
  // 等价 openDb 在 v3 库上触发的 v4 迁移体：对老源清单跑一遍种子合并
  mergeDefaultSources(db, DEFAULT_SOURCES);
  return db;
}

function makeItem(over: Partial<Item> & { sourceId?: string; url?: string } = {}): Item {
  const sourceId = over.sourceId ?? 'rss-techcrunch';
  const url = over.url ?? 'https://techcrunch.com/2026/11/05/hello/';
  return {
    sourceId,
    url,
    id: over.id ?? itemId(sourceId, url),
    kind: over.kind ?? 'news',
    title: over.title ?? 'A news title',
    summary: over.summary ?? '',
    authors: over.authors ?? [],
    publishedAt: over.publishedAt ?? '2026-11-05T08:00:00.000Z',
    fetchedAt: over.fetchedAt ?? '2026-11-05T08:00:00.000Z',
    score: over.score ?? 50,
    scoreReasons: over.scoreReasons ?? [],
    keywords: over.keywords ?? [],
    ...(over.externalId ? { externalId: over.externalId } : {}),
  };
}

const byId = new Map(DEFAULT_SOURCES.map((s) => [s.id, s]));
const RSS_XML =
  '<rss version="2.0"><channel>' +
  '<item><title>t1</title><link>https://x.com/1</link><description>d</description></item>' +
  '</channel></rss>';

describe('daily-newsletter 源清单（defaults）', () => {
  it('新增 41 个 kind=rss 的新闻源，id 唯一（活跃口径；chat 合并后 6 条死源默认禁用、另行留档）', () => {
    const news = DEFAULT_SOURCES.filter((s) => s.tags.includes('news') && s.enabled);
    // 导入批次 41，chat 合并后 6 条死源默认禁用：活跃口径 41 - 6 = 35
    expect(news.length).toBe(35);
    expect(new Set(news.map((s) => s.id)).size).toBe(35);
    for (const s of news) {
      expect(s.kind).toBe('rss');
      expect(s.tags[0]).toBe('news');
      expect(s.tags.length).toBe(2);
      expect(s.note).toContain('来源 daily-newsletter');
      expect(s.url.startsWith('https://')).toBe(true);
      expect(s.enabled).toBe(true);
      // weight 口径：新闻源压在 1.0–1.4，全部低于工程源（flashinfer 1.8、releases 2.4–2.8）
      expect(s.weight).toBeGreaterThanOrEqual(1.0);
      expect(s.weight).toBeLessThanOrEqual(1.4);
    }
  });

  it('分类数量：导入批次 14/8/8/4/3/4，死源禁用后活跃口径 11/8/6/4/2/4', () => {
    expect(NEWS_BY_TAG('china-tech').length).toBe(11);
    expect(NEWS_BY_TAG('tech').length).toBe(8);
    expect(NEWS_BY_TAG('crypto').length).toBe(6);
    expect(NEWS_BY_TAG('gaming').length).toBe(4);
    expect(NEWS_BY_TAG('ai').length).toBe(2);
    expect(NEWS_BY_TAG('dev').length).toBe(4);
    // 导入批次口径（含死源留档）：14/8/8/4/3/4
    const ALL_BY_TAG = (tag: string): Source[] =>
      DEFAULT_SOURCES.filter((s) => s.tags.includes('news') && s.tags.includes(tag));
    expect(ALL_BY_TAG('china-tech').length).toBe(14);
    expect(ALL_BY_TAG('crypto').length).toBe(8);
  });

  it('死源留档：6 条默认禁用但保留 id/url/label 供溯源（chat 合并引入的契约）', () => {
    const DEAD_IDS = ['rss-anthropic-blog', 'rss-huxiu', 'rss-okx-learn-en', 'rss-okx-learn-zh', 'rss-cyzone', 'rss-aigc-cn'];
    for (const id of DEAD_IDS) {
      const s = DEFAULT_SOURCES.find((x) => x.id === id);
      expect(s, `缺死源 ${id}`).toBeDefined();
      expect(s?.enabled).toBe(false);
      expect(s?.note).toContain('默认禁用（实测）');
      expect(s?.url.startsWith('https://')).toBe(true);
    }
  });

  it('关键源逐条对齐用户清单（URL 原样保留）', () => {
    expect(byId.get('rss-36kr')?.url).toBe('https://36kr.com/feed');
    expect(byId.get('rss-ithome')?.url).toBe('https://www.ithome.com/rss/');
    expect(byId.get('rss-qbitai')?.url).toBe('https://www.qbitai.com/feed/');
    expect(byId.get('rss-techcrunch')?.url).toBe('https://techcrunch.com/feed/');
    expect(byId.get('rss-theverge')?.url).toBe('https://www.theverge.com/rss/index.xml');
    expect(byId.get('rss-coindesk')?.url).toBe('https://www.coindesk.com/arc/outboundfeeds/rss/');
    expect(byId.get('rss-cointelegraph')?.url).toBe('https://cointelegraph.com/rss');
    expect(byId.get('rss-gamesindustry')?.url).toBe('https://www.gamesindustry.biz/feed/');
    // t23：ign.com/rss|feeds 404，换成 IGN 官方联合 feed（实测 200）
    expect(byId.get('rss-ign')?.url).toBe('https://feeds.ign.com/ign/all');
    expect(byId.get('rss-ign')?.note).toContain('t23');
    expect(byId.get('rss-openai-blog')?.url).toBe('https://openai.com/blog/rss.xml');
    expect(byId.get('rss-anthropic-blog')?.url).toBe('https://www.anthropic.com/blog/rss.xml');
    expect(byId.get('rss-deepmind-blog')?.url).toBe('https://deepmind.google/blog/rss.xml');
    expect(byId.get('rss-github-blog')?.url).toBe('https://github.com/blog.atom');
    expect(byId.get('rss-stackoverflow-blog')?.url).toBe('https://stackoverflow.blog/feed/');
    expect(byId.get('rss-dev-to')?.url).toBe('https://dev.to/feed');
    expect(byId.get('rss-hackernoon')?.url).toBe('https://hackernoon.com/feed');
  });

  it('t18 之前的 7 个内置源零改动（kind/url/weight/tags 与基线逐字段一致）', () => {
    expect(byId.size).toBe(48);
    expect(defaultSources().filter((s) => (LEGACY_IDS as readonly string[]).includes(s.id)).length).toBe(7);
    for (const [id, want] of Object.entries(LEGACY_SHAPE)) {
      const s = byId.get(id);
      expect(s, id).toBeDefined();
      expect(s?.kind).toBe(want.kind);
      expect(s?.weight).toBe(want.weight);
      expect(s?.tags).toEqual(want.tags);
    }
  });

  it('新闻源 weight 全部低于工程源（背景面不抢工程信号排位）', () => {
    const maxNews = Math.max(...DEFAULT_SOURCES.filter((s) => s.tags.includes('news')).map((s) => s.weight));
    const minEngineering = Math.min(...DEFAULT_SOURCES.filter((s) => !s.tags.includes('news')).map((s) => s.weight));
    expect(maxNews).toBeLessThan(minEngineering);
  });
});

describe('种子合并迁移（v3→v4，顺序迁移可叠加）', () => {
  it('已装库升级：v4 把缺失的默认源幂等补入，老 7 个原样保留', () => {
    const db = makeLegacyDb();
    const after = listSources(db);
    expect(after.length).toBe(48);
    expect(after.filter((s) => s.tags.includes('news')).length).toBe(41);
    for (const id of LEGACY_IDS) expect(after.some((s) => s.id === id)).toBe(true);
    db.close();
  });

  it('重复启动/重复合并不产生重复（INSERT OR IGNORE 幂等）', () => {
    const db = makeLegacyDb();
    const before = listSources(db).map((s) => s.id).sort().join(',');
    expect(before.split(',').length).toBe(48);
    expect(mergeDefaultSources(db, DEFAULT_SOURCES)).toBe(0);
    expect(listSources(db).map((s) => s.id).sort().join(',')).toBe(before);
    db.close();
  });

  it('用户改过的行不被合并覆盖（disabled/weight 保留）', () => {
    const db = makeLegacyDb();
    updateSource(db, 'rss-36kr', { enabled: false, weight: 0.5 });
    expect(mergeDefaultSources(db, DEFAULT_SOURCES)).toBe(0);
    const s = listSources(db).find((x) => x.id === 'rss-36kr');
    expect(s?.enabled).toBe(false);
    expect(s?.weight).toBe(0.5);
    db.close();
  });
});

describe('新闻源采集与去重回归', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('kind 解析：release tag 的源 → release；news tag 的源 → news', () => {
    const releaseSource = byId.get('github-vllm-releases') as Source;
    const newsSource = byId.get('rss-36kr') as Source;
    expect(parseFeed(RSS_XML, releaseSource)[0]?.kind).toBe('release');
    expect(parseFeed(RSS_XML, newsSource)[0]?.kind).toBe('news');
  });

  it('同源同 url 变体只留一条（新源 URL 归一化去重回归）', () => {
    const first = insertItems(db, [
      makeItem({ url: 'https://techcrunch.com/2026/11/05/hello/?utm_source=rss' }),
      makeItem({ url: 'http://techcrunch.com/2026/11/05/hello' }),
    ]);
    expect(first.added).toBe(1);
    const again = insertItems(db, [makeItem({ url: 'https://techcrunch.com/2026/11/05/hello/#top' })]);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(1);
  });

  it('跨源同 url 不互相吞（source_id 进唯一键）', () => {
    expect(insertItems(db, [makeItem({ sourceId: 'rss-techcrunch', url: 'https://x.com/same' })]).added).toBe(1);
    expect(insertItems(db, [makeItem({ sourceId: 'rss-theverge', url: 'https://x.com/same' })]).added).toBe(1);
  });
});

describe('打分回归：新闻源 weight 不改变既有刻度', () => {
  it('相同内容下，release 源（2.8）的条目分数高于 news 源（1.2）', () => {
    const base = {
      title: 'vLLM v1.0 adds speculative decoding support',
      summary: 'engine release notes',
      kind: 'news' as const,
      publishedAt: '2026-11-05T08:00:00.000Z',
    };
    const release = scoreItem({ ...base, kind: 'release', sourceWeight: 2.8, sourceLabel: 'vLLM Releases' });
    const news = scoreItem({ ...base, sourceWeight: 1.2, sourceLabel: 'TechCrunch' });
    expect(release.score).toBeGreaterThan(news.score);
    // 源权重贡献公式未变：weight 1.2 → +1（(1.2-1)*7≈1.4 取整），weight 2.8 → +12（clamp 上限）
    const deltas = (r: { reasons: { delta: number }[] }) => r.reasons.map((x) => x.delta);
    expect(deltas(news)).toContain(1);
    expect(deltas(release)).toContain(12);
  });

  it('新闻条目打分仍是 0–100 整数，理由可读', () => {
    const r = scoreItem({
      sourceId: 'rss-36kr',
      sourceWeight: 1.3,
      sourceLabel: '36氪',
      kind: 'news',
      title: '完全无关的咖啡新闻 coffee news',
      summary: '',
      publishedAt: '2026-11-05T08:00:00.000Z',
    });
    expect(Number.isInteger(r.score)).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.reasons.every((x) => Number.isInteger(x.delta))).toBe(true);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});
