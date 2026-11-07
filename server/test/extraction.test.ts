import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { openDb } from '../src/store/db.js';
import { insertItems, listExtractionCandidates, listItems, releaseKpi, saveExtractions } from '../src/store/queries.js';
import type { DatabaseSync, Row } from 'node:sqlite';
import {
  needsExtraction,
  pointsKey,
  ruleExtract,
  runExtractionPass,
} from '../src/extraction/releases.js';

let dir: string;
let db: DatabaseSync;

const NOTE = `## v0.3.0

### New Features
- Added scheduler support for prefill-decode disaggregation (#1201)
- KV cache offload to host memory with async eviction (#1188)
- New FP8 quantization kernels for Blackwell (#1233)

### Bug Fixes
- Fix tensor parallelism deadlock on H100 x8 (#1210)
- speculative decoding draft length mismatch (#1180)
`;

function seedRelease(id: string, title: string, note: string): void {
  insertItems(db, [
    {
      id,
      sourceId: 'github-vllm-releases',
      kind: 'release',
      title,
      url: `https://github.com/vllm-project/vllm/releases/tag/${id}`,
      summary: note,
      authors: [],
      publishedAt: '2026-11-05T00:00:00.000Z',
      fetchedAt: '2026-11-05T00:00:00.000Z',
      score: 60,
      scoreReasons: [],
      keywords: [],
    },
  ]);
}

