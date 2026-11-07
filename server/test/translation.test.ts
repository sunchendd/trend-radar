import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { openDb } from '../src/store/db.js';
import { insertItems, listTranslationCandidates, saveTranslations, translationCountToday } from '../src/store/queries.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Item } from '../src/types.js';
import {
  containsCjk,
  contentKey,
  needsTranslation,
  runTranslationPass,
  type TranslateLlm,
} from '../src/translation/translate.js';

let dir: string;
let db: DatabaseSync;

function seedItem(overrides: Partial<Item> & { id: string }): void {
  const item: Item = {
    sourceId: 'arxiv-test',
    kind: 'paper',
    title: 'Speculative decoding for LLM serving',
    url: `https://example.org/${overrides.id}`,
    summary: 'A survey of draft-based acceleration techniques.',
    authors: [],
    publishedAt: '2026-11-05T00:00:00.000Z',
    fetchedAt: '2026-11-05T00:00:00.000Z',
    score: 60,
    scoreReasons: [],
    keywords: [],
    ...overrides,
  };
  insertItems(db, [item]);
}

/** 可编程假 LLM：按收到的 user prompt 里的 id 返回指定译文；可注入坏输出 */
function fakeLlm(behavior: {
  titles?: Map<string, string>;
  failOnce?: { remaining: number };
  raw?: string;
}): TranslateLlm & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete(messages) {
      calls += 1;
      if (behavior.failOnce && behavior.failOnce.remaining > 0) {
        behavior.failOnce.remaining -= 1;
        return '这不是 JSON';
      }
      if (behavior.raw !== undefined) return behavior.raw;
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      const ids = [...user.matchAll(/\{"id":"([^"]+)"/g)].map((m) => m[1]!);
      const out = ids.map((id) => ({
        id,
        titleZh: behavior.titles?.get(id) ?? `「${id}」的中文标题`,
        summaryZh: `「${id}」的中文摘要`,
      }));
      return JSON.stringify(out);
    },
  };
}

