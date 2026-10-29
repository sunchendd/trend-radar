import type { ItemKind, ScoreReason } from './types.js';

/**
 * 相关度打分（纯函数、无 IO）。
 *
 * 设计目标不是「算得准」，而是「算得可解释」：前端要能直接告诉用户
 * 「这条为什么值得看」。所以每一分都挂一条 ScoreReason，
 * 且所有规则都是独立可加的线性项，方便运营事后调权重。
 *
 * 分数区间 0–100，总分 = 关键词 + 源权重 + 时效 + 信号 - 惩罚。
 */

export interface KeywordRule {
  /** 匹配用小写词；英文词按词边界匹配，中文词按子串匹配 */
  term: string;
  /** 领域重要性 1–3；标题命中按 3 倍计 */
  weight: number;
  /** 展示名（可读性），缺省用 term */
  label?: string;
}

/**
 * 领域词表：围绕「LLM 推理加速 + 异构部署」的专利落点组织。
 * 权重直接对应分数档位（见 TIER_SCORE）：
 *   3 = 领域骨架（投机解码 / KV cache / PD 分离）→ 命中即 70 档；
 *   2 = 具体机制与主流引擎（MoE、量化、前缀缓存、vLLM/SGLang…）→ 45 档；
 *   1 = 背景词（推理、GPU、延迟）→ 25 档，单独命中说明不了什么。
 * MoE 一开始放在 3 分档，实测把一堆 MoE 泛论顶到了核心论文的分上，故降为 2。
 */
export const DEFAULT_KEYWORDS: readonly KeywordRule[] = [
  // ---- 骨架级 3 分
  { term: 'speculative decoding', weight: 3, label: '投机解码' },
  { term: '投机解码', weight: 3 },
  { term: 'speculative sampling', weight: 3, label: '投机采样' },
  { term: 'kv cache', weight: 3, label: 'KV cache' },
  { term: 'kv 缓存', weight: 3, label: 'KV 缓存' },
  { term: 'kv caching', weight: 3, label: 'KV 缓存' },
  // 真实论文里常写成 Key-Value (KV) cache，只认 "kv cache" 会漏掉整批 KV 论文
  { term: 'key value', weight: 3, label: 'KV cache' },
  { term: 'pd disaggregation', weight: 3, label: 'PD 分离' },
  { term: 'prefill-decode disaggregation', weight: 3, label: 'PD 分离' },
  { term: 'disaggregated prefill', weight: 3, label: 'PD 分离' },
  { term: 'pd 分离', weight: 3 },
  // 只写 prefill-decode 不写 disaggregation 的标题同样在讲分离调度（如 PEARL）
  { term: 'prefill decode', weight: 3, label: 'PD 分离' },

  // ---- 机制级 2 分
  { term: 'mixture of experts', weight: 2, label: 'MoE' },
  { term: 'moe', weight: 2, label: 'MoE' },
  { term: '混合专家', weight: 2, label: 'MoE' },
  { term: 'draft model', weight: 2, label: '草稿模型' },
  { term: 'eagle', weight: 2, label: 'EAGLE 头' },
  { term: 'eagle3', weight: 2, label: 'EAGLE3' },
  { term: 'mtp', weight: 2, label: 'MTP 多 token 预测' },
  { term: 'multi-token prediction', weight: 2, label: '多 token 预测' },
  { term: 'prefix caching', weight: 2, label: '前缀缓存' },
  { term: '前缀缓存', weight: 2 },
  { term: 'paged attention', weight: 2, label: 'PagedAttention' },
  { term: 'kv cache offload', weight: 2, label: 'KV 卸载' },
  { term: 'kv offload', weight: 2, label: 'KV 卸载' },
  { term: 'kv 卸载', weight: 2, label: 'KV 卸载' },
  { term: 'disaggregation', weight: 2, label: '分离部署' },
  // 裸 KV 在推理语料里几乎总是指 KV cache；给相关档而不是核心档，避免和主 KV 词组等价
  { term: 'kv', weight: 2, label: 'KV' },
  { term: 'expert parallelism', weight: 2, label: '专家并行' },
  { term: '专家并行', weight: 2 },
  { term: 'inference engine', weight: 2, label: '推理引擎' },
  { term: '推理引擎', weight: 2 },
  { term: 'vllm', weight: 2, label: 'vLLM' },
  { term: 'sglang', weight: 2, label: 'SGLang' },
  { term: 'tensorrt-llm', weight: 2, label: 'TensorRT-LLM' },
  { term: 'flashinfer', weight: 2, label: 'FlashInfer' },
  { term: 'mindie', weight: 2, label: 'MindIE' },
  { term: 'quantization', weight: 2, label: '量化' },
  { term: '量化', weight: 2 },
  { term: 'fp8', weight: 2, label: 'FP8' },
  { term: 'int4', weight: 2, label: 'INT4' },
  { term: 'awq', weight: 2, label: 'AWQ' },
  { term: 'gptq', weight: 2, label: 'GPTQ' },
  { term: 'chunked prefill', weight: 2, label: '分块 prefill' },
  { term: 'continuous batching', weight: 2, label: '连续批处理' },
  { term: 'attention backend', weight: 2, label: 'attention 后端' },
  { term: 'flash attention', weight: 2, label: 'FlashAttention' },
  { term: 'flashattention', weight: 2, label: 'FlashAttention' },

  // ---- 背景词 1 分
  { term: 'inference', weight: 1, label: '推理' },
  { term: '推理', weight: 1 },
  { term: 'serving', weight: 1, label: '在线服务' },
  { term: 'throughput', weight: 1, label: '吞吐' },
  { term: '吞吐', weight: 1 },
  { term: 'latency', weight: 1, label: '延迟' },
  { term: '延迟', weight: 1 },
  { term: 'llm', weight: 1, label: '大模型' },
  { term: 'large language model', weight: 1, label: '大模型' },
  { term: '大模型', weight: 1 },
  { term: 'gpu', weight: 1, label: 'GPU' },
  { term: 'npu', weight: 1, label: 'NPU' },
  { term: 'ascend', weight: 1, label: '昇腾' },
  { term: '昇腾', weight: 1 },
  { term: '异构', weight: 1, label: '异构' },
  { term: 'heterogeneous', weight: 1, label: '异构' },
  { term: '显存', weight: 1, label: '显存' },
  { term: 'kernel', weight: 1, label: '算子' },
  { term: '算子', weight: 1 },
  { term: 'scheduler', weight: 1, label: '调度器' },
  { term: '调度', weight: 1 },
];

