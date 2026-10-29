/**
 * 手工创建选题的契约测试。
 *
 * 为什么单独一个文件：LLM 不可用时（未配 key / 想自己写一条）这是唯一入口，
 * 它的校验与落库语义必须独立于「生成」那条路径被测到，否则容易在重构里悄悄退化。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tr-ideas-'));
  const config = loadConfig({ TREND_RADAR_DATA_DIR: dir, COLLECT_MINUTES: '0' });
  app = await buildApp(config, { distDir: null, logger: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const valid = {
  title: '一种基于敏感度分级的KV缓存跨设备传输方法',
  problem: '阶段分离推理中KV缓存按固定粒度整体传输，带宽受限时解码侧空转。',
  solution:
    '按层与注意力头的扰动敏感度分级；预填充端生成块级传输清单；解码端按级选择精确或量化重建；传输与解码流水重叠。',
  effect: '跨设备KV传输字节数降低不低于50%，吞吐提升不低于15%。',
  keywords: ['KV缓存', '阶段分离'],
  ipcHints: ['G06F12/0871'],
  queries: ['KV缓存 分级 传输 重建'],
  risks: ['HAWK 的异构感知传输调度'],
  focus: 'PD 分离 GPU-NPU',
};

describe('POST /api/ideas（手工创建）', () => {
  it('创建成功返回 201，并能在列表里查到（含 verdictSummary）', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/ideas', payload: valid });
    expect(created.statusCode).toBe(201);
    const idea = created.json();
    expect(idea.id).toMatch(/^idea-manual-/);
    expect(idea.status).toBe('draft');
    expect(idea.promptVersion).toBe('manual');
    expect(idea.verdictSummary?.verdict).toBe('inconclusive'); // 没查新 → 明确"无法判断"

    const list = await app.inject({ method: 'GET', url: '/api/ideas' });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((row: { id: string }) => row.id === idea.id)).toBe(true);
  });

  it('创建后导出交底书可用（章节齐全，且标注尚未查新）', async () => {
    const idea = (await app.inject({ method: 'POST', url: '/api/ideas', payload: valid })).json();
    const md = await app.inject({ method: 'GET', url: `/api/ideas/${idea.id}/disclosure` });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(md.body).toContain('## 一、发明名称');
    expect(md.body).toContain('本选题尚未查新');
  });

  it('IPC 号格式非法 → 400 且指明字段，不落库', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/ideas',
      payload: { ...valid, ipcHints: ['不是IPC号'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toContain('ipcHints');
    const list = await app.inject({ method: 'GET', url: '/api/ideas' });
    expect(list.json()).toHaveLength(0);
  });

  it('标题过短 / 方案过短 → 400（拦住"一句话选题"污染工作台）', async () => {
    const shortTitle = await app.inject({ method: 'POST', url: '/api/ideas', payload: { ...valid, title: '短' } });
    expect(shortTitle.statusCode).toBe(400);
    const shortSolution = await app.inject({
      method: 'POST',
      url: '/api/ideas',
      payload: { ...valid, solution: '太短' },
    });
    expect(shortSolution.statusCode).toBe(400);
  });

  it('创建后可登记查新并重算出判读（手工链路闭环）', async () => {
    const idea = (await app.inject({ method: 'POST', url: '/api/ideas', payload: valid })).json();
    const nov = await app.inject({
      method: 'POST',
      url: `/api/ideas/${idea.id}/novelty`,
      payload: { query: 'KV缓存 分级 传输', hits: 2, topAssignees: '某公司:2' },
    });
    expect(nov.statusCode).toBe(200);
    expect(nov.json().verdictSummary.verdict).toBe('opportunity');
    expect(nov.json().status).toBe('verified');
  });
});
