import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { sweepWatches } from '../src/sweep.js';
import { openDb } from '../src/store/db.js';
import { addWatch, getWatch, history, listWatches, recordSnapshot } from '../src/store/watches.js';
import type { Source } from '../src/types.js';

/**
 * 巡检引擎扩展测试（engine=google_patents，全程离线，假 fetch）。
 * 覆盖：engine 规范化与存量行默认值、lastSnapshot 摘要形状（at/count/topTitles）、
 * GP 引擎快照（count=top 命中数 + detail top5）、失败进 errors 不记 0 命中。
 */

const makeConfig = (dataDir: string): AppConfig => ({
  dataDir,
  port: 0,
  host: '127.0.0.1',
  collectMinutes: 0,
  minKeepScore: 0,
  limitPerSource: 40,
  ttlDays: 180,
  llm: { baseUrl: '', apiKey: '', model: '', temperature: 0.7, maxTokens: 1000 },
  novelty: { command: '', agreeKick: false },
  translation: { enabled: true, dailyLimit: 100 },
  bark: { url: '', enabled: true },
});

const NOVELTY_UNAVAILABLE = new Error('智慧芽 CLI 未配置');

const PATENTS_JSON = JSON.stringify({
  results: {
    cluster: [
      {
        result: [
          { patent: { title: '投机解码加速方法 A', publication_number: 'CN110A', assignee: '华为', filing_date: '20240101' } },
          { patent: { title: '投机解码加速方法 B', publication_number: 'CN110B', assignee: '腾讯', filing_date: '20240202' } },
          { patent: { title: '投机解码加速方法 C', publication_number: 'CN110C', assignee: '阿里', filing_date: '20240303' } },
          { patent: { title: '投机解码加速方法 D', publication_number: 'CN110D', assignee: '百度', filing_date: '20240404' } },
          { patent: { title: '投机解码加速方法 E', publication_number: 'CN110E', assignee: '字节', filing_date: '20240505' } },
          { patent: { title: '投机解码加速方法 F', publication_number: 'CN110F', assignee: '美团', filing_date: '20240606' } },
        ],
      },
    ],
  },
});

let dataDir: string;
let db: DatabaseSync;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'trend-radar-watcheng-'));
  db = openDb(dataDir);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // 个别用例会换库重开（legacy 测试），已关闭时忽略
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('watches：engine 持久化与 lastSnapshot', () => {
  it('addWatch 默认 zhihuiya；显式 engine 规范存储；listWatches 带出 engine', () => {
    const zh = addWatch(db, { query: '投机解码 草稿 截断' });
    expect(zh.engine).toBe('zhihuiya');
    const gp = addWatch(db, { query: 'assignee:华为 speculative decoding', engine: 'google_patents' });
    expect(gp.engine).toBe('google_patents');
    // 存量语义：listWatches 返回规范值（连字符写法在 API 入口规范化，store 只认规范值）。
    // 断言排序无关：两条同毫秒插入时 created_at 相同，ORDER BY 的 tie 顺序不定义。
    expect(listWatches(db).map((watch) => watch.engine).sort()).toEqual(['google_patents', 'zhihuiya']);
    expect(getWatch(db, gp.id)?.engine).toBe('google_patents');
  });

  it('recordSnapshot 带 detail → lastSnapshot {at,count,topTitles≤5}；无快照 → null', () => {
    const watch = addWatch(db, { query: '投机解码 草稿 截断' });
    expect(listWatches(db)[0]?.lastSnapshot).toBeNull();

    recordSnapshot(db, {
      watchId: watch.id,
      at: '2026-11-05T08:00:00.000Z',
      hits: 12,
      topAssignees: '华为:12',
      detail: JSON.stringify({
        top5: [
          { title: 'T1', publicationNumber: 'CN1', filingDate: '20240101' },
          { title: 'T2', publicationNumber: 'CN2', filingDate: '20240202' },
        ],
      }),
    });
    const view = listWatches(db)[0]!;
    expect(view.lastSnapshot).toEqual({
      at: '2026-11-05T08:00:00.000Z',
      count: 12,
      topTitles: ['T1', 'T2'],
    });
    // 历史接口仍按命中数给出（趋势判读的数据源不变）
    expect(history(db, watch.id)).toHaveLength(1);
  });

  it('存量老库（无 engine/detail 列）打开后自动补列，旧行按默认引擎读取', () => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    // 用「旧 schema」手工建库：没有 engine / detail 列，模拟升级前的库
    const legacy = new DatabaseSync(join(dataDir, 'trend-radar.db'));
    legacy.exec(`
      CREATE TABLE watches (
        id TEXT PRIMARY KEY, query TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE TABLE watch_snapshots (
        watch_id TEXT NOT NULL, at TEXT NOT NULL, hits INTEGER,
        top_assignees TEXT NOT NULL DEFAULT '', PRIMARY KEY (watch_id, at)
      );
      INSERT INTO watches (id, query, created_at) VALUES ('w-old', 'KV cache 推理', '2026-01-01T00:00:00.000Z');
      INSERT INTO watch_snapshots (watch_id, at, hits, top_assignees) VALUES ('w-old', '2026-11-01T00:00:00.000Z', 3, '华为:3');
    `);
    legacy.close();

    const upgraded = openDb(dataDir);
    try {
      const watch = listWatches(upgraded)[0]!;
      expect(watch.engine).toBe('zhihuiya');
      expect(watch.lastSnapshot).toEqual({ at: '2026-11-01T00:00:00.000Z', count: 3 });
      // 新增 GP 巡检项照常工作
      const gp = addWatch(upgraded, { query: 'assignee:华为 KV cache', engine: 'google_patents' });
      expect(getWatch(upgraded, gp.id)?.engine).toBe('google_patents');
    } finally {
      upgraded.close();
    }
  });
});

