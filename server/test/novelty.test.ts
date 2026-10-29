/**
 * novelty.ts 的测试：完全不碰真实浏览器/CLI，用注入的 CommandRunner 模拟智慧芽输出。
 *
 * 重点保护两条纪律（都是生产踩过的坑）：
 *   1. CLI 跑不起来 → NoveltyNotConfiguredError（HTTP 503），绝不静默返回空数组；
 *   2. 全零 → 自动减词重试一次并标注「（减词）」，仍全零交给 verdict 判 inconclusive。
 */

import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import {
  NoveltyNotConfiguredError,
  buildRetryCandidates,
  parseHits,
  relaxQueries,
  runNovelty,
} from '../src/ideas/novelty.js';
import { synonymRewrites } from '../src/ideas/prompts.js';
import { verdict } from '../src/ideas/verdict.js';

const makeConfig = (over: Partial<AppConfig['novelty']> = {}): AppConfig => ({
  dataDir: '/tmp/trend-radar-test',
  port: 8787,
  host: '127.0.0.1',
  collectMinutes: 0,
  minKeepScore: 0,
  limitPerSource: 10,
  ttlDays: 30,
  llm: { baseUrl: '', apiKey: '', model: 'm', temperature: 0.7, maxTokens: 8000 },
  // 不带斜杠 → 跳过文件存在性检查，交给注入的 runner
  novelty: { command: 'batch-search-shim', agreeKick: false, ...over },
});

const idea = {
  title: '一种基于草稿置信度分级的投机解码动态退出方法',
  queries: ['投机解码 草稿 置信度 退出', '草稿模型 接受率 动态 调整', '解码 缓存 命中 分级 调度'],
};

describe('parseHits：命中数解析', () => {
  it('千分位字符串 / 数字 / null 都要正确', () => {
    expect(parseHits('1,234')).toBe(1234);
    expect(parseHits('509')).toBe(509);
    expect(parseHits(7)).toBe(7);
    expect(parseHits(null)).toBe(null);
    expect(parseHits(undefined)).toBe(null);
    expect(parseHits('')).toBe(null);
    expect(parseHits('—')).toBe(null); // 解析失败不是 0
  });
});

describe('relaxQueries：减词纪律', () => {
  it('每条去掉最后一个词，仍 ≥3 词', () => {
    expect(relaxQueries(['投机解码 草稿 置信度 退出', '草稿模型 接受率 动态 调整'])).toEqual([
      '投机解码 草稿 置信度',
      '草稿模型 接受率 动态',
    ]);
  });

  it('已经 3 词就整体放弃重试（混着跑会让命中数不可比）', () => {
    expect(relaxQueries(['投机解码 草稿 置信度', '草稿模型 接受率 动态 调整'])).toBe(null);
  });
});

