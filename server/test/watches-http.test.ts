import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tr-watch-http-'));
  // 指向不存在的 CLI：测试**绝不能**真的去登录智慧芽（本机默认路径是存在的，会跑真浏览器）
  app = await buildApp(
    loadConfig({ TREND_RADAR_DATA_DIR: dir, COLLECT_MINUTES: '0', ZHY_COMMAND: '/nonexistent/zhy-batch.sh' }),
    {
      distDir: null,
      logger: false,
    },
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('/api/watches 契约', () => {
  it('新增 → 列表 → 停用 → 删除 的完整闭环', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/watches',
      payload: { query: '投机解码 草稿 重建', note: '主线方向' },
    });
    expect(created.statusCode).toBe(201);
    const watch = created.json();
    expect(watch.id).toMatch(/^watch-/);
    expect(watch.enabled).toBe(true);
    expect(watch.checks).toBe(0);

    const list = await app.inject({ method: 'GET', url: '/api/watches' });
    expect(list.json()).toHaveLength(1);

    const off = await app.inject({ method: 'PATCH', url: `/api/watches/${watch.id}`, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(false);
    // 默认只列启用的；all=true 才看得到停用的
    expect((await app.inject({ method: 'GET', url: '/api/watches' })).json()).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/api/watches?all=true' })).json()).toHaveLength(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/watches/${watch.id}` });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/watches?all=true' })).json()).toHaveLength(0);
  });

  it('重复检索式不会建两条（去重）', async () => {
    const first = (await app.inject({ method: 'POST', url: '/api/watches', payload: { query: 'KV缓存 分级 传输' } })).json();
    const second = (await app.inject({ method: 'POST', url: '/api/watches', payload: { query: 'KV缓存 分级 传输' } })).json();
    expect(second.id).toBe(first.id);
    expect((await app.inject({ method: 'GET', url: '/api/watches' })).json()).toHaveLength(1);
  });

  it('检索式过短 → 400 且不落库', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/watches', payload: { query: 'KV' } });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toContain('query');
    expect((await app.inject({ method: 'GET', url: '/api/watches' })).json()).toHaveLength(0);
  });

  it('操作不存在的巡检项 → 404（而不是静默成功）', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/api/watches/watch-nope' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/watches/watch-nope', payload: { enabled: true } })).statusCode,
    ).toBe(404);
  });

  it('未配置查新 CLI 时 sweep 返回 503，而不是假装跑完', async () => {
    await app.inject({ method: 'POST', url: '/api/watches', payload: { query: '投机解码 草稿 重建' } });
    const res = await app.inject({ method: 'POST', url: '/api/watches/sweep' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('novelty_not_configured');
  });
});