/** 工程验证信号词：标题里出现说明「不只是想法，已经跑过/发过」 */
const SIGNAL_WORDS: readonly string[] = [
  'benchmark',
  'sota',
  'state-of-the-art',
  'open-source',
  'open source',
  '开源',
  'release',
  '发布',
  'speedup',
  '加速比',
  '首次',
  'first',
  '实测',
  'breakthrough',
];

/** 明显无关领域：商业融资与泛娱乐，出现在标题里基本可以判死 */
const OFF_TOPIC_WORDS: readonly string[] = [
  '融资',
  '轮融资',
  'ipo',
  '上市',
  '股价',
  '财报',
  '营收',
  '收购',
  '裁员',
  '招聘',
  '体育',
  '足球',
  '篮球',
  '奥运',
  '电竞',
  '明星',
  '综艺',
  '票房',
  '恋情',
  '选举',
];

/**
 * 档位分值——刻度的锚。
 *
 * 为什么"分档"而不是"加分"：早先版本把关键词命中的贡献累加起来（每个词 +3~+9），
 * 结果所有本领域论文都挤在 40–60，60 分以上的 KPI 永远是 0 条，用户没法用分数做筛选。
 * 命中多个词并不代表"更相关"（一篇论文标题里有 4 个词不代表比只有 1 个核心词的更值得看），
 * 所以这里只按**命中的最高档词**定档，多次命中不再叠加，只用档位表达相关度。
 */
