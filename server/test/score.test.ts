import { describe, expect, it } from 'vitest';

import { DEFAULT_KEYWORDS, scoreItem, type KeywordRule, type ScoreInput } from '../src/score.js';

/**
 * 打分的测试关心三件事：
 * 1. **刻度**（分档是否把核心论文顶到 72–92、噪音压到 25 以下）——这是产品能不能用分数做筛选的前提；
 * 2. **单调性**（时效越新越高、源权重越高越高、release 比 news 高）；
 * 3. **可解释性**（每个分都有理由，理由相加等于分数）。
 *
 * 不写「某条真实数据 = 58 分」这种断言：那只是把实现细节抄一遍，改权重就全红。
 */

const NOW = new Date('2026-10-29T12:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const baseInput = (overrides: Partial<ScoreInput> = {}): ScoreInput => ({
  title: 'KV cache pruning for long context serving',
  summary: '',
  kind: 'paper',
  sourceWeight: 1,
  sourceId: 'arxiv-speculative-decoding',
  sourceLabel: 'arXiv · 投机解码',
  publishedAt: daysAgo(1),
  fetchedAt: NOW.toISOString(),
  ...overrides,
});

const deltaOf = (reasons: { rule: string; delta: number }[], rule: string): number | undefined =>
  reasons.find((reason) => reason.rule === rule)?.delta;

/** 只放一个词的词表，便于把「关键词档位」单独拎出来算 */
const only = (term: string, weight: number): KeywordRule[] => [{ term, weight }];