describe('sweepWatches：google_patents 引擎', () => {
  it('GP 巡检走 Google Patents 适配器：count=命中数、快照带 top5 摘要、query 原样透传', async () => {
    const gp = addWatch(db, { query: 'assignee:华为 speculative decoding', engine: 'google_patents' });
    const requests: string[] = [];
    const result = await sweepWatches(makeConfig(dataDir), db, {
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(PATENTS_JSON, { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    expect(result.checked).toBe(1);
    expect(result.errors).toEqual([]);
    expect(requests).toHaveLength(1);
    // 空格→+ 是 GP xhr/query 双层编码的硬契约（%20 会让 GP 解析归零）
    expect(decodeURIComponent(requests[0] ?? '')).toContain('q=assignee:华为+speculative+decoding');

    const view = getWatch(db, gp.id)!;
    expect(view.lastHits).toBe(6);
    expect(view.lastSnapshot?.topTitles).toHaveLength(5);
    expect(view.lastSnapshot?.topTitles?.[0]).toBe('投机解码加速方法 A');
    // 趋势判读沿用命中数：首轮无可比历史 → 非 actionable
    expect(result.trends).toHaveLength(1);
    expect(result.alerts).toHaveLength(0);
  });

  it('GP 请求失败 → 进 errors 且不落 0 命中快照（不污染趋势）', async () => {
    addWatch(db, { query: 'assignee:华为 KV cache', engine: 'google_patents' });
    // 整轮全失败 = 巡检语义里的「没跑成」：沿既有约定把首个失败抛给上层（映射 503/500）
    await expect(
      sweepWatches(makeConfig(dataDir), db, {
        fetch: async () => new Response('forbidden', { status: 403 }),
      }),
    ).rejects.toThrow('403');
    expect(listWatches(db)[0]?.lastSnapshot).toBeNull();
    expect(history(db, listWatches(db)[0]!.id)).toHaveLength(0);
  });

  it('混合引擎：zhihuiya 项走原 CLI 路径（未配置 → 错误），GP 项正常跑', async () => {
    addWatch(db, { query: '投机解码 草稿 截断' });
    addWatch(db, { query: 'assignee:华为 KV cache', engine: 'google_patents' });
    const result = await sweepWatches(makeConfig(dataDir), db, {
      fetch: async () => new Response(PATENTS_JSON, { status: 200 }),
    });
    expect(result.checked).toBe(1); // 只有 GP 项成功
    expect(result.skipped).toBe(1); // zhihuiya 项因 CLI 未配置失败
    expect(result.errors[0]?.watchId).toBe(listWatches(db).find((watch) => watch.engine === 'zhihuiya')?.id);
    void NOVELTY_UNAVAILABLE;
    void ({} as Source);
  });
});
