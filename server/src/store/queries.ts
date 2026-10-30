import type { DatabaseSync } from 'node:sqlite';

import type {
  Idea,
  IdeaStatus,
  Item,
  ItemKind,
  ItemQuery,
  NoveltyRecord,
  Paged,
  RunPerSource,
  RunRecord,
  ScoreReason,
  Source,
  SourceError,
  SourceKind,
  Stats,
} from '../types.js';
import { normalizeUrl } from '../url.js';

/**
 * 所有 SQL 读写集中在这一个文件。
 *
 * 为什么不让上层模块自己写 SQL：SQLite 没有类型系统，
 * 列名/JSON 列的解析规则一旦分散，就会出现「同一个字段三个模块三种读法」。
 * 这里统一做 row → 领域对象映射，上层只碰 types.ts 里的类型。
 */

type Row = Record<string, unknown>;

// ---------------------------------------------------------------- row 映射

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : value === null || value === undefined ? fallback : String(value);

const num = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** JSON 列解析失败时退化为空数组：坏数据不该让整页查询 500 */
function jsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function mapItem(row: Row): Item {
  const item: Item = {
    id: str(row['id']),
    sourceId: str(row['source_id']),
    kind: str(row['kind'], 'news') as ItemKind,
    title: str(row['title']),
    url: str(row['url']),
    summary: str(row['summary']),
    authors: jsonArray<string>(row['authors']),
    publishedAt: str(row['published_at']),
    fetchedAt: str(row['fetched_at']),
    score: num(row['score']),
    scoreReasons: jsonArray<ScoreReason>(row['score_reasons']),
    keywords: jsonArray<string>(row['keywords']),
  };
  const externalId = row['external_id'];
  if (typeof externalId === 'string' && externalId !== '') item.externalId = externalId;
  return item;
}

function mapSource(row: Row): Source {
  return {
    id: str(row['id']),
    kind: str(row['kind'], 'rss') as SourceKind,
    label: str(row['label']),
    url: str(row['url']),
    weight: num(row['weight'], 1),
    enabled: num(row['enabled'], 1) === 1,
    tags: jsonArray<string>(row['tags']),
    note: str(row['note']),
    createdAt: str(row['created_at']),
  };
}

function mapRun(row: Row): RunRecord {
  return {
    id: str(row['id']),
    startedAt: str(row['started_at']),
    finishedAt: str(row['finished_at']),
    sourceCount: num(row['source_count']),
    added: num(row['added']),
    fetched: num(row['fetched']),
    errors: jsonArray<SourceError>(row['errors']),
    // 老运行记录没有这一列：保持 undefined（而不是 [])，UI 才能区分"没记录"和"真的零耗时"
    ...(typeof row['per_source'] === 'string' ? { perSource: jsonArray<RunPerSource>(row['per_source']) } : {}),
  };
}

function mapIdea(row: Row): Idea {
  const status = str(row['status'], 'draft');
  const known: IdeaStatus[] = ['draft', 'verified', 'red-ocean', 'archived'];
  return {
    id: str(row['id']),
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
    title: str(row['title']),
    problem: str(row['problem']),
    solution: str(row['solution']),
    effect: str(row['effect']),
    keywords: jsonArray<string>(row['keywords']),
    ipcHints: jsonArray<string>(row['ipc_hints']),
    queries: jsonArray<string>(row['queries']),
    risks: jsonArray<string>(row['risks']),
    status: (known as string[]).includes(status) ? (status as IdeaStatus) : 'draft',
    cites: jsonArray<string>(row['cites']),
    focus: str(row['focus']),
    novelty: jsonArray<NoveltyRecord>(row['novelty']),
  };
}

// ---------------------------------------------------------------- 事务

/** node:sqlite 没有 better-sqlite3 的 transaction() 包装，这里补一个最小实现（不可嵌套） */
function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚失败说明事务已经不在了，保留原始错误更有价值
    }
    throw error;
  }
}

