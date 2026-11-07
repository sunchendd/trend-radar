/**
 * 检索式巡检的持久化：巡检项 + 每次命中数快照。
 *
 * 为什么单独一个文件、而不是加进 store/db.ts：这个能力是后来加的，
 * 用 `CREATE TABLE IF NOT EXISTS` 自带建表，避免动主 schema 的迁移版本号（user_version），
 * 也避免和老库互相影响。表很小（巡检项几十条、快照几千行）。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 巡检引擎：智慧芽 CLI（中文检索式）或 Google Patents XHR（免鉴权，支持 assignee: 语法） */
export type WatchEngine = 'zhihuiya' | 'google_patents';

/** Google Patents 快照的 top5 条目（detail 列的 JSON 结构，内部存储形态） */
export interface GpSnapshotEntry {
  title: string;
  publicationNumber: string;
  filingDate: string;
}

/**
 * 最近快照摘要（给前端的展示形状）：at/count 来自快照行，topTitles 从
 * detail 的 top5 标题派生。刻意不暴露 publicationNumber 等嵌套对象——
 * 前端摘要行只需要标题字符串数组。
 */
export interface WatchLastSnapshot {
  /** 最近快照时间（ISO）；从未巡检时缺省 */
  at?: string;
  /** 最近命中数（GP 引擎 = 命中条数）；页面解析失败时缺省 */
  count?: number;
  /** Top 命中标题，最多 5 条（GP 引擎才有）；无摘要时缺省 */
  topTitles?: string[];
}

export interface Watch {
  id: string;
  /** 检索式原文（中文，3–5 个词最有效） */
  query: string;
  /** 为什么盯它，便于后人接手 */
  note: string;
  enabled: boolean;
  createdAt: string;
  /** 最近一次命中数；从未巡检为 null */
  lastHits: number | null;
  lastCheckedAt: string | null;
  /** 巡检次数 */
  checks: number;
  /** 巡检引擎；存量行无该列，默认按 zhihuiya（规范值，连字符写法在 API 入口规范化） */
  engine: WatchEngine;
  /** 最近快照摘要；从未巡检为 null */
  lastSnapshot: WatchLastSnapshot | null;
}

