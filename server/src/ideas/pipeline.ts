/**
 * 选题生成管线：选料 → 生成 prompt → 调 LLM → 抽取 JSON → 逐条校验 → 去重 → 落成 Idea。
 *
 * 设计上有两个刻意的选择：
 *   1. **逐条校验、丢弃而不整批失败**。模型经常 3 条里有 1 条废（漏字段/检索式
 *      词数不齐/IPC 写错），整批失败会让用户白等 90 秒；丢掉坏的那条、把原因
 *      带回去，用户至少拿到了 2 条能用的，还知道另外 1 条为什么废。
 *   2. **不自动重试补足数量**。重试一次就是再花 90s 和一份 token，而缺条的
 *      原因通常是模型口径问题，用户点第二次同样便宜；所以只把原因说清楚。
 */

import { randomUUID } from 'node:crypto';

import type { AppConfig } from '../config.js';
import type { GenerateIdeasRequest, Idea, Item } from '../types.js';
import {
  LlmJsonError,
  LlmNotConfiguredError,
  createLlm,
  extractJson,
  type ChatMessage,
  type LlmClient,
} from './llm.js';
import {
  IPC_PATTERN,
  MIN_SOLUTION_FEATURES,
  PROMPT_VERSION,
  QUERY_WORD_SPREAD_MAX,
  SYSTEM_PROMPT,
  buildIdeaPrompt,
} from './prompts.js';

// 让 API/前端不必知道模板细节，只从 pipeline 取版本号
export { PROMPT_VERSION } from './prompts.js';

/** 送进 prompt 的条目上限。再多只会稀释模型的注意力，还烧 token。 */
export const MAX_INPUT_ITEMS = 12;
export const DEFAULT_IDEA_COUNT = 3;
export const MAX_IDEA_COUNT = 5;
/** 标题相似度阈值：归一化字符 bigram Jaccard 超过它视为重复选题。 */
export const TITLE_SIMILARITY_MAX = 0.8;
/** 单条检索式的词数硬上限（prompt 要求 3–5，校验放宽到 8 以免模型分词差异误杀）。 */
const QUERY_WORDS_HARD_MAX = 8;

export type IdeaGenerationErrorCode = 'no_items' | 'llm_output_truncated' | 'llm_bad_output' | 'all_invalid';

export class IdeaGenerationError extends Error {
  readonly code: IdeaGenerationErrorCode;
  readonly dropped: IdeaDraftDrop[];
  constructor(message: string, code: IdeaGenerationErrorCode, extra: { cause?: unknown; dropped?: IdeaDraftDrop[] } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'IdeaGenerationError';
    this.code = code;
    this.dropped = extra.dropped ?? [];
  }
}

/** 被丢弃的候选及原因，前端可直接展示「为什么这条没进来」。 */
export interface IdeaDraftDrop {
  /** 模型返回数组里的序号，从 1 开始 */
  index: number;
  title: string;
  reasons: string[];
}

/**
 * 落库用的 idea。
 *
 * 契约里的 Idea 是冻结的，不能加字段，但「这条选题是哪版 prompt 生成」必须可回溯，
 * 所以用附加属性携带 promptVersion：它在 JSON 序列化里会出现，对 Idea 类型仍可赋值。
 */
export type GeneratedIdea = Idea & { promptVersion: string };

export interface GenerateIdeasResult {
  ideas: GeneratedIdea[];
  /** 本次真正喂给模型的条目 id（按相关度倒序），即 ideas[].cites 的取值范围 */
  usedItems: string[];
  /** 不合格/重复而被丢弃的候选，含原因 */
  dropped: IdeaDraftDrop[];
  meta: { promptVersion: string; model: string; focus: string; requested: number };
}

/** 生成只需要 complete，不关心 model 字段，方便测试注入假实现。 */
export type IdeaLlm = Pick<LlmClient, 'complete'>;

export interface GenerateIdeasOptions {
  /** 注入 LLM（测试用假实现；生产不传，走 config.llm） */
  llm?: IdeaLlm;
  /** 库里已有选题的标题，用于去重 */
  existing?: { title: string }[];
  now?: () => Date;
  newId?: (prefix: string) => string;
}

// ---------------------------------------------------------------- 选料