const TIER_SCORE = {
  /** 领域骨架：投机解码 / KV cache / PD 分离 */
  core: { title: 70, summary: 55 },
  /** 领域相关：MoE、量化、引擎、前缀缓存等具体机制 */
  related: { title: 45, summary: 33 },
  /** 背景词：推理、GPU、延迟、吞吐这类单独出现说明不了什么的词 */
  background: { title: 25, summary: 20 },
  /** 一个领域词都没命中 */
  none: { title: 12, summary: 12 },
} as const;

type Tier = keyof typeof TIER_SCORE;

/**
 * 档位内再按命中位置分：标题 > 摘要（原则是「标题命中比摘要命中重」）。
 * 「只出现在摘要」不等于「更可信」——摘要里出现说明沾边，但作者没把它当卖点，
 * 所以每个档位都留一档摘要分，而不是整体降一档：
 * 降一档会让「摘要里满是 KV cache」的论文掉到背景词水平，召回上很吃亏。
 */

/** 噪音封顶：没命中任何领域词、或标题像商业/娱乐新闻的，一律压到这条线下 */
const NOISE_CEILING = 25;

const TIER_LABEL: Record<Tier, string> = {
  core: '核心词',
  related: '相关词',
  background: '背景词',
  none: '未命中领域词',
};

// 编译后的匹配器缓存：score 是纯函数，但仍会被每条条目调用几十次，正则会成为热点
const matcherCache = new Map<string, (haystack: string) => boolean>();

