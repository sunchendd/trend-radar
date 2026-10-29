import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import type { Item } from '../src/types.js';
import {
  IdeaGenerationError,
  MAX_REASON_CHARS,
  PROMPT_VERSION,
  generateIdeas,
  titleSimilarity,
  validateDraft,
  type IdeaLlm,
} from '../src/ideas/pipeline.js';
import type { ChatMessage } from '../src/ideas/llm.js';
import { PROMPT_VERSION as PROMPT_VERSION_FROM_PROMPTS } from '../src/ideas/prompts.js';

const config: AppConfig = {
  dataDir: '/tmp/trend-radar-test',
  port: 8787,
  host: '127.0.0.1',
  collectMinutes: 0,
  minKeepScore: 0,
  limitPerSource: 10,
  ttlDays: 30,
  // 注入了假 LLM，这里留空即可（真实路径会抛 LlmNotConfiguredError）
  llm: { baseUrl: '', apiKey: '', model: 'test-model', temperature: 0.7, maxTokens: 8000 },
  novelty: { command: '', agreeKick: false },
};

const makeItem = (index: number, score: number, title: string): Item => ({
  id: `it-${String(index).padStart(2, '0')}`,
  sourceId: 'arxiv-kv',
  kind: 'paper',
  title,
  url: `https://arxiv.org/abs/2610.${String(index).padStart(4, '0')}`,
  summary: 'KV 缓存分页与投机解码相关的摘要内容。',
  authors: ['A. Author'],
  publishedAt: '2026-10-20T00:00:00.000Z',
  fetchedAt: '2026-10-29T00:00:00.000Z',
  score,
  scoreReasons: [],
  keywords: ['kv', 'speculative'],
});

// 15 条，分数阶梯下降：picked[0]=it-01，picked[1]=it-02 ……
const items: Item[] = Array.from({ length: 15 }, (_, i) => makeItem(i + 1, 100 - i, `情报条目 ${i + 1}：投机解码与 KV 缓存`));

/** 一条各字段都合格的口径样例（①②③ + 量化效果 + 等词数检索式 + 合法 IPC） */
const validDraft = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: '一种基于草稿置信度分级的投机解码动态退出方法',
  problem: '现有投机解码按固定最大草稿长度生成候选，草稿被接受概率在高熵阶段骤降，验证开销反向抬高尾时延，且无法区分简单续写与困难推理。',
  solution:
    '① 草稿阶段逐 token 计算草稿模型与目标模型的 top-1 概率差，得到置信度余量；' +
    '② 以滑动窗口统计被拒率，超阈值即按阶梯下调后续草稿长度，跌破下限则本步回退到目标模型单步解码；' +
    '③ 将置信度余量与 KV cache 分页块命中状态联合判定，命中块保留长草稿、未命中块走短草稿路径。',
  effect: '吞吐由 1820 token/s 提升至 4190 token/s（2.3 倍），P99 首 token 时延由 480ms 降至 302ms（-37%）。',
  keywords: ['投机解码', '草稿模型', '置信度分级'],
  ipcHints: ['G06F9/50', 'G06F12/0871'],
  queries: ['投机解码 草稿 置信度 退出', '草稿模型 接受率 动态 调整', '解码 缓存 命中 分级 调度'],
  risks: ['Google 自适应草稿长度专利族：已按被拒率调草稿步数', 'vLLM dynamic speculative lookahead：按批负载调步数'],
  cites: [1, 2],
  ...over,
});

const fakeLlm = (payload: string, capture?: ChatMessage[][]): IdeaLlm => ({
  async complete(messages) {
    capture?.push(messages);
    return payload;
  },
});

