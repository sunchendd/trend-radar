/**
 * 情报流的筛选状态与取数。
 *
 * 为什么要「按源并发合并」：契约里 /api/items 的 sourceId 是单值，
 * 而产品要求信源**多选**。所以多选时按源并发拉取（每源取 offset+limit 条，
 * 足够覆盖并集的第 offset..offset+limit 段），再在本地合并去重排序——
 * 这样 total 仍是各源 total 之和，分页语义不会失真。
 */
import { listItems } from './api';
import type { Item, ItemKind, ItemQuery, Paged } from './types';

export type TimeRange = '24h' | '7d' | '30d' | 'all';
export type SortKey = 'score' | 'time';

export interface FeedFilters {
  q: string;
  sourceIds: string[];
  /** 单值：与 API 契约一致（paper/news/release），null = 全部 */
  kind: ItemKind | null;
  minScore: number;
  range: TimeRange;
  sort: SortKey;
}

export const DEFAULT_FILTERS: FeedFilters = {
  q: '',
  sourceIds: [],
  kind: null,
  minScore: 0,
  range: 'all',
  sort: 'score',
};

export const RANGE_LABEL: Record<TimeRange, string> = {
  '24h': '24 小时',
  '7d': '7 天',
  '30d': '30 天',
  all: '不限',
};

export function activeFilterCount(f: FeedFilters): number {
  let n = 0;
  if (f.q.trim()) n += 1;
  if (f.sourceIds.length > 0) n += 1;
  if (f.kind) n += 1;
  if (f.minScore > 0) n += 1;
  if (f.range !== 'all') n += 1;
  if (f.sort !== 'score') n += 1;
  return n;
}

export function rangeToSince(range: TimeRange): string | undefined {
  if (range === 'all') return undefined;
  const days = range === '24h' ? 1 : range === '7d' ? 7 : 30;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function toItemQuery(f: FeedFilters, limit: number, offset: number): ItemQuery {
  const q: ItemQuery = {
    limit,
    offset,
    sort: f.sort,
    minScore: f.minScore > 0 ? f.minScore : undefined,
  };
  const needle = f.q.trim();
  if (needle) q.q = needle;
  if (f.kind) q.kind = f.kind;
  if (f.sourceIds.length === 1 && f.sourceIds[0]) q.sourceId = f.sourceIds[0];
  const since = rangeToSince(f.range);
  if (since) q.since = since;
  return q;
}

function comparator(sort: SortKey): (a: Item, b: Item) => number {
  if (sort === 'time') {
    return (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  }
  return (a, b) => b.score - a.score || Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
}

export interface FeedPage extends Paged<Item> {
  /** 是否走了「多源并发合并」路径 */
  merged: boolean;
}

export async function fetchFeed(f: FeedFilters, limit: number, offset: number): Promise<FeedPage> {
  const single = f.sourceIds.length <= 1;
  if (single) {
    const res = await listItems(toItemQuery(f, limit, offset));
    return { ...res, merged: false };
  }

  const need = offset + limit;
  const results = await Promise.all(
    f.sourceIds.map((sid) => listItems({ ...toItemQuery(f, need, 0), sourceId: sid })),
  );

  const seen = new Set<string>();
  const merged: Item[] = [];
  for (const r of results) {
    for (const it of r.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      merged.push(it);
    }
  }
  merged.sort(comparator(f.sort));
  const total = results.reduce((s, r) => s + r.total, 0);
  return {
    items: merged.slice(offset, offset + limit),
    total,
    limit,
    offset,
    merged: true,
  };
}