const baseConfig = () => loadConfig({ TREND_RADAR_DATA_DIR: dir, LLM_BASE_URL: '', LLM_API_KEY: '', COLLECT_MINUTES: '0' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tr-extract-'));
  db = openDb(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('规则兜底抽取（无 LLM 也有产出）', () => {
  it('解析 Features section + 关键词归类（调度/KV/量化/并行/投机）', () => {
    const points = ruleExtract('v0.3.0', NOTE);
    expect(points.length).toBeGreaterThanOrEqual(4);
    const categories = new Set(points.map((p) => p.category));
    expect(categories.has('调度')).toBe(true);
    expect(categories.has('KV')).toBe(true);
    expect(categories.has('量化')).toBe(true);
    // 硬件（H100）与投机（speculative）至少出现一个
    expect(categories.has('硬件') || categories.has('投机')).toBe(true);
    for (const point of points) expect(point.zh.length).toBeGreaterThan(3);
  });

  it('无 section 时退化为关键词全文捞取；title-only release 落标题点', () => {
    const points = ruleExtract('v1.2.3 with new FP8 kernels', 'This release adds FP8 kernels and CUDA graph capture.');
    expect(points.length).toBeGreaterThan(0);
    expect(points.some((p) => p.category === '量化' || p.category === '算子')).toBe(true);
    // 完全无内容 → 空数组；title-only release → 标题兜底点（工程动态卡片不会空着）
    expect(ruleExtract('', '')).toEqual([]);
    expect(ruleExtract('vLLM v0.7.0 release', '')).toEqual([{ category: '其他', zh: 'vLLM v0.7.0 release' }]);
  });

  it('候选判定：points_key 一致跳过，正文变更重抽', () => {
    const key = pointsKey({ title: 'v0.3.0', summary: NOTE });
    expect(needsExtraction({ title: 'v0.3.0', summary: NOTE, pointsKey: key })).toBe(false);
    expect(needsExtraction({ title: 'v0.3.0', summary: 'changed', pointsKey: key })).toBe(true);
    expect(needsExtraction({ title: 'v0.3.0', summary: NOTE, pointsKey: null })).toBe(true);
    expect(needsExtraction({ title: 'v0.3.0', summary: '   ', pointsKey: null })).toBe(false);
  });
});

describe('runExtractionPass（LLM mock，不发真请求）', () => {
  it('LLM 路径：结构化 JSON 落库；第二轮幂等跳过', async () => {
    seedRelease('rel-1', 'vLLM v0.3.0', NOTE);
    seedRelease('rel-2', 'SGLang v0.2.9', NOTE);
    let calls = 0;
    const llm = {
      async complete(messages) {
        calls += 1;
        const user = messages.find((m) => m.role === 'user')?.content ?? '';
        const ids = [...user.matchAll(/\{"id":"([^"]+)"/g)].map((m) => m[1]!);
        void messages;
        return JSON.stringify({
          points: [
            { category: '调度', zh: '新增 prefill-decode 分离调度' },
            { category: 'KV', zh: 'KV cache 支持主机内存异步卸载' },
          ],
          summaryZh: '本版本引入 PD 分离与 KV 卸载。',
        });
      },
    };

    const config = baseConfig();
    const pass = await runExtractionPass(config, { db, llm: llm as TranslateLlmLike, batchSize: 2 });
    expect(pass.degraded).toBe(false);
    expect(pass.requested).toBe(2);
    expect(pass.extracted).toBe(2);
    expect(pass.viaLlm).toBe(2);
    expect(calls).toBe(1); // 两合一批

    const candidates = listExtractionCandidates(db, 10);
    expect(candidates.find((c) => c.id === 'rel-1')?.pointsZh?.[0]?.category).toBe('调度');
    const kpi = releaseKpi(db);
    expect(kpi.extractedTotal).toBe(2);
    expect(kpi.pointsTotal).toBe(4);

    // 第二轮：指纹一致 → 幂等跳过
    const second = await runExtractionPass(config, { db, llm: llm as TranslateLlmLike });
    expect(second.requested).toBe(0);
    expect(second.extracted).toBe(0);
  });

  it('规则兜底路径：无 LLM（未配置 + 不注入）也产出，且不消耗 LLM 配额', async () => {
    seedRelease('rule-1', 'vLLM v0.4.0', NOTE);
    const config = baseConfig(); // LLM 未配置
    const pass = await runExtractionPass(config, { db });
    expect(pass.degraded).toBe(false);
    expect(pass.extracted).toBe(1);
    expect(pass.viaRules).toBe(1);
    expect(pass.viaLlm).toBe(0);
  });

  it('与翻译共用配额：翻译+抽取今日合计达上限 → LLM 路径 capReached（规则路径不受限）', async () => {
    seedRelease('quota-1', 'vLLM v0.5.0', NOTE);
    seedRelease('quota-2', 'SGLang v0.5.1', NOTE);
    // 预置：今天已翻 4 条 + 已抽 0，上限 5 → LLM 路径只剩 1，配 2 候选也不超
    const now = new Date();
    db.prepare(
      `INSERT INTO items (id, source_id, kind, title, url, url_key, summary, authors, published_at, fetched_at, score, score_reasons, keywords, translated_at)
       VALUES ('tx-1','s','paper','t','u','u1','','[]','2026-11-05T00:00:00.000Z','2026-11-05T00:00:00.000Z',0,'[]','[]', ?),
              ('tx-2','s','paper','t','u','u2','','[]','2026-11-05T00:00:00.000Z','2026-11-05T00:00:00.000Z',0,'[]','[]', ?),
              ('tx-3','s','paper','t','u','u3','','[]','2026-11-05T00:00:00.000Z','2026-11-05T00:00:00.000Z',0,'[]','[]', ?),
              ('tx-4','s','paper','t','u','u4','','[]','2026-11-05T00:00:00.000Z','2026-11-05T00:00:00.000Z',0,'[]','[]', ?)`,
    ).run(now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString());

    let calls = 0;
    const llm = {
      complete(messages: { role: string; content: string }[]) {
        calls += 1;
        void messages;
        return JSON.stringify({ points: [{ category: '其他', zh: '要点' }] });
      },
    } as TranslateLlmLike;
    void llm;

    const config = baseConfig();
    const llmStub = {
      complete: async (messages: { role: string; content: string }[]) => {
        calls += 1;
        const ids = [...messages.find((m) => m.role === 'user')!.content.matchAll(/\{"id":"([^"]+)"/g)].map((m) => m[1]!);
        return JSON.stringify({ points: ids.map((id) => ({ category: '其他', zh: `要点 ${id}` })) });
      },
    };
    const pass = await runExtractionPass(config, { db, llm: llmStub, dailyLimit: 5, batchSize: 2 });
    expect(pass.capReached).toBe(true);
    // 共享池 5 - 4 已翻译 = 1：只有 1 条走 LLM，超配额的那条自动落规则兜底
    expect(pass.viaLlm).toBe(1);
    expect(pass.viaRules).toBe(1);
    expect(pass.extracted).toBe(2);
    expect(calls).toBe(1);
  });

  it('内容变更（points_key 不一致）触发重抽并覆盖', async () => {
    seedRelease('re-1', 'vLLM v0.6.0', NOTE);
    const config = baseConfig();
    await runExtractionPass(config, { db });
    db.prepare('UPDATE items SET summary = ? WHERE id = ?').run(`${NOTE}\n- NEW: speculative decoding MTP support`, 're-1');
    const llm = {
      complete: async () => JSON.stringify({ points: [{ category: '投机', zh: '新增 MTP 投机解码支持' }] }),
    } as TranslateLlmLike;
    const pass = await runExtractionPass(config, { db, llm });
    expect(pass.requested).toBe(1);
    const row = db.prepare('SELECT points_zh FROM items WHERE id = ?').get('re-1') as Row;
    expect(String(row['points_zh'])).toContain('投机');
  });

  it('存储直写只命中存在的 id', () => {
    seedRelease('keep-1', 't', NOTE);
    const saved = saveExtractions(db, [
      { id: 'keep-1', pointsZh: [{ category: '其他', zh: 'x' }], pointsAt: '2026-11-05T00:00:00.000Z', pointsKey: 'k' },
      { id: 'ghost', pointsZh: [{ category: '其他', zh: 'y' }], pointsAt: '2026-11-05T00:00:00.000Z', pointsKey: 'k' },
    ]);
    expect(saved).toBe(1);
  });
});

describe('新闻页过滤契约（t19/t21）', () => {
  it('#/news 查询口径（kinds=news）不含 release；#/releases 口径只含 release；论文页不受影响', () => {
    seedRelease('rel-filter', 'vLLM v1.0.0', NOTE);
    insertItems(db, [
      {
        id: 'news-1',
        sourceId: 'rss-36kr',
        kind: 'news',
        title: '行业新闻标题',
        url: 'https://example.org/news-1',
        summary: '行业动态',
        authors: [],
        publishedAt: '2026-11-05T00:00:00.000Z',
        fetchedAt: '2026-11-05T00:00:00.000Z',
        score: 50,
        scoreReasons: [],
        keywords: [],
      },
      {
        id: 'paper-1',
        sourceId: 'arxiv-x',
        kind: 'paper',
        title: 'Paper title',
        url: 'https://example.org/paper-1',
        summary: 'Abstract',
        authors: [],
        publishedAt: '2026-11-05T00:00:00.000Z',
        fetchedAt: '2026-11-05T00:00:00.000Z',
        score: 70,
        scoreReasons: [],
        keywords: [],
      },
    ]);

    expect(listItems(db, { kinds: ['news'] }).items.map((i) => i.kind)).toEqual(['news']);
    expect(listItems(db, { kinds: ['release'] }).items.map((i) => i.kind)).toEqual(['release']);
    // 打分/选题读全量（不带 kinds 过滤）：三条都在
    expect(listItems(db, {}).total).toBe(3);
    expect(listItems(db, { kinds: ['paper'] }).items.map((i) => i.kind)).toEqual(['paper']);
  });
});
