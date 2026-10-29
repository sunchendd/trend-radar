/**
 * 选题生成 / 查新解读 的 prompt 模板（集中管理，带版本号）。
 *
 * 为什么模板要独立成文件并且带版本：
 *   生产上跑过一轮之后，最难回答的问题是「这条选题是拿哪版口径生成的」。
 *   模板一改（多了 few-shot、改了校验口径），历史选题的质量就没法对比。
 *   所以 PROMPT_VERSION 会随每条 idea 一起落库，回溯时一眼能看出批次差异。
 */

import type { Item, ItemKind, NoveltyRecord } from '../types.js';

/** 口径版本：改动模板/校验规则时**必须**升版本，否则历史数据无法归因。 */
export const PROMPT_VERSION = '2026-10-idea-v2';

// ---------------------------------------------------------------- 校验共享常量

/** 检索式词数区间（中文词，空格分隔）。3 词以下太宽、6 词以上几乎必然全零。 */
export const QUERY_MIN_WORDS = 3;
export const QUERY_MAX_WORDS = 5;
/**
 * 同一批检索式允许的最大词数差。
 * 查新时要把命中数横向比较，词数差太大就变成「词多的必然少」，
 * 比出来的不是技术密度而是检索式松紧。prompt 要求等词数（差 ≤1），
 * 校验放宽到 2 是因为分词口径差异（把「预填充-解码」算 1 词还是 2 词）。
 */
export const QUERY_WORD_SPREAD_MAX = 2;

/**
 * 真实 IPC 分类号：部 A–H + 大类两位数字 + 小类字母 + 大组/小组。
 * 例：G06F12/0871、H04L67/10。允许中间一个空格（官方写法 G06F 12/0871）。
 * 只认这个形状，是为了挡住模型爱写的「G06F（电数字数据处理）」这类伪分类号。
 */
export const IPC_PATTERN = /^[A-H]\d{2}[A-Z]\d{1,4}\/\d{2,6}$/u;

/** 生成选题时至少要求的「相互配合的技术手段」数量。 */
export const MIN_SOLUTION_FEATURES = 3;

/**
 * 实测会**压低命中数**的写法 → 同义改写表。
 *
 * 为什么单独维护这张表：智慧芽简单搜索按词面 AND 匹配，词库对「KV缓存」的覆盖
 * 远高于「KV压缩」（前者是论文/专利里的标准术语，后者多见于工程博客）。
 * 同一个方案换一个词，命中数能从 0 跳到几十——这正是「全零不等于空白」的具体机制。
 * 表由人工实测维护，不做自动同义词扩展（自动扩展会把检索变得无法解释）。
 */
export const SYNONYM_REWRITES: readonly { pattern: string; to: string }[] = [
  { pattern: 'KV压缩', to: 'KV缓存' },
  { pattern: '压缩', to: '缓存' },
];

export interface SynonymRewrite {
  /** 被替换的原文 */
  from: string;
  /** 替换后的写法 */
  to: string;
  /** 改写后的完整检索式 */
  text: string;
}

/**
 * 给一条检索式生成同义改写候选。
 * 只做词面替换，不去词、不改词序——保持与原文的可比性（命中数差异只来自术语）。
 */
export function synonymRewrites(query: string): SynonymRewrite[] {
  const base = String(query ?? '').trim();
  if (base === '') return [];
  const out: SynonymRewrite[] = [];
  const seen = new Set<string>([base]);
  for (const rule of SYNONYM_REWRITES) {
    if (!base.includes(rule.pattern)) continue;
    const text = base.split(rule.pattern).join(rule.to);
    if (text === base || seen.has(text)) continue;
    seen.add(text);
    out.push({ from: rule.pattern, to: rule.to, text });
  }
  return out;
}

export const SYSTEM_PROMPT =
  '你是一名资深中国发明专利代理师兼技术情报分析师。你的读者是专利工程师，' +
  '他会直接拿你的产出去做查新和撰写，所以宁可保守也不能编造。' +
  '你只输出 JSON，不输出解释文字、不输出 Markdown 围栏。';

// ---------------------------------------------------------------- 选题生成

