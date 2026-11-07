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
  /** 死源行的公共底座：保留 id/url/label 供「为什么这个源不可用」溯源，但默认禁用 */
  const deadBase = { ...base, enabled: false } as const;

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


    // ================================================================
    // daily-newsletter 新闻源（t19）：导入批次 41 个；chat 合并（t24 之后）实测出 6 条死源
    // 已挪入下方「已死源」小节默认禁用，此处保留 35 个活跃源。
    // id=rss-<slug>；tags 一律 ['news', <分类>]；note 标注「来源 daily-newsletter」，部分带一线评估补充。
    // 导入批次分类：中文科技 14 / 国际科技 8 / 区块链 8 / 游戏 4 / AI 官方 3 / 开发者 4。
    // ================================================================

    // —— 中文科技（11） ——
    {
      ...base,
      id: 'rss-36kr',
      kind: 'rss',
      label: '36氪',
      url: 'https://36kr.com/feed',
      weight: 1.3,
      tags: ['news', 'china-tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-51cto',
      kind: 'rss',
      label: '51CTO 技术栈',
      url: 'https://www.51cto.com/rss/',
      weight: 1.2,
      tags: ['news', 'china-tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-appso',
      kind: 'rss',
      label: 'AppSo（爱范儿旗下）',
      url: 'https://appso.com/feed/',
      weight: 1.2,
      tags: ['news', 'china-tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-geekpark',
      kind: 'rss',
      label: '极客公园',
      url: 'https://www.geekpark.net/rss',
      weight: 1.3,
      tags: ['news', 'china-tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-ifanr',
      kind: 'rss',
      label: '爱范儿',
      url: 'https://www.ifanr.com/feed',
      weight: 1.3,
      tags: ['news', 'china-tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-ithome',
      kind: 'rss',
      label: 'IT之家',
      url: 'https://www.ithome.com/rss/',
      weight: 1.3,
      tags: ['news', 'china-tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-leiphone',
      kind: 'rss',
      label: '雷峰网',
      url: 'https://www.leiphone.com/feed',
      weight: 1.3,
      tags: ['news', 'china-tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-pingwest',
      kind: 'rss',
      label: '品玩 PingWest',
      url: 'https://pingwest.com/feed',
      weight: 1.2,
      tags: ['news', 'china-tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-qbitai',
      kind: 'rss',
      label: '量子位',
      url: 'https://www.qbitai.com/feed/',
      weight: 1.4,
      tags: ['news', 'china-tech'],
      note: '来源 daily-newsletter。中文 AI 媒体里最贴技术的一档，AI 新闻密度高。',
    },
    {
      ...base,
      id: 'rss-ssdfans',
      kind: 'rss',
      label: 'SSD 爱好者',
      url: 'https://ssdfans.com/feed/',
      weight: 1.2,
      tags: ['news', 'china-tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-tmtpost',
      kind: 'rss',
      label: '钛媒体',
      url: 'https://www.tmtpost.com/rss',
      weight: 1.2,
      tags: ['news', 'china-tech'],
      note: '来源 daily-newsletter。',
    },

    // —— 国际科技（8） ——
    {
      ...base,
      id: 'rss-arstechnica',
      kind: 'rss',
      label: 'Ars Technica',
      url: 'https://arstechnica.com/feed/',
      weight: 1.3,
      tags: ['news', 'tech'],
      note: '来源 daily-newsletter。深度技术报道占比高，AI/芯片线值得跟。',
    },
    {
      ...base,
      id: 'rss-cnet',
      kind: 'rss',
      label: 'CNET',
      url: 'https://www.cnet.com/rss/news/',
      weight: 1.2,
      tags: ['news', 'tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-engadget',
      kind: 'rss',
      label: 'Engadget',
      url: 'https://www.engadget.com/rss.xml',
      weight: 1.2,
      tags: ['news', 'tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-gizmodo',
      kind: 'rss',
      label: 'Gizmodo',
      url: 'https://gizmodo.com/rss',
      weight: 1.2,
      tags: ['news', 'tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-techcrunch',
      kind: 'rss',
      label: 'TechCrunch',
      url: 'https://techcrunch.com/feed/',
      weight: 1.3,
      tags: ['news', 'tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-theverge',
      kind: 'rss',
      label: 'The Verge',
      url: 'https://www.theverge.com/rss/index.xml',
      weight: 1.3,
      tags: ['news', 'tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-wired',
      kind: 'rss',
      label: 'WIRED',
      url: 'https://www.wired.com/feed/rss',
      weight: 1.2,
      tags: ['news', 'tech'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-zdnet',
      kind: 'rss',
      label: 'ZDNet',
      url: 'https://www.zdnet.com/rss/',
      weight: 1.2,
      tags: ['news', 'tech'],
      note: '来源 daily-newsletter。',
    },

    // —— 区块链（6） ——
    {
      ...base,
      id: 'rss-binance-en',
      kind: 'rss',
      label: 'Binance Blog',
      url: 'https://www.binance.com/en/blog/rss.xml',
      weight: 1.0,
      tags: ['news', 'crypto'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-binance-zh',
      kind: 'rss',
      label: '币安博客（中文）',
      url: 'https://www.binance.com/zh-CN/blog/rss.xml',
      weight: 1.0,
      tags: ['news', 'crypto'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-coindesk',
      kind: 'rss',
      label: 'CoinDesk',
      url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
      weight: 1.1,
      tags: ['news', 'crypto'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-cointelegraph',
      kind: 'rss',
      label: 'Cointelegraph',
      url: 'https://cointelegraph.com/rss',
      weight: 1.1,
      tags: ['news', 'crypto'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-decrypt',
      kind: 'rss',
      label: 'Decrypt',
      url: 'https://decrypt.co/feed',
      weight: 1.0,
      tags: ['news', 'crypto'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-theblock',
      kind: 'rss',
      label: 'The Block',
      url: 'https://www.theblock.co/rss.xml',
      weight: 1.1,
      tags: ['news', 'crypto'],
      note: '来源 daily-newsletter。',
    },

    // —— 游戏（4） ——
    {
      ...base,
      id: 'rss-gamesindustry',
      kind: 'rss',
      label: 'GamesIndustry.biz',
      url: 'https://www.gamesindustry.biz/feed/',
      weight: 1.0,
      tags: ['news', 'gaming'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-ign',
      kind: 'rss',
      label: 'IGN',
      url: 'https://feeds.ign.com/ign/all',
      weight: 1.0,
      tags: ['news', 'gaming'],
      note: '来源 daily-newsletter。URL 用 IGN 官方联合 feed（ign.com/rss 已 404，t23 实测替换）。',
    },
    {
      ...base,
      id: 'rss-kotaku',
      kind: 'rss',
      label: 'Kotaku',
      url: 'https://kotaku.com/rss',
      weight: 1.0,
      tags: ['news', 'gaming'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-polygon',
      kind: 'rss',
      label: 'Polygon',
      url: 'https://www.polygon.com/rss/index.xml',
      weight: 1.0,
      tags: ['news', 'gaming'],
      note: '来源 daily-newsletter。',
    },

    // —— AI 官方（2） ——
    {
      ...base,
      id: 'rss-deepmind-blog',
      kind: 'rss',
      label: 'Google DeepMind Blog',
      url: 'https://deepmind.google/blog/rss.xml',
      weight: 1.4,
      tags: ['news', 'ai'],
      note: '来源 daily-newsletter。DeepMind 官方（Gemini/研究）；deepmind.com 会跳到 deepmind.google，这里直接存落地地址。',
    },
    {
      ...base,
      id: 'rss-openai-blog',
      kind: 'rss',
      label: 'OpenAI Blog',
      url: 'https://openai.com/blog/rss.xml',
      weight: 1.4,
      tags: ['news', 'ai'],
      note: '来源 daily-newsletter。官方发布（模型/产品/安全），AI 行业的锚点信号源。',
    },

    // —— 开发者（4） ——
    {
      ...base,
      id: 'rss-dev-to',
      kind: 'rss',
      label: 'DEV Community',
      url: 'https://dev.to/feed',
      weight: 1.2,
      tags: ['news', 'dev'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-github-blog',
      kind: 'rss',
      label: 'GitHub Blog',
      url: 'https://github.com/blog.atom',
      weight: 1.3,
      tags: ['news', 'dev'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-hackernoon',
      kind: 'rss',
      label: 'HackerNoon',
      url: 'https://hackernoon.com/feed',
      weight: 1.2,
      tags: ['news', 'dev'],
      note: '来源 daily-newsletter。',
    },
    {
      ...base,
      id: 'rss-stackoverflow-blog',
      kind: 'rss',
      label: 'Stack Overflow Blog',
      url: 'https://stackoverflow.blog/feed/',
      weight: 1.2,
      tags: ['news', 'dev'],
      note: '来源 daily-newsletter。',
    },

    // ------------------------- 已死源（默认禁用，仅留档） -------------------------
    // 以下源 Lead 已实测确认失效，保留行 + 原因是防止后来者重新添加再踩一遍坑。
    // 全新安装默认 enabled=false；已装环境的存量行由集成脚本改 DB，这里只管默认值。
    {
      ...deadBase,
      id: 'rss-anthropic-blog',
      kind: 'rss',
      label: 'Anthropic Blog',
      url: 'https://www.anthropic.com/blog/rss.xml',
      weight: 1.4,
      tags: ['news', 'ai'],
      note: '默认禁用（实测）：官方 RSS 全线 404。来源 daily-newsletter，Claude 系官方发布与对齐研究动态。',
    },
    {
      ...deadBase,
      id: 'rss-huxiu',
      kind: 'rss',
      label: '虎嗅',
      url: 'https://www.huxiu.com/rss.xml',
      weight: 1.4,
      tags: ['news', 'china-tech'],
      note: '默认禁用（实测）：连接失败（疑似反爬/断连）。来源 daily-newsletter，中文科技媒体。',
    },
    {
      ...deadBase,
      id: 'rss-okx-learn-en',
      kind: 'rss',
      label: 'OKX Learn',
      url: 'https://www.okx.com/learn/rss.xml',
      weight: 1.4,
      tags: ['news', 'crypto'],
      note: '默认禁用（实测）：404。来源 daily-newsletter，加密行业教学内容（英文站）。',
    },
    {
      ...deadBase,
      id: 'rss-okx-learn-zh',
      kind: 'rss',
      label: 'OKX 学习（中文）',
      url: 'https://www.okx.com/cn/learn/rss.xml',
      weight: 1.4,
      tags: ['news', 'crypto'],
      note: '默认禁用（实测）：404。来源 daily-newsletter，加密行业教学内容（中文站）。',
    },
    {
      ...deadBase,
      id: 'rss-cyzone',
      kind: 'rss',
      label: '创业邦',
      url: 'https://www.cyzone.cn/rss',
      weight: 1.4,
      tags: ['news', 'china-tech'],
      note: '默认禁用（实测）：/rss 与 /feed/ 均 404。来源 daily-newsletter，创投媒体。',
    },
    {
      ...deadBase,
      id: 'rss-aigc-cn',
      kind: 'rss',
      label: 'AIGC.cn',
      url: 'https://aigc.cn/feed/',
      weight: 1.4,
      tags: ['news', 'china-tech'],
      note: '默认禁用（实测）：403 反爬。来源 daily-newsletter，AIGC 资讯聚合。',
    },
  ];
}

/** 首次启动时灌库的清单（时间戳取模块加载时刻） */
export const DEFAULT_SOURCES: Source[] = defaultSources();