/** 输入条目：按 score 倒序取 ≤12 条；传了 itemIds 就只在其中挑。 */
export function selectItems(items: Item[], itemIds?: string[], limit = MAX_INPUT_ITEMS): Item[] {
  const wanted = Array.isArray(itemIds) ? new Set(itemIds.map(String)) : null;
  const pool = (Array.isArray(items) ? items : []).filter((item) =>
    wanted === null ? true : wanted.has(item.id),
  );
  return [...pool]
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    .slice(0, Math.max(1, limit));
}

// ---------------------------------------------------------------- 标题去重

/** 归一化：全角转半角、小写、只留字母/数字/汉字（连字符与空格不同写法不该算两条）。 */
export function normalizeTitle(title: string): string {
  return String(title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function bigrams(text: string): Set<string> {
  const chars = [...text];
  if (chars.length <= 1) return new Set(chars);
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) grams.add(chars[i]! + chars[i + 1]!);
  return grams;
}

/** Jaccard 相似度（字符 bigram）。中文标题用 bigram 比词袋稳，不用装分词器。 */
export function titleSimilarity(a: string, b: string): number {
  const left = bigrams(normalizeTitle(a));
  const right = bigrams(normalizeTitle(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

// ---------------------------------------------------------------- 字段校验

/** 检索式词数：空格 + 顿号/逗号/加号都当分隔符（模型写法不统一）。 */
export function queryWordCount(query: string): number {
  return String(query ?? '')
    .replace(/[、，,＋+]/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '').length;
}

/** 归一化 IPC：容忍「G06F 12/0871」「G06F12/0871（内存管理）」这类写法。 */
export function normalizeIpc(hint: string): string | null {
  const compact = String(hint ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .toUpperCase();
  if (compact === '') return null;
  if (IPC_PATTERN.test(compact)) return compact;
  const match = compact.match(/[A-H]\d{2}[A-Z]\d{1,4}\/\d{2,6}/u);
  return match === null ? null : match[0];
}

/**
 * 数「相互配合的技术手段」：优先数 ①②③ 编号；没有编号就数分句。
 * 纯启发式——它只负责挡住「一句话方案」，不负责判断方案聪明不聪明。
 */
export function countSolutionFeatures(solution: string): number {
  const text = String(solution ?? '').trim();
  if (text === '') return 0;
  const numbered = text.match(/[①②③④⑤⑥⑦⑧⑨]/gu);
  if (numbered !== null && numbered.length > 0) return numbered.length;
  return text
    .split(/[；;。\n]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 6).length;
}

/** 效果必须带数值口径：光有数字不够（「处理 3 个模块」不算效果），还要有指标单位。 */
export function hasQuantifiedEffect(effect: string): boolean {
  const text = String(effect ?? '').trim();
  if (!/\d/u.test(text)) return false;
  return /(?:%|％|倍|ms|毫秒|秒|gb\/s|mb\/s|tb\/s|gb|mb|qps|tps|token\/s|次\/秒|命中率|时延|带宽|吞吐|条|个|组)/iu.test(
    text,
  );
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function asTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry !== '');
}

interface ValidatedDraft {
  title: string;
  problem: string;
  solution: string;
  effect: string;
  keywords: string[];
  ipcHints: string[];
  queries: string[];
  risks: string[];
  cites: string[];
}

/**
 * 丢弃理由是**给用户看的**（前端直接贴在候选卡片上），所以：
 * 中文、不带英文标识名、≤30 字、尽量带关键数字（词数差 3 / 手段 1 个 / 相似度 0.90）。
 * 机器可读信息放在 `dropped[].index` 与日志里，不塞进这句人话。
 */
export const MAX_REASON_CHARS = 30;

const pushReason = (reasons: string[], text: string): void => {
  const trimmed = text.trim();
  const chars = [...trimmed];
  reasons.push(chars.length <= MAX_REASON_CHARS ? trimmed : `${chars.slice(0, MAX_REASON_CHARS - 1).join('')}…`);
};

/** 校验一条模型草稿；返回 reasons 非空即应丢弃。 */
export function validateDraft(raw: unknown, picked: Item[]): { draft?: ValidatedDraft; reasons: string[] } {
  const reasons: string[] = [];
  const obj = (raw ?? {}) as Record<string, unknown>;

  const title = asText(obj.title);
  const problem = asText(obj.problem);
  const solution = asText(obj.solution);
  const effect = asText(obj.effect);
  const keywords = asTextList(obj.keywords);
  const risks = asTextList(obj.risks);

  if (title.length < 6) pushReason(reasons, '选题标题缺失或过短');
  if (problem === '') pushReason(reasons, '缺少技术问题描述');
  else if (problem.length < 10) pushReason(reasons, '技术问题描述过短');

  if (solution === '') {
    pushReason(reasons, '缺少技术方案');
  } else {
    const features = countSolutionFeatures(solution);
    if (features < MIN_SOLUTION_FEATURES) {
      pushReason(reasons, `技术手段仅 ${features} 个（要求 ≥${MIN_SOLUTION_FEATURES}）`);
    }
  }

  if (effect === '') pushReason(reasons, '缺少有益效果');
  else if (!hasQuantifiedEffect(effect)) pushReason(reasons, '效果缺量化指标');

  if (keywords.length < 2) pushReason(reasons, '关键词不足 2 个');

  const rawIpc = asTextList(obj.ipcHints);
  const ipcHints: string[] = [];
  const badIpc: string[] = [];
  for (const hint of rawIpc) {
    const normalized = normalizeIpc(hint);
    if (normalized === null) badIpc.push(hint);
    else if (!ipcHints.includes(normalized)) ipcHints.push(normalized);
  }
  if (rawIpc.length === 0) pushReason(reasons, '缺少 IPC 分类号');
  if (badIpc.length > 0) pushReason(reasons, `IPC 号格式非法：${badIpc.slice(0, 2).join('、')}`);

  const queries = asTextList(obj.queries);
  if (queries.length < 2) {
    pushReason(reasons, `检索式不足 2 条（${queries.length} 条）`);
  } else {
    const counts = queries.map(queryWordCount);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    if (min < 2) pushReason(reasons, `检索式仅 ${min} 个词，范围过宽`);
    if (max > QUERY_WORDS_HARD_MAX) pushReason(reasons, `检索式 ${max} 词过长（易全零）`);
    if (max - min > QUERY_WORD_SPREAD_MAX) {
      pushReason(reasons, `检索式词数差 ${max - min}（要求 ≤${QUERY_WORD_SPREAD_MAX}）`);
    }
  }

  if (risks.length === 0) pushReason(reasons, '缺少撞车风险点');

  if (reasons.length > 0) return { reasons };

  return {
    reasons,
    draft: {
      title,
      problem,
      solution,
      effect,
      keywords,
      ipcHints,
      queries,
      risks,
      cites: mapCites(obj.cites, picked),
    },
  };
}

/** cites：既接受 1-based 序号（prompt 约定），也接受 item id（人工修订过的数据）。 */
function mapCites(raw: unknown, picked: Item[]): string[] {
  const entries = Array.isArray(raw) ? raw : [];
  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      const item = picked[Math.trunc(entry) - 1];
      if (item !== undefined) ids.push(item.id);
      continue;
    }
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (/^\d+$/u.test(text)) {
        const item = picked[Number(text) - 1];
        if (item !== undefined) ids.push(item.id);
      } else if (picked.some((item) => item.id === text)) {
        ids.push(text);
      }
    }
  }
  return [...new Set(ids)];
}

// ---------------------------------------------------------------- 主流程

const clampCount = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_IDEA_COUNT;
  return Math.max(1, Math.min(MAX_IDEA_COUNT, Math.trunc(parsed)));
};