describe('刻度校准：核心 / 相关 / 噪音三档', () => {
  it('核心论文（标题含 speculative decoding + KV cache，今天发布，arXiv 权重 2.4）落在 72–92', () => {
    const result = scoreItem(
      baseInput({
        title: 'Speculative Decoding with KV Cache Reuse for Long-Context Serving',
        summary: 'We verify several drafted tokens per pass and reuse the prefix KV cache.',
        publishedAt: NOW.toISOString(),
        sourceWeight: 2.4,
      }),
      { now: NOW },
    );
    expect(result.score).toBeGreaterThanOrEqual(72);
    expect(result.score).toBeLessThanOrEqual(92);
    expect(result.reasons[0]?.detail).toContain('核心词');
  });

  it('PD 分离同样算核心档', () => {
    const result = scoreItem(
      baseInput({
        title: 'Prefill-Decode Disaggregation 在异构集群上的调度',
        publishedAt: NOW.toISOString(),
        sourceWeight: 2,
      }),
      { now: NOW },
    );
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  it('领域相关但非核心（MoE 泛论 / 量化泛论）落在 40–70', () => {
    for (const title of ['MoE Routing Revisited', 'Post-Training Quantization for Serving']) {
      const result = scoreItem(baseInput({ title, publishedAt: NOW.toISOString(), sourceWeight: 2.4 }), { now: NOW });
      expect(result.score, title).toBeGreaterThanOrEqual(40);
      expect(result.score, title).toBeLessThanOrEqual(70);
      expect(result.reasons[0]?.detail).toContain('相关词');
    }
  });

  it('明显噪音（融资/体育/人事/无关产品发布）≤ 25', () => {
    const noises: ScoreInput[] = [
      baseInput({ title: 'Confluent 完成 4 亿美金融资', kind: 'news', sourceWeight: 1.5, publishedAt: NOW.toISOString() }),
      baseInput({ title: '世界杯足球决赛今日开打', kind: 'news', sourceWeight: 1.5, publishedAt: NOW.toISOString() }),
      baseInput({ title: '某公司宣布裁员 200 人', kind: 'news', sourceWeight: 1.5, publishedAt: NOW.toISOString() }),
      baseInput({ title: 'v0.33.0rc1: Fix CI test selector', kind: 'release', sourceWeight: 2.8, publishedAt: NOW.toISOString() }),
    ];
    for (const input of noises) {
      expect(scoreItem(input, { now: NOW }).score, input.title).toBeLessThanOrEqual(25);
    }
  });

  it('5 条不同相关度的样本能把刻度撑开（最高 − 最低 ≥ 40）', () => {
    const samples: ScoreInput[] = [
      baseInput({ title: 'Speculative Decoding with KV Cache Reuse', publishedAt: NOW.toISOString(), sourceWeight: 2.4 }),
      baseInput({ title: 'MoE Routing Revisited', publishedAt: daysAgo(10), sourceWeight: 2.4 }),
      baseInput({ title: 'GPU inference throughput tuning', publishedAt: daysAgo(40), sourceWeight: 1.5 }),
      baseInput({ title: 'v0.33.0rc1: Fix CI test selector', kind: 'release', publishedAt: daysAgo(20), sourceWeight: 2.8 }),
      baseInput({ title: '某公司完成 B 轮融资', kind: 'news', publishedAt: NOW.toISOString(), sourceWeight: 1 }),
    ];
    const scores = samples.map((sample) => scoreItem(sample, { now: NOW }).score);
    const spread = Math.max(...scores) - Math.min(...scores);
    expect(spread, JSON.stringify(scores)).toBeGreaterThanOrEqual(40);
    // 至少同时存在 60 分以上与 25 分以下的条目，直方图两头才不会都是空的
    expect(Math.max(...scores)).toBeGreaterThanOrEqual(72);
    expect(Math.min(...scores)).toBeLessThanOrEqual(25);
  });
});

describe('命中位置：标题命中比摘要命中重', () => {
  it('同一个核心词，写进标题拿核心档，只出现在摘要降一档', () => {
    const inTitle = scoreItem(baseInput({ title: 'KV cache pruning', summary: '' }), { now: NOW });
    const inSummary = scoreItem(baseInput({ title: 'A pruning method', summary: 'we compress the kv cache' }), {
      now: NOW,
    });
    expect(deltaOf(inTitle.reasons, 'keyword')).toBe(70);
    expect(deltaOf(inSummary.reasons, 'keyword')).toBe(55);
    expect(inTitle.score).toBeGreaterThan(inSummary.score);
    expect(inSummary.reasons[0]?.detail).toContain('仅摘要');
  });

  it('多词命中不叠加：档位只看命中的最高档词', () => {
    const one = scoreItem(baseInput({ title: 'KV cache pruning' }), { now: NOW });
    const many = scoreItem(
      baseInput({ title: 'KV cache pruning with speculative decoding and MoE routing' }),
      { now: NOW },
    );
    expect(deltaOf(many.reasons, 'keyword')).toBe(deltaOf(one.reasons, 'keyword'));
    expect(many.score).toBe(one.score);
    // 但抽到的关键词更丰富，前端标签用得上
    expect(many.keywords.length).toBeGreaterThan(one.keywords.length);
  });

  it('英文词按词边界匹配：moe 不该命中 moment', () => {
    const falsePositive = scoreItem(baseInput({ title: 'a moment of clarity', summary: '' }), {
      now: NOW,
      keywords: only('moe', 2),
    });
    const hit = scoreItem(baseInput({ title: 'MoE routing for decode', summary: '' }), {
      now: NOW,
      keywords: only('moe', 2),
    });
    expect(falsePositive.reasons[0]?.detail).toContain('未命中');
    expect(hit.score).toBeGreaterThan(falsePositive.score);
  });

  it('连字符写法与空格写法等价（真实 feed 里混用）', () => {
    const spaced = scoreItem(baseInput({ title: 'KV cache pruning' }), { now: NOW });
    const hyphen = scoreItem(baseInput({ title: 'KV-cache pruning' }), { now: NOW });
    const spec = scoreItem(baseInput({ title: 'Speculative-Decoding at Scale' }), { now: NOW });
    expect(hyphen.score).toBe(spaced.score);
    expect(spec.reasons[0]?.detail).toContain('核心词');
  });

  it('Key-Value (KV) cache 这类写法也能命中核心档', () => {
    const result = scoreItem(
      baseInput({ title: 'Stratified Sparse Attention', summary: 'a growing Key-Value (KV) cache dominates cost' }),
      { now: NOW },
    );
    expect(result.score).toBeGreaterThanOrEqual(55);
    expect(result.keywords).toContain('key value');
  });

  it('中文词按子串匹配', () => {
    const hit = scoreItem(baseInput({ title: '面向昇腾的异构推理调度' }), { now: NOW, keywords: only('昇腾', 2) });
    expect(deltaOf(hit.reasons, 'keyword')).toBe(45);
  });
});

describe('时效：越新越高，7 天内缓降、30 天后快降', () => {
  const scoreAt = (days: number): number => scoreItem(baseInput({ publishedAt: daysAgo(days) }), { now: NOW }).score;
  const recencyAt = (days: number): number =>
    deltaOf(scoreItem(baseInput({ publishedAt: daysAgo(days) }), { now: NOW }).reasons, 'recency') ?? 0;

  it('半年以内按发布时间严格单调递减', () => {
    const points = [0, 3, 7, 14, 30, 60, 85];
    const scores = points.map(scoreAt);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]!, `第 ${i} 个时间点应该更低：${JSON.stringify(scores)}`).toBeLessThan(scores[i - 1]!);
    }
  });

  it('7 天内每天掉的分少于 30 天后每天掉的分', () => {
    const early = (recencyAt(0) - recencyAt(7)) / 7;
    const late = (recencyAt(30) - recencyAt(90)) / 60;
    expect(early).toBeGreaterThan(late);
  });

  it('半年前的条目时效到底，再旧也不会更低', () => {
    expect(scoreAt(180)).toBe(scoreAt(400));
  });

  it('发布时间缺失时退到抓取时间，不会直接判死', () => {
    const result = scoreItem(
      { title: 'KV cache pruning', kind: 'paper', sourceWeight: 1, fetchedAt: NOW.toISOString() },
      { now: NOW },
    );
    expect(deltaOf(result.reasons, 'recency')).toBe(8);
  });
});

