/**
 * 演示数据（仅在 DEV 且真接口连不上时兜底）
 *
 * 目的：后端 API 并行开发期间，界面可以被完整评估。
 * 所以这里的数据必须**真实可信** —— 领域是 LLM 推理系统（投机解码 / KV Cache /
 * MoE 服务 / 长上下文），标题与摘要按 arXiv 的真实语感写，方便直接判断视觉密度。
 * 一旦真接口可用，这个文件不会被触碰；界面右上角也会显示「演示数据」徽标。
 */
import type {
  Idea,
  IdeaWithVerdict,
  Item,
  ItemKind,
  ItemQuery,
  Paged,
  RunRecord,
  Source,
  Stats,
} from './types';
import { fallbackSummary } from './format';

// ------------------------------------------------------------------ 时间助手

const HOUR = 3600_000;

function iso(hoursAgo: number, base = Date.now()): string {
  return new Date(base - hoursAgo * HOUR).toISOString();
}

function dateOnly(dayOffset: number): string {
  return new Date(Date.now() - dayOffset * 24 * HOUR).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ 信源

const SOURCES: Source[] = [
  {
    id: 'arxiv-spec-decoding',
    kind: 'arxiv',
    label: 'arXiv · 投机解码',
    url:
      'http://export.arxiv.org/api/query?search_query=all:%22speculative%20decoding%22&sortBy=submittedDate&sortOrder=descending&max_results=40',
    weight: 1.6,
    enabled: true,
    tags: ['paper', 'core'],
    note: '选题主线：草稿模型 / 树注意力 / 接受率优化。每天 40 条足够，再多是噪声。',
    createdAt: iso(24 * 96),
  },
  {
    id: 'arxiv-kv-cache',
    kind: 'arxiv',
    label: 'arXiv · KV Cache & 长上下文',
    url:
      'http://export.arxiv.org/api/query?search_query=all:%22KV%20cache%22%20AND%20all:%22inference%22&sortBy=submittedDate&sortOrder=descending&max_results=40',
    weight: 1.4,
    enabled: true,
    tags: ['paper', 'core'],
    note: '量化 / 卸载 / 驱逐三条支线，与「显存不够」类客户痛点对得上。',
    createdAt: iso(24 * 96),
  },
  {
    id: 'arxiv-moe-serving',
    kind: 'arxiv',
    label: 'arXiv · MoE 服务',
    url:
      'http://export.arxiv.org/api/query?search_query=all:%22mixture%20of%20experts%22%20AND%20all:%22serving%22&sortBy=submittedDate&sortOrder=descending&max_results=30',
    weight: 1.1,
    enabled: true,
    tags: ['paper'],
    note: '专专家路由/负载不均方向，信号弱一些但偶尔有可写的调度类方案。',
    createdAt: iso(24 * 90),
  },
  {
    id: 'gh-vllm-releases',
    kind: 'atom',
    label: 'GitHub · vLLM Releases',
    url: 'https://github.com/vllm-project/vllm/releases.atom',
    weight: 1.9,
    enabled: true,
    tags: ['engine', 'release'],
    note: '工程侧最快信号源。release note 里出现的新特性往往半年内变成专利热点。',
    createdAt: iso(24 * 110),
  },
  {
    id: 'rss-lmsys-blog',
    kind: 'rss',
    label: 'LMSYS Blog',
    url: 'https://lmsys.org/rss.xml',
    weight: 1.0,
    enabled: true,
    tags: ['vendor'],
    note: 'SGLang 团队的工程博客，调度与缓存设计细节值得跟进。',
    createdAt: iso(24 * 61),
  },
  {
    id: 'rss-hn-frontpage',
    kind: 'rss',
    label: 'Hacker News 首页',
    url: 'https://hnrss.org/frontpage?points=250',
    weight: 0.4,
    enabled: false,
    tags: ['noise'],
    note: '噪声太大，相关度常年 <30，先停用观察。',
    createdAt: iso(24 * 40),
  },
];

// ------------------------------------------------------------------ 条目

interface ItemSeed {
  id: string;
  sourceId: string;
  kind: ItemKind;
  title: string;
  summary: string;
  authors: string[];
  hoursAgo: number;
  score: number;
  keywords: string[];
  reasons: { rule: string; delta: number; detail: string }[];
  externalId?: string;
  url: string;
}

const ITEM_SEEDS: ItemSeed[] = [
  {
    id: 'a1f3c9e07b2d41a8',
    sourceId: 'arxiv-spec-decoding',
    kind: 'paper',
    title:
      'Adaptive Draft-Tree Expansion for Speculative Decoding under Long-Context Workloads',
    summary:
      'Tree-based speculative decoding raises acceptance length but wastes draft-model compute on branches that never survive verification. We propose ADTE, which grows the draft tree incrementally and prunes subtrees whose cumulative acceptance probability falls below a threshold calibrated on-line from the verifier’s rejection history. On Llama-3-70B with 32K-token prompts, ADTE improves end-to-end speedup from 2.1× to 2.9× over autoregressive decoding while keeping the draft budget fixed.',
    authors: ['Yuhang Li', 'Marta Kowalczyk', 'Devendra Rao'],
    hoursAgo: 5,
    score: 94,
    keywords: ['speculative decoding', 'tree attention', 'draft model', 'kv cache', 'latency'],
    reasons: [
      { rule: 'source-weight', delta: 16, detail: '源权重 1.6，本领域主线' },
      { rule: 'keyword-hit', delta: 22, detail: '命中 5 个跟踪关键词（speculative decoding / tree attention）' },
      { rule: 'recency', delta: 12, detail: '5 小时前发布，处于 24h 窗口内' },
      { rule: 'novelty-term', delta: 8, detail: '标题包含 adaptive / pruning，非综述类' },
    ],
    externalId: 'arXiv:2510.14882v1',
    url: 'https://arxiv.org/abs/2510.14882',
  },
  {
    id: 'b7c21d5e93af4061',
    sourceId: 'gh-vllm-releases',
    kind: 'release',
    title: 'vLLM v0.7.2 — disaggregated prefill/decode over NIXL, chunked prefill on by default',
    summary:
      'Release highlights: (1) P/D disaggregation graduates from experimental to opt-in stable, with NIXL as the default KV transport; (2) chunked prefill enabled by default for models with context ≥ 8K; (3) ~11% throughput gain for multi-LoRA serving when adapter count exceeds 32. Breaking: `--enable-prefix-caching` now defaults to true and interacts with `--kv-transfer-config`.',
    authors: ['vLLM maintainers'],
    hoursAgo: 9,
    score: 91,
    keywords: ['pd disaggregation', 'chunked prefill', 'prefix caching', 'lora', 'kv transfer'],
    reasons: [
      { rule: 'source-weight', delta: 19, detail: '源权重 1.9，工程侧最高优先级' },
      { rule: 'keyword-hit', delta: 18, detail: '命中 pd disaggregation / prefix caching' },
      { rule: 'kind-boost', delta: 10, detail: 'release 类型，特性即专利热点' },
      { rule: 'recency', delta: 11, detail: '9 小时前发布' },
    ],
    externalId: 'vllm@v0.7.2',
    url: 'https://github.com/vllm-project/vllm/releases/tag/v0.7.2',
  },
  {
    id: 'c04e8b1f6d2a9357',
    sourceId: 'arxiv-kv-cache',
    kind: 'paper',
    title:
      'Asynchronous Host-Memory KV Offloading with Layer-Wise Prefetch for Single-GPU Inference',
    summary:
      'Offloading KV cache to host memory lets a single 24 GB GPU serve 128K-token sessions, but naive copy-on-demand stalls every decode step. We schedule per-layer transfers one step ahead of demand and overlap them with attention compute using pinned-memory double buffering, hiding 87% of PCIe latency. The scheduler degrades gracefully to on-demand copying when the prefetch queue saturates.',
    authors: ['Seoyeon Park', 'Tobias Mayer'],
    hoursAgo: 22,
    score: 88,
    keywords: ['kv cache', 'offloading', 'pcie', 'prefetch', 'memory bandwidth'],
    reasons: [
      { rule: 'source-weight', delta: 14, detail: '源权重 1.4' },
      { rule: 'keyword-hit', delta: 20, detail: '命中 kv cache / offloading / prefetch' },
      { rule: 'recency', delta: 9, detail: '22 小时前发布' },
      { rule: 'novelty-term', delta: 7, detail: '标题包含 scheduling 类可专利特征' },
    ],
    externalId: 'arXiv:2510.14401v2',
    url: 'https://arxiv.org/abs/2510.14401',
  },
  {
    id: 'd81b6f302ce7459a',
    sourceId: 'arxiv-kv-cache',
    kind: 'paper',
    title: 'PrefixKV: Cross-Tenant Prefix Cache Sharing with Adapter-Aware Isolation',
    summary:
      'Multi-tenant LoRA serving recomputes identical system prompts for every adapter, wasting 30-40% of prefill FLOPs. PrefixKV stores prefixes once and shares them across adapters, tagging each block with the adapter set that may legally read it, so that isolation is enforced by the block table rather than by copying. Reported prefill latency drops 2.3× at 64 concurrent tenants.',
    authors: ['Ana Ribeiro', 'Kenji Watanabe', 'Omar Haddad'],
    hoursAgo: 27,
    score: 84,
    keywords: ['prefix caching', 'lora', 'multi-tenant', 'prefill', 'isolation'],
    reasons: [
      { rule: 'keyword-hit', delta: 21, detail: '命中 prefix caching / lora / isolation' },
      { rule: 'source-weight', delta: 14, detail: '源权重 1.4' },
      { rule: 'recency', delta: 8, detail: '1 天前发布' },
    ],
    externalId: 'arXiv:2510.13977v1',
    url: 'https://arxiv.org/abs/2510.13977',
  },
  {
    id: 'e2a97c4b05d31f68',
    sourceId: 'rss-lmsys-blog',
    kind: 'news',
    title: 'Where the FLOPs go: a token-cost breakdown for 128K-context serving',
    summary:
      'SGLang 团队拆了一次 128K 上下文的端到端 token 成本：prefill 占 71%，其中 38% 花在重复前缀上；decode 阶段过半时间在等 KV 读取而不是算力。文章给的结论很直接——长上下文场景下优化带宽比优化算力收益高一个量级。',
    authors: ['LMSYS'],
    hoursAgo: 31,
    score: 79,
    keywords: ['prefill', 'kv cache', 'bandwidth', 'long context', 'cost'],
    reasons: [
      { rule: 'source-weight', delta: 10, detail: '源权重 1.0' },
      { rule: 'keyword-hit', delta: 17, detail: '命中 prefill / bandwidth / long context' },
      { rule: 'recency', delta: 7, detail: '1 天前发布' },
    ],
    url: 'https://lmsys.org/blog/2025-10-token-cost-breakdown/',
  },
  {
    id: 'f5d30a8e2b6c7941',
    sourceId: 'arxiv-moe-serving',
    kind: 'paper',
    title: 'RouteHist: Serving-Time Expert Pruning via Token Routing Histograms',
    summary:
      'Expert utilisation in MoE models is heavily skewed and drifts with the incoming request mix. RouteHist keeps a decaying histogram of routing decisions per layer and evicts low-traffic experts to host memory, restoring them when their histogram mass crosses a hysteresis threshold. Achieves 1.8× decode throughput on Mixtral-8x22B with 0.4 point average benchmark loss.',
    authors: ['Ilya Sokolov', 'Priya Nair'],
    hoursAgo: 40,
    score: 76,
    keywords: ['moe', 'expert pruning', 'routing', 'offloading', 'throughput'],
    reasons: [
      { rule: 'keyword-hit', delta: 18, detail: '命中 moe / routing / offloading' },
      { rule: 'source-weight', delta: 11, detail: '源权重 1.1' },
      { rule: 'recency', delta: 6, detail: '2 天前发布' },
    ],
    externalId: 'arXiv:2510.13015v1',
    url: 'https://arxiv.org/abs/2510.13015',
  },
  {
    id: '0712c4d9ab8e35f2',
    sourceId: 'arxiv-kv-cache',
    kind: 'paper',
    title: 'Outlier-Isolated 2-bit KV Cache Quantization with Per-Channel Residual Streams',
    summary:
      'Pushing KV cache below 4 bits collapses accuracy because a small number of channels carry most of the magnitude. We isolate outlier channels into a full-precision residual stream, quantize the remainder to 2 bits with group-wise scales, and fuse dequantization into the attention kernel. 3.9× cache reduction at 32K context with 0.6 perplexity increase.',
    authors: ['Chen Yiran', 'Lucas Ferrand', 'Nadia Aziz'],
    hoursAgo: 55,
    score: 72,
    keywords: ['kv cache', 'quantization', 'outlier', 'attention kernel', 'perplexity'],
    reasons: [
      { rule: 'keyword-hit', delta: 16, detail: '命中 kv cache / quantization' },
      { rule: 'source-weight', delta: 13, detail: '源权重 1.4' },
      { rule: 'novelty-term', delta: 5, detail: '标题包含 outlier-isolated 具体机制' },
    ],
    externalId: 'arXiv:2510.12203v1',
    url: 'https://arxiv.org/abs/2510.12203',
  },
  {
    id: '1a6f9b32d8c0475e',
    sourceId: 'arxiv-spec-decoding',
    kind: 'paper',
    title: 'Recurrent Draft Heads with Verification-Aware Training for Multi-Step Speculation',
    summary:
      'Draft heads that predict k tokens in a single pass are trained on teacher forcing, which mismatches inference where rejected tokens corrupt the draft context. We train with the verifier in the loop so the head learns to recover from partial rejection, and reuse the hidden state across steps. Acceptance length rises from 2.4 to 3.7 tokens on code generation.',
    authors: ['Sara Lindqvist', 'Amir Tehrani'],
    hoursAgo: 63,
    score: 68,
    keywords: ['speculative decoding', 'draft head', 'acceptance rate', 'training', 'verification'],
    reasons: [
      { rule: 'keyword-hit', delta: 19, detail: '命中 speculative decoding / acceptance rate' },
      { rule: 'source-weight', delta: 16, detail: '源权重 1.6' },
      { rule: 'penalty-generic', delta: -4, detail: '与已有 Medusa 系列高度重叠' },
    ],
    externalId: 'arXiv:2510.11740v1',
    url: 'https://arxiv.org/abs/2510.11740',
  },
  {
    id: '2b70ac4e1f9d6830',
    sourceId: 'gh-vllm-releases',
    kind: 'release',
    title: 'vLLM v0.7.1 — paged attention v3 kernel, 6% decode speedup on H100',
    summary:
      'Minor release: new paged-attention kernel for FP8 KV cache, fixes a correctness bug in prefix-cache eviction under `--max-num-seqs`, and adds `/metrics` histograms for inter-token latency. No API changes.',
    authors: ['vLLM maintainers'],
    hoursAgo: 70,
    score: 66,
    keywords: ['paged attention', 'fp8', 'prefix caching', 'kernel', 'metrics'],
    reasons: [
      { rule: 'source-weight', delta: 17, detail: '源权重 1.9' },
      { rule: 'kind-boost', delta: 6, detail: 'release 类型' },
      { rule: 'keyword-hit', delta: 8, detail: '命中 paged attention / fp8' },
      { rule: 'penalty-generic', delta: -5, detail: '纯性能微优化，可专利特征弱' },
    ],
    externalId: 'vllm@v0.7.1',
    url: 'https://github.com/vllm-project/vllm/releases/tag/v0.7.1',
  },
  {
    id: '3c8e1f7a6b0d2549',
    sourceId: 'rss-hn-frontpage',
    kind: 'news',
    title: 'Show HN: streaming a 70B model at 2× speed on a single M2 Max',
    summary:
      '作者用 mmap + 4-bit 权重做了一次单机推理实验，decode 阶段主要瓶颈是内存带宽。评论区讨论里有人贴了 KV 分页与投机解码的对比数据，工程细节不少，但没有可专利的新机制。',
    authors: ['hn: karpathy_dreams'],
    hoursAgo: 34,
    score: 41,
    keywords: ['local inference', 'memory bandwidth', '4-bit', 'mac'],
    reasons: [
      { rule: 'source-weight', delta: 3, detail: '源权重 0.4' },
      { rule: 'keyword-hit', delta: 9, detail: '命中 memory bandwidth' },
      { rule: 'penalty-generic', delta: -6, detail: 'Show HN 类内容，技术密度低' },
    ],
    url: 'https://news.ycombinator.com/item?id=41982133',
  },
  {
    id: '4d9f2a6c1e8b7035',
    sourceId: 'arxiv-moe-serving',
    kind: 'paper',
    title: 'Priority-Aged Continuous Batching for Bounded Tail Latency in Mixed Workloads',
    summary:
      'Continuous batching maximises throughput but starves long requests behind a stream of short ones. We age requests by wait time and admit them by a squared-position weighting, which bounds P99 latency without measurably reducing tokens-per-second. A queueing analysis explains why the bound holds under bursty arrivals.',
    authors: ['Ravi Menon', 'Johanna Berg'],
    hoursAgo: 88,
    score: 61,
    keywords: ['continuous batching', 'scheduling', 'tail latency', 'queueing', 'slo'],
    reasons: [
      { rule: 'keyword-hit', delta: 15, detail: '命中 continuous batching / scheduling' },
      { rule: 'source-weight', delta: 11, detail: '源权重 1.1' },
      { rule: 'penalty-generic', delta: -3, detail: '调度类论文较多，需查新确认' },
    ],
    externalId: 'arXiv:2510.10988v1',
    url: 'https://arxiv.org/abs/2510.10988',
  },
  {
    id: '5e0a3b7d2c9f1864',
    sourceId: 'arxiv-kv-cache',
    kind: 'paper',
    title: 'Duplicate-KV Deduplication for Beam Search at Serving Scale',
    summary:
      'Beam search at scale stores nearly identical KV blocks for sibling beams that differ by one token. We share blocks along the beam tree with copy-on-write at the divergence point; cache footprint falls 2.7× at beam width 8 with bit-identical outputs.',
    authors: ['Hana Suzuki', 'Piotr Nowak'],
    hoursAgo: 96,
    score: 58,
    keywords: ['kv cache', 'beam search', 'deduplication', 'copy-on-write', 'memory'],
    reasons: [
      { rule: 'keyword-hit', delta: 14, detail: '命中 kv cache / deduplication' },
      { rule: 'source-weight', delta: 13, detail: '源权重 1.4' },
      { rule: 'penalty-generic', delta: -6, detail: '偏工程实现，权利要求空间窄' },
    ],
    externalId: 'arXiv:2510.10441v1',
    url: 'https://arxiv.org/abs/2510.10441',
  },
  {
    id: '6f1b4c8e3d0a2759',
    sourceId: 'arxiv-spec-decoding',
    kind: 'paper',
    title: 'A Survey of Speculative Decoding: Draft Architectures, Verification, and Serving Systems',
    summary:
      'Comprehensive survey covering 140 papers on draft model architectures, tree verification, and deployment constraints in serving engines. Useful taxonomy, but no new mechanism — the value is in the open-problem section.',
    authors: ['Wei Zhang', 'Elena Petrova'],
    hoursAgo: 120,
    score: 47,
    keywords: ['speculative decoding', 'survey', 'serving systems', 'verification'],
    reasons: [
      { rule: 'source-weight', delta: 16, detail: '源权重 1.6' },
      { rule: 'keyword-hit', delta: 12, detail: '命中 speculative decoding' },
      { rule: 'penalty-generic', delta: -12, detail: '综述类，不可专利，仅作背景' },
    ],
    externalId: 'arXiv:2510.09812v1',
    url: 'https://arxiv.org/abs/2510.09812',
  },
  {
    id: '709c5d2a4e1b3806',
    sourceId: 'rss-hn-frontpage',
    kind: 'news',
    title: 'Ask HN: does anyone actually run 128K context in production?',
    summary:
      '一条泛泛的讨论贴，回帖大多在吐槽成本。可作为客户痛点旁证，但信息价值低。',
    authors: ['hn: throwaway_ctx'],
    hoursAgo: 140,
    score: 24,
    keywords: ['long context', 'cost'],
    reasons: [
      { rule: 'source-weight', delta: 2, detail: '源权重 0.4' },
      { rule: 'keyword-hit', delta: 5, detail: '命中 long context' },
      { rule: 'penalty-generic', delta: -9, detail: '无技术细节' },
    ],
    url: 'https://news.ycombinator.com/item?id=41960012',
  },
];

function buildItems(): Item[] {
  const now = Date.now();
  return ITEM_SEEDS.map((s) => ({
    id: s.id,
    sourceId: s.sourceId,
    kind: s.kind,
    title: s.title,
    url: s.url,
    summary: s.summary,
    authors: s.authors,
    publishedAt: iso(s.hoursAgo, now),
    fetchedAt: iso(Math.max(0, s.hoursAgo - 1), now),
    score: s.score,
    scoreReasons: s.reasons,
    keywords: s.keywords,
    ...(s.externalId ? { externalId: s.externalId } : {}),
  }));
}

// ------------------------------------------------------------------ 选题

function buildIdeas(): Idea[] {
  const now = Date.now();
  return [
    {
      id: 'idea-7f2a91',
      createdAt: iso(30, now),
      updatedAt: iso(3, now),
      title: '一种基于验证反馈动态剪枝的投机解码草稿树扩展方法',
      problem:
        '树式投机解码通过一次前向生成多分支草稿以提升接受长度，但草稿模型算力固定分配在全部分支上，长上下文场景中大量分支在验证阶段被整枝拒绝，导致草稿算力空耗、端到端加速比随上下文增长而下降。',
      solution:
        '在解码步内维护一棵可增量扩展的草稿树；对每个节点累计由验证器历史拒绝记录在线标定的接受概率，当子树累计接受概率低于自适应阈值时立即剪枝并停止其后续扩展；将剪枝释放的草稿预算按接受概率从高到低重新分配给尚未饱和的叶节点，从而在固定草稿预算下提高有效接受长度；阈值随滑动窗口内的接受率变化而更新，无需离线重训练草稿模型。',
      effect:
        '在 32K 提示长度下，端到端加速比由 2.1× 提升至 2.9×，草稿模型前向次数下降 34%，输出分布与目标模型保持一致（无精度损失）；阈值自适应使不同任务（代码/对话）下加速比方差降低 40%。',
      keywords: ['投机解码', '草稿树', '剪枝', '接受率', '推理加速'],
      ipcHints: ['G06F 9/50', 'G06N 3/0455', 'G06F 12/0871'],
      queries: ['投机解码 草稿树 剪枝', '草稿模型 接受率 自适应', '推理加速 树形 验证'],
      risks: [
        'Medusa / SpecTree 系列已公开树形验证，需强调「剪枝阈值在线标定」这一动态特征',
        '华为 2023 年有草稿模型调度相关申请，注意权利要求中避免纯调度口径',
      ],
      status: 'verified',
      cites: ['a1f3c9e07b2d41a8', '1a6f9b32d8c0475e', '6f1b4c8e3d0a2759'],
      focus: '投机解码 接受率 优化',
      novelty: [
        {
          at: iso(26, now),
          query: '投机解码 草稿树 剪枝',
          hits: 0,
          topAssignees: '',
          note: '交叉带为空，三词组合无人覆盖',
          site: 'zhihuiya',
        },
        {
          at: iso(26, now),
          query: '草稿模型 接受率 自适应',
          hits: 3,
          topAssignees: '华为技术有限公司:2、清华大学:1',
          note: '3 篇均为静态阈值，无在线标定',
          site: 'zhihuiya',
        },
        {
          at: iso(25, now),
          query: '推理加速 树形 验证',
          hits: 47,
          topAssignees: '华为技术有限公司:11、百度:8、腾讯:6、浙江大学:4',
          note: '红海：树形验证本身已被大量占位，权利要求必须收缩到剪枝机制',
          site: 'zhihuiya',
        },
        {
          at: iso(3, now),
          query: '草稿树 预算 重分配',
          hits: null,
          topAssignees: '',
          note: '智慧芽页面改版，命中数没解析出来，需人工复核',
          site: 'zhihuiya',
        },
      ],
    },
    {
      id: 'idea-3c81be',
      createdAt: iso(52, now),
      updatedAt: iso(20, now),
      title: '一种多租户 LoRA 服务中带权限标记的前缀缓存跨租户共享方法',
      problem:
        '多租户 LoRA 服务中，各适配器共享同一段系统提示词却各自重复预填充，prefill 算力浪费 30%–40%；直接共享 KV 块又会造成租户间数据越权读取。',
      solution:
        '为每个前缀 KV 块维护一个可读适配器集合标记，块表在查找阶段校验当前请求的适配器标识是否属于该集合；命中则复用块并仅追加适配器相关的新块，未命中才触发完整预填充；集合标记随适配器卸载增量回收，回收时执行块级引用计数。',
      effect:
        '64 并发租户下 prefill 延迟下降 2.3×，越权读取为零（形式化校验通过），显存占用下降 27%。',
      keywords: ['前缀缓存', 'LoRA', '多租户', '隔离', '预填充'],
      ipcHints: ['G06F 12/0846', 'G06F 21/62', 'G06N 3/0455'],
      queries: ['前缀缓存 多租户 共享', 'KV 缓存 权限 隔离', 'LoRA 预填充 复用'],
      risks: [
        '「缓存共享」本身在 CDN 领域是成熟概念，需把创造性落在「块级可读集合 + 引用计数回收」',
        '阿里云有 PAI 多租户推理相关申请，注意区分训练态与推理态',
      ],
      status: 'draft',
      cites: ['d81b6f302ce7459a', 'e2a97c4b05d31f68', 'b7c21d5e93af4061'],
      focus: '多租户 LoRA 前缀缓存',
      novelty: [
        {
          at: iso(20, now),
          query: '前缀缓存 多租户 共享',
          hits: 6,
          topAssignees: '阿里云计算有限公司:4、华为技术有限公司:2',
          note: '有共享但未见权限标记，存在绕开空间',
          site: 'zhihuiya',
        },
        {
          at: iso(19, now),
          query: 'KV 缓存 权限 隔离',
          hits: 0,
          topAssignees: '',
          note: '',
          site: 'zhihuiya',
        },
      ],
    },
    {
      id: 'idea-9d40ca',
      createdAt: iso(80, now),
      updatedAt: iso(46, now),
      title: '一种分层量化的 KV Cache 主机内存卸载与回填调度方法',
      problem:
        '单卡 24GB 显存无法承载 128K 会话的 KV Cache，全部按需拷贝会让每个解码步都阻塞在 PCIe 传输上。',
      solution:
        '按注意力层敏感度将 KV 分为常驻、可换出、按需三层；对可换出层提前一步发起 DMA 预取并与注意力计算重叠；预取队列饱和时退化为按需拷贝。',
      effect: '隐藏 87% 的 PCIe 延迟，128K 会话吞吐提升 1.9×，精度无损。',
      keywords: ['KV Cache', '量化', '卸载', '预取', 'PCIe'],
      ipcHints: ['G06F 12/0868', 'G06F 13/28', 'G06N 3/063'],
      queries: ['KV缓存 卸载 调度', '显存 分层 量化', '预取 PCIe 推理'],
      risks: [
        'KV 卸载已有大量申请（华为、浪潮、寒武纪），本条风险最高',
        '建议转向「层敏感度分层」而非「卸载」这一通用动作',
      ],
      status: 'red-ocean',
      cites: ['c04e8b1f6d2a9357', '0712c4d9ab8e35f2'],
      focus: 'KV Cache 卸载 长上下文',
      novelty: [
        {
          at: iso(46, now),
          query: 'KV缓存 卸载 调度',
          hits: 183,
          topAssignees: '华为技术有限公司:52、浪潮电子信息:21、寒武纪:18、中兴通讯:11',
          note: '红海，头部集中度极高，正面申请无意义',
          site: 'zhihuiya',
        },
        {
          at: iso(46, now),
          query: '显存 分层 量化',
          hits: 64,
          topAssignees: '华为技术有限公司:19、上海交通大学:7',
          note: '分层量化有占位，但仍无「层敏感度 + 预取队列退化」组合',
          site: 'zhihuiya',
        },
        {
          at: iso(45, now),
          query: '预取 PCIe 推理',
          hits: 12,
          topAssignees: '中国科学院计算技术研究所:3、寒武纪:2',
          note: '窄口径下命中有限，可作为收缩后的落点',
          site: 'zhihuiya',
        },
      ],
    },
    {
      id: 'idea-1b6f52',
      createdAt: iso(200, now),
      updatedAt: iso(120, now),
      title: '一种 MoE 专家路由直方图的运行时专家换出方法',
      problem: 'MoE 专家利用率高度倾斜且随请求分布漂移，低流量专家长期占用显存。',
      solution: '按层维护衰减路由直方图，直方图质量低于滞后阈值的专家换出至主机内存，回升时回填。',
      effect: 'Mixtral-8x22B 解码吞吐提升 1.8×，基准平均下降 0.4 点。',
      keywords: ['MoE', '专家换出', '路由', '显存'],
      ipcHints: ['G06N 3/063', 'G06F 9/50'],
      queries: ['专家 换出 路由', 'MoE 显存 调度', '专家利用率 直方图'],
      risks: ['与 DeepSeek 已公开的专家卸载路线接近，暂时搁置'],
      status: 'archived',
      cites: ['f5d30a8e2b6c7941'],
      focus: 'MoE 专家调度',
      novelty: [
        {
          at: iso(120, now),
          query: '专家 换出 路由',
          hits: 9,
          topAssignees: '北京智谱华章:3、华为技术有限公司:2',
          note: '归档原因：与在研项目目标客户不匹配，非查新结论',
          site: 'zhihuiya',
        },
      ],
    },
  ];
}

// ------------------------------------------------------------------ 运行记录

function buildRuns(): RunRecord[] {
  const now = Date.now();
  const seeds: { h: number; dur: number; src: number; added: number; fetched: number; errors: number }[] = [
    { h: 3, dur: 8, src: 5, added: 7, fetched: 118, errors: 0 },
    { h: 11, dur: 11, src: 5, added: 4, fetched: 121, errors: 1 },
    { h: 19, dur: 7, src: 5, added: 9, fetched: 116, errors: 0 },
    { h: 27, dur: 15, src: 5, added: 2, fetched: 88, errors: 2 },
    { h: 35, dur: 6, src: 4, added: 5, fetched: 96, errors: 0 },
    { h: 43, dur: 9, src: 4, added: 6, fetched: 103, errors: 0 },
    { h: 51, dur: 22, src: 4, added: 0, fetched: 12, errors: 3 },
  ];
  return seeds.map((s, i) => {
    const started = now - s.h * HOUR;
    const errors =
      s.errors > 0 && i % 2 === 0
        ? [
            {
              sourceId: 'arxiv-moe-serving',
              message: `HTTP 503 from export.arxiv.org after 3 retries (request ${s.fetched} entries)`,
            },
          ]
        : s.errors > 1
          ? [
              {
                sourceId: 'arxiv-moe-serving',
                message: 'HTTP 503 from export.arxiv.org after 3 retries',
              },
              {
                sourceId: 'rss-lmsys-blog',
                message: 'feed 返回 0 条 item，可能改版（expected <entry>, got <html>）',
              },
            ]
          : s.errors > 0
            ? [
                {
                  sourceId: 'rss-lmsys-blog',
                  message: 'feed 解析超时 8s',
                },
              ]
            : [];
    return {
      id: `run-${(now - s.h * HOUR).toString(36)}`,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(started + s.dur * 1000).toISOString(),
      sourceCount: s.src,
      added: s.added,
      fetched: s.fetched,
      errors,
    };
  });
}

// ------------------------------------------------------------------ 可变的内存库

interface MockDb {
  sources: Source[];
  items: Item[];
  ideas: Idea[];
  runs: RunRecord[];
}

let db: MockDb | null = null;

function store(): MockDb {
  if (!db) {
    db = { sources: SOURCES.map((s) => ({ ...s })), items: buildItems(), ideas: buildIdeas(), runs: buildRuns() };
  }
  return db;
}

// ------------------------------------------------------------------ 读

export function mockStats(): Stats {
  const s = store();

  // 近 7 天每日新增：直接来自条目的 fetchedAt，保证与列表/库内总数自洽
  const byDay = new Map<string, number>();
  for (let i = 6; i >= 0; i--) byDay.set(dateOnly(i), 0);
  for (const it of s.items) {
    const d = it.fetchedAt.slice(0, 10);
    if (byDay.has(d)) byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  const dailyAdded = [...byDay.entries()].map(([date, count]) => ({ date, count }));

  // 相关度直方图：[0,20) [20,40) [40,60) [60,80) [80,100]
  const buckets = [
    { bucket: '[0,20)', count: 0 },
    { bucket: '[20,40)', count: 0 },
    { bucket: '[40,60)', count: 0 },
    { bucket: '[60,80)', count: 0 },
    { bucket: '[80,100]', count: 0 },
  ];
  for (const it of s.items) {
    const idx = Math.min(4, Math.max(0, Math.floor(it.score / 20)));
    const b = buckets[idx];
    if (b) b.count += 1;
  }

  return {
    items: s.items.length,
    ideas: s.ideas.filter((i) => i.status !== 'archived').length,
    sources: s.sources.length,
    enabledSources: s.sources.filter((x) => x.enabled).length,
    lastRunAt: s.runs[0]?.finishedAt ?? null,
    dailyAdded,
    scoreHistogram: buckets,
  };
}

export function mockItems(q: ItemQuery): Paged<Item> {
  const s = store();
  const limit = Math.min(200, Math.max(1, q.limit ?? 30));
  const offset = Math.max(0, q.offset ?? 0);
  const needle = (q.q ?? '').trim().toLowerCase();
  const sinceTs = q.since ? Date.parse(q.since) : null;

  let list = s.items.filter((it) => {
    if (q.sourceId && it.sourceId !== q.sourceId) return false;
    if (q.kind && it.kind !== q.kind) return false;
    if (q.minScore !== undefined && it.score < q.minScore) return false;
    if (sinceTs !== null && !Number.isNaN(sinceTs) && Date.parse(it.publishedAt) < sinceTs) return false;
    if (needle) {
      const hay = `${it.title}\n${it.summary}\n${it.keywords.join(' ')}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  list = [...list].sort((a, b) =>
    q.sort === 'time'
      ? Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
      : b.score - a.score,
  );

  return { items: list.slice(offset, offset + limit), total: list.length, limit, offset };
}

export function mockItem(id: string): Item | undefined {
  return store().items.find((i) => i.id === id);
}

export function mockSources(): Source[] {
  return store().sources.map((s) => ({ ...s }));
}

/** 详情视图：Idea + verdictSummary（演示模式下本地算，真实模式这活由服务端干） */
export function withVerdict(idea: Idea): IdeaWithVerdict {
  return { ...idea, verdictSummary: fallbackSummary(idea) };
}

export function mockIdeas(status?: string): IdeaWithVerdict[] {
  const list = store().ideas.filter((i) => (status ? i.status === status : true));
  return [...list]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map(withVerdict);
}

export function mockRuns(): RunRecord[] {
  return [...store().runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

// ------------------------------------------------------------------ 写

export function mockCollect(sourceIds?: string[]): RunRecord {
  const s = store();
  const enabled = s.sources.filter((x) => x.enabled && (!sourceIds || sourceIds.includes(x.id)));
  const started = Date.now();
  const added = 3;
  const run: RunRecord = {
    id: `run-${started.toString(36)}`,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(started + 6400).toISOString(),
    sourceCount: enabled.length,
    added,
    fetched: enabled.length * 22 + 9,
    errors:
      enabled.length > 0
        ? [{ sourceId: enabled[enabled.length - 1]?.id ?? '', message: 'HTTP 503 from export.arxiv.org after 3 retries' }]
        : [],
  };
  s.runs.unshift(run);
  // 演示模式也真的让数据动起来：从已有条目里复制两条「刚刚到达」的
  const pool = s.items.slice(0, 2);
  let i = 0;
  for (const p of pool) {
    s.items.unshift({
      ...p,
      id: `${p.id.slice(0, 12)}${(started + i).toString(16).slice(-4)}`,
      publishedAt: new Date(started + i * 1000).toISOString(),
      fetchedAt: new Date(started + i * 1000).toISOString(),
      score: Math.max(20, Math.min(99, p.score - i)),
    });
    i += 1;
  }
  return run;
}

export function mockPatchSource(
  id: string,
  patch: { enabled?: boolean; weight?: number; note?: string },
): Source {
  const s = store();
  const src = s.sources.find((x) => x.id === id);
  if (!src) throw new Error(`source ${id} not found`);
  if (patch.enabled !== undefined) src.enabled = patch.enabled;
  if (patch.weight !== undefined) src.weight = Math.min(3, Math.max(0.1, patch.weight));
  if (patch.note !== undefined) src.note = patch.note;
  return { ...src };
}

export function mockDeleteSource(id: string): void {
  const s = store();
  s.sources = s.sources.filter((x) => x.id !== id);
}

export function mockCreateSource(body: {
  id: string;
  kind: Source['kind'];
  label: string;
  url: string;
  weight?: number;
  tags?: string[];
  note?: string;
}): Source {
  const s = store();
  const src: Source = {
    id: body.id,
    kind: body.kind,
    label: body.label,
    url: body.url,
    weight: body.weight ?? 1,
    enabled: true,
    tags: body.tags ?? [],
    note: body.note ?? '',
    createdAt: new Date().toISOString(),
  };
  s.sources.push(src);
  return src;
}

const IDEA_TEMPLATES: { title: string; problem: string; solution: string; effect: string }[] = [
  {
    title: '一种基于请求分布漂移检测的推理批处理窗口自适应调整方法',
    problem:
      '固定批处理窗口在请求长度分布发生漂移时，要么等待超时造成空转、要么批内含长请求拖慢同批短请求，P99 延迟不可控。',
    solution:
      '在滑动窗口内统计请求长度分位数，当其变异系数超过阈值时触发窗口调整；按预测的剩余解码步数对批内请求分桶，长请求单独成批并与短批交替调度；窗口长度以「等待超时损失 + 批内干扰损失」的加权代价最小为目标求解。',
    effect: '混合负载下 P99 延迟下降 41%，tokens/s 仅下降 3.2%，无需改动模型与算子。',
  },
  {
    title: '一种基于缓存块热度的前缀缓存驱逐与预取协同方法',
    problem:
      '前缀缓存按 LRU 驱逐，会把「低频但周期性复用」的长前缀踢出，导致多轮对话中反复全量预填充；单纯提高缓存容量又挤占 KV 空间。',
    solution:
      '为每个缓存块维护带衰减的命中热度与其后续复用间隔估计，驱逐时按「热度 × 预测复用临近度」排序而非最近访问时间；对被驱逐的高热度块发起后台预取，预取结果在命中时直接替换，未命中则回滚引用计数。',
    effect: '多轮对话 prefill 命中率由 46% 提升至 78%，缓存内存占用不增加，首 token 延迟下降 33%。',
  },
  {
    title: '一种面向异构算力的解码阶段算子卸载决策方法',
    problem:
      '解码阶段算力密集度低、访存密集度高，统一按层切分给 GPU 会在小 batch 下浪费算力，在大 batch 下又成为瓶颈。',
    solution:
      '按实时 batch 规模与序列长度，估算各层在 GPU/NPU 上的访存-算力比，将访存受限的层整体迁移至带宽更高的设备，算力受限的层保留在原设备；迁移决策以微秒级时间窗滚动重估，并通过双缓冲隐藏跨设备同步开销。',
    effect: '小 batch 场景下 decode 吞吐提升 1.6×，跨设备同步开销占比低于 4%。',
  },
];

export function mockGenerateIdeas(focus: string, count: number): { ideas: IdeaWithVerdict[]; usedItems: string[] } {
  const s = store();
  const now = new Date();
  const n = Math.max(1, Math.min(5, count));
  const usedItems = s.items
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((i) => i.id);

  const ideas: Idea[] = [];
  for (let i = 0; i < n; i++) {
    const t = IDEA_TEMPLATES[i % IDEA_TEMPLATES.length] ?? IDEA_TEMPLATES[0];
    if (!t) continue;
    const idea: Idea = {
      id: `idea-${now.getTime().toString(36)}${i}`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      title: t.title,
      problem: t.problem,
      solution: t.solution,
      effect: t.effect,
      keywords: focus
        .split(/[\s,，、]+/)
        .filter(Boolean)
        .slice(0, 4)
        .concat(['推理调度']),
      ipcHints: ['G06F 9/50', 'G06N 3/0455'],
      queries: [
        `${focus.slice(0, 8)} 批处理 窗口`,
        `${focus.slice(0, 8)} 缓存 驱逐`,
        `${focus.slice(0, 8)} 卸载 决策`,
      ],
      risks: ['演示数据：真接口接入后此处的风险点由 LLM 生成，需人工复核'],
      status: 'draft',
      cites: usedItems,
      focus,
      novelty: [],
    };
    ideas.push(idea);
  }
  s.ideas.unshift(...ideas);
  return { ideas: ideas.map(withVerdict), usedItems };
}

/**
 * 与服务端 verdict.ts 一致的机械重算：
 * 全零 / 全解析失败 → 待判（draft），1–49 → 已验证，≥50 → 红海。
 * 归档态不参与自动重算；gap 只能人工确认，mock 永不自动产出 gap。
 */
function recomputeStatus(idea: Idea): void {
  if (idea.status === 'archived') return;
  const v = fallbackSummary(idea).verdict;
  idea.status = v === 'red-ocean' ? 'red-ocean' : v === 'opportunity' ? 'verified' : 'draft';
}

export function mockAddNovelty(
  ideaId: string,
  rec: { query: string; hits: number | null; topAssignees?: string; note?: string; site?: 'zhihuiya' | 'manual' | 'other' },
): IdeaWithVerdict {
  const s = store();
  const idea = s.ideas.find((i) => i.id === ideaId);
  if (!idea) throw new Error(`idea ${ideaId} not found`);
  idea.novelty.unshift({
    at: new Date().toISOString(),
    query: rec.query,
    hits: rec.hits,
    topAssignees: rec.topAssignees ?? '',
    note: rec.note ?? '',
    site: rec.site ?? 'manual',
  });
  recomputeStatus(idea);
  idea.updatedAt = new Date().toISOString();
  return withVerdict({ ...idea, novelty: [...idea.novelty] });
}

export function mockPatchIdea(id: string, patch: Partial<Pick<Idea, 'status' | 'title'>>): IdeaWithVerdict {
  const s = store();
  const idea = s.ideas.find((i) => i.id === id);
  if (!idea) throw new Error(`idea ${id} not found`);
  if (patch.status) idea.status = patch.status;
  if (patch.title) idea.title = patch.title;
  idea.updatedAt = new Date().toISOString();
  return withVerdict({ ...idea, novelty: [...idea.novelty] });
}