describe('generateIdeas：校验后只留合格条目', () => {
  it('3 条含缺陷的候选被丢弃，只留下 1 条合格选题，并给出丢弃原因', async () => {
    const drafts = [
      validDraft(),
      // 缺陷 1：少字段
      validDraft({ title: '一种缺失字段的投机解码方法', problem: '', keywords: [] }),
      // 缺陷 2：检索式词数不齐（7 / 2 / 2，差 5 > 2）
      validDraft({
        title: '一种检索式词数不齐的推理加速方法',
        queries: ['投机解码 草稿 置信度 退出 并行 校验 回退', '草稿模型 接受率', '解码 缓存'],
      }),
      // 缺陷 3：IPC 非法（「KV缓存优化」不是分类号）
      validDraft({ title: '一种 IPC 写错的缓存管理方法', ipcHints: ['G06F9/50', 'KV缓存优化'] }),
    ];

    const captured: ChatMessage[][] = [];
    const result = await generateIdeas(config, { focus: '投机解码 尾时延', count: 3 }, items, {
      llm: fakeLlm(JSON.stringify(drafts), captured),
      existing: [],
      now: () => new Date('2026-10-29T12:00:00.000Z'),
    });

    // 只留下 1 条
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]!.title).toBe('一种基于草稿置信度分级的投机解码动态退出方法');

    // 丢弃 3 条，且原因具体
    expect(result.dropped).toHaveLength(3);
    expect(result.dropped[0]!.reasons.join('；')).toContain('缺少技术问题描述');
    expect(result.dropped[1]!.reasons.join('；')).toContain('检索式词数差 5');
    expect(result.dropped[2]!.reasons.join('；')).toContain('IPC 号格式非法');
    expect(result.dropped[2]!.reasons.join('；')).toContain('KV缓存优化');

    // 理由是给用户看的：中文、≤30 字、不带 title/problem/solution 这类字段名
    for (const entry of result.dropped) {
      for (const reason of entry.reasons) {
        expect(reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
        expect(reason).toMatch(/[\u4e00-\u9fa5]/u);
        expect(reason).not.toMatch(/\b(problem|solution|effect|title|keywords|ipcHints|risks|queries)\b/u);
      }
    }
    // 序号是模型返回数组里的 1-based 下标，方便对着原始响应排查
    expect(result.dropped.map((entry) => entry.index)).toEqual([2, 3, 4]);

    // 落库字段：focus 快照 / cites / status / promptVersion
    const idea = result.ideas[0]!;
    expect(idea.focus).toBe('投机解码 尾时延');
    expect(idea.cites).toEqual(['it-01', 'it-02']);
    expect(idea.status).toBe('draft');
    expect(idea.novelty).toEqual([]);
    expect(idea.promptVersion).toBe(PROMPT_VERSION);
    expect(PROMPT_VERSION).toBe(PROMPT_VERSION_FROM_PROMPTS);
    expect(idea.createdAt).toBe('2026-10-29T12:00:00.000Z');

    // 选料：15 条只取 12 条，按 score 倒序
    expect(result.usedItems).toHaveLength(12);
    expect(result.usedItems[0]).toBe('it-01');
    expect(result.usedItems[11]).toBe('it-12');

    // prompt 里必须带上 focus、数量要求与情报序号（cites 的依据）
    const userPrompt = captured[0]!.find((message) => message.role === 'user')!.content;
    expect(userPrompt).toContain('投机解码 尾时延');
    expect(userPrompt).toContain('长度恰好 3');
    expect(userPrompt).toContain('[1]');
    expect(userPrompt).toContain('[12]');
    expect(userPrompt).not.toContain('[13]'); // 第 13 条没进 prompt
    expect(userPrompt).toContain('正例');
  });

  it('与库里已有选题标题近似（Jaccard > 0.8）→ 跳过，并在原因里给出相似度', async () => {
    const existing = [{ title: '一种基于草稿置信度分级的投机解码动态退出方法' }];
    const drafts = [
      validDraft({ title: '基于草稿置信度分级的投机解码动态退出方法' }), // 去掉「一种」= 近似
      validDraft({
        title: '一种显存分页块预取与重算权衡的 KV 缓存压缩方法',
        problem: '现有 KV 缓存压缩在预取命中率下降时仍按固定比例淘汰分页块，导致重算量突增并拖慢长上下文推理的稳定吞吐。',
        solution:
          '① 统计每个分页块的复用间隔与预取命中率，构造块级收益估计；' +
          '② 收益低于阈值的块优先进入重算队列而非保留在显存；' +
          '③ 重算队列与注意力计算图融合，按层粒度批处理以摊薄重算开销。',
      }),
    ];

    const result = await generateIdeas(config, { focus: 'KV 缓存', count: 3 }, items, {
      llm: fakeLlm(JSON.stringify(drafts)),
      existing,
    });

    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]!.title).toContain('KV 缓存压缩');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.reasons.join('；')).toContain('标题与已有选题高度相似');
    expect(result.dropped[0]!.reasons.join('；')).toMatch(/高度相似（0\.9\d）/u);
    expect(result.dropped[0]!.reasons[0]!.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
    expect(titleSimilarity('基于草稿置信度分级的投机解码动态退出方法', existing[0]!.title)).toBeGreaterThan(0.8);
  });

  it('count 上限 5：模型多给了也截断', async () => {
    const titles = [
      '一种基于置信度分级的投机解码动态退出方法',
      '一种显存分页块预取与重算权衡的 KV 缓存压缩方法',
      '一种预填充与解码阶段弹性配比的批调度方法',
      '一种面向长上下文的注意力窗口自适应裁剪方法',
      '一种多副本推理服务的请求重排与合并方法',
      '一种基于梯度冲突检测的多任务参数合并方法',
    ];
    const drafts = titles.map((title) => validDraft({ title }));

    const result = await generateIdeas(config, { focus: '推理加速', count: 99 }, items, {
      llm: fakeLlm(JSON.stringify(drafts)),
    });

    expect(result.ideas).toHaveLength(5);
    expect(result.meta.requested).toBe(5);
  });

  it('全部不合格 → 抛 IdeaGenerationError（不静默返回空数组）', async () => {
    const drafts = [validDraft({ problem: '' }), validDraft({ ipcHints: ['不是分类号'] })];

    let caught: unknown;
    try {
      await generateIdeas(config, { focus: 'x', count: 3 }, items, { llm: fakeLlm(JSON.stringify(drafts)) });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IdeaGenerationError);
    const error = caught as IdeaGenerationError;
    expect(error.code).toBe('all_invalid');
    expect(error.message).toContain('全部不合格');
    expect(error.message).toContain('缺少技术问题描述');
    expect(error.dropped).toHaveLength(2);
  });

  it('输出被截断 → 报「输出被截断，请减少数量」', async () => {
    const truncated = '[{"title":"一种基于置信度分级的投机解码动态退出方法","solution":"① 计算置信度余量；② 统计被拒率';

    let caught: unknown;
    try {
      await generateIdeas(config, { focus: 'x', count: 5 }, items, { llm: fakeLlm(truncated) });
    } catch (error) {
      caught = error;
    }

    const error = caught as IdeaGenerationError;
    expect(error).toBeInstanceOf(IdeaGenerationError);
    expect(error.code).toBe('llm_output_truncated');
    expect(error.message).toContain('输出被截断，请减少数量');
    expect(error.message).toContain('count=5');
  });

  it('没有情报条目 → no_items', async () => {
    await expect(
      generateIdeas(config, { focus: 'x', count: 3 }, [], { llm: fakeLlm('[]') }),
    ).rejects.toMatchObject({ code: 'no_items' });
  });

  it('itemIds 只在选中条目里挑，cites 映射到真实 item id', async () => {
    const result = await generateIdeas(
      config,
      { focus: 'x', count: 3, itemIds: ['it-05', 'it-07'] },
      items,
      { llm: fakeLlm(JSON.stringify([validDraft()])) },
    );

    // it-05 分数更高（95）→ 排第一，序号 2 对应 it-07
    expect(result.usedItems).toEqual(['it-05', 'it-07']);
    expect(result.ideas[0]!.cites).toEqual(['it-05', 'it-07']);
  });
});

describe('validateDraft：单条校验口径', () => {
  const picked = items.slice(0, 2);

  it('合格口径通过，IPC 归一化（去空格/去括号注释）', () => {
    const { draft, reasons } = validateDraft(validDraft({ ipcHints: ['G06F 9/50', 'G06F12/0871（内存管理）'] }), picked);
    expect(reasons).toEqual([]);
    expect(draft?.ipcHints).toEqual(['G06F9/50', 'G06F12/0871']);
  });

  it('单特征方案被拦下', () => {
    const { reasons } = validateDraft(validDraft({ solution: '采用改进的投机解码提升推理速度。' }), picked);
    expect(reasons.join('；')).toContain('技术手段仅 1 个（要求 ≥3）');
  });

  it('无量化效果被拦下', () => {
    const { reasons } = validateDraft(validDraft({ effect: '速度更快、效果更好。' }), picked);
    expect(reasons.join('；')).toContain('效果缺量化指标');
  });
});