const KIND_LABEL: Record<ItemKind, string> = {
  paper: '论文',
  news: '新闻',
  release: '版本发布',
};

export interface PromptItem {
  item: Item;
  /** 从 1 开始的引用序号，模型在 cites 里回填它 */
  index: number;
}

function formatItem({ item, index }: PromptItem): string {
  const date = item.publishedAt === '' ? '日期未知' : item.publishedAt.slice(0, 10);
  const summary = String(item.summary ?? '').replace(/\s+/gu, ' ').slice(0, 600);
  return [
    `[${index}] ${KIND_LABEL[item.kind] ?? item.kind} | ${item.sourceId} | ${date} | 相关度 ${Math.round(item.score)}`,
    `标题: ${item.title}`,
    `链接: ${item.url}`,
    `摘要: ${summary === '' ? '（无摘要）' : summary}`,
  ].join('\n');
}

export interface IdeaPromptInput {
  focus: string;
  count: number;
  items: PromptItem[];
}

/**
 * 选题生成 prompt。
 *
 * 口径全部来自踩过的坑：
 *   - 方案必须多特征：单特征选题（「用 A 提升 B」）在中国发明专利里几乎必然被
 *     现有技术单独公开打掉，撰写的创造性论证也没地方落；
 *   - 效果必须量化：专利工程师写「有益效果」时要对着数字说事，
 *     「更快更省」在审查意见里等于没说；
 *   - 检索式等词数：命中数要横向比，词数不齐比的是检索式松紧不是技术密度；
 *   - risks 点名具体方案：泛泛说「已有类似研究」不能指导规避设计。
 */