export interface WatchSnapshot {
  watchId: string;
  at: string;
  /** null = 页面解析失败（≠ 0 命中） */
  hits: number | null;
  topAssignees: string;
  /** 结构化快照摘要（JSON 字符串，如 {"top5":[...]}）；智慧芽引擎不填 */
  detail?: string;
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watch_snapshots (
      watch_id TEXT NOT NULL,
      at TEXT NOT NULL,
      hits INTEGER,
      top_assignees TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (watch_id, at)
    );
    CREATE INDEX IF NOT EXISTS idx_watch_snapshots_watch ON watch_snapshots (watch_id, at DESC);
  `);
  // engine 列后补（v+t 竞对监控）：存量行落默认值 'zhihuiya'，ALTER 重复执行会抛
  // "duplicate column"——吞掉即是幂等，与 settings/watches 自建表的原则一致，
  // 绝不进 db.ts 的 user_version 迁移链
  try {
    db.exec(`ALTER TABLE watches ADD COLUMN engine TEXT NOT NULL DEFAULT 'zhihuiya'`);
  } catch {
    /* 列已存在 */
  }
  try {
    db.exec('ALTER TABLE watch_snapshots ADD COLUMN detail TEXT');
  } catch {
    /* 列已存在 */
  }
}

interface WatchRow {
  id: string;
  query: string;
  note: string;
  enabled: number;
  created_at: string;
  last_hits: number | null;
  last_checked_at: string | null;
  checks: number;
  engine?: string | null;
  last_detail?: string | null;
}

const ENGINES: readonly string[] = ['zhihuiya', 'google_patents'];

/** detail JSON 解析失败退 null：快照摘要只服务于展示，坏数据不该拖垮列表 */
function toDetail(value: string | null | undefined): { top5?: GpSnapshotEntry[] } | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as { top5?: GpSnapshotEntry[] };
    }
    return null;
  } catch {
    return null;
  }
}

/** 由行数据拼 lastSnapshot：从未巡检为 null；hits=null（解析失败）不给 count */
function toLastSnapshot(row: Pick<WatchRow, 'last_hits' | 'last_checked_at' | 'last_detail'>): WatchLastSnapshot | null {
  const detail = toDetail(row.last_detail);
  const topTitles = (detail?.top5 ?? []).map((entry) => entry.title).filter((title) => title !== '').slice(0, 5);
  if (row.last_checked_at === null && topTitles.length === 0) return null;
  const snapshot: WatchLastSnapshot = {};
  if (row.last_checked_at !== null) snapshot.at = row.last_checked_at;
  if (row.last_hits !== null) snapshot.count = row.last_hits;
  if (topTitles.length > 0) snapshot.topTitles = topTitles;
  return snapshot;
}

const toWatch = (row: WatchRow): Watch => ({
  id: row.id,
  query: row.query,
  note: row.note,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  lastHits: row.last_hits,
  lastCheckedAt: row.last_checked_at,
  checks: Number(row.checks ?? 0),
  // ALTER 加列前的存量行读出来是 undefined，统一按默认引擎
  engine: (row.engine && (ENGINES as readonly string[]).includes(row.engine) ? row.engine : 'zhihuiya') as WatchEngine,
  lastSnapshot: toLastSnapshot(row),
});

const SELECT_WATCH = `
  SELECT w.id, w.query, w.note, w.enabled, w.created_at, w.engine,
         (SELECT s.hits FROM watch_snapshots s WHERE s.watch_id = w.id ORDER BY s.at DESC LIMIT 1) AS last_hits,
         (SELECT s.at   FROM watch_snapshots s WHERE s.watch_id = w.id ORDER BY s.at DESC LIMIT 1) AS last_checked_at,
         (SELECT COUNT(*) FROM watch_snapshots s WHERE s.watch_id = w.id) AS checks,
         (SELECT s.detail FROM watch_snapshots s WHERE s.watch_id = w.id ORDER BY s.at DESC LIMIT 1) AS last_detail
  FROM watches w
`;

export function listWatches(db: DatabaseSync, includeDisabled = false): Watch[] {
  ensureSchema(db);
  const sql = `${SELECT_WATCH} ${includeDisabled ? '' : 'WHERE w.enabled = 1'} ORDER BY w.created_at DESC`;
  return (db.prepare(sql).all() as unknown as WatchRow[]).map(toWatch);
}

export function getWatch(db: DatabaseSync, id: string): Watch | undefined {
  ensureSchema(db);
  const row = db.prepare(`${SELECT_WATCH} WHERE w.id = ?`).get(id) as unknown as WatchRow | undefined;
  return row ? toWatch(row) : undefined;
}

export function addWatch(
  db: DatabaseSync,
  input: { query: string; note?: string; engine?: WatchEngine; now?: string },
): Watch {
  ensureSchema(db);
  const query = input.query.trim();
  if (query === '') throw new Error('巡检检索式不能为空');
  const existing = db.prepare('SELECT id FROM watches WHERE query = ?').get(query) as { id?: string } | undefined;
  if (existing?.id) return getWatch(db, existing.id) as Watch;
  const now = input.now ?? new Date().toISOString();
  const id = `watch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const engine = input.engine && (ENGINES as readonly string[]).includes(input.engine) ? input.engine : 'zhihuiya';
  db.prepare('INSERT INTO watches (id, query, note, enabled, created_at, engine) VALUES (?, ?, ?, 1, ?, ?)').run(
    id,
    query,
    input.note ?? '',
    now,
    engine,
  );
  return getWatch(db, id) as Watch;
}

export function setWatchEnabled(db: DatabaseSync, id: string, enabled: boolean): Watch | undefined {
  ensureSchema(db);
  db.prepare('UPDATE watches SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return getWatch(db, id);
}

export function removeWatch(db: DatabaseSync, id: string): boolean {
  ensureSchema(db);
  db.prepare('DELETE FROM watch_snapshots WHERE watch_id = ?').run(id);
  const res = db.prepare('DELETE FROM watches WHERE id = ?').run(id);
  return Number(res.changes ?? 0) > 0;
}

export function recordSnapshot(db: DatabaseSync, snapshot: WatchSnapshot): void {
  ensureSchema(db);
  db.prepare(
    'INSERT INTO watch_snapshots (watch_id, at, hits, top_assignees, detail) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(watch_id, at) DO UPDATE SET hits = excluded.hits, top_assignees = excluded.top_assignees, ' +
      'detail = COALESCE(excluded.detail, detail)',
  ).run(snapshot.watchId, snapshot.at, snapshot.hits, snapshot.topAssignees, snapshot.detail ?? null);
}

/** 取最近 N 次的命中数，按时间升序（趋势判读要升序） */
export function history(db: DatabaseSync, watchId: string, limit = 12): WatchSnapshot[] {
  ensureSchema(db);
  const rows = db
    .prepare('SELECT watch_id, at, hits, top_assignees FROM watch_snapshots WHERE watch_id = ? ORDER BY at DESC LIMIT ?')
    .all(watchId, limit) as unknown as { watch_id: string; at: string; hits: number | null; top_assignees: string }[];
  return rows
    .map((row) => ({ watchId: row.watch_id, at: row.at, hits: row.hits, topAssignees: row.top_assignees }))
    .reverse();
}
