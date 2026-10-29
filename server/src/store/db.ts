import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_SOURCES } from '../sources/defaults.js';
import { seedSources } from './queries.js';

/**
 * 存储入口。
 *
 * 为什么用 node:sqlite 而不是 better-sqlite3：整个产品要能 `npm i` 后零编译直接跑，
 * 原生模块在 arm/无网环境经常装不上；Node 24 的 node:sqlite 已够用（同步 API，
 * 与 HTTP 层 30 行查询一起用完全没问题）。
 */

/** schema 迁移脚本数组；下标 i 表示「从版本 i 升到 i+1」。只追加，不修改已发布的元素。 */
const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // v0 -> v1：首版 schema
  (db) => {
    db.exec(`
      CREATE TABLE sources (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        label      TEXT NOT NULL,
        url        TEXT NOT NULL,
        weight     REAL NOT NULL DEFAULT 1,
        enabled    INTEGER NOT NULL DEFAULT 1,
        tags       TEXT NOT NULL DEFAULT '[]',
        note       TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE items (
        id            TEXT PRIMARY KEY,
        source_id     TEXT NOT NULL,
        kind          TEXT NOT NULL,
        title         TEXT NOT NULL,
        url           TEXT NOT NULL,
        url_key       TEXT NOT NULL,
        summary       TEXT NOT NULL DEFAULT '',
        authors       TEXT NOT NULL DEFAULT '[]',
        published_at  TEXT NOT NULL,
        fetched_at    TEXT NOT NULL,
        score         INTEGER NOT NULL DEFAULT 0,
        score_reasons TEXT NOT NULL DEFAULT '[]',
        keywords      TEXT NOT NULL DEFAULT '[]',
        external_id   TEXT
      );

      -- 同一源内 url 归一化后只留一条：即便调用方自己拼的 id 有偏差，这里也能兜住
      CREATE UNIQUE INDEX items_source_url ON items(source_id, url_key);
      -- 跨源去重（arXiv id / DOI / GitHub release tag）走这个索引
      CREATE INDEX items_external_id ON items(external_id) WHERE external_id IS NOT NULL;
      CREATE INDEX items_published ON items(published_at DESC);
      CREATE INDEX items_score ON items(score DESC);
      CREATE INDEX items_source ON items(source_id);
      CREATE INDEX items_fetched ON items(fetched_at);

      CREATE TABLE runs (
        id           TEXT PRIMARY KEY,
        started_at   TEXT NOT NULL,
        finished_at  TEXT NOT NULL,
        source_count INTEGER NOT NULL,
        added        INTEGER NOT NULL,
        fetched      INTEGER NOT NULL,
        errors       TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE ideas (
        id         TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title      TEXT NOT NULL,
        problem    TEXT NOT NULL DEFAULT '',
        solution   TEXT NOT NULL DEFAULT '',
        effect     TEXT NOT NULL DEFAULT '',
        keywords   TEXT NOT NULL DEFAULT '[]',
        ipc_hints  TEXT NOT NULL DEFAULT '[]',
        queries    TEXT NOT NULL DEFAULT '[]',
        risks      TEXT NOT NULL DEFAULT '[]',
        status     TEXT NOT NULL DEFAULT 'draft',
        cites      TEXT NOT NULL DEFAULT '[]',
        focus      TEXT NOT NULL DEFAULT '',
        novelty    TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX ideas_updated ON ideas(updated_at DESC);
      CREATE INDEX ideas_status ON ideas(status);
    `);
  },
  // v1 -> v2：记录每个源的耗时与产出（老数据没有这一列，读出来是 undefined，不是空数组）
  (db) => {
    db.exec(`ALTER TABLE runs ADD COLUMN per_source TEXT`);
  },
];

function applyMigrations(db: DatabaseSync): void {
  // PRAGMA 不能用参数绑定，这里的数字来自本地循环下标，不含外部输入
  const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
  const current = Number(row?.['user_version'] ?? 0) || 0;

  for (let i = current; i < MIGRATIONS.length; i += 1) {
    const step = MIGRATIONS[i];
    if (!step) continue;
    // 迁移要么整块成功要么整块回滚，避免半截 schema 让后续启动彻底卡死
    db.exec('BEGIN');
    try {
      step(db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

/**
 * 打开（必要时创建）数据库。
 *
 * @param dataDir 数据目录；传 `:memory:` 走内存库，测试专用。
 */
export function openDb(dataDir: string): DatabaseSync {
  const isMemory = dataDir === ':memory:';
  if (!isMemory) mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(isMemory ? ':memory:' : join(dataDir, 'trend-radar.db'));
  // WAL 让「采集写 + API 读」互不阻塞；busy_timeout 兜住极端并发下的 SQLITE_BUSY
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  applyMigrations(db);

  // 首次启动灌入内置源：这样 `GET /api/sources` 在还没采集过时也有东西可展示
  const count = db.prepare('SELECT COUNT(*) AS c FROM sources').get() as Record<string, unknown>;
  if (Number(count['c'] ?? 0) === 0) {
    seedSources(db, DEFAULT_SOURCES);
  }

  return db;
}
