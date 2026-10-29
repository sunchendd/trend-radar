import type { Source } from '../types.js';

/**
 * 内置情报源清单。
 *
 * 选源口径：只保留「能直接指向推理加速工程决策」的源。
 * - arXiv 关键词订阅负责「新方法」，必须按 URL 订阅（不能按分类，分类一改就抓错、且噪音大）；
 * - GitHub Releases 负责「方法真的进了生产引擎」这个工程验证信号；
 * - 厂商/社区 blog 负责「还没写论文但已经在调优」的一手经验。
 *
 * max_results 取 20 而不是 config.limitPerSource 的默认 40：arXiv 响应时间基本与条目数成正比，
 * 实测 40 条要 6–16s（还撞上过 19.9s），紧贴 20s 超时线；20 条稳定在 3s 量级。
 * 三个关键词订阅各取 20 条已经能覆盖当天新论文，再多也只是重复（跨源还要按 arXiv id 去重）。
 */

const ARXIV_BASE = 'https://export.arxiv.org/api/query';
const MAX = 20;

/** 按关键词拼 arXiv 查询 URL；短语必须带引号，否则被拆成 OR 语义，噪音暴涨 */
function arxivQuery(searchQuery: string): string {
  return `${ARXIV_BASE}?search_query=${searchQuery}&sortBy=submittedDate&sortOrder=descending&max_results=${MAX}`;
}

export function defaultSources(now: Date = new Date()): Source[] {
  const createdAt = now.toISOString();
  const base = { enabled: true, createdAt } as const;

  return [
    {
      ...base,
      id: 'arxiv-speculative-decoding',
      kind: 'arxiv',
      label: 'arXiv · 投机解码',
      // 只写 https：export.arxiv.org 的 http 会 301，且并发打同一 URL 会 500
      url: arxivQuery('all:%22speculative+decoding%22'),
      weight: 2.4,
      tags: ['paper', 'speculative-decoding'],
      note: '投机解码（draft/verify、EAGLE、MTP、自投机）是当前推理加速最活跃的专利密集区，单独立一个源避免被通用推理论文淹没。',
    },
    {
      ...base,
      id: 'arxiv-kv-cache-inference',
      kind: 'arxiv',
      label: 'arXiv · KV cache 与推理',
      url: arxivQuery('all:%22KV+cache%22+AND+all:%22inference%22'),
      weight: 2.4,
      tags: ['paper', 'kv-cache'],
      note: 'KV cache 的压缩/稀疏/卸载/前缀复用是显存瓶颈的主战场，也是异构部署专利的共同技术底座。',
    },
    {
      ...base,
      id: 'arxiv-pd-disaggregation',
      kind: 'arxiv',
      label: 'arXiv · PD 分离',
      url: arxivQuery('all:%22prefill%22+AND+all:%22decode%22+AND+all:%22disaggregation%22'),
      weight: 2.0,
      tags: ['paper', 'pd-disaggregation'],
      note: 'Prefill/Decode 分离调度决定集群吞吐，很多「异构 GPU-NPU 混部」方案的创新点其实落在这里。',
    },
    {
      ...base,
      id: 'github-vllm-releases',
      kind: 'atom',
      label: 'vLLM Releases',
      url: 'https://github.com/vllm-project/vllm/releases.atom',
      weight: 2.8,
      tags: ['release', 'engine', 'vllm'],
      note: 'vLLM 是本领域事实标准引擎；release note 里出现的调度器/KV/投机改动就是「已工程验证」的最强信号，权重给最高。',
    },
    {
      ...base,
      id: 'github-sglang-releases',
      kind: 'atom',
      label: 'SGLang Releases',
      url: 'https://github.com/sgl-project/sglang/releases.atom',
      weight: 2.6,
      tags: ['release', 'engine', 'sglang'],
      note: 'SGLang 的 RadixAttention/前缀缓存与 PD 分离实现更新快，是 vLLM 之外最值得跟的第二条工程线。',
    },
    {
      ...base,
      id: 'github-tensorrt-llm-releases',
      kind: 'atom',
      label: 'TensorRT-LLM Releases',
      url: 'https://github.com/NVIDIA/TensorRT-LLM/releases.atom',
      weight: 2.4,
      tags: ['release', 'engine', 'tensorrt-llm'],
      note: 'NVIDIA 官方引擎，其 release 往往先暴露新硬件（FP8/NVFP4、Blackwell）上的算子与量化取舍，对硬件相关专利有指向性。',
    },
    {
      ...base,
      id: 'blog-flashinfer',
      kind: 'rss',
      label: 'FlashInfer Blog',
      url: 'https://flashinfer.ai/feed.xml',
      weight: 1.8,
      tags: ['blog', 'kernel'],
      note: 'FlashInfer 专注 attention/采样内核与 autotune，博文里的实测数据常是论文里看不到的工程细节，适合给专利补「效果」证据。',
    },
  ];
}

/** 首次启动时灌库的清单（时间戳取模块加载时刻） */
export const DEFAULT_SOURCES: Source[] = defaultSources();