function matcher(term: string): (haystack: string) => boolean {
  const cached = matcherCache.get(term);
  if (cached) return cached;

  const lower = normalizeForMatch(term);
  let fn: (haystack: string) => boolean;

  if (/^[a-z0-9][a-z0-9 ._/-]*$/.test(lower)) {
    // 英文/带连写的词按「词边界」匹配，否则 moe 会命中 moment、router 会命中 routerless 之外的噪音
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`);
    fn = (haystack) => re.test(haystack);
  } else {
    // 中文没有词边界概念，退化为子串匹配
    fn = (haystack) => haystack.includes(lower);
  }

  matcherCache.set(term, fn);
  return fn;
}

/**
 * 匹配用的文本归一化：小写 + 连字符/下划线统一成空格。
 *
 * 真实语料里 "kx cache / kv-cache / KV Cache"、"speculative decoding / speculative-decoding"、
 * "state-of-the-art" 混着写，逐个词表项加变体是不可维护的；两边同时归一后，词表只写一种形式。
 */
const normalizeForMatch = (input: string): string =>
  input.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

export interface ScoreInput {
  title: string;
  summary?: string;
  kind: ItemKind;
  /** 源的领域权重（Source.weight，0.1–3） */
  sourceWeight: number;
  /** 发布时间 ISO；缺失/非法时退化到 fetchedAt，再不行按时效 0 计 */
  publishedAt?: string;
  fetchedAt?: string;
  sourceId?: string;
  /** 源展示名，只用于理由文案（例如「arXiv · 投机解码」） */
  sourceLabel?: string;
}

export interface ScoreOptions {
  /** 计算时效的基准时间；测试注入固定时间用 */
  now?: Date;
  /** 覆盖默认词表（测试或某个垂直领域专用） */
  keywords?: readonly KeywordRule[];
}

export interface ScoreResult {
  score: number;
  reasons: ScoreReason[];
  /** 命中的关键词（小写去重），写进 Item.keywords */
  keywords: string[];
}

interface KeywordHit {
  rule: KeywordRule;
  titleHit: boolean;
  summaryHit: boolean;
}

function matchKeywords(title: string, summary: string, rules: readonly KeywordRule[]): KeywordHit[] {
  const hits: KeywordHit[] = [];
  for (const rule of rules) {
    const test = matcher(rule.term);
    const titleHit = test(title);
    const summaryHit = titleHit ? false : test(summary);
    if (titleHit || summaryHit) hits.push({ rule, titleHit, summaryHit });
  }
  return hits;
}

/** 时效加减：7 天内缓降、7–30 天中速、30 天以后快速转负，半年后到底（内插锚点） */
const RECENCY_ANCHORS: readonly { days: number; points: number }[] = [
  { days: 0, points: 8 },
  { days: 7, points: 6 },
  { days: 30, points: 1 },
  { days: 90, points: -8 },
  { days: 180, points: -10 },
];

function recencyPoints(ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) return RECENCY_ANCHORS[0]?.points ?? 8;
  for (let i = 0; i < RECENCY_ANCHORS.length - 1; i += 1) {
    const left = RECENCY_ANCHORS[i];
    const right = RECENCY_ANCHORS[i + 1];
    if (!left || !right) continue;
    if (ageDays <= right.days) {
      const span = right.days - left.days;
      const ratio = span === 0 ? 0 : (ageDays - left.days) / span;
      return left.points + (right.points - left.points) * ratio;
    }
  }
  return RECENCY_ANCHORS.at(-1)?.points ?? -10;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function ageInDays(input: ScoreInput, now: Date): number | undefined {
  const published = parseTime(input.publishedAt);
  const fetched = parseTime(input.fetchedAt);
  const basis = published ?? fetched;
  if (basis === undefined) return undefined;
  return (now.getTime() - basis) / 86_400_000;
}

const weightToTier = (weight: number): Tier => (weight >= 3 ? 'core' : weight >= 2 ? 'related' : 'background');

/** 有符号整数，用于理由文案：「+10」/「-8」 */
const withSign = (value: number): string => (value > 0 ? `+${value}` : `${value}`);

/** 源权重贡献：1 为基准，3 → +12，0.1 → -6；上下限防止单个源把刻度拉爆 */
function sourceAdjustment(weight: number): number {
  const raw = (weight - 1) * 7;
  return Math.round(Math.max(-8, Math.min(12, raw)));
}

/**
 * 给一条条打分。纯函数：同样的输入 + 同样的 now 一定得到同样的输出，不碰数据库、不发请求。
 *
 * 分数 = 档位基础分 + 源权重 ± 时效 ± 工程信号 − 噪音惩罚，最后按噪音规则封顶并 clamp 到 0–100。
 * 每条理由的 delta 相加正好等于最终分数（封顶也记成一条负数理由），前端可以把「为什么这个分」讲圆。
 */
export function scoreItem(input: ScoreInput, options: ScoreOptions = {}): ScoreResult {
  const now = options.now ?? new Date();
  const rules = options.keywords ?? DEFAULT_KEYWORDS;
  // 归一化后再匹配（见 normalizeForMatch），标题/摘要/词表三方口径一致
  const title = normalizeForMatch(input.title ?? '');
  const summary = normalizeForMatch(input.summary ?? '');
  const reasons: ScoreReason[] = [];

  // ---- 规则 1：定档（只看命中的最高档词，不累加）
  const hits = matchKeywords(title, summary, rules);
  const titleHits = hits.filter((hit) => hit.titleHit).sort((a, b) => b.rule.weight - a.rule.weight);
  const summaryHits = hits.filter((hit) => hit.summaryHit).sort((a, b) => b.rule.weight - a.rule.weight);

  const bestTitleHit = titleHits[0];
  const bestSummaryHit = summaryHits[0];
  let tier: Tier = 'none';
  let position: 'title' | 'summary' = 'title';
  if (bestTitleHit) {
    tier = weightToTier(bestTitleHit.rule.weight);
  } else if (bestSummaryHit) {
    tier = weightToTier(bestSummaryHit.rule.weight);
    position = 'summary';
  }

  /*
   * 发版说明（release）的标题是 commit message 的摘录，不是作者提炼的技术主张，
   * 所以按「摘要」档计分：同样写着 KV cache 的一行日志改动，不该压过一篇真正的 KV cache 论文
   * （论文优先是本产品的价值取向——最终产出是专利选题，论文才是一手技术证据）。
   */
  const scoredPosition = input.kind === 'release' ? 'summary' : position;
  const base = TIER_SCORE[tier][scoredPosition];
  const keywordExamples = [...titleHits, ...summaryHits]
    .slice(0, 3)
    .map((hit) => `${hit.rule.label ?? hit.rule.term}${hit.titleHit ? '' : '(摘要)'}`)
    .join('、');
  reasons.push({
    rule: 'keyword',
    delta: base,
    detail:
      tier === 'none'
        ? `基础档：${TIER_LABEL.none} ${withSign(base)}`
        : `基础档：${TIER_LABEL[tier]}命中 ${keywordExamples}${
            position === 'summary' ? '（仅摘要）' : input.kind === 'release' ? '（发版说明按摘要档计）' : ''
          } ${withSign(base)}`,
  });

  const keywords = [
    ...new Set(
      [...hits]
        .sort((a, b) => (b.titleHit ? 1 : 0) - (a.titleHit ? 1 : 0) || b.rule.weight - a.rule.weight)
        .map((hit) => hit.rule.term),
    ),
  ];

  // ---- 规则 2：源权重
  const sourceDelta = sourceAdjustment(input.sourceWeight);
  reasons.push({
    rule: 'source',
    delta: sourceDelta,
    detail: `源权重：${input.sourceLabel ?? input.sourceId ?? 'unknown'} ${input.sourceWeight} ${withSign(sourceDelta)}`,
  });

  // ---- 规则 3：时效
  const age = ageInDays(input, now);
  let recencyDelta = 0;
  if (age === undefined) {
    reasons.push({ rule: 'recency', delta: 0, detail: '时效：发布时间缺失，按 0 计' });
  } else {
    recencyDelta = Math.round(recencyPoints(age));
    const days = Math.max(0, Math.round(age * 10) / 10);
    reasons.push({
      rule: 'recency',
      delta: recencyDelta,
      detail: days < 1 ? `时效：今天发布 ${withSign(recencyDelta)}` : `时效：发布于 ${days} 天前 ${withSign(recencyDelta)}`,
    });
  }

  // ---- 规则 4：工程验证信号
  let signalDelta = 0;
  const signalHit: string[] = [];
  if (input.kind === 'release') {
    // +5 而不是更高的理由：本品最终产出是专利选题，论文才是一手技术证据；
    // 版本 note 只是「这东西进生产了」的佐证，给到能压过纯背景词条目即可，不该盖过核心论文。
    signalDelta += 5;
    signalHit.push('正式发布(release)');
  }
  for (const word of SIGNAL_WORDS) {
    if (signalDelta >= 14) break;
    // kind=release 的条目本身已经拿了 +8，标题里再出现 release/发布 属于同一件事，不重复给分
    if (input.kind === 'release' && (word === 'release' || word === '发布')) continue;
    if (matcher(word)(title)) {
      signalDelta += 2;
      signalHit.push(word);
    }
  }
  signalDelta = Math.min(signalDelta, 14);
  if (signalDelta > 0) {
    reasons.push({
      rule: 'signal',
      delta: signalDelta,
      detail: `工程验证信号：${signalHit.slice(0, 4).join('、')} ${withSign(signalDelta)}`,
    });
  }

  // ---- 规则 5：噪音惩罚 + 封顶
  const offTopic = OFF_TOPIC_WORDS.filter((word) => matcher(word)(title));
  let penalty = 0;
  if (offTopic.length > 0) {
    penalty -= 20;
  }

  let raw = base + sourceDelta + recencyDelta + signalDelta + penalty;

  if (penalty < 0 || tier === 'none') {
    const reason = offTopic.length > 0 ? `标题像商业/泛娱乐新闻：${offTopic.slice(0, 3).join('、')}` : TIER_LABEL.none;
    if (penalty < 0) {
      reasons.push({ rule: 'penalty', delta: penalty, detail: `噪音扣分：${reason} ${withSign(penalty)}` });
    }
    if (raw > NOISE_CEILING) {
      const capDelta = NOISE_CEILING - raw;
      reasons.push({
        rule: 'penalty',
        delta: capDelta,
        detail: `噪音封顶 ${NOISE_CEILING}：${reason} ${withSign(capDelta)}`,
      });
      raw = NOISE_CEILING;
    }
  }

  const score = Math.round(Math.min(100, Math.max(0, raw)));
  return { score, reasons, keywords };
}