describe('源权重：高权重源分数更高', () => {
  it('源权重提升严格单调，1.0 不加不减', () => {
    const at = (sourceWeight: number): number => scoreItem(baseInput({ sourceWeight }), { now: NOW }).score;
    expect(at(3)).toBeGreaterThan(at(2.4));
    expect(at(2.4)).toBeGreaterThan(at(1));
    expect(at(1)).toBeGreaterThan(at(0.1));

    expect(deltaOf(scoreItem(baseInput({ sourceWeight: 1 }), { now: NOW }).reasons, 'source')).toBe(0);
  });

  it('源权重贡献有上下限，不足以单枪把噪音顶上去', () => {
    expect(deltaOf(scoreItem(baseInput({ sourceWeight: 3 }), { now: NOW }).reasons, 'source')).toBe(12);
    expect(deltaOf(scoreItem(baseInput({ sourceWeight: 0.1 }), { now: NOW }).reasons, 'source')).toBe(-6);
  });

  it('理由里带源展示名，便于前端直接展示', () => {
    const reason = scoreItem(baseInput({ sourceWeight: 2.4 }), { now: NOW }).reasons.find(
      (item) => item.rule === 'source',
    );
    expect(reason?.detail).toContain('arXiv · 投机解码');
  });
});

describe('工程验证信号', () => {
  it('release 类型固定 +5，但发版说明的标题按摘要档计（论文优先）', () => {
    const title = 'KV cache offload';
    const release = scoreItem(baseInput({ kind: 'release', title, sourceWeight: 2.8 }), { now: NOW });
    const paper = scoreItem(baseInput({ kind: 'paper', title, sourceWeight: 2.8 }), { now: NOW });

    expect(deltaOf(release.reasons, 'signal')).toBe(5);
    // 同样的 KV cache，release 拿摘要档 55、论文拿标题档 70
    expect(deltaOf(release.reasons, 'keyword')).toBe(55);
    expect(deltaOf(paper.reasons, 'keyword')).toBe(70);
    expect(paper.score).toBeGreaterThan(release.score);
    expect(release.reasons[0]?.detail).toContain('发版说明按摘要档计');
  });

  it('标题里的 benchmark/SOTA/开源 加分，且有上限', () => {
    const plain = scoreItem(baseInput({ title: 'KV cache offload' }), { now: NOW });
    const flagged = scoreItem(baseInput({ title: 'KV cache offload benchmark SOTA 开源' }), { now: NOW });
    expect(flagged.score).toBeGreaterThan(plain.score);

    const spam = scoreItem(baseInput({ title: 'KV cache benchmark SOTA 开源 release speedup 发布 实测' }), {
      now: NOW,
    });
    expect(deltaOf(spam.reasons, 'signal')).toBe(14);
    expect(spam.score).toBeLessThanOrEqual(100);
  });
});

