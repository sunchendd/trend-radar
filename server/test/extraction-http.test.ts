import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tr-extract-http-'));
  // LLM 不配置：抽取走规则兜底（仍应有产出），状态端点如实上报 llmConfigured=false
  app = await buildApp(
    loadConfig({ TREND_RADAR_DATA_DIR: dir, COLLECT_MINUTES: '0', LLM_BASE_URL: '', LLM_API_KEY: '' }),
    { distDir: null, logger: false },
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('/api/extraction 契约（t21）', () => {
  it('status：默认启用、LLM 未配置如实上报、KPI 初始为零', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/extraction/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.llmConfigured).toBe(false);
    expect(body.dailyLimit).toBeGreaterThan(0);
    expect(body.pending).toBe(0);
    expect(body.extractedTotal).toBe(0);
    expect(body.pointsTotal).toBe(0);
    expect(body.todayReleases).toBe(0);
    expect(body.inflight).toBe(false);
  });

  it('run：无 LLM 走规则兜底；无数据时零产出但不报错', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/extraction/run' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.degraded).toBe(false);
    expect(body.extracted).toBe(0);
    // 关闭翻译开关后，手动抽取同样 422（同一总开关管自动处理）
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { translation: { enabled: false } } });
    const disabled = await app.inject({ method: 'POST', url: '/api/extraction/run' });
    expect(disabled.statusCode).toBe(422);
    expect(disabled.json().error.code).toBe('extraction_disabled');
  });
});
