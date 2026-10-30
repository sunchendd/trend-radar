/**
 * 运行时设置 + kinds 多选过滤。
 *
 * 分两层测：
 *  - 存储/合并规则（纯函数 + :memory: 库）：改字段、apiKey 留空不改、默认值回落；
 *  - HTTP 契约（真实 modules + 临时 sqlite 文件）：GET 永不吐明文 key、PUT 立即重排、
 *    kinds 逗号分隔多选与老的单值 kind 兼容。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { loadDeps, type HttpDeps } from '../src/http/deps.js';
import type { Scheduler } from '../src/scheduler.js';
import { openDb } from '../src/store/db.js';
import { insertItems } from '../src/store/queries.js';
import {
  applySettingsToConfig,
  commandAvailable,
  readSettings,
  resolveSettings,
  settingsUpdatedAt,
  writeSettings,
} from '../src/store/settings.js';
import type { AppSettings, Item } from '../src/types.js';

const makeConfig = (over: Partial<AppConfig> = {}): AppConfig => ({
  dataDir: ':memory:',
  port: 0,
  host: '127.0.0.1',
  collectMinutes: 360,
  minKeepScore: 10,
  limitPerSource: 40,
  ttlDays: 180,
  llm: { baseUrl: '', apiKey: '', model: 'deepseek-chat', temperature: 0.7, maxTokens: 8000 },
  novelty: { command: '', agreeKick: false },
  ...over,
});

const makeItem = (over: Partial<Item> & Pick<Item, 'id' | 'kind' | 'url'>): Item => ({
  sourceId: 'arxiv-spec',
  title: `条目 ${over.id}`,
  summary: '',
  authors: [],
  publishedAt: '2026-10-20T00:00:00.000Z',
  fetchedAt: '2026-10-21T00:00:00.000Z',
  score: 70,
  scoreReasons: [],
  keywords: [],
  ...over,
});

// ---------------------------------------------------------------- 存储层

describe('settings 存储与合并规则', () => {
  it('空库读出来是 {} —— 表示「全用 config 默认值」', () => {
    const db = openDb(':memory:');
    try {
      expect(readSettings(db)).toEqual({});
      expect(settingsUpdatedAt(db)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('writeSettings 只写传了的字段，后续写入不会清掉别的字段', () => {
    const db = openDb(':memory:');
    try {
      writeSettings(db, { dailyRefreshAt: '07:30' });
      expect(readSettings(db)).toEqual({ dailyRefreshAt: '07:30' });

      writeSettings(db, { ttlDays: 30, llm: { model: 'qwen' } });
      const patch = readSettings(db);
      expect(patch.dailyRefreshAt).toBe('07:30');
      expect(patch.ttlDays).toBe(30);
      expect(patch.llm).toEqual({ model: 'qwen' });
      expect(settingsUpdatedAt(db)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('llm.apiKey 传空串 = 不改（设置页拿不到明文，提交空串不能把 key 抹掉）', () => {
    const db = openDb(':memory:');
    try {
      writeSettings(db, { llm: { apiKey: 'sk-real-key' } });
      writeSettings(db, { llm: { apiKey: '', model: 'x' } });
      const patch = readSettings(db);
      expect(patch.llm?.apiKey).toBe('sk-real-key');
      expect(patch.llm?.model).toBe('x');
    } finally {
      db.close();
    }
  });

  it('resolveSettings：config 值是默认，DB 覆盖优先，且不外泄明文 key', () => {
    const config = makeConfig();
    const base = resolveSettings(config, {});
    expect(base.collectMinutes).toBe(360);
    expect(base.limitPerSource).toBe(40);
    expect(base.ttlDays).toBe(180);
    expect(base.llm).toEqual({ baseUrl: '', model: 'deepseek-chat', hasApiKey: false });
    expect(base.llm).not.toHaveProperty('apiKey');
    expect(base.dailyRefreshAt).toBe('08:00');
    expect(base.nextRefreshAt).toBeNull();
    // 与既有 KPI 卡片口径一致：高分 ≥70 / 待判 50–70
    expect(base.highScore).toBe(70);
    expect(base.midScore).toBe(50);
    // config.collectMinutes=360 且未开每日 → 间隔模式
    expect(base.refreshMode).toBe('interval');

    const overridden = resolveSettings(config, { collectMinutes: 15, ttlDays: 7, llm: { apiKey: 'sk-1' } }, '2026-10-30T00:00:00.000Z');
    expect(overridden.collectMinutes).toBe(15);
    expect(overridden.ttlDays).toBe(7);
    expect(overridden.llm.hasApiKey).toBe(true);
    expect(overridden.updatedAt).toBe('2026-10-30T00:00:00.000Z');
    expect(overridden.refreshMode).toBe('interval');
  });

  it('hasCommand 按「文件/PATH 是否真的存在」判，而不是字符串非空', () => {
    // 存在：本测试文件自己
    expect(commandAvailable(new URL(import.meta.url).pathname)).toBe(true);
    // 不存在：路径写错是最容易误导人的情形，必须是 false
    expect(commandAvailable('/definitely/not/here/batch_search.sh')).toBe(false);
    // 纯命令名交给 PATH
    expect(commandAvailable('node')).toBe(true);
    expect(commandAvailable('no-such-command-xyz-123')).toBe(false);
    // 空/空白
    expect(commandAvailable('')).toBe(false);
    expect(commandAvailable('   ')).toBe(false);

    const config = makeConfig({ novelty: { command: '/definitely/not/here/zhy.sh', agreeKick: false } });
    expect(resolveSettings(config, {}).novelty.hasCommand).toBe(false);
    const resolved = resolveSettings(config, { novelty: { command: 'node' } });
    expect(resolved.novelty.hasCommand).toBe(true);
  });

  it('applySettingsToConfig：设置里的采集参数与明文 key 进入运行时配置', () => {
    const config = makeConfig();
    const effective = applySettingsToConfig(config, {
      limitPerSource: 12,
      minKeepScore: 25,
      ttlDays: 30,
      collectMinutes: 5,
      llm: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'local', apiKey: 'sk-db' },
      novelty: { command: '/tmp/zhy.sh' },
    });

    expect(effective.limitPerSource).toBe(12);
    expect(effective.minKeepScore).toBe(25);
    expect(effective.ttlDays).toBe(30);
    expect(effective.collectMinutes).toBe(5);
    expect(effective.llm.apiKey).toBe('sk-db');
    expect(effective.llm.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(effective.novelty.command).toBe('/tmp/zhy.sh');
    // 没传的字段继续吃 config
    expect(effective.llm.temperature).toBe(config.llm.temperature);
  });
});

// ---------------------------------------------------------------- HTTP 层

interface Harness {
  app: FastifyInstance;
  deps: HttpDeps;
  reschedules: AppSettings[];
  dir: string;
}

const openApps: FastifyInstance[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHarness(config: Partial<AppConfig> = {}, seed?: (db: ReturnType<typeof openDb>) => void): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'trend-radar-settings-'));
  tmpDirs.push(dir);
  const fullConfig = makeConfig({ ...config, dataDir: dir });

  if (seed) {
    const db = openDb(dir);
    try {
      seed(db);
    } finally {
      db.close();
    }
  }

  const deps = await loadDeps(fullConfig);
  const reschedules: AppSettings[] = [];
  const scheduler: Scheduler = {
    stop: () => {},
    nextAt: () => null,
    reschedule: (settings) => {
      reschedules.push(settings as AppSettings);
    },
  };

  const app = await buildApp(fullConfig, {
    deps,
    logger: false,
    distDir: null,
    schedulerFactory: () => scheduler,
  });
  openApps.push(app);
  return { app, deps, reschedules, dir };
}

describe('GET/PUT /api/settings', () => {
  it('GET 返回完整 AppSettings，但绝不回传明文 apiKey', async () => {
    const { app } = await makeHarness();
    const res = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(res.statusCode).toBe(200);
    const body = res.json<AppSettings>();
    expect(body).toMatchObject({
      dailyRefreshAt: '08:00',
      dailyRefreshEnabled: false,
      collectMinutes: 360,
      limitPerSource: 40,
      ttlDays: 180,
      highScore: 70,
      midScore: 50,
      updatedAt: null,
      refreshMode: 'interval',
    });
    // 未开启每日定时时回落到 config 的 collectMinutes（默认 360 分钟）
    const next = new Date(body.nextRefreshAt as string);
    expect(Math.round((next.getTime() - Date.now()) / 60_000)).toBe(360);
    expect(body.llm.hasApiKey).toBe(false);
    expect(body.llm).not.toHaveProperty('apiKey');
    expect(body.novelty.hasCommand).toBe(false);
  });

  it('PUT 保存后立即重排并按新设置算出 nextRefreshAt', async () => {
    const { app, reschedules } = await makeHarness();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { dailyRefreshEnabled: true, dailyRefreshAt: '09:30', collectMinutes: 0 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<AppSettings>();
    expect(body.dailyRefreshEnabled).toBe(true);
    expect(body.dailyRefreshAt).toBe('09:30');
    expect(body.refreshMode).toBe('daily');
    expect(body.nextRefreshAt).not.toBeNull();
    const next = new Date(body.nextRefreshAt as string);
    expect(next.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
    expect(body.updatedAt).not.toBeNull();

    // 立即生效：调度器必须收到一次 reschedule，且带的是最新设置
    expect(reschedules).toHaveLength(1);
    expect(reschedules[0]?.dailyRefreshAt).toBe('09:30');
  });

  it('关闭每日定时且间隔为 0 → nextRefreshAt 为 null（不自动采集）', async () => {
    const { app } = await makeHarness();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { dailyRefreshEnabled: false, collectMinutes: 0 },
    });

    expect(res.statusCode).toBe(200);
    const off = res.json<AppSettings>();
    expect(off.nextRefreshAt).toBeNull();
    expect(off.refreshMode).toBe('off');
  });

  it('PUT apiKey 生效但只回 hasApiKey；之后提交空串不会抹掉它', async () => {
    const { app } = await makeHarness();

    const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: { llm: { apiKey: 'sk-secret-value' } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<AppSettings>().llm.hasApiKey).toBe(true);
    expect(saved.body).not.toContain('sk-secret-value');

    const cleared = await app.inject({ method: 'PUT', url: '/api/settings', payload: { llm: { apiKey: '', model: 'm2' } } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<AppSettings>().llm.hasApiKey).toBe(true);
    expect(cleared.json<AppSettings>().llm.model).toBe('m2');
  });

  it('设置写入 sqlite：换一个进程（重新 openDb/loadDeps）仍然生效', async () => {
    const first = await makeHarness();
    await first.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { collectMinutes: 45, ttlDays: 14, highScore: 90, midScore: 70 },
    });
    await first.app.close();

    // 复用同一个 dataDir：相当于进程重启后重新打开库
    const deps = await loadDeps(makeConfig({ dataDir: first.dir }));
    const app = await buildApp(makeConfig({ dataDir: first.dir }), { deps, logger: false, distDir: null });
    openApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = res.json<AppSettings>();
    expect(body.collectMinutes).toBe(45);
    expect(body.ttlDays).toBe(14);
    expect(body.highScore).toBe(90);
    expect(body.midScore).toBe(70);
    expect(body.refreshMode).toBe('interval');
  });

  it('非法值一律 400，并且 message 点名出错字段', async () => {
    const { app } = await makeHarness();

    const cases: { payload: Record<string, unknown>; field: string }[] = [
      { payload: { dailyRefreshAt: '24:00' }, field: 'dailyRefreshAt' },
      { payload: { dailyRefreshAt: '8:00' }, field: 'dailyRefreshAt' }, // 必须补零
      { payload: { collectMinutes: -1 }, field: 'collectMinutes' },
      { payload: { collectMinutes: 10081 }, field: 'collectMinutes' },
      { payload: { ttlDays: 0 }, field: 'ttlDays' },
      { payload: { ttlDays: 3651 }, field: 'ttlDays' },
      { payload: { limitPerSource: 0 }, field: 'limitPerSource' },
      { payload: { highScore: 101 }, field: 'highScore' },
      { payload: { midScore: 90 }, field: 'midScore' }, // 合并后 90 > 默认 highScore 80
      { payload: {}, field: 'body' },
    ];

    for (const { payload, field } of cases) {
      const res = await app.inject({ method: 'PUT', url: '/api/settings', payload });
      expect(res.statusCode, `payload=${JSON.stringify(payload)}`).toBe(400);
      const body = res.json<{ error: { code: string; message: string; detail?: { fields?: { field: string }[] } } }>();
      expect(body.error.code).toBe('validation_error');
      expect(body.error.message).toContain(field);
    }
  });

  it('同时传 highScore/midScore 时校验两者关系', async () => {
    const { app } = await makeHarness();
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { highScore: 50, midScore: 70 } });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain('midScore');

    const ok = await app.inject({ method: 'PUT', url: '/api/settings', payload: { highScore: 95, midScore: 40 } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('GET /api/items?kinds=', () => {
  const seedItems = (db: ReturnType<typeof openDb>): void => {
    insertItems(db, [
      makeItem({ id: 'i-paper', kind: 'paper', url: 'https://example.com/paper', score: 90 }),
      makeItem({ id: 'i-news', kind: 'news', url: 'https://example.com/news', score: 60 }),
      makeItem({ id: 'i-release', kind: 'release', url: 'https://example.com/release', score: 30 }),
    ]);
  };

  const kindsOf = (body: { items: Item[] }): string[] => body.items.map((item) => item.kind).sort();

  it('逗号分隔多选：kinds=news,release 只回这两类', async () => {
    const { app } = await makeHarness({}, seedItems);
    const res = await app.inject({ method: 'GET', url: '/api/items?kinds=news,release' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Item[]; total: number }>();
    expect(body.total).toBe(2);
    expect(kindsOf(body)).toEqual(['news', 'release']);
  });

  it('兼容单值 kind，并与 kinds 合并去重', async () => {
    const { app } = await makeHarness({}, seedItems);

    const single = await app.inject({ method: 'GET', url: '/api/items?kind=paper' });
    expect(single.json<{ total: number }>().total).toBe(1);

    const merged = await app.inject({ method: 'GET', url: '/api/items?kinds=paper&kind=news' });
    const body = merged.json<{ items: Item[]; total: number }>();
    expect(body.total).toBe(2);
    expect(kindsOf(body)).toEqual(['news', 'paper']);
  });

  it('空 kinds 视为不过滤（含逗号空位与重复值）', async () => {
    const { app } = await makeHarness({}, seedItems);

    for (const query of ['kinds=', 'kinds=,,', 'kinds=news,news']) {
      const res = await app.inject({ method: 'GET', url: `/api/items?${query}` });
      expect(res.statusCode, query).toBe(200);
      const total = res.json<{ total: number }>().total;
      expect(total, query).toBe(query === 'kinds=news,news' ? 1 : 3);
    }
  });

  it('非法 kind 值 400，并点名 kinds 字段', async () => {
    const { app } = await makeHarness({}, seedItems);
    const res = await app.inject({ method: 'GET', url: '/api/items?kinds=blog,news' });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toContain('kinds');
  });

  it('kinds 与其它过滤条件同时生效', async () => {
    const { app } = await makeHarness({}, seedItems);
    const res = await app.inject({ method: 'GET', url: '/api/items?kinds=news,release&minScore=50' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Item[]; total: number }>();
    expect(body.total).toBe(1);
    expect(body.items[0]?.id).toBe('i-news');
  });
});