const defaultNewId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

/**
 * 生成选题。
 *
 * @param config 全局配置（llm 端点）；注入了 options.llm 时可留空配置
 * @param req    focus / count / 可选 itemIds
 * @param items  候选情报（函数内部再按 score 排序取前 12）
 */
export async function generateIdeas(
  config: AppConfig,
  req: GenerateIdeasRequest,
  items: Item[],
  options: GenerateIdeasOptions = {},
): Promise<GenerateIdeasResult> {
  const focus = String(req?.focus ?? '').trim().slice(0, 200);
  const count = clampCount(req?.count);
  const picked = selectItems(items, req?.itemIds, MAX_INPUT_ITEMS);

  if (picked.length === 0) {
    throw new IdeaGenerationError(
      '没有可用的情报条目：调用方需要传入 items（API 层用 getItemsByIds / listItems 取），或先跑一次采集',
      'no_items',
    );
  }

  const client: IdeaLlm = options.llm ?? createLlm(config);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildIdeaPrompt({
        focus,
        count,
        items: picked.map((item, index) => ({ item, index: index + 1 })),
      }),
    },
  ];

  // 5 条选题的 JSON 实测要 6000+ tokens：沿用 config 里的 maxTokens（默认 8000），
  // 参考实现把 4200 提到 8000 就是因为 count=5 会被截断成不可解析。
  const answer = await client.complete(messages, {
    temperature: config.llm?.temperature,
    maxTokens: config.llm?.maxTokens,
  });

  let parsed: unknown;
  try {
    parsed = extractJson(answer);
  } catch (error) {
    if (error instanceof LlmJsonError && error.truncated) {
      throw new IdeaGenerationError(
        `模型输出被截断，请减少数量（当前 count=${count}）或降低单条选题长度后重试`,
        'llm_output_truncated',
        { cause: error },
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new IdeaGenerationError(`模型返回的选题不是合法 JSON：${reason}`, 'llm_bad_output', { cause: error });
  }

  if (!Array.isArray(parsed)) {
    throw new IdeaGenerationError('模型返回的不是选题数组（期望 JSON 数组）', 'llm_bad_output');
  }

  const existing = (options.existing ?? []).map((entry) => String(entry?.title ?? '')).filter((title) => title !== '');
  const accepted: { idea: GeneratedIdea; title: string }[] = [];
  const dropped: IdeaDraftDrop[] = [];
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? defaultNewId;
  const at = now().toISOString();

  for (let index = 0; index < parsed.length; index += 1) {
    if (accepted.length >= count) break; // 模型多给了就截到 count，不多花落库成本
    const raw = parsed[index];
    const rawTitle = asText((raw as Record<string, unknown> | null)?.title);
    const { draft, reasons } = validateDraft(raw, picked);

    if (draft === undefined) {
      dropped.push({ index: index + 1, title: rawTitle.slice(0, 80), reasons });
      continue;
    }

    // 库内已有标题 + 本批已接受的标题都参与去重
    const dupOf = [...existing, ...accepted.map((entry) => entry.title)].find(
      (candidate) => titleSimilarity(draft.title, candidate) > TITLE_SIMILARITY_MAX,
    );
    if (dupOf !== undefined) {
      const similarity = titleSimilarity(draft.title, dupOf);
      const reasons: string[] = [];
      // 措辞保持「高度相似」：api 的契约测试也按这个词断言，别为了好看改字
      pushReason(reasons, `标题与已有选题高度相似（${similarity.toFixed(2)}）`);
      dropped.push({ index: index + 1, title: draft.title.slice(0, 80), reasons });
      continue;
    }

    accepted.push({
      title: draft.title,
      idea: {
        id: newId('idea'),
        createdAt: at,
        updatedAt: at,
        title: draft.title,
        problem: draft.problem,
        solution: draft.solution,
        effect: draft.effect,
        keywords: draft.keywords,
        ipcHints: draft.ipcHints,
        queries: draft.queries,
        risks: draft.risks,
        status: 'draft',
        cites: draft.cites,
        // focus 快照 + cites：脱离当时的条目池也能复现「为什么是这条选题」
        focus: focus === '' ? '（未指定 focus）' : focus,
        novelty: [],
        promptVersion: PROMPT_VERSION,
      },
    });
  }

  if (accepted.length === 0) {
    const detail = dropped
      .map((entry) => `#${entry.index}「${entry.title}」：${entry.reasons.join('；')}`)
      .join(' / ');
    throw new IdeaGenerationError(
      `模型返回的 ${parsed.length} 条选题全部不合格（数量要求 ${count}）：${detail === '' ? '无有效条目' : detail}`,
      'all_invalid',
      { dropped },
    );
  }

  return {
    ideas: accepted.map((entry) => entry.idea),
    usedItems: picked.map((item) => item.id),
    dropped,
    meta: {
      promptVersion: PROMPT_VERSION,
      model: options.llm === undefined ? config.llm.model : 'injected',
      focus,
      requested: count,
    },
  };
}

/** 给 API 层用：LlmNotConfiguredError 原样抛出（映射 503），其余生成错误带 code。 */
export { LlmNotConfiguredError };