const baseConfig = () => loadConfig({ TREND_RADAR_DATA_DIR: dir, LLM_BASE_URL: '', LLM_API_KEY: '', COLLECT_MINUTES: '0' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tr-translate-'));
  db = openDb(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('迁移 v3（t18）', () => {
  it('新库直接建到 v3，items 带翻译列；重复打开不报错', () => {
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBeGreaterThanOrEqual(3);
    // 四列都存在（SELECT 缺列会直接抛错）
    expect(() => db.prepare('SELECT title_zh, summary_zh, translated_at, zh_key FROM items LIMIT 0').all()).not.toThrow();

    const reopened = openDb(dir);
    const again = reopened.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(again.user_version).toBe(version.user_version);
    reopened.close();
  });

  it('旧数据（无译文）读取兼容：zh 字段为 undefined 而不是空串', () => {
    seedItem({ id: 'old-1' });
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get('old-1') as Record<string, unknown>;
    expect(row['title_zh']).toBeNull();
    expect(row['translated_at']).toBeNull();
  });
});

describe('语言检测与候选判定', () => {
  it('含 CJK 即视为中文（标题或摘要任一命中都跳过）', () => {
    expect(containsCjk('量子纠错 code')).toBe(true);
    expect(containsCjk('pure english text')).toBe(false);
    expect(
      needsTranslation({ kind: 'paper', title: 'Attention Is All You Need', summary: '包含中文的摘要', zhKey: null }),
    ).toBe(false);
    expect(
      needsTranslation({ kind: 'paper', title: '注意力机制综述', summary: '', zhKey: null }),
    ).toBe(false);
  });

  it('空文本与不可翻译 kind 不进候选', () => {
    expect(needsTranslation({ kind: 'paper', title: '', summary: '', zhKey: null })).toBe(false);
    expect(needsTranslation({ kind: 'idea', title: 'x', summary: 'y', zhKey: null })).toBe(false);
  });

  it('已翻译且内容未变 → 跳过；内容变更 → 重译', () => {
    const item = { kind: 'paper', title: 'T', summary: 'S' };
    const key = contentKey(item);
    expect(needsTranslation({ ...item, zhKey: key })).toBe(false);
    expect(needsTranslation({ ...item, summary: 'S changed', zhKey: key })).toBe(true);
    expect(needsTranslation({ ...item, zhKey: null })).toBe(true);
  });
});

describe('runTranslationPass（LLM mock，不发真请求）', () => {
  it('批量翻译并落库；第二轮幂等跳过；中文原文计 skippedCjk', async () => {
    seedItem({ id: 'a1', title: 'Paper A', summary: 'Summary A' });
    seedItem({ id: 'a2', title: 'Paper B', summary: 'Summary B' });
    seedItem({ id: 'cn1', title: '中文论文标题', summary: '中文摘要' });

    const llm = fakeLlm({});
    const config = baseConfig();
    const first = await runTranslationPass(config, { db, llm, batchSize: 2 });

    expect(first.degraded).toBe(false);
    expect(first.skippedCjk).toBe(1);
    expect(first.requested).toBe(2);
    expect(first.translated).toBe(2);
    expect(llm.calls).toBe(1); // 两条合一批：一次请求

    const candidates = listTranslationCandidates(db, 10);
    const a1 = candidates.find((c) => c.id === 'a1');
    expect(a1?.titleZh).toBe('「a1」的中文标题');
    expect(a1?.translatedAt).not.toBeNull();

    // 第二轮：已翻译未变更 → alreadyDone=2，不调 LLM
    const second = await runTranslationPass(config, { db, llm, batchSize: 2 });
    expect(second.requested).toBe(0);
    expect(second.alreadyDone).toBe(2);
    expect(llm.calls).toBe(1);
  });

  it('每日上限是硬闸：配额用尽报 capReached，超出配额的候选不调 LLM', async () => {
    for (let i = 0; i < 5; i += 1) seedItem({ id: `cap-${i}` });
    const llm = fakeLlm({});
    const config = baseConfig();
    const pass = await runTranslationPass(config, { db, llm, batchSize: 2, dailyLimit: 3 });
    expect(pass.translated).toBe(3);
    expect(pass.capReached).toBe(true);
    // 再来一轮：今天已翻 3 条 = 上限 → 直接 capReached，零请求
    const second = await runTranslationPass(config, { db, llm, batchSize: 2, dailyLimit: 3 });
    expect(second.capReached).toBe(true);
    expect(second.translated).toBe(0);
    expect(llm.calls).toBe(2); // 5 候选取 3 条 = 2 批（2+1），没有多余请求
  });

  it('LLM 未配置 → degraded 静默降级，不抛错', async () => {
    seedItem({ id: 'd1' });
    const config = loadConfig({ TREND_RADAR_DATA_DIR: dir, LLM_BASE_URL: '', LLM_API_KEY: '' });
    const pass = await runTranslationPass(config, { db });
    expect(pass.degraded).toBe(true);
    expect(pass.translated).toBe(0);
  });

  it('坏输出重试一次后仍失败 → 记 failed 留待下轮；好输出后能补翻', async () => {
    seedItem({ id: 'r1' });
    const failing = fakeLlm({ failOnce: { remaining: 2 } }); // 首次+重试都坏
    const config = baseConfig();
    const bad = await runTranslationPass(config, { db, llm: failing });
    expect(bad.failed).toBe(1);
    expect(bad.translated).toBe(0);

    const good = fakeLlm({});
    const ok = await runTranslationPass(config, { db, llm: good });
    expect(ok.translated).toBe(1);
    expect(listTranslationCandidates(db, 5).find((c) => c.id === 'r1')?.titleZh).toContain('中文标题');
  });

  it('内容变更（zhKey 不一致）触发重译并覆盖旧译文', async () => {
    seedItem({ id: 'm1', title: 'Original title', summary: 'Original summary' });
    const llm = fakeLlm({});
    const config = baseConfig();
    await runTranslationPass(config, { db, llm });
    const before = listTranslationCandidates(db, 5).find((c) => c.id === 'm1');
    expect(before?.titleZh).toBe('「m1」的中文标题');

    // 模拟内容变更：直接改原文 + 清掉指纹对齐（zhKey 留旧值）
    db.prepare('UPDATE items SET title = ? WHERE id = ?').run('Renamed title', 'm1');
    const after = await runTranslationPass(config, { db, llm });
    expect(after.requested).toBe(1);
    const updated = listTranslationCandidates(db, 5).find((c) => c.id === 'm1');
    expect(updated?.zhKey).toBe(contentKey({ title: 'Renamed title', summary: 'Original summary' }));
  });

  it('saveTranslations 只命中存在的 id（并发下条目被清理时少记）', () => {
    seedItem({ id: 'keep' });
    // translatedAt 必须是「现在」：translationCountToday 按本地今天对账，
    // 硬编码历史日期的行不会被计入（日期一翻就是假失败）
    const now = new Date().toISOString();
    const saved = saveTranslations(db, [
      { id: 'keep', titleZh: '标题', summaryZh: '摘要', translatedAt: now, zhKey: 'k1' },
      { id: 'gone', titleZh: '标题', summaryZh: '摘要', translatedAt: now, zhKey: 'k2' },
    ]);
    expect(saved).toBe(1);
    expect(translationCountToday(db)).toBe(1);
  });
});

describe('t24：thinking 禁用 + 全文覆盖', () => {
  it('真实客户端：options.thinking=disabled 时请求体携带 thinking:{type:"disabled"}', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: '译文' } }] }), { status: 200 });
    }) as typeof fetch;

    const { createLlm } = await import('../src/ideas/llm.js');
    const config = loadConfig({ LLM_BASE_URL: 'https://llm.example/v1', LLM_API_KEY: 'sk-1' });
    const llm = createLlm(config, { fetch: fakeFetch, sleep: async () => {} });
    await llm.complete([{ role: 'user', content: 'hi' }], { thinking: 'disabled' });
    expect(bodies[0]?.thinking).toEqual({ type: 'disabled' });

    await llm.complete([{ role: 'user', content: 'hi' }]);
    expect(bodies[1]?.thinking).toBeUndefined();
  });

  it('翻译批次默认带 thinking disabled（可经 config.llm.thinkingDisabled 关掉）', async () => {
    seedItem({ id: 'think-1', title: 'Thinking test', summary: 'Body text.' });
    const seenOptions: { thinking?: string }[] = [];
    const llm: TranslateLlm = {
      async complete(_messages, options) {
        seenOptions.push({ thinking: options?.thinking });
        return JSON.stringify([{ id: 'think-1', titleZh: '标题', summaryZh: '摘要' }]);
      },
    };
    const config = baseConfig();
    await runTranslationPass(config, { db, llm });
    expect(seenOptions[0]?.thinking).toBe('disabled');

    const off = loadConfig({ TREND_RADAR_DATA_DIR: dir, TREND_LLM_THINKING_DISABLED: '0' });
    await runTranslationPass({ ...off }, { db, llm });
    expect(seenOptions[1]?.thinking).toBeUndefined();
  });

  it('覆盖扩大：release 条目全文进 prompt（kind 标记 + 超 1200 字不截断）', async () => {
    const longNote = `# v9.9.0\n\n${'A very long release note line. '.repeat(80)}`; // ~2900 字符
    seedItem({ id: 'rel-full', kind: 'release', title: 'vLLM v9.9.0', summary: longNote });

    let capturedUser = '';
    const llm: TranslateLlm = {
      async complete(messages, options) {
        capturedUser = messages.find((m) => m.role === 'user')?.content ?? '';
        void options;
        const ids = [...capturedUser.matchAll(/\{"id":"([^"]+)"/g)].map((m) => m[1]!);
        return JSON.stringify(ids.map((id) => ({ id, titleZh: `标题 ${id}`, summaryZh: `## v9.9.0 中文全文译本` })));
      },
    };
    const config = baseConfig();
    const pass = await runTranslationPass(config, { db, llm, batchSize: 4 });
    expect(pass.translated).toBe(1);
    // kind 标记随条目进 prompt（release 走全文翻译指令）
    expect(capturedUser).toContain('"kind":"release"');
    // 全文不再按 1200 截断：长 note 的尾部内容仍在 prompt 里
    expect(capturedUser.length).toBeGreaterThan(1200);
    expect(capturedUser).toContain(longNote.slice(-60, -50));
    const row = db.prepare('SELECT summary_zh FROM items WHERE id = ?').get('rel-full') as { summary_zh: string };
    expect(row.summary_zh).toContain('v9.9.0');
  });
});