describe('runNovelty：CLI 对接', () => {
  it('解析 q/count/apps/pats，hits 为 null 时保留 null', async () => {
    const calls: string[][] = [];
    const records = await runNovelty(makeConfig(), idea, undefined, {
      now: () => new Date('2026-10-29T12:00:00.000Z'),
      runCommand: async (_command, args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify([
            { q: args[0], count: '1,234', apps: ['华为技术有限公司:21', '腾讯科技（深圳）有限公司:17'], pats: ['CN123456A | 一种解码方法'] },
            { q: args[1], count: null, apps: [], pats: [] },
            { q: args[2], count: '3', apps: ['中国电信:2'], pats: [] },
          ]),
          stderr: '[1/3] 投机解码\n',
        };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(idea.queries); // 每条检索式一个 argv
    expect(records).toHaveLength(3);

    expect(records[0]).toMatchObject({
      query: '投机解码 草稿 置信度 退出',
      hits: 1234,
      topAssignees: '华为技术有限公司:21、腾讯科技（深圳）有限公司:17',
      site: 'zhihuiya',
      at: '2026-10-29T12:00:00.000Z',
    });
    expect(records[0]!.note).toContain('样例 CN123456A');
    expect(records[1]!.hits).toBe(null);
    expect(records[1]!.note).toContain('解析失败');
    expect(records[2]!.hits).toBe(3);
  });

  it('全零 → 自动减词重试一次，结果标注「（减词）」', async () => {
    const calls: string[][] = [];
    const records = await runNovelty(makeConfig(), idea, undefined, {
      runCommand: async (_command, args) => {
        calls.push(args);
        const second = calls.length === 2;
        // 首轮全零，减词后命中数出来了
        return {
          stdout: JSON.stringify(args.map((q) => ({ q, count: second ? '4' : '0', apps: ['华为技术有限公司:2'], pats: [] }))),
          stderr: '',
        };
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['投机解码 草稿 置信度', '草稿模型 接受率 动态', '解码 缓存 命中 分级']);
    expect(records.map((r) => r.hits)).toEqual([4, 4, 4]);
    expect(records[0]!.query).toBe('投机解码 草稿 置信度（减词）');
    expect(records[0]!.note).toContain('原检索式全零');
    expect(verdict(records).verdict).toBe('opportunity');
  });

  it('减词后仍全零 → 交给 verdict 判 inconclusive（不是技术空白）', async () => {
    const records = await runNovelty(makeConfig(), idea, undefined, {
      runCommand: async (_command, args) => ({
        stdout: JSON.stringify(args.map((q) => ({ q, count: 0, apps: [], pats: [] }))),
        stderr: '',
      }),
    });

    expect(records.every((r) => r.hits === 0)).toBe(true);
    const outcome = verdict(records);
    expect(outcome.verdict).toBe('inconclusive');
    expect(outcome.reason).toContain('先怀疑检索式/术语，再谈空白');
  });

  it('CLI 失败（非 0 退出/超时）→ NoveltyNotConfiguredError（绝不静默返回空）', async () => {
    let caught: unknown;
    try {
      await runNovelty(makeConfig(), idea, undefined, {
        runCommand: async () => {
          throw new Error('CLI 退出码 2：未登录（跳到了 account.zhihuiya.com）');
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NoveltyNotConfiguredError);
    expect((caught as NoveltyNotConfiguredError).code).toBe('novelty_not_configured');
    expect((caught as Error).message).toContain('未登录');
  });

  it('CLI 路径不存在 → 立刻 503 语义错误', async () => {
    await expect(
      runNovelty(makeConfig({ command: '/nope/batch_search.sh' }), idea),
    ).rejects.toBeInstanceOf(NoveltyNotConfiguredError);
  });

  it('未配置 command → 503 语义错误', async () => {
    await expect(runNovelty(makeConfig({ command: '   ' }), idea)).rejects.toMatchObject({
      code: 'novelty_not_configured',
    });
  });

  it('CLI 返回空数组 → 视作环境不可用，而不是「零命中」', async () => {
    await expect(
      runNovelty(makeConfig(), idea, undefined, {
        runCommand: async () => ({ stdout: '[]', stderr: '' }),
      }),
    ).rejects.toMatchObject({ code: 'novelty_not_configured' });
  });

  it('没有检索式 → 普通错误（不是配置问题）', async () => {
    await expect(runNovelty(makeConfig(), { title: 'x', queries: [] })).rejects.toThrow(/没有可用的查新检索式/u);
  });

  it('最多跑 5 条检索式（智慧芽一批 5–6 条最稳）', async () => {
    const six = [...idea.queries, '推理 服务 副本 扩容', '显存 分页 回收 命中'];
    let seen: string[] = [];
    await runNovelty(makeConfig(), { title: 'x', queries: six }, undefined, {
      runCommand: async (_command, args) => {
        seen = args;
        return { stdout: JSON.stringify(args.map((q) => ({ q, count: 9, apps: [], pats: [] }))), stderr: '' };
      },
    });

    expect(seen).toHaveLength(5);
  });

  it('agreeKick 打开时透传 ZHY_AGREE_KICK=1 给 CLI', async () => {
    let env: NodeJS.ProcessEnv = {};
    await runNovelty(makeConfig({ agreeKick: true }), idea, undefined, {
      runCommand: async (_command, args, options) => {
        env = options.env;
        return { stdout: JSON.stringify(args.map((q) => ({ q, count: 9, apps: [], pats: [] }))), stderr: '' };
      },
    });

    expect(env.ZHY_AGREE_KICK).toBe('1');
  });
});

describe('同义改写候选（实测会压低命中数的词）', () => {
  it('KV压缩 → KV缓存，只出一条改写（不重复出「压缩→缓存」）', () => {
    expect(synonymRewrites('KV压缩 分页 块')).toEqual([{ from: 'KV压缩', to: 'KV缓存', text: 'KV缓存 分页 块' }]);
  });

  it('没有可改写的词 → 空数组', () => {
    expect(synonymRewrites('草稿模型 接受率 动态')).toEqual([]);
  });

  it('重试候选：主候选与首轮一一对齐，同义改写作为第二候选补在后面', () => {
    const candidates = buildRetryCandidates(['KV压缩 分页 块 管理', '草稿模型 接受率 动态']);

    expect(candidates).toEqual([
      { query: 'KV压缩 分页 块', kind: 'relaxed' },
      { query: '草稿模型 接受率 动态', kind: 'original' },
      { query: 'KV缓存 分页 块 管理', kind: 'synonym', from: 'KV压缩', to: 'KV缓存' },
    ]);
  });
});

describe('runNovelty：全零后的同义改写重试', () => {
  it('3 词无法减词 → 走同义改写，记录标注「（同义改写）」', async () => {
    const calls: string[][] = [];
    const records = await runNovelty(makeConfig(), { title: 'x', queries: ['KV压缩 分页 块', '草稿模型 接受率 动态'] }, undefined, {
      runCommand: async (_command, args) => {
        calls.push(args);
        const retry = calls.length === 2;
        return {
          stdout: JSON.stringify(args.map((q) => ({ q, count: retry ? '6' : '0', apps: ['华为技术有限公司:2'], pats: [] }))),
          stderr: '',
        };
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(['KV缓存 分页 块', '草稿模型 接受率 动态']);

    expect(records[0]!.query).toBe('KV缓存 分页 块（同义改写）');
    expect(records[0]!.note).toContain('同义改写「KV压缩」→「KV缓存」');
    expect(records[0]!.hits).toBe(6);
    // 无法改写的检索式原样重跑，保证命中数表与首轮可对照
    expect(records[1]!.query).toBe('草稿模型 接受率 动态');
    expect(records[1]!.note).toContain('原样重跑');
    expect(verdict(records).verdict).toBe('opportunity');
  });

  it('既减不了词也没有同义词 → 不白等第二轮（只调一次 CLI）', async () => {
    let calls = 0;
    const records = await runNovelty(makeConfig(), { title: 'x', queries: ['草稿模型 接受率 动态'] }, undefined, {
      runCommand: async (_command, args) => {
        calls += 1;
        return { stdout: JSON.stringify(args.map((q) => ({ q, count: 0, apps: [], pats: [] }))), stderr: '' };
      },
    });

    expect(calls).toBe(1);
    expect(records.every((record) => record.hits === 0)).toBe(true);
    expect(verdict(records).verdict).toBe('inconclusive');
  });
});