describe('输出契约', () => {
  it('分数是 0–100 的整数', () => {
    const cases: ScoreInput[] = [
      baseInput(),
      baseInput({ title: '融资 体育 明星 IPO', kind: 'news', sourceWeight: 3 }),
      baseInput({
        sourceWeight: 3,
        kind: 'release',
        publishedAt: NOW.toISOString(),
        title: 'MoE 投机解码 KV cache benchmark SOTA 开源',
      }),
      baseInput({ sourceWeight: 0.1, publishedAt: daysAgo(1000), title: '' }),
    ];
    for (const input of cases) {
      const result = scoreItem(input, { now: NOW });
      expect(Number.isInteger(result.score)).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  it('理由的 delta 相加等于分数（未触发 0/100 裁剪时），前端能把账算圆', () => {
    const samples: ScoreInput[] = [
      baseInput({ title: 'Speculative Decoding with KV Cache Reuse', publishedAt: NOW.toISOString(), sourceWeight: 2.4 }),
      baseInput({ title: 'MoE Routing Revisited', publishedAt: daysAgo(20), sourceWeight: 2 }),
      baseInput({ title: '某公司完成 B 轮融资', kind: 'news', publishedAt: NOW.toISOString(), sourceWeight: 1.5 }),
      baseInput({ title: 'v0.33.0rc1: Fix CI test selector', kind: 'release', sourceWeight: 2.8 }),
    ];
    for (const sample of samples) {
      const result = scoreItem(sample, { now: NOW });
      const sum = result.reasons.reduce((total, reason) => total + reason.delta, 0);
      expect(sum, `${sample.title} → ${JSON.stringify(result.reasons)}`).toBe(result.score);
      for (const reason of result.reasons) {
        expect(Number.isInteger(reason.delta)).toBe(true);
        expect(reason.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it('纯函数：不改入参、同输入同输出', () => {
    const input = baseInput({ summary: 'KV cache and speculative decoding' });
    const snapshot = JSON.parse(JSON.stringify(input)) as ScoreInput;
    const first = scoreItem(input, { now: NOW });
    const second = scoreItem(input, { now: NOW });
    expect(first).toEqual(second);
    expect(input).toEqual(snapshot);
  });

  it('keywords 去重且小写', () => {
    const result = scoreItem(baseInput({ title: 'KV Cache vs MoE', summary: 'kv cache again' }), { now: NOW });
    expect(result.keywords).toContain('kv cache');
    expect(result.keywords).toContain('moe');
    expect(new Set(result.keywords).size).toBe(result.keywords.length);
    expect(result.keywords.every((keyword) => keyword === keyword.toLowerCase())).toBe(true);
  });

  it('自定义词表可整体替换默认词表', () => {
    const custom = scoreItem(baseInput({ title: 'KV cache pruning' }), { now: NOW, keywords: only('nonexistent', 3) });
    expect(custom.keywords).toEqual([]);
    expect(custom.reasons[0]?.detail).toContain('未命中');

    const defaults = scoreItem(baseInput({ title: 'KV cache pruning' }), { now: NOW });
    expect(defaults.score).toBeGreaterThan(custom.score);
  });

  it('默认词表：核心档只留给三条主线，MoE/引擎在相关档', () => {
    const weightOf = (term: string): number | undefined =>
      DEFAULT_KEYWORDS.find((rule) => rule.term === term)?.weight;
    for (const core of ['speculative decoding', '投机解码', 'kv cache', 'pd 分离', 'prefill-decode disaggregation']) {
      expect(weightOf(core), core).toBe(3);
    }
    for (const related of ['moe', 'mixture of experts', 'vllm', 'sglang', 'quantization', 'flashattention']) {
      expect(weightOf(related), related).toBe(2);
    }
    for (const background of ['inference', 'gpu', 'npu', '昇腾', '延迟']) {
      expect(weightOf(background), background).toBe(1);
    }
  });
});
