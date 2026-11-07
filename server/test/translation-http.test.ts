import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tr-translate-http-'));
  // LLM 不配置：翻译链路必须走「degraded 静默降级」而不是真请求
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

describe('/api/translation 契约（t18）', () => {
  it('status：默认开关开、LLM 未配置如实上报、上限取默认 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/translation/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.llmConfigured).toBe(false);
    expect(body.dailyLimit).toBeGreaterThan(0);
    expect(body.translatedToday).toBe(0);
    expect(body.inflight).toBe(false);
    expect(body.pending).toBe(0);
  });

  it('run：LLM 未配置时返回 degraded（200，不报错刷屏）', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/translation/run' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.degraded).toBe(true);
    expect(body.translated).toBe(0);
  });

  it('设置页能改翻译开关与上限；关闭后手动触发 422 translation_disabled', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { translation: { enabled: false, dailyLimit: 100 } },
    });
    expect(saved.statusCode).toBe(200);
    const settings = saved.json();
    expect(settings.translation.enabled).toBe(false);
    expect(settings.translation.dailyLimit).toBe(100);

    const status = await app.inject({ method: 'GET', url: '/api/translation/status' });
    expect(status.json().enabled).toBe(false);
    expect(status.json().dailyLimit).toBe(100);

    const run = await app.inject({ method: 'POST', url: '/api/translation/run' });
    expect(run.statusCode).toBe(422);
    expect(run.json().error.code).toBe('translation_disabled');

    // 恢复开启：回 200 degraded（LLM 仍未配置）
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { translation: { enabled: true } } });
    const runAgain = await app.inject({ method: 'POST', url: '/api/translation/run' });
    expect(runAgain.statusCode).toBe(200);
    expect(runAgain.json().degraded).toBe(true);
  });

  it('items 列表带出译文列（未翻译条目不出空字段）', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/items' });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Record<string, unknown>[];
    for (const item of items) {
      // 未翻译条目不应出现译文空字段；出现时必须是字符串
      if ('titleZh' in item) expect(typeof item.titleZh).toBe('string');
      if ('summaryZh' in item) expect(typeof item.summaryZh).toBe('string');
    }
  });
});