export function buildIdeaPrompt({ focus, count, items }: IdeaPromptInput): string {
  const list = items.map(formatItem).join('\n\n');
  return [
    '下面是最近抓取的技术情报（论文 / 版本发布 / 新闻）。请面向「可申请的中国发明专利」提出候选选题。',
    focus.trim() === '' ? '' : `本次关注方向：${focus.trim().slice(0, 200)}`,
    '',
    '【硬性口径】每个选题必须同时满足：',
    '1. problem：一句话说清现有技术的**机制性缺陷**（在什么环节、因为什么、导致什么代价），禁止「效率不高」「效果不好」这类空话；',
    `2. solution：必须包含 ${MIN_SOLUTION_FEATURES} 个以上**相互配合**的技术手段（用 ①②③ 或分号分隔），写清模块、数据流、判据或约束；只写一个手段的选题直接作废；`,
    '3. effect：必须可量化，给出指标名 + 数值 + 口径（如「吞吐提升 2.3 倍」「P99 时延由 480ms 降至 302ms」「命中率 91.4%」），禁止「显著提升」；',
    '4. keywords：3–6 个中文关键词；',
    '5. ipcHints：1–3 个**真实** IPC 分类号，形如 G06F12/0871、H04L67/10；不要写中文类别名，不要写「G06F（电数字数据处理）」这种带括号的伪分类号；',
    `6. queries：恰好 3 条可直接粘贴到智慧芽（PatSnap）的中文查新检索式，每条 ${QUERY_MIN_WORDS}–${QUERY_MAX_WORDS} 个词、空格分隔、**词数尽量一致**（差 ≤1），便于横向比较命中数；用领域通用术语，不要用自造的方案名；`,
    '7. risks：恰好 2 条，点名最可能撞车的**具体**现有方案（论文方法名 / 厂商功能名 / 专利族）并说明撞在哪，不要写「已有类似研究」；',
    '8. cites：引用到的情报序号（方括号里的数字），只引用真实存在的序号。',
    '',
    '【正例（口径参照，不要照抄内容）】',
    '[{"title":"一种基于草稿置信度分级的投机解码动态退出方法",',
    '"problem":"现有投机解码按固定最大草稿长度生成候选，草稿模型在高熵生成阶段被接受概率骤降，被拒 token 的验证开销反而抬高了尾时延，且固定长度无法区分简单续写与困难推理两类请求。",',
    '"solution":"① 草稿阶段逐 token 计算草稿模型与目标模型的 top-1 概率差，得到置信度余量；② 以滑动窗口统计窗口内被拒率，被拒率超阈值即按阶梯下调后续草稿长度，跌破下限则本步回退到目标模型单步解码；③ 将置信度余量与 KV cache 分页块命中状态联合判定，仅对命中的缓存块保留长草稿、未命中块走短草稿路径，两级判据共同决定本步草稿长度与是否并发校验。",',
    '"effect":"在 7B 目标模型 + 1.5B 草稿模型上，吞吐由 1820 token/s 提升至 4190 token/s（2.3 倍），P99 首 token 时延由 480ms 降至 302ms（-37%），平均接受长度由 2.1 提升至 3.4，显存占用不增加。",',
    '"keywords":["投机解码","草稿模型","置信度分级","动态草稿长度","KV缓存","尾时延"],',
    '"ipcHints":["G06F9/50","G06F12/0871"],',
    '"queries":["投机解码 草稿 置信度 退出","草稿模型 接受率 动态 调整","解码 缓存 命中 分级 调度"],',
    '"risks":["Google 自适应草稿长度专利族：已公开按被拒率调整草稿步数，区别点须落在『置信度余量 + KV 块命中』的联合判定","vLLM dynamic speculative lookahead：按批负载调草稿步数，需强调 token 级置信度而非 batch 级统计"],',
    '"cites":[1,3]}]',
    '',
    '【反例（会被下游校验直接丢弃，不要这样写）】',
    '- solution 只写「采用改进的投机解码提升推理速度」：单特征、无数据流、无判据；',
    '- effect 只写「速度更快、效果更好」：没有量化口径；',
    '- queries 写成「基于置信度分级与缓存命中联合判定的投机解码动态退出方法」：12 个词，简单搜索是 AND 语义，必然 0 命中，查新无效。',
    '',
    `【输出】只输出 JSON 数组，长度恰好 ${count}，不要输出任何解释。数组元素字段：`,
    '{"title":"","problem":"","solution":"","effect":"","keywords":[""],"ipcHints":[""],"queries":["","",""],"risks":["",""],"cites":[1]}',
    '',
    '【情报列表】',
    list,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ---------------------------------------------------------------- 查新解读

export interface NoveltyInterpretInput {
  title: string;
  records: NoveltyRecord[];
  /** 机械判读结果（由 verdict.ts 算出，模型不得改判） */
  verdict: string;
  reason: string;
}

/**
 * 查新解读 prompt。
 *
 * 注意边界：判读是**机械规则**（verdict.ts），模型只做「翻成人话 + 下一步动作」，
 * 不允许它把 inconclusive 说成「技术空白」——这正是生产上踩过的坑。
 */
export function buildNoveltyInterpretPrompt({ title, records, verdict, reason }: NoveltyInterpretInput): string {
  const rows = records
    .map((r) => {
      const hits = r.hits === null ? '解析失败' : String(r.hits);
      const apps = r.topAssignees.trim() === '' ? '（无）' : r.topAssignees;
      return `- 检索式「${r.query}」命中 ${hits}；头部申请人：${apps}`;
    })
    .join('\n');

  return [
    '你在为专利工程师解读一次查新结果。判读结论已由机械规则给出，你**不得修改结论**，只负责解释与给出下一步动作。',
    `选题：${title.slice(0, 200)}`,
    '查新记录：',
    rows === '' ? '- （无记录）' : rows,
    `机械判读：${verdict} —— ${reason}`,
    '',
    '请输出 JSON 对象：',
    '{"reading":"80–150 字中文解读：命中数说明这个方向的拥挤程度，申请人分布说明谁在布防；若检索式疑似过窄要直说","next":["1–3 条具体下一步动作，例如减词重跑、换同义词、读某篇最近邻的权利要求"]}',
    '',
    '口径示例：',
    '- 全零时必须写成「检索式可能过窄或术语不匹配，需先减词/换词重跑，不能据此认定技术空白」；',
    '- 红海时必须点名头部申请人，并建议「往其未覆盖的子问题规避」。',
    '只输出 JSON 对象，不要解释文字，不要 Markdown 围栏。',
  ].join('\n');
}
