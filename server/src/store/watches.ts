/**
 * 检索式巡检的持久化：巡检项 + 每次命中数快照。
 *
 * 为什么单独一个文件、而不是加进 store/db.ts：这个能力是后来加的，
 * 用 `CREATE TABLE IF NOT EXISTS` 自带建表，避免动主 schema 的迁移版本号（user_version），
 * 也避免和老库互相影响。表很小（巡检项几十条、快照几千行）。
 */
import type { DatabaseSync } from 'node:sqlite';

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
}

export interface WatchSnapshot {
  watchId: string;
  at: string;
  /** null = 页面解析失败（≠ 0 命中） */
  hits: number | null;
  topAssignees: string;
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
});

const SELECT_WATCH = `
  SELECT w.id, w.query, w.note, w.enabled, w.created_at,
         (SELECT s.hits FROM watch_snapshots s WHERE s.watch_id = w.id ORDER BY s.at DESC LIMIT 1) AS last_hits,
         (SELECT s.at   FROM watch_snapshots s WHERE s.watch_id = w.id ORDER BY s.at DESC LIMIT 1) AS last_checked_at,
         (SELECT COUNT(*) FROM watch_snapshots s WHERE s.watch_id = w.id) AS checks
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

export function addWatch(db: DatabaseSync, input: { query: string; note?: string; now?: string }): Watch {
  ensureSchema(db);
  const query = input.query.trim();
  if (query === '') throw new Error('巡检检索式不能为空');
  const existing = db.prepare('SELECT id FROM watches WHERE query = ?').get(query) as { id?: string } | undefined;
  if (existing?.id) return getWatch(db, existing.id) as Watch;
  const now = input.now ?? new Date().toISOString();
  const id = `watch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare('INSERT INTO watches (id, query, note, enabled, created_at) VALUES (?, ?, ?, 1, ?)').run(
    id,
    query,
    input.note ?? '',
    now,
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
    'INSERT INTO watch_snapshots (watch_id, at, hits, top_assignees) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(watch_id, at) DO UPDATE SET hits = excluded.hits, top_assignees = excluded.top_assignees',
  ).run(snapshot.watchId, snapshot.at, snapshot.hits, snapshot.topAssignees);
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