// ---------------------------------------------------------------- sources

export function listSources(db: DatabaseSync): Source[] {
  return db.prepare('SELECT * FROM sources ORDER BY weight DESC, id ASC').all().map(mapSource);
}

export function getSource(db: DatabaseSync, id: string): Source | undefined {
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  return row ? mapSource(row) : undefined;
}

/** 只取 enabled 的源；采集调度用这个，避免每轮都自己过滤一遍 */
export function listEnabledSources(db: DatabaseSync): Source[] {
  return db.prepare('SELECT * FROM sources WHERE enabled = 1 ORDER BY weight DESC, id ASC').all().map(mapSource);
}

/**
 * 灌入内置源，只在 sources 表为空时生效。
 * 为什么不让调用方判断：db.ts 初始化与 `POST /api/collect` 都可能先跑，
 * 把幂等判断收在这里，任何入口都不会重复插入。
 */
export function seedSources(db: DatabaseSync, sources: Source[]): number {
  const count = num(db.prepare('SELECT COUNT(*) AS c FROM sources').get()?.['c']);
  if (count > 0) return 0;

  return tx(db, () => {
    const statement = db.prepare(
      `INSERT OR IGNORE INTO sources (id, kind, label, url, weight, enabled, tags, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const source of sources) {
      const result = statement.run(
        source.id,
        source.kind,
        source.label,
        source.url,
        source.weight,
        source.enabled ? 1 : 0,
        JSON.stringify(source.tags),
        source.note,
        source.createdAt,
      );
      inserted += Number(result.changes);
    }
    return inserted;
  });
}

export type NewSourceInput = Pick<Source, 'id' | 'kind' | 'label' | 'url'> &
  Partial<Pick<Source, 'weight' | 'tags' | 'note' | 'enabled'>>;

const clampWeight = (weight: number): number => Math.min(3, Math.max(0.1, weight));

export function insertSource(db: DatabaseSync, input: NewSourceInput): Source {
  const source: Source = {
    id: input.id,
    kind: input.kind,
    label: input.label,
    url: input.url,
    weight: clampWeight(input.weight ?? 1),
    enabled: input.enabled ?? true,
    tags: input.tags ?? [],
    note: input.note ?? '',
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO sources (id, kind, label, url, weight, enabled, tags, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    source.id,
    source.kind,
    source.label,
    source.url,
    source.weight,
    source.enabled ? 1 : 0,
    JSON.stringify(source.tags),
    source.note,
    source.createdAt,
  );
  return source;
}

/** 名字带 upsert 是因为 API 的 PATCH 与「新增内置源」两条路径都会调用 */
export function updateSource(
  db: DatabaseSync,
  id: string,
  patch: { enabled?: boolean; weight?: number; note?: string; label?: string; url?: string },
): Source | undefined {
  const current = getSource(db, id);
  if (!current) return undefined;

  const next: Source = {
    ...current,
    enabled: patch.enabled ?? current.enabled,
    weight: patch.weight === undefined ? current.weight : clampWeight(patch.weight),
    note: patch.note ?? current.note,
    label: patch.label ?? current.label,
    url: patch.url ?? current.url,
  };

  db.prepare('UPDATE sources SET enabled = ?, weight = ?, note = ?, label = ?, url = ? WHERE id = ?').run(
    next.enabled ? 1 : 0,
    next.weight,
    next.note,
    next.label,
    next.url,
    id,
  );
  return next;
}

/** 删除源但**保留条目**（契约要求）：条目保留 sourceId，前端按 source 缺失标 orphan */
export function deleteSource(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM sources WHERE id = ?').run(id).changes) > 0;
}

// ---------------------------------------------------------------- items

export interface InsertResult {
  /** 真正新入库的条数 */
  added: number;
  /** 命中去重（同源同 url 或同 externalId）被丢弃的条数 */
  skipped: number;
  /** 命中去重但新分数更高、回写了分数与关键词的条数 */
  merged: number;
}

/**
 * 批量入库，内部完成两道去重：
 * 1. 主键 id（= sha1(sourceId + 归一化 url)）+ (source_id, url_key) 唯一索引 → 同源同条只留一条；
 * 2. external_id（arXiv id / DOI / GitHub release tag）→ 跨源同一篇论文只留一条，
 *    但分数取两者较高者：同一篇论文被高权重源收录时不该因为「先入库的源权重低」被压下去。
 */
export function insertItems(db: DatabaseSync, items: Item[]): InsertResult {
  if (items.length === 0) return { added: 0, skipped: 0, merged: 0 };

  const findById = db.prepare('SELECT id FROM items WHERE id = ?');
  const findByExternal = db.prepare('SELECT id, score FROM items WHERE external_id = ? ORDER BY score DESC LIMIT 1');
  const bumpScore = db.prepare('UPDATE items SET score = ?, score_reasons = ?, keywords = ? WHERE id = ?');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO items
      (id, source_id, kind, title, url, url_key, summary, authors, published_at, fetched_at,
       score, score_reasons, keywords, external_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return tx(db, () => {
    let added = 0;
    let skipped = 0;
    let merged = 0;

    for (const item of items) {
      if (findById.get(item.id)) {
        skipped += 1;
        continue;
      }

      if (item.externalId) {
        const existing = findByExternal.get(item.externalId);
        if (existing) {
          const existingId = str(existing['id']);
          if (item.score > num(existing['score']) && existingId !== '') {
            bumpScore.run(item.score, JSON.stringify(item.scoreReasons), JSON.stringify(item.keywords), existingId);
            merged += 1;
          } else {
            skipped += 1;
          }
          continue;
        }
      }

      const result = insert.run(
        item.id,
        item.sourceId,
        item.kind,
        item.title,
        item.url,
        normalizeUrl(item.url),
        item.summary,
        JSON.stringify(item.authors),
        item.publishedAt,
        item.fetchedAt,
        item.score,
        JSON.stringify(item.scoreReasons),
        JSON.stringify(item.keywords),
        item.externalId ?? null,
      );

      if (Number(result.changes) > 0) added += 1;
      else skipped += 1;
    }

    return { added, skipped, merged };
  });
}

export function getItem(db: DatabaseSync, id: string): Item | undefined {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  return row ? mapItem(row) : undefined;
}

export function getItemsByIds(db: DatabaseSync, ids: string[]): Item[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM items WHERE id IN (${placeholders})`).all(...ids);
  // 按调用方给的顺序返回，选题生成处依赖这个顺序做引用
  const byId = new Map(rows.map((row) => [str(row['id']), mapItem(row)]));
  return ids.map((id) => byId.get(id)).filter((item): item is Item => item !== undefined);
}

/** LIKE 里的 % _ \ 必须转义，否则用户搜 "100%" 会变成通配 */
const likePattern = (input: string): string => `%${input.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;

interface WhereClause {
  sql: string;
  params: (string | number)[];
}

function buildItemWhere(query: ItemQuery): WhereClause {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  const q = query.q?.trim();
  if (q) {
    clauses.push(
      `(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')`,
    );
    const pattern = likePattern(q);
    params.push(pattern, pattern, pattern);
  }
  if (query.sourceId) {
    clauses.push('source_id = ?');
    params.push(query.sourceId);
  }
  if (query.kind) {
    clauses.push('kind = ?');
    params.push(query.kind);
  }
  // 多选：空数组表示「不按类型过滤」（前端清空筛选时传 []），不能拼出 `kind IN ()` 这种非法 SQL
  if (query.kinds !== undefined && query.kinds.length > 0) {
    clauses.push(`kind IN (${query.kinds.map(() => '?').join(', ')})`);
    params.push(...query.kinds);
  }
  if (query.minScore !== undefined && Number.isFinite(query.minScore)) {
    clauses.push('score >= ?');
    params.push(query.minScore);
  }
  if (query.since) {
    clauses.push('published_at >= ?');
    params.push(query.since);
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export const DEFAULT_ITEM_LIMIT = 30;
export const MAX_ITEM_LIMIT = 200;

export function listItems(db: DatabaseSync, query: ItemQuery = {}): Paged<Item> {
  const { sql: where, params } = buildItemWhere(query);
  const limit = Math.min(MAX_ITEM_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_ITEM_LIMIT)));
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  // score= 默认按相关度；time= 按发布时间。两个排序都带次级键，避免翻页时同分条目乱序跳行
  const order = query.sort === 'time' ? 'published_at DESC, score DESC' : 'score DESC, published_at DESC';

  const rows = db
    .prepare(`SELECT * FROM items ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  const total = num(db.prepare(`SELECT COUNT(*) AS c FROM items ${where}`).get(...params)?.['c']);

  return { items: rows.map(mapItem), total, limit, offset };
}

/** 导出用：不分页，但要有个硬上限，避免一条 SQL 把进程内存吃满 */
export function exportItems(db: DatabaseSync, query: ItemQuery = {}, max = 5000): Item[] {
  const { sql: where, params } = buildItemWhere(query);
  const order = query.sort === 'time' ? 'published_at DESC, score DESC' : 'score DESC, published_at DESC';
  return db.prepare(`SELECT * FROM items ${where} ORDER BY ${order} LIMIT ?`).all(...params, max).map(mapItem);
}

/** 按 ttlDays 清掉过老条目，控制库体积；返回删除条数 */
export function pruneItems(db: DatabaseSync, ttlDays: number, now: Date = new Date()): number {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
  return Number(db.prepare('DELETE FROM items WHERE published_at < ?').run(cutoff).changes);
}

// ---------------------------------------------------------------- runs

export function insertRun(db: DatabaseSync, run: RunRecord): void {
  db.prepare(
    `INSERT OR REPLACE INTO runs (id, started_at, finished_at, source_count, added, fetched, errors, per_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    run.startedAt,
    run.finishedAt,
    run.sourceCount,
    run.added,
    run.fetched,
    JSON.stringify(run.errors),
    run.perSource === undefined ? null : JSON.stringify(run.perSource),
  );
}

export function listRuns(db: DatabaseSync, limit = 20): RunRecord[] {
  return db
    .prepare('SELECT * FROM runs ORDER BY finished_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, Math.trunc(limit))))
    .map(mapRun);
}

// ---------------------------------------------------------------- ideas

export function listIdeas(db: DatabaseSync, status?: IdeaStatus): Idea[] {
  const rows = status
    ? db.prepare('SELECT * FROM ideas WHERE status = ? ORDER BY updated_at DESC').all(status)
    : db.prepare('SELECT * FROM ideas ORDER BY updated_at DESC').all();
  return rows.map(mapIdea);
}

export function getIdea(db: DatabaseSync, id: string): Idea | undefined {
  const row = db.prepare('SELECT * FROM ideas WHERE id = ?').get(id);
  return row ? mapIdea(row) : undefined;
}

export function upsertIdea(db: DatabaseSync, idea: Idea): Idea {
  db.prepare(
    `INSERT INTO ideas (id, created_at, updated_at, title, problem, solution, effect, keywords,
                        ipc_hints, queries, risks, status, cites, focus, novelty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       updated_at = excluded.updated_at,
       title = excluded.title,
       problem = excluded.problem,
       solution = excluded.solution,
       effect = excluded.effect,
       keywords = excluded.keywords,
       ipc_hints = excluded.ipc_hints,
       queries = excluded.queries,
       risks = excluded.risks,
       status = excluded.status,
       cites = excluded.cites,
       focus = excluded.focus,
       novelty = excluded.novelty`,
  ).run(
    idea.id,
    idea.createdAt,
    idea.updatedAt,
    idea.title,
    idea.problem,
    idea.solution,
    idea.effect,
    JSON.stringify(idea.keywords),
    JSON.stringify(idea.ipcHints),
    JSON.stringify(idea.queries),
    JSON.stringify(idea.risks),
    idea.status,
    JSON.stringify(idea.cites),
    idea.focus,
    JSON.stringify(idea.novelty),
  );
  return idea;
}

export type IdeaPatch = Partial<Pick<Idea, 'title' | 'problem' | 'solution' | 'effect' | 'queries' | 'risks' | 'status' | 'keywords' | 'ipcHints'>>;

export function updateIdea(db: DatabaseSync, id: string, patch: IdeaPatch): Idea | undefined {
  const current = getIdea(db, id);
  if (!current) return undefined;
  const next: Idea = { ...current, ...patch, updatedAt: new Date().toISOString() };
  return upsertIdea(db, next);
}

export function addNoveltyRecord(db: DatabaseSync, id: string, record: NoveltyRecord): Idea | undefined {
  const current = getIdea(db, id);
  if (!current) return undefined;
  const next: Idea = {
    ...current,
    novelty: [...current.novelty, record],
    updatedAt: new Date().toISOString(),
  };
  return upsertIdea(db, next);
}

// ---------------------------------------------------------------- stats

const DAY_MS = 86_400_000;

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function stats(db: DatabaseSync, now: Date = new Date()): Stats {
  const items = num(db.prepare('SELECT COUNT(*) AS c FROM items').get()?.['c']);
  // archived 是软删（契约里 DELETE /api/ideas 归档），统计里不该算作有效选题
  const ideas = num(db.prepare("SELECT COUNT(*) AS c FROM ideas WHERE status != 'archived'").get()?.['c']);
  const sources = num(db.prepare('SELECT COUNT(*) AS c FROM sources').get()?.['c']);
  const enabledSources = num(db.prepare('SELECT COUNT(*) AS c FROM sources WHERE enabled = 1').get()?.['c']);

  const lastRun = db.prepare('SELECT MAX(finished_at) AS at FROM runs').get();
  const lastRunAt = typeof lastRun?.['at'] === 'string' && lastRun['at'] !== '' ? lastRun['at'] : null;

  // 近 7 天（含今天）每日新增，按入库时间算；缺失的日期补 0，前端画柱状图不需要自己补洞
  const today = new Date(now.getTime());
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - 6 * DAY_MS);
  const dailyRows = db
    .prepare(`SELECT substr(fetched_at, 1, 10) AS day, COUNT(*) AS c FROM items WHERE fetched_at >= ? GROUP BY day`)
    .all(start.toISOString());
  const dailyMap = new Map(dailyRows.map((row) => [str(row['day']), num(row['c'])]));
  const dailyAdded: { date: string; count: number }[] = [];
  for (let i = 0; i < 7; i += 1) {
    const date = utcDate(new Date(start.getTime() + i * DAY_MS));
    dailyAdded.push({ date, count: dailyMap.get(date) ?? 0 });
  }

  // 直方图桶 [0,20) ... [80,100]；score 是 0–100 整数，100 归入最后一桶
  const histogramRows = db
    .prepare('SELECT MIN(CAST(score / 20 AS INTEGER), 4) AS bucket, COUNT(*) AS c FROM items GROUP BY bucket')
    .all();
  const bucketMap = new Map(histogramRows.map((row) => [num(row['bucket']), num(row['c'])]));
  const labels = ['0-20', '20-40', '40-60', '60-80', '80-100'];
  const scoreHistogram = labels.map((bucket, index) => ({ bucket, count: bucketMap.get(index) ?? 0 }));

  return { items, ideas, sources, enabledSources, lastRunAt, dailyAdded, scoreHistogram };
}
